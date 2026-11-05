"""Engineering drawing (image / PDF) -> part spec, using Claude vision.

Claude reads the views and dimensions on the drawing and returns a spec in the
same format the browser and CadQuery use (see js/geometry.js). The spec is then
validated by building the real solid before it is sent back to the browser.
"""
from __future__ import annotations

import base64
import json
import os
from typing import Any

try:
    import anthropic
except ImportError:  # optional dependency
    anthropic = None

MODEL = os.environ.get("AICAD_MODEL", "claude-opus-5-5")
MAX_BYTES = 20 * 1024 * 1024
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}

_POINT = {
    "type": "object",
    "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
    "required": ["a", "b"],
    "additionalProperties": False,
}

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "part_name": {"type": "string", "description": "Short name of the part, e.g. 'Flanes', 'Val', 'Vtulka'."},
        "kind": {"type": "string", "enum": ["revolve", "extrude"]},
        "profile": {
            "type": "array", "items": _POINT,
            "description": "revolve only: closed half-section polygon, a = radius (>= 0), b = axial position, mm. Empty for extrude.",
        },
        "outline": {
            "type": "array", "items": _POINT,
            "description": "extrude only: closed outer contour of the plan view, a = x, b = y, mm, centred on the origin. Empty for revolve.",
        },
        "holes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"x": {"type": "number"}, "y": {"type": "number"}, "diameter": {"type": "number"}},
                "required": ["x", "y", "diameter"],
                "additionalProperties": False,
            },
            "description": "extrude only: through holes in the same plan-view coordinates.",
        },
        "thickness": {"type": "number", "description": "extrude only: plate thickness in mm (0 for revolve)."},
        "dimensions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"label": {"type": "string"}, "value_mm": {"type": "number"}},
                "required": ["label", "value_mm"],
                "additionalProperties": False,
            },
            "description": "Every dimension read from the drawing that was used.",
        },
        "assumptions": {
            "type": "array", "items": {"type": "string"},
            "description": "Anything assumed, guessed, simplified or left out (chamfers, threads, cross holes...).",
        },
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["part_name", "kind", "profile", "outline", "holes", "thickness", "dimensions", "assumptions", "confidence"],
    "additionalProperties": False,
}

SYSTEM = """You read mechanical engineering drawings (ESKD/GOST, ISO or ANSI) and turn them into a simple solid model.

The modeller supports exactly two kinds of part:
1. revolve - a body of rotation (shaft, bushing, pin, flange disc, pulley, nut blank). Give the half-section as a
   closed polygon of (radius, axial position) points in mm: radius >= 0, the axis is radius 0, the part starts at
   axial position 0. Include steps, grooves, chamfers (as straight segments) and axial bores (an inner radius).
   Start the polygon on the axis or on the bore and walk around the section once without crossing itself.
2. extrude - a prismatic plate: the plan-view outer contour (x, y in mm, centred on the origin, counter-clockwise,
   arcs and fillets approximated with enough points to look round) extruded by `thickness`, with circular through
   holes at (x, y) with their diameter.

Rules:
- Use only dimensions written on the drawing. Do not measure pixels unless a dimension is missing, and then say
  so in `assumptions` and set confidence to low.
- Respect dimension chains, symmetry, Ø/R/× (e.g. "4 отв. Ø10", "4x Ø10") and the scale note.
- If the part has features the two kinds cannot express (threads, keyways, cross holes, pockets, several bodies),
  model the closest supported shape and list every omitted feature in `assumptions`.
- Fill the unused fields with empty arrays and thickness 0.
- Write `part_name` and `assumptions` in Uzbek (Latin script)."""


class DrawingError(Exception):
    """A user-facing problem with the drawing or the model response."""


def available() -> bool:
    return anthropic is not None and bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _content_block(data: bytes, media_type: str) -> dict[str, Any]:
    if len(data) > MAX_BYTES:
        raise DrawingError("Fayl 20 MB dan katta")
    b64 = base64.standard_b64encode(data).decode("ascii")
    if media_type == "application/pdf":
        return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
    if media_type in IMAGE_TYPES:
        return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}}
    raise DrawingError("Faqat PNG, JPEG, WEBP, GIF yoki PDF chizma qabul qilinadi")


def to_spec(result: dict[str, Any]) -> dict[str, Any]:
    """Convert the model's JSON into the shared spec format."""
    name = result.get("part_name") or "chizma"
    if result["kind"] == "revolve":
        profile = [[float(p["a"]), float(p["b"])] for p in result["profile"]]
        if len(profile) < 3:
            raise DrawingError("Chizmadan aylanma profil olinmadi")
        if any(r < 0 for r, _ in profile):
            raise DrawingError("Profil radiusi manfiy bo'lib qoldi")
        return {"kind": "revolve", "name": name, "profile": profile}

    outline = [[float(p["a"]), float(p["b"])] for p in result["outline"]]
    if len(outline) < 3:
        raise DrawingError("Chizmadan detal konturi olinmadi")
    thickness = float(result["thickness"])
    if thickness <= 0:
        raise DrawingError("Plastina qalinligi aniqlanmadi")
    # make the outline counter-clockwise (shoelace) so holes/normals are consistent
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(outline, outline[1:] + outline[:1]))
    if area < 0:
        outline.reverse()
    holes = [{"x": float(h["x"]), "y": float(h["y"]), "r": float(h["diameter"]) / 2}
             for h in result["holes"] if h["diameter"] > 0]
    return {"kind": "extrude", "name": name, "axis": "y", "depth": thickness, "outline": outline, "holes": holes}


def analyze(data: bytes, media_type: str, note: str = "", client: Any = None) -> dict[str, Any]:
    """Send the drawing to Claude and return {"spec": ..., "analysis": ...}."""
    if client is None:
        if anthropic is None:
            raise DrawingError("Serverda `anthropic` paketi o'rnatilmagan (pip install anthropic)")
        client = anthropic.Anthropic()

    prompt = "Analyse this drawing and return the part model."
    if note.strip():
        prompt += "\n\nNote from the user about the drawing:\n" + note.strip()[:2000]

    # The drawing is long input, so stream and collect the final message.
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=64000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        thinking={"type": "adaptive"},
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}},
        system=SYSTEM,
        messages=[{"role": "user", "content": [_content_block(data, media_type), {"type": "text", "text": prompt}]}],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "refusal":
        raise DrawingError("Model bu so'rovni rad etdi")
    if message.stop_reason == "max_tokens":
        raise DrawingError("Javob juda uzun bo'lib, kesilib qoldi — soddaroq chizma yuboring")
    text = next((b.text for b in message.content if b.type == "text"), None)
    if not text:
        raise DrawingError("Modeldan javob kelmadi")
    try:
        result = json.loads(text)
    except json.JSONDecodeError as e:
        raise DrawingError(f"Model javobi JSON emas: {e}")

    return {"spec": to_spec(result), "analysis": {
        "part_name": result.get("part_name"),
        "kind": result.get("kind"),
        "dimensions": result.get("dimensions", []),
        "assumptions": result.get("assumptions", []),
        "confidence": result.get("confidence"),
        "model": message.model,
    }}
