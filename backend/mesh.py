"""Server-side mesh audit and repair with trimesh (FR-5)."""
from __future__ import annotations

import io

import numpy as np
import trimesh


def load_stl(data: bytes) -> trimesh.Trimesh:
    mesh = trimesh.load(io.BytesIO(data), file_type="stl", force="mesh", process=True)
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        raise ValueError("STL is empty or invalid")
    return mesh


def report(mesh: trimesh.Trimesh) -> dict:
    watertight = bool(mesh.is_watertight)
    return {
        "triangles": int(len(mesh.faces)),
        "vertices": int(len(mesh.vertices)),
        "watertight": watertight,
        "winding_consistent": bool(mesh.is_winding_consistent),
        "is_volume": bool(mesh.is_volume),
        "volume_cm3": float(abs(mesh.volume)) / 1000 if watertight else None,
        "area_cm2": float(mesh.area) / 100,
        "extents": [float(v) for v in mesh.extents],
        "euler_number": int(mesh.euler_number),
    }


def repair(mesh: trimesh.Trimesh) -> tuple[trimesh.Trimesh, list[str]]:
    log: list[str] = []
    n = len(mesh.faces)
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    if len(mesh.faces) != n:
        log.append(f"removed {n - len(mesh.faces)} degenerate/duplicate faces")
    if not mesh.is_watertight:
        trimesh.repair.fill_holes(mesh)
        log.append("filled holes" if mesh.is_watertight else "hole filling incomplete")
    trimesh.repair.fix_normals(mesh)
    if mesh.is_watertight and mesh.volume < 0:
        mesh.invert()
    return mesh, log


def to_stl(mesh: trimesh.Trimesh) -> bytes:
    return mesh.export(file_type="stl")


def box_stl(l: float, w: float, h: float) -> bytes:
    """Helper for tests."""
    return to_stl(trimesh.creation.box(extents=np.array([l, w, h])))
