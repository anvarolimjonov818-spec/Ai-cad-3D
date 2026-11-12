"""AI-CAD 3D backend: serves the web app and provides STEP export + mesh audit.

Run:  python backend/main.py          (http://localhost:8000)
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Annotated, Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, model_validator

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cad  # noqa: E402
import drawing  # noqa: E402
import gemini as geminilib  # noqa: E402
import mesh as meshlib  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
try:
    import dotenv
    dotenv.load_dotenv(ROOT / ".env")
except Exception:
    pass
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


Coord = Annotated[float, Field(ge=-MAX_DIM, le=MAX_DIM)]


class Circle(BaseModel):
    center: tuple[Coord, Coord] = (0.0, 0.0)
    diameter: float = Field(gt=0, le=2 * MAX_DIM)


class Feature(BaseModel):
    """One step of a feature-based ("csg") part; see js/csg.js for the conventions."""
    op: Literal["add", "cut"] = "add"
    shape: Literal["prism", "cylinder", "regular_prism", "hull", "revolve"]
    axis: Literal["x", "y", "z"] = "z"
    from_: Optional[Coord] = Field(default=None, alias="from")
    to: Optional[Coord] = None
    outline: Optional[list[tuple[Coord, Coord]]] = Field(default=None, max_length=4000)
    profile: Optional[list[tuple[Coord, Coord]]] = Field(default=None, max_length=4000)
    center: tuple[Coord, Coord] = (0.0, 0.0)
    diameter: Optional[float] = Field(default=None, gt=0, le=2 * MAX_DIM)
    sides: Optional[int] = Field(default=None, ge=3, le=64)
    rotation_deg: float = 0.0
    circles: Optional[list[Circle]] = Field(default=None, max_length=50)
    label: str = ""

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def check(self):
        need = {"prism": ["outline"], "cylinder": ["diameter"], "regular_prism": ["diameter", "sides"],
                "hull": ["circles"], "revolve": ["profile"]}[self.shape]
        for name in need:
            if not getattr(self, name):
                raise ValueError(f"{self.shape} feature needs '{name}'")
        if self.shape != "revolve":
            if self.from_ is None or self.to is None or self.to - self.from_ <= 0:
                raise ValueError(f"{self.shape} feature needs from < to")
        if self.shape in ("prism", "revolve") and len(self.outline or self.profile) < 3:
            raise ValueError("polygon needs at least 3 points")
        return self


class Spec(BaseModel):
    kind: Literal["revolve", "extrude", "csg"]
    features: Optional[list[Feature]] = Field(default=None, max_length=80)
    name: str = "model"
    profile: Optional[list[Point]] = Field(default=None, max_length=4000)
    outline: Optional[list[Point]] = Field(default=None, max_length=4000)
    holes: list[Hole] = Field(default_factory=list, max_length=200)
    depth: Optional[float] = Field(default=None, gt=0, le=MAX_DIM)
    axis: Literal["y", "z"] = "y"

    @model_validator(mode="after")
    def check(self):
        if self.kind == "csg":
            if not self.features:
                raise ValueError("csg spec needs features")
            if self.features[0].op != "add":
                raise ValueError("first feature must be 'add'")
            return self
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
    return {"ok": True, "step": cad.available(), "drawing": drawing.available(), "version": app.version}


@app.post("/api/export/step")
def export_step(spec: Spec):
    if not cad.available():
        raise HTTPException(503, "CadQuery is not installed on the server")
    try:
        data = cad.to_step(spec.model_dump(by_alias=True, exclude_none=True))
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


@app.post("/api/drawing/analyze")
async def drawing_analyze(request: Request, note: str = ""):
    """Body: the drawing file (image or PDF); Content-Type must match it."""
    if not drawing.available():
        raise HTTPException(503, "Chizma tahlili uchun serverda `anthropic` paketi o'rnatilmagan")
    body = await request.body()
    if not body:
        raise HTTPException(400, "Bo'sh so'rov: chizma faylini yuboring")
    media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    api_key = request.headers.get("x-anthropic-key") or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
    if not api_key:
        raise HTTPException(401, "AI API kaliti topilmadi. Iltimos, API kalitingizni kiriting yoki .env faylga yozing.")
    custom_key = request.headers.get("x-anthropic-key")
    try:
        if custom_key:
            old_key = os.environ.get("ANTHROPIC_API_KEY")
            try:
                os.environ["ANTHROPIC_API_KEY"] = custom_key
                result = await run_in_threadpool(drawing.analyze, body, media_type, note)
            finally:
                if old_key is not None:
                    os.environ["ANTHROPIC_API_KEY"] = old_key
                else:
                    os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            result = await run_in_threadpool(drawing.analyze, body, media_type, note)
    except drawing.DrawingError as e:
        raise HTTPException(422, str(e))
    except Exception as e:  # API/network failures
        raise HTTPException(502, f"AI tahlil xatosi: {e}")
    try:  # make sure the spec is a valid Spec and really builds as a solid
        spec = Spec.model_validate(result["spec"]).model_dump(by_alias=True, exclude_none=True)
        if cad.available():
            result["analysis"]["volume_cm3"] = cad.volume_mm3(spec) / 1000
    except Exception as e:
        raise HTTPException(422, f"Chizmadan olingan geometriya yaroqsiz: {e}")
    return result


@app.get("/api/gemini")
async def gemini_status():
    api_key = geminilib.get_api_key()
    if not api_key:
        return JSONResponse({"configured": False, "models": []}, headers={"Cache-Control": "no-store"})
    try:
        models = await geminilib.list_models(api_key)
        return JSONResponse({"configured": True, "valid": True, "models": models}, headers={"Cache-Control": "no-store"})
    except geminilib.ProxyRequestError as e:
        return JSONResponse(
            {"configured": True, "valid": False, "models": [], "error": str(e)},
            headers={"Cache-Control": "no-store"},
        )
    except Exception as e:
        return JSONResponse(
            {"configured": True, "valid": False, "models": [], "error": geminilib.sanitize_error(e, api_key)},
            headers={"Cache-Control": "no-store"},
        )


@app.post("/api/gemini")
async def gemini_generate(request: Request):
    api_key = geminilib.get_api_key()
    if not api_key:
        return JSONResponse(
            {
                "missingKey": True,
                "error": {"message": "Serverda AI Vision kaliti o'rnatilmagan."},
            },
            status_code=503,
            headers={"Cache-Control": "no-store"},
        )
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": {"message": "Noto'g'ri JSON so'rov"}}, status_code=400, headers={"Cache-Control": "no-store"})
    try:
        status, data, headers = await geminilib.generate(api_key, payload)
        return JSONResponse(data, status_code=status, headers=headers)
    except geminilib.ProxyRequestError as e:
        return JSONResponse({"error": {"message": str(e)}}, status_code=e.status, headers={"Cache-Control": "no-store"})
    except Exception as e:
        return JSONResponse(
            {"error": {"message": geminilib.sanitize_error(e, api_key)}},
            status_code=502,
            headers={"Cache-Control": "no-store"},
        )


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
