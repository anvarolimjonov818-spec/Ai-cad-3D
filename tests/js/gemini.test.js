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

test('analyzeResilient retries a busy model, then falls back to the next one', async () => {
    const answers = { 'gemini-a': [503, 503, 503], 'gemini-b': [200] };
    const seen = [];
    const f = fakeFetch(url => {
        const model = /models\/([^:]+):/.exec(url)[1];
        seen.push(model);
        const status = answers[model].shift();
        return status === 200
            ? { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":1}' }] } }] } }
            : { status, body: { error: { message: 'This model is currently experiencing high demand.' } } };
    });
    const status = [];
    const r = await Gm.analyzeResilient({ key: 'k', model: 'gemini-a', models: ['gemini-a', 'gemini-b'], file: { mimeType: 'image/png', base64: 'x' },
        prompt: 'p', fetchFn: f, retryDelays: [1, 1], onStatus: m => status.push(m) });
    assert.deepEqual(seen, ['gemini-a', 'gemini-a', 'gemini-a', 'gemini-b']);
    assert.equal(r.model, 'gemini-b');
    assert.equal(r.text, '{"ok":1}');
    assert.ok(status.some(m => /qayta urinilmoqda/.test(m)) && status.some(m => /boshqa modelga/.test(m)));
});

test('analyzeResilient does not retry a bad key', async () => {
    let calls = 0;
    const f = fakeFetch(() => { calls++; return { status: 400, body: { error: { message: 'API key not valid' } } }; });
    await assert.rejects(Gm.analyzeResilient({ key: 'k', model: 'a', models: ['a', 'b'], file: { mimeType: 'image/png', base64: 'x' }, prompt: 'p', fetchFn: f, retryDelays: [1] }), /kalit/);
    assert.equal(calls, 1);
});

test('thinkingConfigFor selects version-appropriate fast settings', () => {
    assert.equal(Gm.thinkingConfigFor('gemini-3.5-flash', false), null);
    assert.deepEqual(Gm.thinkingConfigFor('gemini-3.5-flash', true), { thinkingLevel: 'low' });
    assert.deepEqual(Gm.thinkingConfigFor('gemini-2.5-flash', true), { thinkingBudget: 512 });
    assert.deepEqual(Gm.thinkingConfigFor('gemini-2.5-pro', true), { thinkingBudget: 1024 });
    assert.equal(Gm.thinkingConfigFor('gemini-2.0-flash', true), null);
});

test('analyze fast mode sends thinkingConfig and retries without it if model rejects thinkingConfig', async () => {
    let call = 0;
    const f = fakeFetch(() => {
        call++;
        if (call === 1) return { status: 400, body: { error: { message: 'thinkingLevel is not supported on this model' } } };
        return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"kind":"csg"}' }] } }] } };
    });
    const text = await Gm.analyze({ key: 'k', model: 'gemini-3.5-flash', file: { mimeType: 'image/jpeg', base64: 'QUJD' }, prompt: 'P', fast: true, fetchFn: f });
    assert.equal(text, '{"kind":"csg"}');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(JSON.parse(f.calls[0].init.body).generationConfig.thinkingConfig, { thinkingLevel: 'low' });
    assert.equal(JSON.parse(f.calls[1].init.body).generationConfig.thinkingConfig, undefined);
});

test('analyzeResilient waits for 429 cooldown and retries to succeed', async () => {
    let calls = 0;
    const f = fakeFetch(() => {
        calls++;
        if (calls <= 2) return { status: 429, body: { error: { message: 'Please retry in 42s' } } };
        return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":2}' }] } }] } };
    });
    const status = [];
    const r = await Gm.analyzeResilient({
        key: 'k', model: 'gemini-a', models: ['gemini-a', 'gemini-b'],
        file: { mimeType: 'image/png', base64: 'x' }, prompt: 'p',
        fetchFn: f, retryDelays: [1], quotaDelays: [10], onStatus: m => status.push(m)
    });
    assert.equal(r.text, '{"ok":2}');
    assert.equal(r.model, 'gemini-a');
    assert.equal(calls, 3);
    assert.ok(status.some(m => /429/.test(m)));
});

test('analyzeResilient skips cooldown wait when all models hit PerDay quota and supports abort', async () => {
    let calls = 0;
    const fDaily = fakeFetch(() => {
        calls++;
        return { status: 429, body: { error: { message: 'Quota exceeded for GenerateRequestsPerDay' } } };
    });
    await assert.rejects(Gm.analyzeResilient({
        key: 'k', model: 'gemini-a', models: ['gemini-a'],
        file: { mimeType: 'image/png', base64: 'x' }, prompt: 'p',
        fetchFn: fDaily, quotaDelays: [5000]
    }), /limit tugadi/);
    assert.equal(calls, 1);

    const ctrl = new AbortController();
    const f429 = fakeFetch(() => ({ status: 429, body: { error: { message: 'RPM limit' } } }));
    setTimeout(() => ctrl.abort(), 15);
    await assert.rejects(Gm.analyzeResilient({
        key: 'k', model: 'gemini-a', models: ['gemini-a'],
        file: { mimeType: 'image/png', base64: 'x' }, prompt: 'p',
        fetchFn: f429, quotaDelays: [5000], signal: ctrl.signal
    }), err => err.name === 'AbortError');
});
