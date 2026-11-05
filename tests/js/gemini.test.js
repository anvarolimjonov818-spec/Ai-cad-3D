const test = require('node:test');
const assert = require('node:assert/strict');
const Gm = require('../../js/gemini.js');

const MODELS = [
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.6-flash-preview', displayName: 'Gemini 3.6 Flash Preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-image', displayName: 'Image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.5-flash-tts', displayName: 'TTS', supportedGenerationMethods: ['generateContent'] }
];

function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init });
        const { status = 200, body } = handler(url, init);
        return { ok: status < 400, status, statusText: 'x', json: async () => body };
    };
    fn.calls = calls;
    return fn;
}

test('ranks usable models: newest stable Flash first, skips image/tts/embedding', () => {
    const ids = Gm.rankModels(MODELS).map(m => m.id);
    assert.equal(ids[0], 'gemini-3.5-flash');
    assert.ok(!ids.some(id => /image|tts|embedding/.test(id)));
    assert.ok(ids.includes('gemini-2.5-pro'));
});

test('listModels sends the key in a header, not the URL', async () => {
    const f = fakeFetch(() => ({ body: { models: MODELS } }));
    const models = await Gm.listModels('AIzaTEST', f);
    assert.equal(models[0].id, 'gemini-3.5-flash');
    assert.equal(f.calls[0].init.headers['x-goog-api-key'], 'AIzaTEST');
    assert.ok(!f.calls[0].url.includes('AIzaTEST'));
});

test('analyze sends the drawing inline and returns the text, skipping thought parts', async () => {
    const f = fakeFetch(() => ({ body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"kind":"csg"}' }] } }] } }));
    const text = await Gm.analyze({ key: 'k', model: 'gemini-3.5-flash', file: { mimeType: 'application/pdf', base64: 'QUJD' }, prompt: 'P', fetchFn: f });
    assert.equal(text, '{"kind":"csg"}');
    const body = JSON.parse(f.calls[0].init.body);
    assert.match(f.calls[0].url, /models\/gemini-3\.5-flash:generateContent$/);
    assert.equal(body.contents[0].parts[0].inline_data.mime_type, 'application/pdf');
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('errors become clear Uzbek messages', async () => {
    const call = (status, message) => Gm.analyze({ key: 'k', model: 'm', file: { mimeType: 'image/png', base64: 'x' }, prompt: 'p',
        fetchFn: fakeFetch(() => ({ status, body: { error: { message } } })) });
    await assert.rejects(call(400, 'API key not valid. Please pass a valid API key.'), /kalit noto'g'ri/);
    await assert.rejects(call(429, 'Resource has been exhausted'), /limit tugadi/);
    await assert.rejects(call(400, 'User location is not supported for the API use.'), /hududingizda/);
    await assert.rejects(Gm.analyze({ key: 'k', model: 'm', file: { mimeType: 'image/png', base64: 'x' }, prompt: 'p',
        fetchFn: fakeFetch(() => ({ body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] } })) }), /kesilib/);
});
