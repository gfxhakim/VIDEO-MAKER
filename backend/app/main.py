"""AutoClip Studio API.

    uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import music, projects, publish
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
    bins = check_binaries()
    if not all(bins.values()):
        log.error("FFmpeg/ffprobe not found on PATH: %s. Install FFmpeg before generating clips.", bins)
    worker = scheduler = None
    if s.embedded_worker:
        from .publishing.scheduler import Scheduler
        from .queue import Worker

        worker, scheduler = Worker(), Scheduler()
        worker.start()
        scheduler.start()
        log.info("embedded worker started (concurrency=%s)", worker.concurrency)
    yield
    if worker:
        worker.stop()
    if scheduler:
        scheduler.stop()


app = FastAPI(title="AutoClip Studio API", version="0.1.0", lifespan=lifespan)
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _settings.cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(projects.router)
app.include_router(music.router)
app.include_router(publish.router)
# Rendered clips, thumbnails and music are served from here (Range requests supported).
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
        "publish_dry_run": s.publish_dry_run,
    }


@app.get("/api/presets")
def presets():
    """Everything the style selector needs."""
    return {
        "editing_styles": [{"key": k, **v} for k, v in editing_styles().items()],
        "caption_styles": [{"key": k, **v} for k, v in caption_styles().items()],
        "aspect_ratios": [{"key": k, "width": w, "height": h} for k, (w, h) in ASPECT_RATIOS.items()],
        "clip_count": {"min": 10, "max": 50, "default": 20},
    }
