"""Engineering drawing (image / PDF) -> part spec, using Claude vision (paid API mode).

The free mode does the same through claude.ai copy/paste (js/drawing.js).

Claude reads the views and dimensions on the drawing and returns a spec in the
same format the browser and CadQuery use (see js/geometry.js). The spec is then
validated by building the real solid before it is sent back to the browser.
"""
from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path
from typing import Any

try:
    import anthropic
except ImportError:  # optional dependency
    anthropic = None

MODEL = os.environ.get("AICAD_MODEL", "claude-3-7-sonnet-20250219")
MAX_BYTES = 20 * 1024 * 1024
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}

_UV = {"type": "array", "items": {"type": "number"}}
_FEATURE = {
    "type": "object",
    "properties": {
        "op": {"type": "string", "enum": ["add", "cut"]},
        "shape": {"type": "string", "enum": ["prism", "cylinder", "regular_prism", "hull", "revolve"]},
        "axis": {"type": "string", "enum": ["x", "y", "z"]},
        "from": {"type": "number"},
        "to": {"type": "number"},
        "outline": {"type": "array", "items": _UV, "description": "prism only, else []"},
        "profile": {"type": "array", "items": _UV, "description": "revolve only, else []"},
        "center": _UV,
        "diameter": {"type": "number", "description": "cylinder / regular_prism, else 0"},
        "sides": {"type": "integer", "description": "regular_prism only, else 0"},
        "rotation_deg": {"type": "number"},
        "circles": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"center": _UV, "diameter": {"type": "number"}},
                "required": ["center", "diameter"],
                "additionalProperties": False,
            },
            "description": "hull only, else []",
        },
        "label": {"type": "string"},
    },
    "required": ["op", "shape", "axis", "from", "to", "outline", "profile", "center", "diameter", "sides",
                 "rotation_deg", "circles", "label"],
    "additionalProperties": False,
}

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "part_name": {"type": "string"},
        "kind": {"type": "string", "enum": ["csg"]},
        "features": {"type": "array", "items": _FEATURE},
        "dimensions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"label": {"type": "string"}, "value_mm": {"type": "number"}},
                "required": ["label", "value_mm"],
                "additionalProperties": False,
            },
        },
        "assumptions": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["part_name", "kind", "features", "dimensions", "assumptions", "confidence"],
    "additionalProperties": False,
}


def _load_prompt() -> str:
    """The drawing prompt lives in js/drawing.js so the free (claude.ai) and API modes stay identical."""
    src = (Path(__file__).resolve().parent.parent / "js" / "drawing.js").read_text(encoding="utf-8")
    m = re.search(r"const PROMPT = `(.*?)`;", src, re.S)
    if not m:
        raise RuntimeError("PROMPT not found in js/drawing.js")
    return m.group(1).replace("\\`", "`").replace("\\\\", "\\")


SYSTEM = _load_prompt() + (
    "\n\nYou are called through the API: the answer format is enforced by a JSON schema, so return only the JSON object."
    " Every feature must contain every field; use [] / 0 / \"\" for fields its shape does not use.")


class DrawingError(Exception):
    """A user-facing problem with the drawing or the model response."""


def available() -> bool:
    return anthropic is not None

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
    if result["kind"] == "csg":
        features = []
        for f in result.get("features") or []:
            shape = f.get("shape")
            clean = {"op": f.get("op", "add"), "shape": shape, "label": f.get("label", "")}
            if shape == "revolve":
                clean.update(profile=f["profile"], center=f.get("center") or [0, 0])
            else:
                clean.update(axis=f.get("axis", "z"), **{"from": f["from"]}, to=f["to"])
                if shape == "prism":
                    clean["outline"] = f["outline"]
                elif shape == "cylinder":
                    clean.update(center=f.get("center") or [0, 0], diameter=f["diameter"])
                elif shape == "regular_prism":
                    clean.update(center=f.get("center") or [0, 0], diameter=f["diameter"],
                                 sides=f["sides"], rotation_deg=f.get("rotation_deg", 0))
                elif shape == "hull":
                    clean["circles"] = f["circles"]
            features.append(clean)
        if not features:
            raise DrawingError("Chizmadan birorta ham element olinmadi")
        return {"kind": "csg", "name": name, "features": features}
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


def analyze(data: bytes, media_type: str, note: str = "", client: Any = None, api_key: Any = None) -> dict[str, Any]:
    """Send the drawing to Claude and return {"spec": ..., "analysis": ...}."""
    if client is None:
        if anthropic is None:
            raise DrawingError("Serverda `anthropic` paketi o'rnatilmagan (pip install anthropic)")
        key = api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        if not key:
            raise DrawingError("AI tahlil kaliti topilmadi. Iltimos, API kalitini kiriting yoki .env fayliga yozing.")
        client = anthropic.Anthropic(api_key=str(key).strip())

    prompt = "Analyse this drawing and return the part model."
    if note.strip():
        prompt += "\n\nNote from the user about the drawing:\n" + note.strip()[:2000]

    candidate_models = [
        MODEL,
        "claude-3-7-sonnet-20250219",
        "claude-3-5-sonnet-20241022",
        "claude-3-5-sonnet-latest"
    ]
    seen = set()
    models = [m for m in candidate_models if m and not (m in seen or seen.add(m))]

    last_error = None
    message = None
    for m in models:
        try:
            message = client.messages.create(
                model=m,
                max_tokens=8192,
                system=SYSTEM + "\n\nCRITICAL: Respond ONLY with a valid JSON object matching the requested schema. Do not include markdown codeblocks or preamble.",
                messages=[{"role": "user", "content": [_content_block(data, media_type), {"type": "text", "text": prompt}]}],
            )
            break
        except Exception as err:
            last_error = err
            continue

    if message is None:
        raise DrawingError(f"AI chaqiruvida xatolik: {last_error}")

    if getattr(message, "stop_reason", None) == "refusal":
        raise DrawingError("Model bu so'rovni rad etdi")
    if getattr(message, "stop_reason", None) == "max_tokens":
        raise DrawingError("Javob juda uzun bo'lib, kesilib qoldi — soddaroq chizma yuboring")

    text = ""
    for block in message.content:
        if getattr(block, "type", "") == "text":
            text += block.text

    if not text:
        raise DrawingError("Modeldan javob kelmadi")

    cleaned = text.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1:
        cleaned = cleaned[start:end+1]

    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise DrawingError(f"Model javobi yaroqli JSON emas: {e}\nMatn: {cleaned[:300]}")

    return {"spec": to_spec(result), "analysis": {
        "part_name": result.get("part_name"),
        "kind": result.get("kind"),
        "dimensions": result.get("dimensions", []),
        "assumptions": result.get("assumptions", []),
        "confidence": result.get("confidence"),
        "model": message.model,
    }}
