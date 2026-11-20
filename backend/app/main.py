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
from starlette.datastructures import MutableHeaders
from starlette.middleware.gzip import GZipMiddleware

from .api import admin as admin_api
from .api import auth as auth_api
from .api import broll, music, projects, system, uploads
from .api.deps import current_user
from .auth import request_user_id
from .config import effective_cpus, get_settings, memory_limit_bytes, worker_count
from .db import init_db
from .jobs import register_all
from .pipeline import llm
from .pipeline.media import check_binaries
from .presets import ASPECT_RATIOS, caption_styles, editing_styles, video_effects
from .queue import Worker  # noqa: F401

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("autoclip")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    init_db()
    auth_api.bootstrap_admin()
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


app = FastAPI(title="AutoClip Studio API", version="0.3.0", lifespan=lifespan)
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_TEXT_EXT = (".html", ".js", ".css", ".json", ".txt", ".svg", ".map", ".xml", ".webmanifest")


def _compressible(path: str) -> bool:
    if path.startswith(("/media/", "/api/uploads")):
        return False
    if path.startswith("/api/"):
        return not path.endswith(("/download", ".zip"))
    last = path.rsplit("/", 1)[-1]
    return "." not in last or last.endswith(_TEXT_EXT)


def _cache_policy(path: str) -> str | None:
    if path.startswith("/_next/static/"):
        return "public, max-age=31536000, immutable"
    if path.startswith(("/api/", "/media/")):
        return None
    last = path.rsplit("/", 1)[-1]
    if "." not in last or last.endswith(".html"):
        return "no-cache"
    return None


class FastDelivery:
    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024, compresslevel=5)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        policy = _cache_policy(path)

        async def send_with_cache(message):
            if message["type"] == "http.response.start":
                ok = message.get("status") in (200, 206, 304)
                if policy and (ok or policy == "no-cache"):
                    headers = MutableHeaders(scope=message)
                    if "cache-control" not in headers:
                        headers["Cache-Control"] = policy
            await send(message)

        handler = self.gzip if _compressible(path) else self.app
        await handler(scope, receive, send_with_cache if policy else send)


app.add_middleware(FastDelivery)

_BODY_PATHS = ("/api/uploads", "/api/projects/upload", "/api/music", "/api/broll")


@app.middleware("http")
async def protect_media(request: Request, call_next):
    path = request.url.path
    guarded = path.startswith("/media/") or (request.method in ("POST", "PUT") and path.startswith(_BODY_PATHS))
    if guarded and request_user_id(request) is None:
        return JSONResponse({"detail": "Not signed in"}, status_code=401)
    return await call_next(request)


app.include_router(auth_api.router)
app.include_router(admin_api.router)
app.include_router(projects.router)
app.include_router(uploads.router)
app.include_router(music.router)
app.include_router(broll.router)
app.include_router(system.router)
app.mount("/media/projects", StaticFiles(directory=_settings.projects_dir), name="media-projects")
app.mount("/media/music", StaticFiles(directory=_settings.music_dir), name="media-music")
app.mount("/media/broll", StaticFiles(directory=_settings.broll_dir), name="media-broll")


@app.get("/api/health")
def health():
    s = get_settings()
    return {
        "ok": True,
        "binaries": check_binaries(),
        "transcribe_backend": s.transcribe_backend,
        "whisper_model": s.whisper_model,
        "embedded_worker": s.embedded_worker,
        "cpus": effective_cpus(),
        "memory_gb": round(memory_limit_bytes() / 1024**3, 1),
        "worker_concurrency": worker_count(),
    }


@app.get("/api/presets", dependencies=[Depends(current_user)])
def presets():
    """Everything the style selector needs."""
    return {
        "editing_styles": [{"key": k, **v} for k, v in editing_styles().items()],
        "caption_styles": [{"key": k, **v} for k, v in caption_styles().items()],
        "video_effects": [{"key": k, **v} for k, v in video_effects().items()],
        "playback_speeds": [
            {"value": 0.9, "label": "0.9x Slow"},
            {"value": 1.0, "label": "1.0x Normal"},
            {"value": 1.05, "label": "1.05x Tight"},
            {"value": 1.1, "label": "1.1x Viral"},
            {"value": 1.15, "label": "1.15x Fast"},
            {"value": 1.25, "label": "1.25x Rapid"},
        ],
        "aspect_ratios": [{"key": k, "width": w, "height": h} for k, (w, h) in ASPECT_RATIOS.items()],
        "hook_card_styles": [
            {"key": "light", "name": "Light pill"},
            {"key": "dark", "name": "Dark pill"},
            {"key": "accent", "name": "Brand gradient"},
            {"key": "glass", "name": "Frosted glass"},
        ],
        "clip_count": {"min": 1, "max": 50, "default": 20},
        "llm_configured": llm.is_configured(),
    }


if _settings.static_dir and (_settings.static_dir / "index.html").exists():
    app.mount("/", StaticFiles(directory=_settings.static_dir, html=True), name="frontend")
    log.info("serving frontend from %s", _settings.static_dir)
