/*
 * Vercel Serverless Function proxy for Gemini API (/api/gemini).
 * Keeps GEMINI_API_KEY strictly on the server so public visitors can
 * upload drawings and generate 3D models without entering any API key.
 */
'use strict';

const Gm = require('../js/gemini.js');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ALLOWED_MIME = /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/i;
const SAFE_MODEL = /^[A-Za-z0-9._-]+$/;
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;
const MODEL_CACHE_TTL_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 15 * 1000;
const COOLDOWN_BUSY_MS = 5 * 60 * 1000;
const COOLDOWN_NOT_FOUND_MS = 15 * 60 * 1000;

function sendJson(res, status, data, extraHeaders) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) {
            if (v != null && v !== '') res.setHeader(k, String(v));
        }
    }
    res.end(JSON.stringify(data));
}

function readJsonBody(req) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        return Promise.resolve(req.body);
    }
    if (typeof req.body === 'string') {
        return Promise.resolve().then(() => JSON.parse(req.body || '{}'));
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('Fayl hajmi juda katta (maks. 4.5 MB)'), { status: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(Object.assign(new Error("Noto'g'ri JSON so'rov"), { status: 400 }));
            }
        });
        req.on('error', err => reject(Object.assign(new Error(err.message), { status: 400 })));
    });
}

function sanitizeError(msg, apiKey) {
    const text = String(msg || 'Noma\'lum xatolik');
    return apiKey ? text.split(apiKey).join('***') : text;
}

/** Build a testable `/api/gemini` request handler with optional injected dependencies. */
function createHandler(deps) {
    const options = deps || {};
    let cachedModels = null;
    let cachedAt = 0;
    let cachedKey = '';
    const cooldowns = new Map();

    function markCooldown(model, status) {
        if (!model) return;
        if (status < 400) { cooldowns.delete(model); return; }
        if (status === 404) cooldowns.set(model, Date.now() + COOLDOWN_NOT_FOUND_MS);
        else if (status === 429 || status >= 500) cooldowns.set(model, Date.now() + COOLDOWN_BUSY_MS);
    }

    function sortByHealth(list) {
        const now = Date.now();
        const ready = [];
        const cooled = [];
        for (const m of list) {
            const until = cooldowns.get(m.id) || 0;
            if (until > now) cooled.push(m);
            else ready.push(m);
        }
        return ready.concat(cooled);
    }

    async function getModels(apiKey, fetchFn, useCache) {
        const now = Date.now();
        if (useCache && cachedModels && cachedKey === apiKey && now - cachedAt < MODEL_CACHE_TTL_MS) {
            return sortByHealth(cachedModels);
        }
        const models = await Gm.listModels(apiKey, fetchFn);
        if (useCache) {
            cachedModels = models;
            cachedKey = apiKey;
            cachedAt = now;
        }
        return sortByHealth(models);
    }

    return async function geminiHandler(req, res) {
        const env = options.env || process.env;
        const fetchFn = options.fetchFn || fetch;
        const useCache = options.cache !== false && !options.fetchFn;
        const apiKey = String(env.GEMINI_API_KEY || '').trim();
        const method = String(req.method || 'GET').toUpperCase();

        if (method === 'GET') {
            if (!apiKey) {
                return sendJson(res, 200, { configured: false, models: [] });
            }
            try {
                const models = await getModels(apiKey, fetchFn, useCache);
                return sendJson(res, 200, { configured: true, valid: true, models });
            } catch (err) {
                return sendJson(res, 200, {
                    configured: true,
                    valid: false,
                    models: [],
                    error: sanitizeError(err.message, apiKey)
                });
            }
        }

        if (method !== 'POST') {
            return sendJson(res, 405, { error: { message: 'Faqat GET va POST ruxsat etilgan' } }, { Allow: 'GET, POST' });
        }

        if (!apiKey) {
            return sendJson(res, 503, {
                missingKey: true,
                error: { message: "Serverda AI_API_KEY sozlanmagan." }
            });
        }

        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return sendJson(res, err.status || 400, { error: { message: sanitizeError(err.message, apiKey) } });
        }

        const file = body && body.file;
        const prompt = body && body.prompt;
        if (!file || typeof file.mimeType !== 'string' || !ALLOWED_MIME.test(file.mimeType) ||
            typeof file.base64 !== 'string' || !file.base64.length) {
            return sendJson(res, 400, { error: { message: 'Yaroqli chizma fayli (PNG, JPEG, WEBP, GIF yoki PDF) yuborilishi shart' } });
        }
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50000) {
            return sendJson(res, 400, { error: { message: "Prompt matni bo'sh yoki juda uzun" } });
        }

        let model = typeof body.model === 'string' ? body.model.trim() : '';
        if (model && !SAFE_MODEL.test(model)) {
            return sendJson(res, 400, { error: { message: "Model nomi noto'g'ri" } });
        }

        try {
            if (!model) {
                const models = await getModels(apiKey, fetchFn, useCache);
                model = models[0].id;
            }
        } catch (err) {
            return sendJson(res, 502, { error: { message: sanitizeError(err.message, apiKey) } });
        }

        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : UPSTREAM_TIMEOUT_MS;
        const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent`;
        const callUpstream = async thinking => {
            const payload = Gm.buildGenerateBody({
                file: { mimeType: file.mimeType, base64: file.base64 },
                prompt,
                thinking
            });
            const ctrl = new AbortController();
            const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
            try {
                return await fetchFn(url, {
                    method: 'POST',
                    headers: {
                        'x-goog-api-key': apiKey,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    signal: ctrl.signal
                });
            } catch (e) {
                if (e && e.name === 'AbortError') {
                    throw Object.assign(new Error("Model javobi kechikdi — boshqa modelga o'tilmoqda"), { isTimeout: true });
                }
                throw e;
            } finally {
                if (timer) clearTimeout(timer);
            }
        };

        try {
            const tc = Gm.thinkingConfigFor(model, body.fast === 'medium' ? 'medium' : Boolean(body.fast));
            let upRes = await callUpstream(tc);
            let data = await upRes.json().catch(() => ({
                error: { message: upRes.statusText || ('HTTP ' + upRes.status) }
            }));

            if (!upRes.ok && upRes.status === 400 && tc && /thinking/i.test(String((data.error && data.error.message) || ''))) {
                upRes = await callUpstream(null);
                data = await upRes.json().catch(() => ({
                    error: { message: upRes.statusText || ('HTTP ' + upRes.status) }
                }));
            }

            markCooldown(model, upRes.status || 200);
            if (data && data.error && data.error.message) {
                data.error.message = sanitizeError(data.error.message, apiKey);
            }
            const retryAfter = upRes.headers && typeof upRes.headers.get === 'function' ? upRes.headers.get('retry-after') : null;
            return sendJson(res, upRes.status || 200, data, {
                'Retry-After': retryAfter,
                'X-Gemini-Model': model
            });
        } catch (err) {
            if (err && err.isTimeout) {
                markCooldown(model, 504);
                return sendJson(res, 504, { error: { message: err.message } }, { 'X-Gemini-Model': model });
            }
            return sendJson(res, 502, { error: { message: sanitizeError(err.message, apiKey) } });
        }
    };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
