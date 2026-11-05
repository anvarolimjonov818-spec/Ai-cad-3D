"""Parametric spec -> CadQuery B-rep solid -> STEP.

The spec format is shared with the browser (js/geometry.js); orientation and
units (mm, Y-up as in the viewer) match the Three.js mesh exactly.
"""
from __future__ import annotations

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

    raise ValueError(f"unknown spec kind: {kind}")


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
