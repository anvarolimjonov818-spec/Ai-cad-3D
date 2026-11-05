"""AI-CAD 3D backend: serves the web app and provides STEP export + mesh audit.

Run:  python backend/main.py          (http://localhost:8000)
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cad  # noqa: E402
import mesh as meshlib  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MAX_UPLOAD = 50 * 1024 * 1024
MAX_DIM = 5000.0
Point = tuple[float, float]

app = FastAPI(title="AI-CAD 3D", version="2.0.0")
app.add_middleware(  # lets a statically hosted frontend use ?api=http://localhost:8000
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"]
)


class Hole(BaseModel):
    x: float = Field(ge=-MAX_DIM, le=MAX_DIM)
    y: float = Field(ge=-MAX_DIM, le=MAX_DIM)
    r: float = Field(gt=0, le=MAX_DIM)


class Spec(BaseModel):
    kind: Literal["revolve", "extrude"]
    name: str = "model"
    profile: Optional[list[Point]] = Field(default=None, max_length=4000)
    outline: Optional[list[Point]] = Field(default=None, max_length=4000)
    holes: list[Hole] = Field(default_factory=list, max_length=200)
    depth: Optional[float] = Field(default=None, gt=0, le=MAX_DIM)
    axis: Literal["y", "z"] = "y"

    @model_validator(mode="after")
    def check(self):
        pts = self.profile if self.kind == "revolve" else self.outline
        if not pts or len(pts) < 3:
            raise ValueError(f"{'profile' if self.kind == 'revolve' else 'outline'} needs at least 3 points")
        if any(abs(c) > MAX_DIM for p in pts for c in p):
            raise ValueError(f"coordinates must be within ±{MAX_DIM} mm")
        if self.kind == "revolve" and any(r < 0 for r, _ in pts):
            raise ValueError("revolve profile radii must be >= 0")
        if self.kind == "extrude" and self.depth is None:
            raise ValueError("extrude spec needs depth")
        return self


@app.get("/api/health")
def health():
    return {"ok": True, "step": cad.available(), "version": app.version}


@app.post("/api/export/step")
def export_step(spec: Spec):
    if not cad.available():
        raise HTTPException(503, "CadQuery is not installed on the server")
    try:
        data = cad.to_step(spec.model_dump())
    except (ValueError, RuntimeError) as e:
        raise HTTPException(422, str(e))
    except Exception as e:  # OCC kernel failures
        raise HTTPException(422, f"CAD kernel could not build the solid: {e}")
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", spec.name)[:60] or "model"
    return Response(data, media_type="application/step",
                    headers={"Content-Disposition": f'attachment; filename="{name}.step"'})


async def _read_stl(request: Request) -> bytes:
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty body: send STL bytes")
    if len(body) > MAX_UPLOAD:
        raise HTTPException(413, "STL larger than 50 MB")
    return body


@app.post("/api/mesh/check")
async def mesh_check(request: Request):
    try:
        m = meshlib.load_stl(await _read_stl(request))
    except ValueError as e:
        raise HTTPException(422, str(e))
    return JSONResponse(meshlib.report(m))


@app.post("/api/mesh/repair")
async def mesh_repair(request: Request):
    try:
        m = meshlib.load_stl(await _read_stl(request))
    except ValueError as e:
        raise HTTPException(422, str(e))
    m, log = meshlib.repair(m)
    return Response(meshlib.to_stl(m), media_type="model/stl",
                    headers={"X-Repair-Log": "; ".join(log) or "clean"})


# --- static frontend (only the app files, never the repo root) ---
app.mount("/js", StaticFiles(directory=ROOT / "js"), name="js")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/index.css", include_in_schema=False)
def css():
    return FileResponse(ROOT / "index.css", media_type="text/css")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")))
