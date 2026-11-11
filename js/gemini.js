/*
 * Gemini API client for automatic drawing -> 3D mode.
 * Supports same-origin server proxy endpoints (e.g. /api/gemini) as well as direct calls with an explicit key.
 * Uses the REST API directly: https://ai.google.dev/api
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CadGemini = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const BASE = 'https://generativelanguage.googleapis.com/v1beta';
    const MAX_FILE = 15 * 1024 * 1024;    // inline data limit is ~20 MB per request
    const SKIP = /(image|tts|audio|live|embed|vision|robot|computer|learnlm|aqa|imagen|veo|gemma|native|nano|transcribe|customtools|argon|carbon|omni)/i;

    function parseRetryAfterMs(res, data, msg) {
        const hdr = res && res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) : 0;
        if (Number.isFinite(hdr) && hdr > 0) return Math.min(120000, Math.round(hdr * 1000));
        const details = data && data.error && Array.isArray(data.error.details) ? data.error.details : [];
        for (const d of details) {
            const m = /^([\d.]+)s$/i.exec(String((d && d.retryDelay) || ''));
            if (m) return Math.min(120000, Math.round(parseFloat(m[1]) * 1000));
        }
        const m = /retry\s+in\s+([\d.]+)\s*s/i.exec(msg || '');
        return m ? Math.min(120000, Math.round(parseFloat(m[1]) * 1000)) : 0;
    }

    function abortError() {
        const e = new Error('Tahlil bekor qilindi');
        e.name = 'AbortError';
        return e;
    }

    async function request(fetchFn, url, key, body, signal) {
        let res;
        try {
            const headers = Object.assign(
                key ? { 'x-goog-api-key': key } : {},
                body ? { 'Content-Type': 'application/json' } : {}
            );
            const init = {
                method: body ? 'POST' : 'GET',
                headers,
                body: body ? JSON.stringify(body) : undefined
            };
            if (signal) init.signal = signal;
            res = await fetchFn(url, init);
        } catch (e) {
            if (e && e.name === 'AbortError') throw abortError();
            throw new Error("Gemini'ga ulanib bo'lmadi — internetni tekshiring (" + e.message + ')');
        }
        let data = {};
        try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
        if (!res.ok) {
            const msg = (data.error && data.error.message) || res.statusText || ('HTTP ' + res.status);
            if (res.status === 413) throw httpError(413, 'Fayl hajmi juda katta (maks. 3 MB PDF yoki rasm)');
            if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) {
                throw new Error(key ? "API kalit noto'g'ri — aistudio.google.com/apikey sahifasidan nusxalang" : "Serverdagi Gemini API kalit noto'g'ri");
            }
            if (res.status === 400 && /location is not supported/i.test(msg)) throw new Error('Gemini API sizning hududingizda ishlamayapti');
            if (res.status === 403) throw httpError(403, 'Kalitga ruxsat yo\'q: ' + msg);
            if (res.status === 429) {
                const err = httpError(429, "Bepul limit tugadi (429). Bir oz kutib qayta urining yoki boshqa modelni tanlang. " + msg.split('\n')[0]);
                err.retryAfterMs = parseRetryAfterMs(res, data, msg);
                const rawDetails = data && data.error && data.error.details ? JSON.stringify(data.error.details) : '';
                err.isDailyQuota = /\bper\s*day\b|PerDay/i.test(msg + ' ' + rawDetails);
                throw err;
            }
            if (data && data.missingKey) {
                const err = httpError(res.status, msg);
                err.noRetry = true;
                throw err;
            }
            if (res.status === 503 || res.status === 500 || res.status === 502 || res.status === 504) {
                throw httpError(res.status, `Google serveri hozir band (${res.status}) — bu vaqtinchalik.`);
            }
            if (res.status === 404) throw httpError(404, `Model topilmadi (404): ${msg}`);
            throw httpError(res.status, `Gemini xatosi ${res.status}: ${msg}`);
        }
        return data;
    }

    function httpError(status, message) {
        const e = new Error(message);
        e.status = status;
        return e;
    }

    const BUSY = [500, 502, 503, 504];

    function waitWithCountdown(ms, onTick, signal) {
        if (signal && signal.aborted) return Promise.reject(abortError());
        if (ms < 1000) {
            if (onTick) onTick(Math.max(1, Math.ceil(ms / 1000)));
            return new Promise((resolve, reject) => {
                const onAbort = () => { clearTimeout(t); reject(abortError()); };
                const t = setTimeout(() => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    resolve();
                }, ms);
                if (signal) signal.addEventListener('abort', onAbort, { once: true });
            });
        }
        return new Promise((resolve, reject) => {
            const end = Date.now() + ms;
            const tick = () => { if (onTick) onTick(Math.max(1, Math.ceil((end - Date.now()) / 1000))); };
            tick();
            const iv = setInterval(() => {
                if (Date.now() >= end) { cleanup(); resolve(); }
                else tick();
            }, 1000);
            const t = setTimeout(() => { cleanup(); resolve(); }, ms);
            const onAbort = () => { cleanup(); reject(abortError()); };
            function cleanup() {
                clearInterval(iv);
                clearTimeout(t);
                if (signal) signal.removeEventListener('abort', onAbort);
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function roundWaitMs(errs, round, quotaDelays, busyDelays, explicitQuota) {
        const hasRetryable = errs.some(e => e.status === 429 || BUSY.includes(e.status));
        const allDaily = errs.length > 0 && errs.every(e => e.status === 429 && e.isDailyQuota);
        if (!hasRetryable || allDaily) return null;
        const all5xx = !errs.some(e => e.status === 429);
        if (all5xx) {
            if (round >= busyDelays.length) return null;
            return { ms: busyDelays[round], all5xx: true };
        }
        if (round >= quotaDelays.length) return null;
        const hintMs = Math.max(0, ...errs.map(e => e.retryAfterMs || 0));
        const ms = explicitQuota ? quotaDelays[round] : (hintMs > 0 ? Math.min(120000, Math.max(quotaDelays[round], hintMs + 2000)) : quotaDelays[round]);
        return { ms, all5xx: false };
    }

    /**
     * analyze() with resilience: optionally retry a busy model, fail over
     * across backup models, retry transient all-5xx rounds quickly, and wait
     * 1–2 min on 429 rate limits before retrying.
     */
    async function analyzeResilient(opts) {
        const { models, onStatus, signal } = opts;
        const delays = Array.isArray(opts.retryDelays) ? opts.retryDelays : [2000, 5000];
        const quotaDelays = opts.quotaDelays || [60000, 60000];
        const busyDelays = opts.busyDelays || quotaDelays;
        const rawOrder = (opts.model ? [opts.model] : []).concat((models || []).filter(m => m && m !== opts.model));
        const order = (rawOrder.length ? rawOrder : ['']).slice(0, opts.maxModels || 6);

        async function tryModelsOnce() {
            const errors = [];
            for (let idx = 0; idx < order.length; idx++) {
                const model = order[idx];
                let lastErr;
                for (let attempt = 0; attempt <= delays.length; attempt++) {
                    if (signal && signal.aborted) throw abortError();
                    try {
                        const text = await analyze(Object.assign({}, opts, { model }));
                        return { hit: { text, model } };
                    } catch (err) {
                        if (err && err.name === 'AbortError') throw err;
                        lastErr = err;
                        if (!err.noRetry && BUSY.includes(err.status) && attempt < delays.length) {
                            if (onStatus) onStatus(`${model || 'Gemini'} band — ${Math.round(delays[attempt] / 1000)} s dan keyin qayta urinilmoqda...`);
                            await waitWithCountdown(delays[attempt], null, signal);
                            continue;
                        }
                        break;
                    }
                }
                if (lastErr.noRetry || !(BUSY.includes(lastErr.status) || lastErr.status === 429 || lastErr.status === 404)) throw lastErr;
                errors.push(lastErr);
                const next = order[idx + 1];
                if (onStatus && next) onStatus(`${model} band — boshqa modelga o'tilmoqda (${next})...`);
            }
            return { errors, lastErr: errors[errors.length - 1] };
        }

        let res = await tryModelsOnce();
        if (res.hit) return res.hit;

        const maxRounds = Math.max(quotaDelays.length, busyDelays.length);
        for (let q = 0; q < maxRounds; q++) {
            const wait = roundWaitMs(res.errors, q, quotaDelays, busyDelays, Boolean(opts.quotaDelays));
            if (!wait) break;
            await waitWithCountdown(wait.ms, sec => {
                if (onStatus) onStatus(wait.all5xx
                    ? `Serverlar hozir band — ${sec} s dan keyin qayta uriniladi...`
                    : `Bepul limit (429) — ${sec} s dan keyin avtomatik qayta uriniladi...`);
            }, signal);

            if (onStatus) onStatus(`Qayta urinilmoqda (${order[0]})...`);
            res = await tryModelsOnce();
            if (res.hit) return res.hit;
        }
        throw res.lastErr;
    }

    /** Version number in a model name, e.g. "models/gemini-3.5-flash" → 3.5. */
    function version(name) {
        const m = /gemini-(\d+(?:\.\d+)?)/.exec(name);
        return m ? parseFloat(m[1]) : 0;
    }

    /** Models that can read an image and write text, best first (newest Flash, then the rest). */
    function rankModels(models) {
        const usable = (models || []).filter(m =>
            /gemini/i.test(m.name) && /(flash|lite|pro)/i.test(m.name) && !SKIP.test(m.name) &&
            (m.supportedGenerationMethods || []).includes('generateContent'));
        const score = m => {
            const n = m.name.toLowerCase();
            let s = version(n) * 100;
            if (n.includes('flash') && !n.includes('lite')) s += 30;       // free tier sweet spot
            else if (n.includes('lite')) s += 10;
            else if (n.includes('pro')) s += 5;                             // usually paid only
            if (/preview|exp/.test(n)) s -= 15;
            if (/latest/.test(n)) s += 1;
            return s;
        };
        return usable.sort((a, b) => score(b) - score(a)).map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
    }

    async function listModels(key, fetchFn) {
        fetchFn = fetchFn || fetch;
        const all = [];
        let token = '';
        for (let page = 0; page < 5; page++) {
            const data = await request(fetchFn, `${BASE}/models?pageSize=200${token ? '&pageToken=' + encodeURIComponent(token) : ''}`, key);
            all.push(...(data.models || []));
            if (!data.nextPageToken) break;
            token = data.nextPageToken;
        }
        const ranked = rankModels(all);
        if (!ranked.length) throw new Error("Bu kalit uchun chizma o'qiy oladigan Gemini modeli topilmadi");
        return ranked;
    }

    /**
     * Build generationConfig.thinkingConfig for fast mode.
     * Gemini 3+ uses thinkingLevel; Gemini 2.5 uses thinkingBudget (never mix both).
     */
    function thinkingConfigFor(model, fast) {
        if (!fast) return null;
        const v = version(model);
        if (v >= 3) return { thinkingLevel: 'low' };
        if (v >= 2.5) return { thinkingBudget: /pro/i.test(model) ? 1024 : 512 };
        return null;
    }

    /** Fetch server configuration and ranked usable models from `/api/gemini`. */
    async function listServerModels(endpoint, fetchFn) {
        return request(fetchFn || fetch, endpoint || '/api/gemini', '', null, null);
    }

    /** Build a Google Gemini `:generateContent` JSON request body. */
    function buildGenerateBody({ file, prompt, thinking }) {
        return {
            contents: [{
                role: 'user',
                parts: [
                    { inline_data: { mime_type: file.mimeType, data: file.base64 } },
                    { text: prompt + '\n\nReturn ONLY the JSON object (no prose, no code fence): a program parses your answer.' }
                ]
            }],
            generationConfig: Object.assign(
                { responseMimeType: 'application/json' },
                thinking ? { thinkingConfig: thinking } : {}
            )
        };
    }

    /** Extract the non-thought text payload from a Gemini response object. */
    function extractAnswerText(data) {
        if (data.promptFeedback && data.promptFeedback.blockReason) throw new Error('Gemini so\'rovni rad etdi: ' + data.promptFeedback.blockReason);
        const cand = (data.candidates || [])[0];
        if (!cand) throw new Error("Gemini javob qaytarmadi");
        const text = ((cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('');
        if (cand.finishReason === 'MAX_TOKENS') throw new Error('Gemini javobi kesilib qoldi — soddaroq chizma yoki boshqa model bilan urining');
        if (!text.trim()) throw new Error('Gemini bo\'sh javob qaytardi' + (cand.finishReason ? ' (' + cand.finishReason + ')' : ''));
        return text;
    }

    /**
     * Send the drawing and the prompt; returns Gemini's text answer.
     * Supports server proxy (`endpoint`) or direct browser key (`key`).
     * `file` = { mimeType, base64 }.
     */
    async function analyze({ key, endpoint, model, file, prompt, fast, signal, fetchFn }) {
        fetchFn = fetchFn || fetch;
        if (!endpoint && !key) throw new Error('Avval Gemini API kalitini kiriting');
        if (!file || !file.base64) throw new Error('Avval chizmani yuklang');
        if (endpoint) {
            const payload = {
                model: model || '',
                file: { mimeType: file.mimeType, base64: file.base64 },
                prompt,
                fast: !!fast
            };
            const data = await request(fetchFn, endpoint, '', payload, signal);
            return extractAnswerText(data);
        }
        const tc = thinkingConfigFor(model, fast);
        const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent`;
        let data;
        try {
            data = await request(fetchFn, url, key, buildGenerateBody({ file, prompt, thinking: tc }), signal);
        } catch (err) {
            if (!(tc && err.status === 400 && /thinking/i.test(err.message))) throw err;
            data = await request(fetchFn, url, key, buildGenerateBody({ file, prompt, thinking: null }), signal);
        }
        return extractAnswerText(data);
    }

    function readRawBase64(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve({
                mimeType: file.type,
                base64: String(r.result).split(',')[1],
                origBytes: file.size,
                sentBytes: file.size,
                resized: false
            });
            r.onerror = () => reject(new Error("Faylni o'qib bo'lmadi"));
            r.readAsDataURL(file);
        });
    }

    function compressImage(file, maxSide, minBytes) {
        if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined' ||
            !/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
            return Promise.resolve(null);
        }
        return new Promise(resolve => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const w0 = img.naturalWidth || img.width;
                const h0 = img.naturalHeight || img.height;
                const maxDim = Math.max(w0, h0);
                if (!maxDim || (maxDim <= maxSide && file.size <= minBytes)) { resolve(null); return; }
                const scale = maxDim > maxSide ? maxSide / maxDim : 1;
                const w = Math.max(1, Math.round(w0 * scale));
                const h = Math.max(1, Math.round(h0 * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) { resolve(null); return; }
                ctx.fillStyle = '#ffffff';   // keep transparent PNG backgrounds white in JPEG
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.90);
                const b64 = dataUrl.split(',')[1] || '';
                const sentBytes = Math.floor(b64.length * 3 / 4);
                if (!b64 || sentBytes >= file.size) { resolve(null); return; }
                resolve({ mimeType: 'image/jpeg', base64: b64, origBytes: file.size, sentBytes, resized: true });
            };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        });
    }

    async function readFile(file, opts) {
        if (file.size > MAX_FILE) throw new Error('Fayl 15 MB dan katta');
        const maxSide = (opts && opts.maxSide) || 1600;
        const minBytes = (opts && opts.minBytes) || 500 * 1024;
        try {
            const smaller = await compressImage(file, maxSide, minBytes);
            if (smaller) return smaller;
        } catch (e) { /* fall back to raw file */ }
        return readRawBase64(file);
    }

    return { listModels, listServerModels, rankModels, analyze, analyzeResilient, readFile, thinkingConfigFor, buildGenerateBody, extractAnswerText };
});
