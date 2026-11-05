const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../js/geometry.js');
const C = require('../../js/csg.js');
const D = require('../../js/drawing.js');
const fixtures = require('../fixtures/drawings.json');

let wasm;
test.before(async () => {
    const Module = (await import('manifold-3d')).default;
    wasm = await Module();
    wasm.setup();
});

for (const [name, fx] of Object.entries(fixtures)) {
    if (name.startsWith('_')) continue;
    test(`real drawing "${name}" builds a watertight solid with the right volume`, () => {
        const text = 'Detal: ...\n```json\n' + JSON.stringify(fx.answer, null, 2) + '\n```';
        const { spec, analysis } = D.parseAnswer(text);
        assert.equal(spec.kind, 'csg');
        assert.equal(analysis.part_name, fx.answer.part_name);
        const built = C.build(wasm, spec);
        const report = G.analyzeMesh(built.positions);
        assert.ok(report.watertight, 'watertight');
        assert.equal(report.invertedNormals, false);
        assert.ok(Math.abs(built.volume - fx.expected_volume) < fx.expected_volume * 0.002, `${built.volume} vs ${fx.expected_volume}`);
        assert.ok(Math.abs(report.volume - built.volume) < built.volume * 1e-4, 'viewer mesh = solid');
    });
}

test('axes map (u, v) the same way as the backend', () => {
    // a 10 x 5 (u x v) rectangle swept 3 mm along each axis
    const rect = [[0, 0], [10, 0], [10, 5], [0, 5]];
    const sizes = {};
    for (const axis of ['x', 'y', 'z']) {
        const b = C.build(wasm, { kind: 'csg', features: [{ op: 'add', shape: 'prism', axis, from: 1, to: 4, outline: rect }] });
        const r = G.analyzeMesh(b.positions);
        // viewer is Y-up: (x, y, z)_cad = (vx, -vz, vy)
        sizes[axis] = { x: r.size[0], y: r.size[2], z: r.size[1], min: [r.bbox.min[0], -r.bbox.max[2], r.bbox.min[1]] };
    }
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} vs ${b}`);
    close(sizes.z.x, 10); close(sizes.z.y, 5); close(sizes.z.z, 3); close(sizes.z.min[2], 1);
    close(sizes.x.x, 3); close(sizes.x.y, 10); close(sizes.x.z, 5); close(sizes.x.min[0], 1);
    close(sizes.y.x, 10); close(sizes.y.y, 3); close(sizes.y.z, 5); close(sizes.y.min[1], 1);
});

test('normalize rejects bad features with Uzbek messages', () => {
    assert.throws(() => C.normalize({ features: [] }), /element/);
    assert.throws(() => C.normalize({ features: [{ op: 'cut', shape: 'cylinder', from: 0, to: 1, diameter: 2 }] }), /Birinchi/);
    assert.throws(() => C.normalize({ features: [{ op: 'add', shape: 'cone', from: 0, to: 1 }] }), /noma'lum/);
    assert.throws(() => C.normalize({ features: [{ op: 'add', shape: 'cylinder', from: 2, to: 2, diameter: 2 }] }), /nolga/);
    assert.throws(() => C.normalize({ features: [{ op: 'add', shape: 'prism', from: 0, to: 1, outline: [[0, 0], [1, 1], [1, 0], [0, 1]] }] }), /kesib/);
    assert.throws(() => C.normalize({ features: [{ op: 'add', shape: 'regular_prism', from: 0, to: 1, sides: 2, diameter: 5 }] }), /tomonlar/);
});

test('cutting everything away is reported', () => {
    assert.throws(() => C.build(wasm, { features: [
        { op: 'add', shape: 'cylinder', from: 0, to: 5, diameter: 10 },
        { op: 'cut', shape: 'cylinder', from: -1, to: 6, diameter: 20 }] }), /bo'sh/);
});
