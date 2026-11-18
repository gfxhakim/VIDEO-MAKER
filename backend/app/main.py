"""AutoClip Studio API (+ the built frontend in production).

    uvicorn app.main:app --port 8000
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import auth as auth_api
from .api import music, projects, uploads
from .api.deps import current_user
from .auth import request_user_id
from .config import get_settings
from .db import init_db
from .jobs import register_all
from .pipeline.media import check_binaries
from .presets import ASPECT_RATIOS, caption_styles, editing_styles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("autoclip")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    init_db()
    register_all()
    uploads.recover_uploads()
    bins = check_binaries()
    if not all(bins.values()):
        log.error("FFmpeg/ffprobe not found on PATH: %s. Install FFmpeg before generating clips.", bins)
    worker = None
    if s.embedded_worker:
        from .queue import Worker

        worker = Worker()
        worker.start()
        log.info("embedded worker started (concurrency=%s)", worker.concurrency)
    yield
    if worker:
        worker.stop()


app = FastAPI(title="AutoClip Studio API", version="0.2.0", lifespan=lifespan)
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Requests with a (possibly huge) body: turned away before the body is read when not signed in.
_BODY_PATHS = ("/api/uploads", "/api/projects/upload", "/api/music")


@app.middleware("http")
async def protect_media(request: Request, call_next):
    """Rendered videos, thumbnails and music are only served to signed-in users,
    and nobody can make the server swallow an upload without a session."""
    path = request.url.path
    guarded = path.startswith("/media/") or (request.method in ("POST", "PUT") and path.startswith(_BODY_PATHS))
    if guarded and request_user_id(request) is None:
        return JSONResponse({"detail": "Not signed in"}, status_code=401)
    return await call_next(request)


app.include_router(auth_api.router)
app.include_router(projects.router)
app.include_router(uploads.router)
app.include_router(music.router)
# Range requests are supported, so videos seek instantly.
app.mount("/media/projects", StaticFiles(directory=_settings.projects_dir), name="media-projects")
app.mount("/media/music", StaticFiles(directory=_settings.music_dir), name="media-music")


@app.get("/api/health")
def health():
    s = get_settings()
    return {
        "ok": True,
        "binaries": check_binaries(),
        "transcribe_backend": s.transcribe_backend,
        "whisper_model": s.whisper_model,
        "embedded_worker": s.embedded_worker,
    }


@app.get("/api/presets", dependencies=[Depends(current_user)])
def presets():
    """Everything the style selector needs."""
    return {
        "editing_styles": [{"key": k, **v} for k, v in editing_styles().items()],
        "caption_styles": [{"key": k, **v} for k, v in caption_styles().items()],
        "aspect_ratios": [{"key": k, "width": w, "height": h} for k, (w, h) in ASPECT_RATIOS.items()],
        "clip_count": {"min": 10, "max": 50, "default": 20},
    }


# Production: serve the statically exported Next.js app from the same origin (one
# Railway service, one volume, cookies just work). Mounted last so /api wins.
if _settings.static_dir and (_settings.static_dir / "index.html").exists():
    app.mount("/", StaticFiles(directory=_settings.static_dir, html=True), name="frontend")
    log.info("serving frontend from %s", _settings.static_dir)
