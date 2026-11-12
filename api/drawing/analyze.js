'use strict';

const CadDrawing = require('../../js/drawing.js');

const ALLOWED_MIME = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf'
]);

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

const CANDIDATE_MODELS = [
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-latest'
];

async function readRawBody(req) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body, 'base64');
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_BYTES) {
                reject(new Error("Fayl hajmi 20 MB dan katta"));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ detail: "Faqat POST so'rov qabul qilinadi" }));
    }

    try {
        const apiKey = (req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY || '').trim();
        if (!apiKey) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.end(JSON.stringify({
                detail: "AI tahlil kaliti topilmadi. Tizim sozlamalaridan kalitni kiriting."
            }));
        }

        const contentType = (req.headers['content-type'] || 'image/png').split(';')[0].trim().toLowerCase();
        const mediaType = ALLOWED_MIME.has(contentType) ? contentType : 'image/png';

        const buffer = await readRawBody(req);
        if (!buffer || buffer.length === 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.end(JSON.stringify({ detail: "Chizma fayli bo'sh yoki yuklanmadi" }));
        }

        const b64 = buffer.toString('base64');
        const contentBlock = mediaType === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
            : { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };

        const url = new URL(req.url, 'http://localhost');
        const note = (url.searchParams.get('note') || '').trim();
        let prompt = "Analyse this drawing and return the part model.";
        if (note) {
            prompt += "\n\nNote from the user about the drawing:\n" + note.slice(0, 2000);
        }

        const systemPrompt = CadDrawing.PROMPT +
            "\n\nYou are called through the API: the answer format is enforced by a JSON schema, so return only the JSON object." +
            " Every feature must contain every field; use [] / 0 / \"\" for fields its shape does not use." +
            "\n\nCRITICAL: Respond ONLY with a valid JSON object matching the requested schema. Do not include markdown codeblocks or preamble.";

        let lastError = null;
        let responseJson = null;

        for (const model of CANDIDATE_MODELS) {
            try {
                const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        model,
                        max_tokens: 8192,
                        system: systemPrompt,
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    contentBlock,
                                    { type: 'text', text: prompt }
                                ]
                            }
                        ]
                    })
                });

                const data = await apiRes.json();
                if (!apiRes.ok) {
                    const msg = (data && data.error && data.error.message) || apiRes.statusText;
                    if (apiRes.status === 400 && msg.includes('credit balance is too low')) {
                        throw new Error("AI hisobingizda balans kam. Iltimos, hisobingizni to'ldiring.");
                    }
                    throw new Error(msg);
                }

                responseJson = data;
                break;
            } catch (err) {
                lastError = err;
                if (err.message && err.message.includes('balans kam')) {
                    break;
                }
            }
        }

        if (!responseJson) {
            throw lastError || new Error("Sun'iy intellektdan javob olinmadi");
        }

        const content = responseJson.content || [];
        let text = '';
        for (const block of content) {
            if (block.type === 'text') {
                text += block.text;
            }
        }

        if (!text) {
            throw new Error("Model javob qaytarmadi");
        }

        const parsed = CadDrawing.parseAnswer(text);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(parsed));
    } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ detail: err.message || "Tahlil jarayonida kutilmagan xatolik yuz berdi" }));
    }
};

module.exports.config = {
    api: {
        bodyParser: false
    }
};
