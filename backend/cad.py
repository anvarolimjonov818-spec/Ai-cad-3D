"""Parametric spec -> CadQuery B-rep solid -> STEP.

The spec format is shared with the browser (js/geometry.js); orientation and
units (mm, Y-up as in the viewer) match the Three.js mesh exactly.
"""
from __future__ import annotations

import math
import os
import tempfile
from typing import Any

try:
    import cadquery as cq
except ImportError:  # optional dependency
    cq = None


def available() -> bool:
    return cq is not None


def _dedupe(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for x, y in points:
        if not out or abs(out[-1][0] - x) > 1e-6 or abs(out[-1][1] - y) > 1e-6:
            out.append((float(x), float(y)))
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) < 1e-6 and abs(out[0][1] - out[-1][1]) < 1e-6:
        out.pop()
    return out


def build_solid(spec: dict[str, Any]):
    """Return a cadquery.Workplane holding one solid."""
    if cq is None:
        raise RuntimeError("CadQuery is not installed (pip install cadquery)")

    kind = spec["kind"]
    if kind == "revolve":
        pts = _dedupe(spec["profile"])
        if len(pts) < 3:
            raise ValueError("profile needs at least 3 points")
        # sketch in XY as (radius, height) and revolve about the Y axis
        return cq.Workplane("XY").polyline(pts).close().revolve(360, (0, 0, 0), (0, 1, 0))

    if kind == "extrude":
        pts = _dedupe(spec["outline"])
        if len(pts) < 3:
            raise ValueError("outline needs at least 3 points")
        depth = float(spec["depth"])
        solid = cq.Workplane("XY").polyline(pts).close().extrude(depth)
        for h in spec.get("holes") or []:
            cutter = cq.Workplane("XY").center(h["x"], h["y"]).circle(h["r"]).extrude(depth)
            solid = solid.cut(cutter)
        if spec.get("axis", "y") == "z":
            return solid.translate((0, 0, -depth / 2))
        # same as Three.js rotateX(-90°): (x, y, z) -> (x, z, -y)
        return solid.rotate((0, 0, 0), (1, 0, 0), -90)

    if kind == "csg":
        return _build_csg(spec["features"])

    raise ValueError(f"unknown spec kind: {kind}")


# --- feature-based solids (same conventions as js/csg.js: mm, Z up) ---

def _plane(axis: str, start: float, end: float):
    """Sketch plane whose local (u, v) matches js/csg.js and whose normal sweeps start..end."""
    if axis == "x":
        return cq.Plane(origin=(start, 0, 0), xDir=(0, 1, 0), normal=(1, 0, 0))   # (u, v) = (y, z)
    if axis == "y":
        return cq.Plane(origin=(0, end, 0), xDir=(1, 0, 0), normal=(0, -1, 0))    # (u, v) = (x, z)
    return cq.Plane(origin=(0, 0, start), xDir=(1, 0, 0), normal=(0, 0, 1))       # (u, v) = (x, y)


def _regular_polygon(f) -> list[tuple[float, float]]:
    n, r = int(f["sides"]), float(f["diameter"]) / 2
    rot = math.radians(float(f.get("rotation_deg") or 0))
    cx, cy = f.get("center") or (0, 0)
    return [(cx + r * math.cos(rot + 2 * math.pi * i / n), cy + r * math.sin(rot + 2 * math.pi * i / n)) for i in range(n)]


def _feature(f):
    shape = f["shape"]
    if shape == "revolve":
        cx, cy = f.get("center") or (0, 0)
        plane = cq.Plane(origin=(cx, cy, 0), xDir=(1, 0, 0), normal=(0, -1, 0))  # (u, v) = (x, z)
        return cq.Workplane(plane).polyline(_dedupe(f["profile"])).close().revolve(360, (0, 0, 0), (0, 1, 0))

    start, end = float(f["from"]), float(f["to"])
    wp = cq.Workplane(_plane(f.get("axis", "z"), start, end))
    h = end - start
    if shape == "prism":
        return wp.polyline(_dedupe(f["outline"])).close().extrude(h)
    if shape == "cylinder":
        cx, cy = f.get("center") or (0, 0)
        return wp.center(cx, cy).circle(float(f["diameter"]) / 2).extrude(h)
    if shape == "regular_prism":
        return wp.polyline(_regular_polygon(f)).close().extrude(h)
    if shape == "hull":
        sk = cq.Sketch()
        for c in f["circles"]:
            (cx, cy), r = c["center"], float(c["diameter"]) / 2
            sk = sk.arc((cx, cy), r, 0.0, 360.0)
        return wp.placeSketch(sk.hull()).extrude(h)
    raise ValueError(f"unknown feature shape: {shape}")


def _build_csg(features: list[dict]):
    if not features or features[0].get("op", "add") != "add":
        raise ValueError("first feature must be 'add'")
    solid = None
    for f in features:
        part = _feature(f)
        if solid is None:
            solid = part
        elif f.get("op", "add") == "add":
            solid = solid.union(part)
        else:
            solid = solid.cut(part)
    return solid


def volume_mm3(spec: dict[str, Any]) -> float:
    return build_solid(spec).val().Volume()


def to_step(spec: dict[str, Any]) -> bytes:
    solid = build_solid(spec)
    fd, path = tempfile.mkstemp(suffix=".step")
    os.close(fd)
    try:
        cq.exporters.export(solid, path, exportType="STEP")
        with open(path, "rb") as f:
            return f.read()
    finally:
        os.unlink(path)
