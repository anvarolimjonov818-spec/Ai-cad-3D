const test = require('node:test');
const assert = require('node:assert/strict');
const THREE = require('three');
const G = require('../../js/geometry.js');
const M = require('../../js/mesher.js');

const soupOf = (preset, dims) => M.specToGeometry(THREE, G.buildSpec(preset, dims)).attributes.position.array;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} ≉ ${b}`);

test('all presets are watertight with outward normals and exact bounding boxes', () => {
    const cases = [
        ['spray_bottle', { length: 60, width: 60, height: 180, param: 15 }, [60, 180, 60]],
        ['bevel_box', { length: 60, width: 50, height: 180, param: 6 }, [60, 180, 50]],
        ['flange', { length: 80, width: 60, height: 12, param: 20 }, [80, 12, 60]],
        ['tube', { length: 40, width: 40, height: 60, param: 30 }, [40, 60, 40]]
    ];
    for (const [preset, dims, size] of cases) {
        const r = G.analyzeMesh(soupOf(preset, dims));
        assert.ok(r.watertight, preset + ' watertight');
        assert.equal(r.invertedNormals, false, preset + ' normals');
        size.forEach((s, k) => close(r.size[k], s, 0.01, preset + ' size'));
        close(r.bbox.min[1], 0, 1e-6, preset + ' sits on y=0');
    }
});

test('volumes match analytic values', () => {
    const box = G.analyzeMesh(soupOf('bevel_box', { length: 60, width: 50, height: 180, param: 0 }));
    close(box.volume, 60 * 50 * 180, 1e-3, 'box');
    const tube = G.analyzeMesh(soupOf('tube', { length: 60, width: 60, height: 100, param: 40 }));
    close(tube.volume, Math.PI * (900 - 400) * 100, Math.PI * 500 * 100 * 0.002, 'tube');
});

test('validation catches impossible dimensions', () => {
    assert.ok(G.validate('flange', { length: 50, width: 40, height: 10, param: 45 }).errors.length);
    assert.ok(G.validate('flange', { length: 50, width: 40, height: 10, param: 38 }).errors.length, 'wall < 1.2 mm');
    assert.equal(G.validate('flange', { length: 50, width: 40, height: 10, param: 20 }).errors.length, 0);
    assert.ok(G.validate('spray_bottle', { length: 40, width: 40, height: 100, param: 25 }).errors.length);
    assert.ok(G.validate('bevel_box', { length: 0, width: 40, height: 100, param: 0 }).errors.length);
    assert.ok(G.validate('tube', { length: 30, width: 30, height: 100, param: 30 }).errors.length);
});

function cubeSoup() {
    const g = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
    return Float32Array.from(g.attributes.position.array);
}

test('repair closes holes, fixes winding and inverted normals', () => {
    const soup = cubeSoup();
    const holed = soup.slice(9);                 // drop one triangle
    assert.equal(G.analyzeMesh(holed).watertight, false);
    const fixed = G.repairMesh(holed);
    assert.ok(fixed.report.watertight);
    close(fixed.report.volume, 1000, 1e-6);

    const inverted = soup.slice();
    for (let i = 0; i < inverted.length; i += 9) for (let k = 0; k < 3; k++) {
        const t = inverted[i + 3 + k]; inverted[i + 3 + k] = inverted[i + 6 + k]; inverted[i + 6 + k] = t;
    }
    assert.ok(G.analyzeMesh(inverted).invertedNormals);
    const r2 = G.repairMesh(inverted);
    assert.equal(r2.report.invertedNormals, false);

    const mixed = soup.slice();                  // flip a single triangle
    const t = mixed[3]; mixed[3] = mixed[6]; mixed[6] = t;
    const t1 = mixed[4]; mixed[4] = mixed[7]; mixed[7] = t1;
    const t2 = mixed[5]; mixed[5] = mixed[8]; mixed[8] = t2;
    assert.ok(G.analyzeMesh(mixed).inconsistentEdges > 0);
    assert.ok(G.repairMesh(mixed).report.watertight);
});

test('repair closes pinched holes that touch at a single vertex', () => {
    const soup = soupOf('bevel_box', { length: 40, width: 30, height: 20, param: 4 });
    const tris = soup.length / 9;
    const key = (t, k) => [0, 1, 2].map(j => soup[t * 9 + k * 3 + j].toFixed(4)).join(',');
    const verts = t => new Set([0, 1, 2].map(k => key(t, k)));
    let pair = null;
    for (let a = 0; a < tris && !pair; a++) for (let b = a + 1; b < tris; b++) {
        const va = verts(a);
        const shared = [...verts(b)].filter(v => va.has(v)).length;
        if (shared === 1) { pair = [a, b]; break; }
    }
    assert.ok(pair, 'found two triangles sharing one vertex');
    const keep = [];
    for (let t = 0; t < tris; t++) if (!pair.includes(t)) keep.push(...soup.slice(t * 9, t * 9 + 9));
    const holed = Float32Array.from(keep);
    assert.equal(G.analyzeMesh(holed).watertight, false);
    const fixed = G.repairMesh(holed);
    assert.ok(fixed.report.watertight, 'pinched hole closed');
    close(fixed.report.volume, G.analyzeMesh(soup).volume, 1e-3);
});

test('binary STL round-trips through parseSTL', () => {
    const soup = soupOf('flange', { length: 80, width: 60, height: 12, param: 20 });
    const buf = G.toBinarySTL(soup, 'flange');
    assert.equal(buf.byteLength, 84 + (soup.length / 9) * 50);
    const back = G.parseSTL(buf);
    const a = G.analyzeMesh(soup), b = G.analyzeMesh(back);
    close(a.volume, b.volume, 1e-2);
    assert.equal(b.watertight, true);
    a.size.forEach((s, k) => close(b.size[k], s, 1e-4));
});

test('OBJ has shared vertices', () => {
    const obj = G.toOBJ(cubeSoup(), 'cube');
    assert.equal(obj.split('\n').filter(l => l.startsWith('v ')).length, 8);
    assert.equal(obj.split('\n').filter(l => l.startsWith('f ')).length, 12);
});

function syntheticImage(w, h, draw) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const on = draw(x, y);
        data[i] = on ? 30 : 235; data[i + 1] = on ? 60 : 235; data[i + 2] = on ? 200 : 235; data[i + 3] = 255;
    }
    return { width: w, height: h, data };
}

test('contour extraction finds the silhouette and builds closed revolve/extrude parts', () => {
    // a 40×120 px rectangle with a speck of noise and an interior hole
    const img = syntheticImage(100, 160, (x, y) =>
        (x >= 30 && x < 70 && y >= 20 && y < 140 && !(x > 45 && x < 55 && y > 70 && y < 80)) || (x === 5 && y === 5));
    const c = G.extractContour(img, { threshold: 40 });
    assert.ok(c);
    assert.deepEqual(c.bbox, { minX: 30, maxX: 70, minY: 20, maxY: 140 });
    assert.equal(c.mask[75 * 100 + 50], 1, 'interior hole filled');
    assert.equal(c.mask[5 * 100 + 5], 0, 'noise removed');

    for (const mode of ['revolve', 'extrude']) {
        c.mode = mode;
        const spec = G.buildSpec('contour', { length: 40, width: 20, height: 120, param: 0 }, c);
        const r = G.analyzeMesh(M.specToGeometry(THREE, spec).attributes.position.array);
        assert.ok(r.watertight, mode + ' watertight');
        close(r.size[0], 40, 0.6, mode + ' L');
        close(r.size[1], 120, 1e-6, mode + ' H');
        if (mode === 'revolve') close(r.volume, Math.PI * 400 * 120, Math.PI * 400 * 120 * 0.01, 'cylinder volume');
        else close(r.volume, 40 * 120 * 20, 40 * 120 * 20 * 0.01, 'slab volume');
    }
});

test('contour extraction returns null for an empty image', () => {
    assert.equal(G.extractContour(syntheticImage(50, 50, () => false)), null);
});
