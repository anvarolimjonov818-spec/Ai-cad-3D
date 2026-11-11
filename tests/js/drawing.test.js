const test = require('node:test');
const assert = require('node:assert/strict');
const THREE = require('three');
const G = require('../../js/geometry.js');
const M = require('../../js/mesher.js');
const D = require('../../js/drawing.js');

const plate = {
    part_name: 'Flanes plastina', kind: 'extrude', profile: [],
    outline: [[-50, -35], [-50, 35], [50, 35], [50, -35]],          // clockwise on purpose
    holes: [{ x: 0, y: 0, diameter: 30 }, { x: 38, y: 23, diameter: 10 }, { x: 80, y: 0, diameter: 10 }],
    thickness: 8, dimensions: [{ label: '100', value_mm: 100 }], assumptions: ['Faskalar kiritilmadi'], confidence: 'high'
};

const chatAnswer = obj => `Chizmani tahlil qildim. Mana model:\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\nOmad!`;

test('prompt includes the note and the JSON shape', () => {
    const p = D.buildPrompt('4 ta teshik Ø10');
    assert.match(p, /"kind": "csg"/);
    assert.match(p, /4 ta teshik Ø10$/);
    assert.equal(D.buildPrompt(''), D.PROMPT);
});

test('parses a chat answer with fences and surrounding text into a watertight plate', () => {
    const { spec, analysis, warnings } = D.parseAnswer(chatAnswer(plate));
    assert.equal(spec.kind, 'extrude');
    assert.equal(spec.depth, 8);
    assert.equal(spec.holes.length, 2);
    assert.equal(warnings.length, 1, 'hole outside the outline is reported');
    assert.equal(analysis.confidence, 'high');
    const r = G.analyzeMesh(M.specToGeometry(THREE, spec).attributes.position.array);
    assert.ok(r.watertight);
    const expected = 100 * 70 * 8 - Math.PI * (15 * 15 + 5 * 5) * 8;
    assert.ok(Math.abs(r.volume - expected) < expected * 0.002, `${r.volume} vs ${expected}`);
});

test('parses a revolve answer and tolerates trailing commas and object points', () => {
    const text = '{"part_name":"Val","kind":"revolve","profile":[{"r":0,"y":0},{"r":10,"y":0},{"r":10,"y":40},{"r":6,"y":40},{"r":6,"y":70},{"r":0,"y":70},],"outline":[],"holes":[],"thickness":0,"dimensions":[],"assumptions":[],"confidence":"medium",}';
    const { spec } = D.parseAnswer(text);
    assert.deepEqual(spec.profile[2], [10, 40]);
    const r = G.analyzeMesh(M.specToGeometry(THREE, spec).attributes.position.array);
    assert.ok(r.watertight);
    const expected = Math.PI * (100 * 40 + 36 * 30);
    assert.ok(Math.abs(r.volume - expected) < expected * 0.002);
});

test('rejects broken answers with a clear message', () => {
    assert.throws(() => D.parseAnswer(''), /bo'sh/);
    assert.throws(() => D.parseAnswer('salom'), /JSON topilmadi/);
    assert.throws(() => D.parseAnswer('{"kind":"sphere"}'), /csg/);
    assert.throws(() => D.parseAnswer({ ...plate, thickness: 0 }), /qalinligi/);
    assert.throws(() => D.parseAnswer({ ...plate, outline: [[0, 0], [10, 10], [10, 0], [0, 10]] }), /kesib/);
    assert.throws(() => D.parseAnswer({ kind: 'revolve', profile: [[0, 0], [-5, 0], [0, 10]] }), /manfiy/);
    assert.throws(() => D.parseAnswer({ kind: 'revolve', profile: [[0, 0], ['a', 0], [0, 10]] }), /son emas/);
});

test('warns when generated csg height clearly mismatches explicit height dimension', () => {
    const partial = {
        part_name: 'Mexanik qism',
        kind: 'csg',
        dimensions: [{ label: 'Balandligi', value_mm: 80 }],
        features: [
            { op: 'add', shape: 'prism', axis: 'z', from: 0, to: 20, outline: [[-55, -35], [55, -35], [55, 35], [-55, 35]] }
        ]
    };
    const { warnings } = D.parseAnswer(partial);
    assert.ok(warnings.some(w => /balandlik/i.test(w) && /20 mm/.test(w)));
});
