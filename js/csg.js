/*
 * Feature-based solids ("csg" spec) built with the Manifold library.
 *
 *   { kind: 'csg', name, features: [feature, ...] }
 *
 * Coordinates are CAD style: millimetres, Z up, origin at the centre of the
 * part's footprint on its bottom face. Features are applied in order:
 * "add" = union, "cut" = subtract. Each feature is one of
 *
 *   prism          closed outline [[u, v], ...] extruded along `axis` from `from` to `to`
 *   cylinder       circle of `diameter` at `center` [u, v], along `axis`, `from`..`to`
 *   regular_prism  regular polygon: `sides`, circumscribed `diameter`, `rotation_deg`, `center`
 *   hull           convex hull of `circles` [{center, diameter}] (wrench arms, links, slots)
 *   revolve        `profile` [[r, z], ...] revolved about a vertical axis through `center` [x, y]
 *
 * The (u, v) plane depends on the axis: z → (x, y), x → (y, z), y → (x, z).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CadCSG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SEGMENTS = 96;
    const MAX_COORD = 5000;
    const MAX_FEATURES = 80;
    const SHAPES = ['prism', 'cylinder', 'regular_prism', 'hull', 'revolve'];

    // ------------------------------------------------------------ validation

    const num = (v, what) => {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`${what} son emas`);
        if (Math.abs(n) > MAX_COORD) throw new Error(`${what} ${MAX_COORD} mm dan katta`);
        return n;
    };

    const pair = (p, what) => {
        const pt = Array.isArray(p) ? p : (p && typeof p === 'object' ? [p.x ?? p.u ?? p.r ?? p.a, p.y ?? p.v ?? p.z ?? p.b] : null);
        if (!pt || pt.length < 2) throw new Error(`${what} [a, b] ko'rinishida bo'lishi kerak`);
        return [num(pt[0], what), num(pt[1], what)];
    };

    function signedArea(pts) {
        let s = 0;
        for (let i = 0; i < pts.length; i++) {
            const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
            s += x0 * y1 - x1 * y0;
        }
        return s / 2;
    }

    function selfIntersects(pts) {
        const n = pts.length;
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const strict = (d1, d2) => (d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9);
        for (let i = 0; i < n; i++) {
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue;
                const a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
                if (strict(cross(c, d, a), cross(c, d, b)) && strict(cross(a, b, c), cross(a, b, d))) return true;
            }
        }
        return false;
    }

    function cleanPolygon(list, what, minPts) {
        if (!Array.isArray(list)) throw new Error(`${what} ro'yxat bo'lishi kerak`);
        const out = [];
        list.forEach((p, i) => {
            const q = pair(p, `${what} ${i + 1}-nuqta`);
            const last = out[out.length - 1];
            if (!last || Math.abs(last[0] - q[0]) > 1e-6 || Math.abs(last[1] - q[1]) > 1e-6) out.push(q);
        });
        if (out.length > 1) {
            const a = out[0], b = out[out.length - 1];
            if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
        }
        if (out.length < minPts) throw new Error(`${what} kamida ${minPts} ta nuqtadan iborat bo'lishi kerak`);
        if (out.length > 4000) throw new Error(`${what} da nuqtalar juda ko'p`);
        if (selfIntersects(out)) throw new Error(`${what} o'zini kesib o'tadi`);
        if (Math.abs(signedArea(out)) < 1e-4) throw new Error(`${what} yuzasi nolga teng`);
        return signedArea(out) < 0 ? out.reverse() : out;   // counter-clockwise
    }

    /** Check and normalise a csg spec. Returns a clean copy; throws Error (Uzbek message). */
    function normalize(spec) {
        const list = spec && spec.features;
        if (!Array.isArray(list) || !list.length) throw new Error("Detalda birorta ham element (features) yo'q");
        if (list.length > MAX_FEATURES) throw new Error(`Elementlar soni ${MAX_FEATURES} tadan oshmasligi kerak`);
        const features = list.map((f, i) => {
            const at = `${i + 1}-element`;
            if (!f || typeof f !== 'object') throw new Error(`${at} obyekt emas`);
            const op = String(f.op || 'add').toLowerCase();
            if (op !== 'add' && op !== 'cut') throw new Error(`${at}: "op" faqat "add" yoki "cut"`);
            const shape = String(f.shape || '').toLowerCase();
            if (!SHAPES.includes(shape)) throw new Error(`${at}: noma'lum shakl "${f.shape}"`);
            const out = { op, shape, label: f.label ? String(f.label).slice(0, 120) : '' };

            if (shape === 'revolve') {
                out.axis = 'z';
                out.center = f.center ? pair(f.center, `${at} center`) : [0, 0];
                const prof = cleanPolygon(f.profile, `${at} profil`, 3);
                if (prof.some(([r]) => r < -1e-9)) throw new Error(`${at}: profil radiusi manfiy`);
                out.profile = prof.map(([r, z]) => [Math.max(0, r), z]);
                return out;
            }

            out.axis = ['x', 'y', 'z'].includes(String(f.axis || 'z').toLowerCase()) ? String(f.axis || 'z').toLowerCase() : null;
            if (!out.axis) throw new Error(`${at}: "axis" faqat x, y yoki z`);
            out.from = num(f.from, `${at} from`);
            out.to = num(f.to, `${at} to`);
            if (out.to < out.from) [out.from, out.to] = [out.to, out.from];
            if (out.to - out.from < 1e-3) throw new Error(`${at}: balandlik (to - from) nolga teng`);

            if (shape === 'prism') {
                out.outline = cleanPolygon(f.outline, `${at} kontur`, 3);
            } else if (shape === 'cylinder' || shape === 'regular_prism') {
                out.center = f.center ? pair(f.center, `${at} center`) : [0, 0];
                let d = Number(f.diameter);
                if (shape === 'regular_prism') {
                    out.sides = Math.round(Number(f.sides));
                    if (!(out.sides >= 3 && out.sides <= 64)) throw new Error(`${at}: tomonlar soni 3..64 bo'lishi kerak`);
                    if (!(d > 0) && Number(f.across_flats) > 0) d = Number(f.across_flats) / Math.cos(Math.PI / out.sides);
                    out.rotation_deg = Number(f.rotation_deg) || 0;
                }
                out.diameter = num(d, `${at} diametr`);
                if (!(out.diameter > 0)) throw new Error(`${at}: diametr musbat bo'lishi kerak`);
            } else if (shape === 'hull') {
                if (!Array.isArray(f.circles) || !f.circles.length) throw new Error(`${at}: "circles" bo'sh`);
                out.circles = f.circles.map((c, k) => {
                    const d = num(c && c.diameter, `${at} ${k + 1}-aylana diametri`);
                    if (!(d > 0)) throw new Error(`${at}: aylana diametri musbat bo'lishi kerak`);
                    return { center: pair(c.center || [0, 0], `${at} ${k + 1}-aylana markazi`), diameter: d };
                });
            }
            return out;
        });
        if (features[0].op !== 'add') throw new Error("Birinchi element \"add\" bo'lishi kerak (avval jism, keyin kesimlar)");
        return { kind: 'csg', name: String(spec.name || 'detal').slice(0, 80), features };
    }

    // -------------------------------------------------------------- building

    /** Outline (u, v) points of a feature's cross-section. */
    function regularPolygon(f) {
        const r = f.diameter / 2, rot = (f.rotation_deg || 0) * Math.PI / 180;
        return Array.from({ length: f.sides }, (_, i) => {
            const a = rot + (i / f.sides) * Math.PI * 2;
            return [f.center[0] + r * Math.cos(a), f.center[1] + r * Math.sin(a)];
        });
    }

    // column-major 4x4: local (u, v, w) extrusion → world, w spanning from..to
    function axisMatrix(axis, from, to) {
        if (axis === 'x') return [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, from, 0, 0, 1];   // (w+from, u, v)
        if (axis === 'y') return [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, to, 0, 1];    // (u, to-w, v)
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, from, 1];                     // (u, v, w+from)
    }

    function featureSolid(wasm, f, trash) {
        const { CrossSection } = wasm;
        const keep = o => (trash.push(o), o);
        if (f.shape === 'revolve') {
            const cs = keep(new CrossSection([f.profile]));
            return keep(keep(cs.revolve(SEGMENTS)).translate([f.center[0], f.center[1], 0]));
        }
        let cs;
        if (f.shape === 'prism') cs = keep(new CrossSection([f.outline]));
        else if (f.shape === 'regular_prism') cs = keep(new CrossSection([regularPolygon(f)]));
        else if (f.shape === 'cylinder') cs = keep(keep(CrossSection.circle(f.diameter / 2, SEGMENTS)).translate(f.center));
        else if (f.shape === 'hull') {
            const parts = f.circles.map(c => keep(keep(CrossSection.circle(c.diameter / 2, SEGMENTS)).translate(c.center)));
            cs = keep(CrossSection.hull(parts));
        }
        const solid = keep(cs.extrude(f.to - f.from));
        return keep(solid.transform(axisMatrix(f.axis, f.from, f.to)));
    }

    /**
     * Build the solid. Returns { positions (Y-up triangle soup for the viewer),
     * volume (mm³), genus, triangles }.
     */
    function build(wasm, spec) {
        const s = normalize(spec);
        const trash = [];
        try {
            let solid = null;
            for (const f of s.features) {
                const part = featureSolid(wasm, f, trash);
                solid = !solid ? part : trash[trash.push(f.op === 'add' ? solid.add(part) : solid.subtract(part)) - 1];
            }
            if (solid.status && solid.status() !== 'NoError' && solid.status().value !== 0) throw new Error('Geometriya xatosi: ' + solid.status());
            if (solid.isEmpty()) throw new Error("Natija bo'sh — kesimlar butun jismni olib tashladi");
            const mesh = solid.getMesh();
            const P = mesh.vertProperties, np = mesh.numProp, T = mesh.triVerts;
            const out = new Float32Array(T.length * 3);
            for (let i = 0; i < T.length; i++) {
                const v = T[i] * np;
                // Z-up (CAD) → Y-up (viewer): (x, y, z) → (x, z, -y)
                out[i * 3] = P[v]; out[i * 3 + 1] = P[v + 2]; out[i * 3 + 2] = -P[v + 1];
            }
            return { positions: out, volume: solid.volume(), genus: solid.genus(), triangles: T.length / 3, spec: s };
        } finally {
            for (const o of trash) { try { o.delete(); } catch (e) { /* already freed */ } }
        }
    }

    return { normalize, build, SHAPES, axisMatrix, regularPolygon };
});
