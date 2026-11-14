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
    const PROMPT = `You are an expert CAD engineer and mechanical drawing reader (ESKD / GOST, ISO, ANSI standards).
Your job is to read EVERY view (Front, Top, Side, Sections) and all dimension annotations on the attached mechanical engineering drawing, then construct an EXACT, watertight 3D solid model as a sequence of CSG features for a CAD application.

COORDINATES (millimetres):
- X = left-right in the front view (+X right, -X left). Centered at X = 0 for symmetric parts.
- Y = depth / front-to-back in the top view (+Y towards back, -Y towards front). Centered at Y = 0 for symmetric parts.
- Z = height / vertical in the front view (+Z upwards). Z = 0 is ALWAYS the flat bottom seating face of the base plate.

FEATURES (applied in sequential order starting from empty space: "add" = union, "cut" = subtract):
The first feature MUST be an "add" (the main base block).
Every feature extends along "axis" ("z" vertical, "x" or "y" horizontal) from absolute coordinate "from" to "to".
Points [u, v] lie in the plane perpendicular to the axis:
- axis "z" -> [x, y]
- axis "x" -> [y, z]
- axis "y" -> [x, z]

Allowed feature shapes:
- "prism": "outline" = closed polygon [[u, v], ...], no self-crossing.
- "cylinder": "center" [u, v], "diameter".
- "regular_prism": regular polygon with "sides", circumscribed "diameter", "rotation_deg", "center" [u, v].
- "hull": convex hull of "circles" [{"center": [u, v], "diameter": d}, ...].
- "revolve": vertical body of rotation: "profile" = closed half-section [[radius, z], ...] (radius >= 0), around vertical axis at "center" [x, y].

CRITICAL ENGINEERING DRAWING RULES (GOST / ISO):
1. SOLID CONTINUOUS LINES (Asosiy ko'rinadigan chiziqlar) vs DASHED LINES (Shtrix / ko'rinmaydigan chiziqlar):
   - Solid lines represent visible exterior geometric contours.
   - DASHED LINES (Штриховые линии / Shtrix-chiziqlar) ALWAYS represent HIDDEN INTERNAL VOIDS, HOLES, TUNNELS, SLOTS, OR UNDERCUTS!
   - You MUST NOT IGNORE dashed lines! Every dashed line corresponds to an interior "cut" feature!
   - Under-base tunnel rule: If the Front view shows a horizontal dashed line at height H_tunnel (e.g. 10 mm) and the Top view shows two dashed lines across width W_tunnel (e.g. 50 mm), this is an UNDER-BASE TUNNEL / SLOT cut through the bottom face from one end to the other! Model it as an "op": "cut" prism along axis "x" from -length/2-1 to length/2+1 with outline [[-W/2, -1], [W/2, -1], [W/2, H], [-W/2, H]].
   - Vertical dashed lines inside a boss or cylinder indicate an internal hole/bore extending downwards into the part.

2. STIFFENING RIBS (Mustahkamlik qovurg'alari / Ребра жесткости) vs UPRIGHT WALLS:
   - Do NOT turn the main upright walls into sloped troughs!
   - An upright end wall extends across the FULL DEPTH of the part (e.g. from Y = -depth/2 to +depth/2) as a rectangular prism.
   - A stiffening rib is a THIN TRIANGULAR WEB (e.g. thickness 10 mm, centered at Y = 0, from Y = -5 to +5) that braces the inner face of the upright wall down to the base!
   - Model the full-depth upright wall first ("add" prism across full Y), then model the thin triangular rib as a separate "add" prism along axis "y" from -thickness/2 to +thickness/2 with triangular outline in the [X, Z] plane: [[x_wall, z_base], [x_toe, z_base], [x_wall, z_top]].

3. CYLINDERS, HOLES, AND LATERAL WINDOWS:
   - A cylinder boss is an "add" cylinder along axis "z" from base height up to its top height.
   - A central hole through the cylinder is a "cut" prism or cylinder along axis "z" from -1 through to the bottom.
   - A lateral through-window or cross-opening in the cylinder is a "cut" prism along axis "y" spanning from -diameter/2-1 to +diameter/2+1 at the specified Z window height.

4. SYMMETRY & DASH-DOT CENTERLINES (O'q chiziqlari):
   - Centerlines denote bilateral symmetry along X and/or Y. Ensure symmetric walls, ribs, and cutouts mirror symmetrically across the center axis.

5. DIMENSION ACCOUNTING CHECKLIST:
   - Every single dimension number visible on the drawing (e.g. 120, 100, 70, 64, 50, 28, 24, 20, 10) MUST be accounted for by the coordinates and dimensions of your features.
   - Verify that outer bounds match: L (Length/X) x W (Width/Y) x H (Total Height/Z).

6. Uzbek Language:
   - Write "part_name", feature "label"s and "assumptions" in Uzbek (Latin script).

ANSWER FORMAT:
First a few lines of reasoning breaking down the projections and dimensions, followed by ONE JSON code block:

\`\`\`json
{
  "part_name": "Kronshteyn opora",
  "kind": "csg",
  "features": [
    {"op": "add", "shape": "prism", "axis": "z", "from": 0, "to": 20, "outline": [[-60, -35], [60, -35], [60, 35], [-60, 35]], "label": "Asos 120x70x20"},
    {"op": "cut", "shape": "prism", "axis": "x", "from": -61, "to": 61, "outline": [[-25, -1], [25, -1], [25, 10], [-25, 10]], "label": "Ostki tunnel 50x10"},
    {"op": "add", "shape": "prism", "axis": "z", "from": 20, "to": 70, "outline": [[-60, -35], [-50, -35], [-50, 35], [-60, 35]], "label": "Chap tik devor 10x70x50"},
    {"op": "add", "shape": "prism", "axis": "z", "from": 20, "to": 70, "outline": [[50, -35], [60, -35], [60, 35], [50, 35]], "label": "O'ng tik devor 10x70x50"},
    {"op": "add", "shape": "prism", "axis": "y", "from": -5, "to": 5, "outline": [[-50, 20], [-32, 20], [-50, 70]], "label": "Chap qovurg'a 10 mm"},
    {"op": "add", "shape": "prism", "axis": "y", "from": -5, "to": 5, "outline": [[50, 20], [32, 20], [50, 70]], "label": "O'ng qovurg'a 10 mm"},
    {"op": "add", "shape": "cylinder", "axis": "z", "from": 20, "to": 60, "center": [0, 0], "diameter": 50, "label": "Markaziy silindr Ø50"},
    {"op": "cut", "shape": "prism", "axis": "z", "from": -1, "to": 61, "outline": [[-12, -14], [12, -14], [12, 14], [-12, 14]], "label": "Markaziy teshik 24x28"},
    {"op": "cut", "shape": "prism", "axis": "y", "from": -26, "to": 26, "outline": [[-12, 30], [12, 30], [12, 50], [-12, 50]], "label": "Silindr darchasi 24x20"}
  ],
  "dimensions": [
    {"label": "120", "value_mm": 120},
    {"label": "70", "value_mm": 70},
    {"label": "70", "value_mm": 70},
    {"label": "50", "value_mm": 50},
    {"label": "Ø50", "value_mm": 50}
  ],
  "assumptions": ["Barcha o'lchamlar va shtrix chiziqlar to'liq inobatga olindi"],
  "confidence": "high"
}
\`\`\``;

    function buildPrompt(note) {
        note = (note || '').trim();
        return note ? PROMPT + '\n\nNote from me about this drawing: ' + note.slice(0, 2000) : PROMPT;
    }

    /** Pull the JSON object out of a chat answer (handles ```json fences and surrounding text). */
    function extractJSON(text) {
        if (!text || !text.trim()) throw new Error("AI javobi bo'sh — uni to'liq nusxalab qo'ying");
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        let body = fence ? fence[1] : text;
        const start = body.indexOf('{'), end = body.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error("Javobda JSON topilmadi — AI javobini to'liq nusxalang");
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
            if (selfIntersects(profile)) throw new Error("Profil o'zini kesib o'tadi — AI'dan profilni qayta tekshirishni so'rang");
            if (Math.abs(signedArea(profile)) < 1e-3) throw new Error("Profil yuzasi nolga teng — kesim chizilmagan");
            spec = { kind: 'revolve', name, profile: profile.map(([a, b]) => [Math.max(0, a), b]) };
        } else if (kind === 'extrude') {
            let outline = dedupe(toPoints(r.outline || [], 'outline'));
            if (outline.length < 3) throw new Error("Plastina konturida kamida 3 ta nuqta bo'lishi kerak");
            const thickness = Number(r.thickness);
            if (!(thickness > 0) || thickness > MAX_COORD) throw new Error("Plastina qalinligi (thickness) musbat son bo'lishi kerak");
            if (selfIntersects(outline)) throw new Error("Kontur o'zini kesib o'tadi — AI'dan konturni qayta tekshirishni so'rang");
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
