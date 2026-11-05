/*
 * Spec → Three.js BufferGeometry. Takes THREE as an argument so it works with
 * the browser global and with require('three') in Node tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CadMesher = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const REVOLVE_SEGMENTS = 96;
    const HOLE_SEGMENTS = 64;

    function specToGeometry(THREE, spec) {
        let geo;
        if (spec.kind === 'revolve') {
            const pts = spec.profile.map(([r, y]) => new THREE.Vector2(r, y));
            const first = pts[0], last = pts[pts.length - 1];
            if (first.x > 1e-9 || last.x > 1e-9) pts.push(first.clone());   // close the loop off-axis
            geo = new THREE.LatheGeometry(pts, REVOLVE_SEGMENTS);
        } else if (spec.kind === 'extrude') {
            const shape = new THREE.Shape(spec.outline.map(([x, y]) => new THREE.Vector2(x, y)));
            for (const h of spec.holes || []) {
                const path = new THREE.Path();
                path.absarc(h.x, h.y, h.r, 0, Math.PI * 2, true);
                shape.holes.push(path);
            }
            geo = new THREE.ExtrudeGeometry(shape, { depth: spec.depth, bevelEnabled: false, curveSegments: HOLE_SEGMENTS });
            if (spec.axis === 'z') geo.translate(0, 0, -spec.depth / 2);
            else geo.rotateX(-Math.PI / 2);   // footprint on the ground, grows along +Y
        } else {
            throw new Error('Unknown spec kind: ' + spec.kind);
        }
        geo = geo.index ? geo.toNonIndexed() : geo;
        orientOutward(geo);
        geo.computeBoundingBox();
        return geo;
    }

    /** Flip triangle winding if the signed volume is negative. */
    function orientOutward(geo) {
        const p = geo.attributes.position.array;
        let vol = 0;
        for (let i = 0; i < p.length; i += 9) {
            vol += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7])
                 - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
                 + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
        }
        if (vol >= 0) return;
        for (let i = 0; i < p.length; i += 9) {
            for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
        }
        geo.attributes.position.needsUpdate = true;
        const n = geo.attributes.normal;
        if (n) {
            const a = n.array;
            for (let i = 0; i < a.length; i += 9) {
                for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
            }
            for (let i = 0; i < a.length; i++) a[i] = -a[i];
            n.needsUpdate = true;
        }
    }

    return { specToGeometry, orientOutward };
});
