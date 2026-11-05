/*
 * Free drawing → 3D flow: the user uploads the drawing to claude.ai together
 * with the prompt below, then pastes Claude's JSON answer back into the app.
 * No API key and no server needed. Works in the browser and in Node tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CadDrawing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_COORD = 5000;   // mm
    const MAX_POINTS = 4000;

    const PROMPT = `You are reading a mechanical engineering drawing (ESKD/GOST, ISO or ANSI) that I attached. Turn it into a simple solid model for my CAD app.

The app supports exactly two kinds of part:

1. "revolve" - a body of rotation (shaft, bushing, pin, flange disc, pulley).
   "profile" is the half-section as a closed polygon of [radius, axial_position] points in mm.
   radius >= 0, the axis is radius 0, the part starts at axial position 0.
   Include steps, grooves, chamfers (as straight segments) and axial bores (as an inner radius).
   Start on the axis (or on the bore) and walk around the section once, without crossing itself.

2. "extrude" - a flat plate: "outline" is the plan-view outer contour as [x, y] points in mm,
   centred on the origin, counter-clockwise; approximate arcs and fillets with enough points to look round.
   "thickness" is the plate thickness, "holes" are circular through holes [{"x", "y", "diameter"}].

Rules:
- Use only dimensions written on the drawing. If a dimension is missing and you estimate it from the
  picture, say so in "assumptions" and set "confidence" to "low".
- Respect dimension chains, symmetry, Ø / R / quantity notes (e.g. "4 отв. Ø10", "4x Ø10") and the scale.
- If the part has features these two kinds cannot express (threads, keyways, cross holes, pockets,
  several bodies), model the closest supported shape and list every omitted feature in "assumptions".
- Write "part_name" and "assumptions" in Uzbek (Latin script).

Answer with ONE JSON code block only, exactly in this shape (use [] and 0 for fields the kind does not use):

\`\`\`json
{
  "part_name": "Val",
  "kind": "revolve",
  "profile": [[0, 0], [10, 0], [10, 40], [6, 40], [6, 70], [0, 70]],
  "outline": [],
  "holes": [],
  "thickness": 0,
  "dimensions": [{"label": "Ø20", "value_mm": 20}],
  "assumptions": ["Rezba modelga kiritilmadi"],
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

        if (kind === 'revolve') {
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
            throw new Error(`"kind" faqat "revolve" yoki "extrude" bo'lishi mumkin (keldi: "${r.kind}")`);
        }

        const analysis = {
            part_name: name,
            kind,
            dimensions: Array.isArray(r.dimensions) ? r.dimensions.filter(d => d && d.label != null).slice(0, 200) : [],
            assumptions: Array.isArray(r.assumptions) ? r.assumptions.map(String).slice(0, 100) : [],
            confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'medium'
        };
        return { spec, analysis, warnings };
    }

    return { PROMPT, buildPrompt, extractJSON, parseAnswer, selfIntersects };
});
