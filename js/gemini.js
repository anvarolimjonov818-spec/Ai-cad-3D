/*
 * Gemini API client for the free, fully automatic drawing → 3D mode.
 * Runs in the browser with the user's own API key (never shipped in the site).
 * Uses the REST API directly: https://ai.google.dev/api
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CadGemini = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const BASE = 'https://generativelanguage.googleapis.com/v1beta';
    const MAX_FILE = 15 * 1024 * 1024;    // inline data limit is ~20 MB per request
    const SKIP = /(image|tts|audio|live|embed|vision|robot|computer|learnlm|aqa|imagen|veo|gemma|native|nano)/i;

    async function request(fetchFn, url, key, body) {
        let res;
        try {
            res = await fetchFn(url, {
                method: body ? 'POST' : 'GET',
                headers: Object.assign({ 'x-goog-api-key': key }, body ? { 'Content-Type': 'application/json' } : {}),
                body: body ? JSON.stringify(body) : undefined
            });
        } catch (e) {
            throw new Error("Gemini'ga ulanib bo'lmadi — internetni tekshiring (" + e.message + ')');
        }
        let data = {};
        try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
        if (!res.ok) {
            const msg = (data.error && data.error.message) || res.statusText;
            if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) throw new Error("API kalit noto'g'ri — aistudio.google.com/apikey sahifasidan nusxalang");
            if (res.status === 400 && /location is not supported/i.test(msg)) throw new Error('Gemini API sizning hududingizda ishlamayapti');
            if (res.status === 403) throw httpError(403, 'Kalitga ruxsat yo\'q: ' + msg);
            if (res.status === 429) throw httpError(429, "Bepul limit tugadi (429). Bir oz kutib qayta urining yoki boshqa modelni tanlang. " + msg.split('\n')[0]);
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

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const BUSY = [500, 502, 503, 504];

    /**
     * analyze() with resilience: retry the same model while Google reports it is
     * busy (5xx), then fall back to the next models in `models` (also on 429
     * quota and 404). Returns { text, model }. `onStatus(message)` reports progress.
     */
    async function analyzeResilient(opts) {
        const { models, onStatus } = opts;
        const delays = opts.retryDelays || [2000, 5000];
        const order = [opts.model].concat((models || []).filter(m => m !== opts.model)).slice(0, opts.maxModels || 4);
        let lastErr;
        for (const model of order) {
            for (let attempt = 0; attempt <= delays.length; attempt++) {
                try {
                    const text = await analyze(Object.assign({}, opts, { model }));
                    return { text, model };
                } catch (err) {
                    lastErr = err;
                    if (BUSY.includes(err.status) && attempt < delays.length) {
                        if (onStatus) onStatus(`${model} band — ${Math.round(delays[attempt] / 1000)} s dan keyin qayta urinilmoqda...`);
                        await sleep(delays[attempt]);
                        continue;
                    }
                    break;   // try the next model (or give up on non-retryable errors)
                }
            }
            if (!(BUSY.includes(lastErr.status) || lastErr.status === 429 || lastErr.status === 404)) throw lastErr;
            if (onStatus) onStatus(`${model} ishlamadi — boshqa modelga o'tilmoqda...`);
        }
        throw lastErr;
    }

    /** Version number in a model name, e.g. "models/gemini-3.5-flash" → 3.5. */
    function version(name) {
        const m = /gemini-(\d+(?:\.\d+)?)/.exec(name);
        return m ? parseFloat(m[1]) : 0;
    }

    /** Models that can read an image and write text, best first (newest Flash, then the rest). */
    function rankModels(models) {
        const usable = (models || []).filter(m =>
            /gemini/i.test(m.name) && !SKIP.test(m.name) &&
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
     * Send the drawing and the prompt; returns Gemini's text answer.
     * `file` = { mimeType, base64 }.
     */
    async function analyze({ key, model, file, prompt, fetchFn }) {
        fetchFn = fetchFn || fetch;
        if (!key) throw new Error('Avval Gemini API kalitini kiriting');
        if (!file || !file.base64) throw new Error('Avval chizmani yuklang');
        const body = {
            contents: [{
                role: 'user',
                parts: [
                    { inline_data: { mime_type: file.mimeType, data: file.base64 } },
                    { text: prompt + '\n\nReturn ONLY the JSON object (no prose, no code fence): a program parses your answer.' }
                ]
            }],
            generationConfig: { responseMimeType: 'application/json' }
        };
        const data = await request(fetchFn, `${BASE}/models/${encodeURIComponent(model)}:generateContent`, key, body);
        if (data.promptFeedback && data.promptFeedback.blockReason) throw new Error('Gemini so\'rovni rad etdi: ' + data.promptFeedback.blockReason);
        const cand = (data.candidates || [])[0];
        if (!cand) throw new Error("Gemini javob qaytarmadi");
        const text = ((cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('');
        if (cand.finishReason === 'MAX_TOKENS') throw new Error('Gemini javobi kesilib qoldi — soddaroq chizma yoki boshqa model bilan urining');
        if (!text.trim()) throw new Error('Gemini bo\'sh javob qaytardi' + (cand.finishReason ? ' (' + cand.finishReason + ')' : ''));
        return text;
    }

    function readFile(file) {
        return new Promise((resolve, reject) => {
            if (file.size > MAX_FILE) return reject(new Error('Fayl 15 MB dan katta'));
            const r = new FileReader();
            r.onload = () => resolve({ mimeType: file.type, base64: String(r.result).split(',')[1] });
            r.onerror = () => reject(new Error("Faylni o'qib bo'lmadi"));
            r.readAsDataURL(file);
        });
    }

    return { listModels, rankModels, analyze, analyzeResilient, readFile };
});
