/*
 * Free drawing → 3D flow: the user uploads the drawing to claude.ai together
 * with the prompt below, then pastes Claude's JSON answer back into the app.
 * Answers use the feature-based "csg" spec (js/csg.js); the older single-body
 * "revolve" / "extrude" answers are still accepted.
 * No API key and no server needed. Works in the browser and in Node tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CadDrawing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CSG = typeof module === 'object' && module.exports ? require('./csg.js') : self.CadCSG;
    const MAX_COORD = 5000;   // mm
    const MAX_POINTS = 4000;

    // Single source of truth for the drawing prompt (backend/drawing.py reads it from here).
    const PROMPT = `You are reading a mechanical engineering drawing (ESKD/GOST, ISO or ANSI; orthographic views, sections, maybe an isometric) that I attached. Build the part as a solid model for my CAD app, which assembles the part from simple features.

COORDINATES (millimetres):
- X = left-right in the main (front) view, Y = depth (the vertical direction of the top view, +Y = towards the back), Z = height (up in the front view).
- Origin: the centre of the part's footprint (or its main axis), Z = 0 on the bottom face.

FEATURES are applied in order, starting from nothing: "add" = union, "cut" = subtract. The first feature must be "add".
Every feature extends along "axis" ("z" vertical, "x" or "y" horizontal) from "from" to "to" (absolute coordinates on that axis).
Points [u, v] lie in the plane perpendicular to the axis: axis "z" -> [x, y], axis "x" -> [y, z], axis "y" -> [x, z].
- "prism": "outline" = closed polygon [[u, v], ...], no self-crossing. Approximate arcs and fillets with enough points.
- "cylinder": "center" [u, v], "diameter".
- "regular_prism": regular polygon with "sides", "diameter" = circumscribed (across corners), "rotation_deg" = angle of the first corner from +u, "center".
  A hexagon given across flats S has diameter S / cos(30°). A square □a has diameter a·√2 (rotation 45 = sides parallel to the axes, 0 = diamond).
- "hull": convex hull of "circles" [{"center": [u, v], "diameter": d}, ...] - wrench arms, links, slots, lugs with rounded ends.
- "revolve": vertical body of rotation: "profile" = closed half-section [[radius, z], ...] (radius >= 0), around a vertical axis at "center" [x, y]. Use for shafts, grooves, tapers, stepped bores.

HOW TO WORK:
1. Read EVERY view together: Front view gives (X, Z) width and height; Top view gives (X, Y) width and depth; Left/Side view gives (Y, Z) depth and height. If an isometric/3D view is present, make sure every wall, boss, rib, lug, slot, chamfer and hole in it is included.
2. Build the ENTIRE 3D volume from Z = 0 up to the full height H, not just the bottom base plate. Overlap adjacent "add" features by ~0.1 mm where they touch so they union cleanly into ONE solid body.
3. Use only dimensions written on the drawing; respect dimension chains, symmetry, Ø, R, □, S, "4x Ø10" / "4 отв.", chamfers "2x45°", and the scale.
4. Through cuts go 1 mm beyond both outer faces; blind pockets, slots and recesses MUST stop at their own depth ("from".."to") and MUST NOT split the base into separate disconnected pieces unless the drawing literally shows two parts.
5. Before writing JSON, double-check that the overall X (Length), Y (Width) and Z (Height) bounding box of your "add" features matches the drawing's main dimensions and every feature matches all views.
6. If something is not dimensioned, estimate it carefully from proportions in the drawing, say so in "assumptions" and set "confidence" to "low". Threads are modelled as plain holes/shafts of the nominal diameter; list such simplifications in "assumptions".
7. Write "part_name", "label" and "assumptions" in Uzbek (Latin script).

ANSWER: first a few short lines describing the part, then ONE JSON code block exactly in this shape (omit fields a shape does not use):

\`\`\`json
{
  "part_name": "Silindrli blok",
  "kind": "csg",
  "features": [
    {"op": "add", "shape": "prism", "axis": "z", "from": 0, "to": 20, "outline": [[-40, -30], [40, -30], [40, 30], [-40, 30]], "label": "Asos 80x60x20"},
    {"op": "add", "shape": "cylinder", "axis": "z", "from": 20, "to": 60, "center": [0, 0], "diameter": 44, "label": "Silindr Ø44"},
    {"op": "cut", "shape": "cylinder", "axis": "z", "from": -1, "to": 61, "center": [0, 0], "diameter": 20, "label": "Teshik Ø20"},
    {"op": "cut", "shape": "prism", "axis": "y", "from": -31, "to": 31, "outline": [[30, 21], [41, 21], [41, 10]], "label": "Qiya kesim"}
  ],
  "dimensions": [{"label": "Ø44", "value_mm": 44}],
  "assumptions": ["Faskalar modelga kiritilmadi"],
  "confidence": "high"
}
\`\`\``;

    function buildPrompt(note) {
        note = (note || '').trim();
        return note ? PROMPT + '\n\nNote from me about this drawing: ' + note.slice(0, 2000) : PROMPT;
    }

    /** Pull the JSON object out of a chat answer (handles ```json fences and surrounding text). */
    function extractJSON(text) {
        if (!text || !text.trim()) throw new Error("Claude javobi bo'sh — uni to'liq nusxalab qo'ying");
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        let body = fence ? fence[1] : text;
        const start = body.indexOf('{'), end = body.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error("Javobda JSON topilmadi — Claude javobini to'liq nusxalang");
        body = body.slice(start, end + 1);
        try {
            return JSON.parse(body);
        } catch (e) {
            // tolerate the usual chat artefacts: trailing commas, smart quotes
            const cleaned = body.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1');
            try { return JSON.parse(cleaned); } catch (e2) {
                throw new Error("JSON xato: " + e.message + " — javobni o'zgartirmasdan nusxalang");
            }
        }
    }

    function toPoints(list, name) {
        if (!Array.isArray(list)) throw new Error(`"${name}" ro'yxat bo'lishi kerak`);
        if (list.length > MAX_POINTS) throw new Error(`"${name}" da nuqtalar juda ko'p`);
        return list.map((p, i) => {
            const pt = Array.isArray(p) ? p : (p && typeof p === 'object' ? [p.x ?? p.a ?? p.r, p.y ?? p.b] : null);
            if (!pt || pt.length < 2) throw new Error(`"${name}" ning ${i + 1}-nuqtasi noto'g'ri`);
            const [a, b] = pt.map(Number);
            if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`"${name}" ning ${i + 1}-nuqtasi son emas`);
            if (Math.abs(a) > MAX_COORD || Math.abs(b) > MAX_COORD) throw new Error(`"${name}" ning ${i + 1}-nuqtasi ${MAX_COORD} mm dan katta`);
            return [a, b];
        });
    }

    function dedupe(pts) {
        const out = [];
        for (const p of pts) {
            const q = out[out.length - 1];
            if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) out.push(p);
        }
        if (out.length > 1) {
            const a = out[0], b = out[out.length - 1];
            if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
        }
        return out;
    }

    function signedArea(pts) {
        let s = 0;
        for (let i = 0; i < pts.length; i++) {
            const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
            s += x0 * y1 - x1 * y0;
        }
        return s / 2;
    }

    /** True if two non-adjacent edges of the closed polygon cross. */
    function selfIntersects(pts) {
        const n = pts.length;
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const hit = (p1, p2, p3, p4) => {
            const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
            return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
        };
        for (let i = 0; i < n; i++) {
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue;
                if (hit(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
            }
        }
        return false;
    }

    function pointInPolygon(x, y, pts) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const [xi, yi] = pts[i], [xj, yj] = pts[j];
            if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    /** Claude's answer (text or object) → { spec, analysis, warnings }. Throws Error with an Uzbek message. */
    function parseAnswer(answer) {
        const r = typeof answer === 'string' ? extractJSON(answer) : answer;
        if (!r || typeof r !== 'object') throw new Error("Javob JSON obyekt emas");
        const kind = String(r.kind || '').toLowerCase();
        const name = String(r.part_name || 'chizma').slice(0, 80);
        const warnings = [];
        let spec;

        if (kind === 'csg' || (!kind && Array.isArray(r.features))) {
            spec = CSG.normalize({ name, features: r.features });
        } else if (kind === 'revolve') {
            const profile = dedupe(toPoints(r.profile || [], 'profile'));
            if (profile.length < 3) throw new Error("Aylanma profilda kamida 3 ta nuqta bo'lishi kerak");
            if (profile.some(([rad]) => rad < -1e-9)) throw new Error("Profil radiusi manfiy bo'lishi mumkin emas");
            if (selfIntersects(profile)) throw new Error("Profil o'zini kesib o'tadi — Claude'dan profilni qayta tekshirishni so'rang");
            if (Math.abs(signedArea(profile)) < 1e-3) throw new Error("Profil yuzasi nolga teng — kesim chizilmagan");
            spec = { kind: 'revolve', name, profile: profile.map(([a, b]) => [Math.max(0, a), b]) };
        } else if (kind === 'extrude') {
            let outline = dedupe(toPoints(r.outline || [], 'outline'));
            if (outline.length < 3) throw new Error("Plastina konturida kamida 3 ta nuqta bo'lishi kerak");
            const thickness = Number(r.thickness);
            if (!(thickness > 0) || thickness > MAX_COORD) throw new Error("Plastina qalinligi (thickness) musbat son bo'lishi kerak");
            if (selfIntersects(outline)) throw new Error("Kontur o'zini kesib o'tadi — Claude'dan konturni qayta tekshirishni so'rang");
            if (Math.abs(signedArea(outline)) < 1e-3) throw new Error("Kontur yuzasi nolga teng");
            if (signedArea(outline) < 0) outline = outline.slice().reverse();
            const holes = [];
            for (const [i, h] of (Array.isArray(r.holes) ? r.holes : []).entries()) {
                const x = Number(h && h.x), y = Number(h && h.y), d = Number(h && (h.diameter ?? (h.r != null ? h.r * 2 : NaN)));
                if (![x, y, d].every(Number.isFinite) || d <= 0) { warnings.push(`${i + 1}-teshik noto'g'ri — tashlab ketildi`); continue; }
                if (!pointInPolygon(x, y, outline)) { warnings.push(`${i + 1}-teshik (${x}, ${y}) kontur tashqarisida — tashlab ketildi`); continue; }
                holes.push({ x, y, r: d / 2 });
            }
            spec = { kind: 'extrude', name, axis: 'y', depth: thickness, outline, holes };
        } else {
            throw new Error(`"kind" "csg" bo'lishi kerak (keldi: "${r.kind}")`);
        }

        const analysis = {
            part_name: name,
            kind,
            dimensions: Array.isArray(r.dimensions) ? r.dimensions.filter(d => d && d.label != null).slice(0, 200) : [],
            assumptions: Array.isArray(r.assumptions) ? r.assumptions.map(String).slice(0, 100) : [],
            confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'medium'
        };
        if (spec.kind === 'csg') {
            const zSpan = estimateCsgZSpan(spec.features);
            const hDim = analysis.dimensions.find(d => /(baland|umumiy balandlik|height|^h$)/i.test(String(d.label || '')) && Number(d.value_mm) > 0);
            if (hDim && zSpan > 0 && zSpan < Number(hDim.value_mm) * 0.65) {
                warnings.push(`Diqqat: chizmada ko'rsatilgan balandlik (~${hDim.value_mm} mm) bilan yasalgan model balandligi (${Math.round(zSpan)} mm) mos kelmadi — yuqori qismlar tushib qolgan bo'lishi mumkin.`);
            }
        }
        return { spec, analysis, warnings };
    }

    function estimateCsgZSpan(features) {
        let minZ = Infinity, maxZ = -Infinity;
        for (const f of features || []) {
            if (f.op !== 'add') continue;
            if (f.shape === 'revolve') {
                for (const [, z] of f.profile || []) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
            } else if (f.axis === 'z') {
                minZ = Math.min(minZ, f.from); maxZ = Math.max(maxZ, f.to);
            } else if (f.axis === 'x' || f.axis === 'y') {
                const pts = f.outline || (f.circles || []).flatMap(c => [[c.center[0], c.center[1] - c.diameter / 2], [c.center[0], c.center[1] + c.diameter / 2]]);
                for (const [, v] of pts || []) { minZ = Math.min(minZ, v); maxZ = Math.max(maxZ, v); }
                if (f.shape === 'cylinder' || f.shape === 'regular_prism') {
                    const rad = (f.diameter || 0) / 2;
                    minZ = Math.min(minZ, f.center[1] - rad); maxZ = Math.max(maxZ, f.center[1] + rad);
                }
            }
        }
        return Number.isFinite(minZ) && maxZ > minZ ? maxZ - minZ : 0;
    }

    return { PROMPT, buildPrompt, extractJSON, parseAnswer, selfIntersects };
});
