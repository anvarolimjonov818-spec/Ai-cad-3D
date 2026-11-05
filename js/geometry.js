/*
 * AI-CAD 3D — geometry core.
 *
 * Pure functions with no DOM or Three.js dependency, so the same code runs in
 * the browser (window.CadGeo) and in Node tests (require('./geometry.js')).
 *
 * A model is described by a "spec" that both the browser (Three.js) and the
 * backend (CadQuery → STEP) turn into the same solid, in millimetres:
 *
 *   { kind: 'revolve', profile: [[r, y], ...] }
 *       Closed profile in the (radius, height) half-plane, revolved 360° about
 *       the Y axis. Points on the axis have r = 0.
 *
 *   { kind: 'extrude', outline: [[x, y], ...], holes: [{x, y, r}], depth, axis }
 *       Closed outline extruded by `depth`. axis 'y': outline is the footprint
 *       (x, -z) and the part grows upward from y = 0. axis 'z': outline is the
 *       front silhouette (x, y) and the part is centred on z = 0.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CadGeo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MIN_WALL = 1.2;     // mm, minimum printable wall (spec §4, row 5)
    const MAX_DIM = 2000;     // mm
    const ARC_SEGMENTS = 12;  // segments per rounded corner

    // ------------------------------------------------------------------ presets

    const PRESETS = {
        spray_bottle: { label: 'Sprey / Ballon', param: 'Qopqoq radiusi (r)', revolve: true },
        bevel_box:    { label: 'Quti / Korpus',  param: 'Burchak radiusi (r)' },
        flange:       { label: 'Flanes / Plastina', param: 'Teshik diametri (Ø)' },
        tube:         { label: 'Vtulka / Quvur', param: 'Ichki diametr (Ø)', revolve: true },
        contour:      { label: 'Rasm konturi',   param: null },
        drawing:      { label: 'Chizma (AI)',    param: null }
    };

    function roundedRect(l, w, r) {
        const l2 = l / 2, w2 = w / 2;
        r = Math.max(0, Math.min(r, l2 - 1e-6, w2 - 1e-6));
        if (r < 1e-3) return [[-l2, -w2], [l2, -w2], [l2, w2], [-l2, w2]];
        const pts = [];
        const corners = [[l2 - r, -w2 + r, -Math.PI / 2], [l2 - r, w2 - r, 0],
                         [-l2 + r, w2 - r, Math.PI / 2], [-l2 + r, -w2 + r, Math.PI]];
        for (const [cx, cy, a0] of corners) {
            for (let i = 0; i <= ARC_SEGMENTS; i++) {
                const a = a0 + (i / ARC_SEGMENTS) * (Math.PI / 2);
                pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
            }
        }
        return pts;
    }

    function bottleProfile(d, h, capR) {
        const R = d / 2;
        capR = Math.max(1, Math.min(capR, R));
        const c = Math.min(R * 0.08, h * 0.03);         // bottom chamfer
        const bodyTop = h * 0.70, neckY = h * 0.80;
        const neckR = Math.max(capR * 0.85, Math.min(R * 0.45, capR));
        const pts = [[0, 0], [R - c, 0], [R, c], [R, bodyTop]];
        const steps = 10;                                // curved shoulder
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const ease = 1 - Math.pow(1 - t, 2);
            pts.push([R + (neckR - R) * ease, bodyTop + (neckY - bodyTop) * t]);
        }
        const capBottom = neckY + (h - neckY) * 0.15;
        const fillet = Math.min(2, capR * 0.2, (h - capBottom) * 0.2);
        pts.push([neckR, capBottom], [capR, capBottom], [capR, h - fillet], [capR - fillet, h], [0, h]);
        return dedupe(pts);
    }

    /** Build a spec from a preset and the four user dimensions. */
    function buildSpec(type, dims, contour) {
        const { length: L, width: W, height: H, param: P } = dims;
        switch (type) {
            case 'spray_bottle':
                return { kind: 'revolve', profile: bottleProfile(L, H, P) };
            case 'tube': {
                const R = L / 2, ri = Math.max(0, P / 2);
                const profile = ri > 0 ? [[ri, 0], [R, 0], [R, H], [ri, H]] : [[0, 0], [R, 0], [R, H], [0, H]];
                return { kind: 'revolve', profile };
            }
            case 'flange':
                return { kind: 'extrude', axis: 'y', depth: H,
                         outline: roundedRect(L, W, Math.min(L, W) * 0.15),
                         holes: P > 0 ? [{ x: 0, y: 0, r: P / 2 }] : [] };
            case 'contour':
                if (!contour) throw new Error('Kontur topilmadi: avval rasm yuklang');
                return contour.mode === 'extrude'
                    ? { kind: 'extrude', axis: 'z', depth: W, outline: outlineFromContour(contour, L, H), holes: [] }
                    : { kind: 'revolve', profile: profileFromContour(contour, L, H) };
            case 'bevel_box':
            default:
                return { kind: 'extrude', axis: 'y', depth: H, outline: roundedRect(L, W, P), holes: [] };
        }
    }

    /** Input Validation Engine (spec §4 row 2 and row 5). */
    function validate(type, dims) {
        const errors = [], warnings = [];
        const { length: L, width: W, height: H, param: P } = dims;
        const named = { 'Uzunlik (L)': L, 'Chuqurlik (W)': W, 'Balandlik (H)': H };
        for (const [name, v] of Object.entries(named)) {
            if (!(v > 0)) errors.push(`${name} musbat son bo'lishi kerak`);
            else if (v > MAX_DIM) errors.push(`${name} ${MAX_DIM} mm dan oshmasligi kerak`);
        }
        if (!(P >= 0)) errors.push("4-parametr manfiy bo'lishi mumkin emas");
        if (errors.length) return { errors, warnings };

        const minSide = Math.min(L, W);
        if (type === 'spray_bottle') {
            if (P > L / 2) errors.push(`Qopqoq radiusi (${P} mm) idish radiusidan (${L / 2} mm) katta`);
            if (H < L) warnings.push("Balandlik diametrdan kichik — idish juda past chiqadi");
        } else if (type === 'bevel_box') {
            if (P >= minSide / 2) errors.push(`Burchak radiusi ${(minSide / 2).toFixed(1)} mm dan kichik bo'lishi kerak`);
        } else if (type === 'flange') {
            if (P >= minSide) errors.push(`Teshik diametri (${P} mm) detal o'lchamidan (${minSide} mm) katta yoki teng — teshik o'lchami ob'ektga mos emas`);
            else if (P > 0 && (minSide - P) / 2 < MIN_WALL) errors.push(`Teshik atrofidagi devor ${((minSide - P) / 2).toFixed(2)} mm — kamida ${MIN_WALL} mm bo'lishi kerak`);
        } else if (type === 'tube') {
            if (P >= L) errors.push(`Ichki diametr (${P} mm) tashqi diametrdan (${L} mm) katta yoki teng`);
            else if (P > 0 && (L - P) / 2 < MIN_WALL) errors.push(`Quvur devori ${((L - P) / 2).toFixed(2)} mm — kamida ${MIN_WALL} mm bo'lishi kerak`);
        }
        if (Math.min(L, W, H) < MIN_WALL) warnings.push(`Eng kichik o'lcham ${MIN_WALL} mm dan kam — 3D printerda chiqmasligi mumkin`);
        return { errors, warnings };
    }

    // ---------------------------------------------------------------- contours

    /**
     * Extract an object silhouette from RGBA pixels.
     * Background colour = median of the border pixels; foreground = pixels whose
     * colour differs by more than `threshold`. Only the largest connected
     * component is kept and its interior holes are filled.
     * Returns { width, height, mask, rows: [{y, left, right}], bbox } or null.
     */
    function extractContour(img, opts) {
        opts = Object.assign({ threshold: 40 }, opts);
        const { width: w, height: h, data } = img;
        const n = w * h;

        // 1. background colour from border pixels (per-channel median)
        const border = [[], [], []];
        const pushPx = (x, y) => { const i = (y * w + x) * 4; border[0].push(data[i]); border[1].push(data[i + 1]); border[2].push(data[i + 2]); };
        for (let x = 0; x < w; x++) { pushPx(x, 0); pushPx(x, h - 1); }
        for (let y = 1; y < h - 1; y++) { pushPx(0, y); pushPx(w - 1, y); }
        const bg = border.map(ch => { ch.sort((a, b) => a - b); return ch[ch.length >> 1]; });

        // 2. threshold (transparent pixels are background)
        const thr2 = opts.threshold * opts.threshold;
        let mask = new Uint8Array(n);
        for (let p = 0; p < n; p++) {
            const i = p * 4;
            if (data[i + 3] < 128) continue;
            const dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2];
            if (dr * dr + dg * dg + db * db > thr2) mask[p] = 1;
        }

        // 3. keep the largest 4-connected component
        const label = new Int32Array(n).fill(-1);
        const stack = new Int32Array(n);
        let best = -1, bestSize = 0, comp = 0;
        for (let s = 0; s < n; s++) {
            if (!mask[s] || label[s] !== -1) continue;
            let top = 0, size = 0;
            stack[top++] = s; label[s] = comp;
            while (top) {
                const p = stack[--top]; size++;
                const x = p % w, y = (p / w) | 0;
                if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = comp; stack[top++] = p - 1; }
                if (x < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = comp; stack[top++] = p + 1; }
                if (y > 0 && mask[p - w] && label[p - w] === -1) { label[p - w] = comp; stack[top++] = p - w; }
                if (y < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = comp; stack[top++] = p + w; }
            }
            if (size > bestSize) { bestSize = size; best = comp; }
            comp++;
        }
        if (best < 0 || bestSize < Math.max(50, n * 0.002)) return null;
        for (let p = 0; p < n; p++) mask[p] = label[p] === best ? 1 : 0;

        // 4. fill interior holes: flood the background from the border
        const outside = new Uint8Array(n);
        let top = 0;
        const seed = p => { if (!mask[p] && !outside[p]) { outside[p] = 1; stack[top++] = p; } };
        for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
        for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
        while (top) {
            const p = stack[--top];
            const x = p % w, y = (p / w) | 0;
            if (x > 0) seed(p - 1);
            if (x < w - 1) seed(p + 1);
            if (y > 0) seed(p - w);
            if (y < h - 1) seed(p + w);
        }
        for (let p = 0; p < n; p++) mask[p] = outside[p] ? 0 : 1;

        // 5. per-row extents
        const rows = [];
        let minX = w, maxX = -1;
        for (let y = 0; y < h; y++) {
            let left = -1, right = -1;
            for (let x = 0; x < w; x++) if (mask[y * w + x]) { left = x; break; }
            if (left < 0) continue;
            for (let x = w - 1; x >= left; x--) if (mask[y * w + x]) { right = x + 1; break; }
            rows.push({ y, left, right });
            if (left < minX) minX = left;
            if (right > maxX) maxX = right;
        }
        const bbox = { minX, maxX, minY: rows[0].y, maxY: rows[rows.length - 1].y + 1 };
        return { width: w, height: h, mask, rows, bbox, background: bg };
    }

    /**
     * Heuristic: does this image look like a technical drawing (line art on a
     * white sheet) rather than a photo of an object? Drawings are mostly light
     * paper with a small share of thin dark lines; object photos have a large
     * dark/coloured area.
     */
    function looksLikeDrawing(img) {
        const { data } = img;
        const n = data.length / 4;
        let light = 0, dark = 0;
        for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum > 170) light++;
            else if (lum < 110) dark++;
        }
        return light / n > 0.55 && dark / n > 0.005 && dark / n < 0.2;
    }

    /** Resample contour rows to `samples` evenly spaced, lightly smoothed rows (bottom → top). */
    function sampleRows(contour, samples) {
        samples = samples || 64;
        const { rows, bbox } = contour;
        const span = bbox.maxY - bbox.minY;
        const byY = new Map(rows.map(r => [r.y, r]));
        const out = [];
        for (let i = 0; i <= samples; i++) {
            // image y grows downward; t = 0 is the bottom of the object
            const t = i / samples;
            const yImg = Math.min(bbox.maxY - 1, Math.max(bbox.minY, Math.round(bbox.maxY - 1 - t * (span - 1))));
            // average over a small window for smoothing
            let l = 0, r = 0, k = 0;
            for (let d = -2; d <= 2; d++) {
                const row = byY.get(yImg + d);
                if (row) { l += row.left; r += row.right; k++; }
            }
            if (!k) continue;
            out.push({ t, left: l / k, right: r / k });
        }
        return out;
    }

    /** Revolve profile: radius = half the silhouette width per row, scaled to mm. */
    function profileFromContour(contour, lengthMm, heightMm) {
        const { bbox } = contour;
        const sx = lengthMm / (bbox.maxX - bbox.minX);
        const pts = [[0, 0]];
        for (const s of sampleRows(contour)) {
            const r = Math.max(0.5, ((s.right - s.left) / 2) * sx);
            pts.push([r, s.t * heightMm]);
        }
        pts.push([0, heightMm]);
        return dedupe(pts);
    }

    /** Extrude outline: left edge bottom→top, then right edge top→bottom (counter-clockwise). */
    function outlineFromContour(contour, lengthMm, heightMm) {
        const { bbox } = contour;
        const sx = lengthMm / (bbox.maxX - bbox.minX);
        const cx = (bbox.maxX + bbox.minX) / 2;
        const rows = sampleRows(contour);
        const right = rows.map(s => [(s.right - cx) * sx, s.t * heightMm]);
        const left = rows.map(s => [(s.left - cx) * sx, s.t * heightMm]).reverse();
        return dedupe(right.concat(left));
    }

    function dedupe(pts) {
        const out = [];
        for (const p of pts) {
            const q = out[out.length - 1];
            if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) out.push([+p[0].toFixed(4), +p[1].toFixed(4)]);
        }
        const a = out[0], b = out[out.length - 1];
        if (out.length > 1 && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
        return out;
    }

    // ------------------------------------------------------------ mesh analysis

    /** Weld a triangle soup (flat xyz array, 9 floats per triangle) into vertices + indices. */
    function weld(positions, eps) {
        eps = eps || 1e-4;
        const map = new Map();
        const verts = [];
        const triCount = positions.length / 9;
        const idx = new Uint32Array(triCount * 3);
        for (let v = 0; v < triCount * 3; v++) {
            const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
            const key = Math.round(x / eps) + ',' + Math.round(y / eps) + ',' + Math.round(z / eps);
            let id = map.get(key);
            if (id === undefined) { id = verts.length / 3; map.set(key, id); verts.push(x, y, z); }
            idx[v] = id;
        }
        return { vertices: new Float64Array(verts), indices: idx };
    }

    function triArea(V, a, b, c) {
        const ux = V[b * 3] - V[a * 3], uy = V[b * 3 + 1] - V[a * 3 + 1], uz = V[b * 3 + 2] - V[a * 3 + 2];
        const vx = V[c * 3] - V[a * 3], vy = V[c * 3 + 1] - V[a * 3 + 1], vz = V[c * 3 + 2] - V[a * 3 + 2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    }

    function signedVolume(V, I) {
        let vol = 0;
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            vol += (V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1])
                  - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c])
                  + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c])) / 6;
        }
        return vol;
    }

    function edgeMap(I) {
        const edges = new Map();  // undirected key -> list of [tri, from, to]
        for (let t = 0; t < I.length / 3; t++) {
            for (let k = 0; k < 3; k++) {
                const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3];
                const key = a < b ? a + '_' + b : b + '_' + a;
                let list = edges.get(key);
                if (!list) edges.set(key, list = []);
                list.push([t, a, b]);
            }
        }
        return edges;
    }

    function analyzeIndexed(V, I) {
        const edges = edgeMap(I);
        let boundary = 0, nonManifold = 0, flipped = 0;
        for (const list of edges.values()) {
            if (list.length === 1) boundary++;
            else if (list.length > 2) nonManifold++;
            else if (list[0][1] === list[1][1]) flipped++;   // same direction → inconsistent winding
        }
        let area = 0;
        for (let t = 0; t < I.length; t += 3) area += triArea(V, I[t], I[t + 1], I[t + 2]);
        const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) {
            if (V[i + k] < bbox.min[k]) bbox.min[k] = V[i + k];
            if (V[i + k] > bbox.max[k]) bbox.max[k] = V[i + k];
        }
        const vol = signedVolume(V, I);
        return {
            triangles: I.length / 3,
            vertices: V.length / 3,
            boundaryEdges: boundary,
            nonManifoldEdges: nonManifold,
            inconsistentEdges: flipped,
            watertight: boundary === 0 && nonManifold === 0 && flipped === 0,
            volume: Math.abs(vol),          // mm³
            invertedNormals: vol < 0,
            area,                           // mm²
            bbox,
            size: bbox.max.map((m, k) => m - bbox.min[k])
        };
    }

    /** Analyse a triangle soup. */
    function analyzeMesh(positions) {
        const { vertices, indices } = weld(positions);
        return analyzeIndexed(vertices, cleanIndices(vertices, indices).indices);
    }

    function cleanIndices(V, I) {
        const out = [];
        const seen = new Set();
        let degenerate = 0, duplicate = 0;
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t], b = I[t + 1], c = I[t + 2];
            if (a === b || b === c || a === c || triArea(V, a, b, c) < 1e-10) { degenerate++; continue; }
            const key = [a, b, c].sort((x, y) => x - y).join('_');
            if (seen.has(key)) { duplicate++; continue; }
            seen.add(key);
            out.push(a, b, c);
        }
        return { indices: Uint32Array.from(out), degenerate, duplicate };
    }

    /**
     * Watertight auto-repair (FR-5.2): weld, drop degenerate/duplicate faces,
     * make winding consistent, fill boundary loops, orient normals outward.
     * Returns { positions: Float32Array soup, report, log: [string] }.
     */
    function repairMesh(positions) {
        const log = [];
        const welded = weld(positions);
        let V = Array.from(welded.vertices);
        const cleaned = cleanIndices(welded.vertices, welded.indices);
        let I = Array.from(cleaned.indices);
        if (cleaned.degenerate) log.push(`${cleaned.degenerate} ta degenerat uchburchak olib tashlandi`);
        if (cleaned.duplicate) log.push(`${cleaned.duplicate} ta takroriy uchburchak olib tashlandi`);

        // consistent winding via BFS over shared edges
        const triCount = I.length / 3;
        const edges = edgeMap(I);
        const visited = new Uint8Array(triCount);
        let flips = 0;
        for (let s = 0; s < triCount; s++) {
            if (visited[s]) continue;
            visited[s] = 1;
            const queue = [s];
            while (queue.length) {
                const t = queue.pop();
                for (let k = 0; k < 3; k++) {
                    const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3];
                    const list = edges.get(a < b ? a + '_' + b : b + '_' + a);
                    if (list.length !== 2) continue;
                    const other = list[0][0] === t ? list[1][0] : list[0][0];
                    if (visited[other]) continue;
                    visited[other] = 1;
                    // neighbour must traverse the edge b→a
                    let sameDir = false;
                    for (let j = 0; j < 3; j++) if (I[other * 3 + j] === a && I[other * 3 + (j + 1) % 3] === b) sameDir = true;
                    if (sameDir) { const tmp = I[other * 3 + 1]; I[other * 3 + 1] = I[other * 3 + 2]; I[other * 3 + 2] = tmp; flips++; }
                    queue.push(other);
                }
            }
        }
        if (flips) log.push(`${flips} ta uchburchak yo'nalishi moslashtirildi`);

        // fill boundary loops with a centroid fan
        // boundary edge a→b of a face is closed by a new face using b→a
        const outgoing = new Map();   // vertex -> [next vertices]
        let remaining = 0;
        for (const list of edgeMap(I).values()) {
            if (list.length !== 1) continue;
            const from = list[0][2], to = list[0][1];
            if (!outgoing.has(from)) outgoing.set(from, []);
            outgoing.get(from).push(to);
            remaining++;
        }
        let holes = 0;
        const fill = loop => {
            if (loop.length < 3) return;
            let cx = 0, cy = 0, cz = 0;
            for (const v of loop) { cx += V[v * 3]; cy += V[v * 3 + 1]; cz += V[v * 3 + 2]; }
            const c = V.length / 3;
            V.push(cx / loop.length, cy / loop.length, cz / loop.length);
            for (let i = 0; i < loop.length; i++) I.push(loop[i], loop[(i + 1) % loop.length], c);
            holes++;
        };
        while (remaining) {
            let start;
            for (const [v, nexts] of outgoing) { if (nexts.length) { start = v; break; } }
            // walk until we return to a vertex already on the path; that closes one
            // simple loop (pinched holes that touch at a vertex become separate loops)
            const path = [start];
            const pos = new Map([[start, 0]]);
            let cur = start;
            while (true) {
                const nexts = outgoing.get(cur);
                if (!nexts || !nexts.length) break;      // open chain: cannot close
                const next = nexts.pop();
                remaining--;
                if (pos.has(next)) {
                    const tail = path.splice(pos.get(next) + 1);   // `next` stays on the path
                    tail.forEach(v => pos.delete(v));
                    fill([next].concat(tail));
                    cur = next;
                    continue;
                }
                pos.set(next, path.length);
                path.push(next);
                cur = next;
            }
        }
        if (holes) log.push(`${holes} ta ochiq teshik (boundary loop) yopildi`);

        if (signedVolume(V, I) < 0) {
            for (let t = 0; t < I.length; t += 3) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; }
            log.push('Normallar tashqariga burildi');
        }
        if (!log.length) log.push('Model toza — tuzatish talab qilinmadi');

        const out = new Float32Array(I.length * 3);
        for (let i = 0; i < I.length; i++) {
            out[i * 3] = V[I[i] * 3]; out[i * 3 + 1] = V[I[i] * 3 + 1]; out[i * 3 + 2] = V[I[i] * 3 + 2];
        }
        return { positions: out, report: analyzeIndexed(Float64Array.from(V), Uint32Array.from(I)), log };
    }

    // ----------------------------------------------------------------- writers

    function faceNormal(p, t) {
        const o = t * 9;
        const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
        const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        return [nx / len, ny / len, nz / len];
    }

    /** Binary STL (little-endian), millimetres, Z-up (CAD/slicer convention). */
    function toBinarySTL(positions, name) {
        const p = toZUp(positions);
        const tris = p.length / 9;
        const buf = new ArrayBuffer(84 + tris * 50);
        const dv = new DataView(buf);
        const header = ('AI-CAD 3D ' + (name || 'model') + ' units=mm').slice(0, 80);
        for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
        dv.setUint32(80, tris, true);
        let o = 84;
        for (let t = 0; t < tris; t++) {
            const n = faceNormal(p, t);
            for (let k = 0; k < 3; k++, o += 4) dv.setFloat32(o, n[k], true);
            for (let k = 0; k < 9; k++, o += 4) dv.setFloat32(o, p[t * 9 + k], true);
            o += 2;
        }
        return buf;
    }

    /** Wavefront OBJ with shared vertices, millimetres, Y-up (web/AR convention). */
    function toOBJ(positions, name) {
        const { vertices: V, indices: I } = weld(positions);
        const lines = ['# AI-CAD 3D export, units: mm', 'o ' + (name || 'model')];
        for (let i = 0; i < V.length; i += 3) lines.push(`v ${+V[i].toFixed(5)} ${+V[i + 1].toFixed(5)} ${+V[i + 2].toFixed(5)}`);
        for (let t = 0; t < I.length; t += 3) lines.push(`f ${I[t] + 1} ${I[t + 1] + 1} ${I[t + 2] + 1}`);
        return lines.join('\n') + '\n';
    }

    /** Y-up (viewer) → Z-up (CAD): (x, y, z) → (x, -z, y). Keeps handedness. */
    function toZUp(positions) {
        const out = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 3) {
            out[i] = positions[i]; out[i + 1] = -positions[i + 2]; out[i + 2] = positions[i + 1];
        }
        return out;
    }

    /** Parse binary or ASCII STL into a triangle soup (Z-up file → Y-up viewer). */
    function parseSTL(buffer) {
        const bytes = new Uint8Array(buffer);
        let soup;
        const dv = new DataView(buffer);
        const isBinary = bytes.length >= 84 && 84 + dv.getUint32(80, true) * 50 === bytes.length;
        if (isBinary) {
            const tris = dv.getUint32(80, true);
            soup = new Float32Array(tris * 9);
            for (let t = 0; t < tris; t++) for (let k = 0; k < 9; k++) soup[t * 9 + k] = dv.getFloat32(84 + t * 50 + 12 + k * 4, true);
        } else {
            const text = new TextDecoder().decode(bytes);
            const nums = [];
            const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
            let m;
            while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
            if (!nums.length || nums.length % 9) throw new Error("STL fayl noto'g'ri yoki bo'sh");
            soup = Float32Array.from(nums);
        }
        const out = new Float32Array(soup.length);
        for (let i = 0; i < soup.length; i += 3) { out[i] = soup[i]; out[i + 1] = soup[i + 2]; out[i + 2] = -soup[i + 1]; }
        return out;
    }

    return {
        MIN_WALL, PRESETS,
        buildSpec, validate, roundedRect, bottleProfile,
        extractContour, looksLikeDrawing, profileFromContour, outlineFromContour,
        weld, analyzeMesh, repairMesh, signedVolume,
        toBinarySTL, toOBJ, toZUp, parseSTL
    };
});
