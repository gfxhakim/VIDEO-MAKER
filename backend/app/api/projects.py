"""Projects (ingestion + generation) and clips (review/edit)."""
from __future__ import annotations

import json
import re
import shutil
import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session, col, select

from ..db import get_session
from ..models import Clip, Job, Project, utcnow
from ..config import get_settings
from ..pipeline.publish_kit import PLATFORMS, build_kit, build_zip
from ..pipeline.tasks import project_dir
from ..presets import caption_styles, editing_styles
from ..queue import enqueue
from ..schemas import ClipOut, ClipUpdate, GenerationSettings, PostedUpdate, ProjectCreateURL, ProjectOut
from .deps import current_user, media_url

router = APIRouter(prefix="/api", tags=["projects"], dependencies=[Depends(current_user)])


def _validate(settings: GenerationSettings) -> GenerationSettings:
    if settings.editing_style not in editing_styles():
        raise HTTPException(400, f"Unknown editing_style '{settings.editing_style}'")
    if settings.caption_style not in caption_styles() and settings.caption_style != "none":
        raise HTTPException(400, f"Unknown caption_style '{settings.caption_style}'")
    return settings


def project_out(session: Session, p: Project) -> ProjectOut:
    clips = session.exec(select(Clip).where(Clip.project_id == p.id)).all()
    ready = [c for c in clips if c.status == "ready"]
    best = max(ready, key=lambda c: c.score) if ready else None
    return ProjectOut(
        **p.model_dump(exclude={"source_path", "updated_at"}), clip_count=len(clips), ready_count=len(ready),
        thumb_url=media_url(best.thumb_path) if best else None,
    )


def clip_out(c: Clip) -> ClipOut:
    v = c.updated_at.timestamp() if c.updated_at else None
    return ClipOut(
        **c.model_dump(exclude={"video_path", "thumb_path", "created_at", "updated_at"}),
        duration=round(c.end - c.start, 2), video_url=media_url(c.video_path, v), thumb_url=media_url(c.thumb_path, v),
    )


def _start(session: Session, p: Project) -> None:
    p.status, p.stage, p.progress, p.error, p.updated_at = "queued", "Waiting for worker", 0.0, None, utcnow()
    session.add(p)
    session.commit()
    enqueue("analyze_project", {"project_id": p.id}, priority=10)


# ------------------------------------------------------------------ projects
@router.get("/projects", response_model=list[ProjectOut])
def list_projects(session: Session = Depends(get_session)):
    rows = session.exec(select(Project).order_by(col(Project.id).desc())).all()
    return [project_out(session, p) for p in rows]


@router.post("/projects", response_model=ProjectOut)
def create_from_link(body: ProjectCreateURL, start: bool = True, session: Session = Depends(get_session)):
    """Create from a URL (YouTube, TikTok, Twitch VOD, Drive...) or a path on this machine."""
    if not body.url and not body.path:
        raise HTTPException(400, "Provide a url or a local path")
    if body.url and not re.match(r"^https?://", body.url.strip()):
        raise HTTPException(400, "URL must start with http:// or https://")
    settings = _validate(body.settings or GenerationSettings())
    src_type, src = ("url", body.url.strip()) if body.url else ("path", body.path.strip())
    p = Project(name=body.name or src.rsplit("/", 1)[-1][:120], source_type=src_type, source=src,
                settings=settings.model_dump())
    session.add(p)
    session.commit()
    session.refresh(p)
    if start:
        _start(session, p)
    return project_out(session, p)


@router.post("/projects/upload", response_model=ProjectOut)
def create_from_upload(file: UploadFile = File(...), settings: Optional[str] = Form(None), name: Optional[str] = Form(None),
                       start: bool = Form(True), session: Session = Depends(get_session)):
    try:
        gs = _validate(GenerationSettings(**json.loads(settings)) if settings else GenerationSettings())
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"Invalid settings: {e}") from e
    p = Project(name=name or (file.filename or "Upload").rsplit(".", 1)[0][:120], source_type="upload",
                source=file.filename or "upload.mp4", settings=gs.model_dump())
    session.add(p)
    session.commit()
    session.refresh(p)
    ext = "." + (file.filename or "x.mp4").rsplit(".", 1)[-1].lower()[:5]
    dest = project_dir(p.id) / f"source{ext}"
    with open(dest, "wb") as out:
        shutil.copyfileobj(file.file, out, length=8 * 1024 * 1024)
    p.source_path = str(dest)
    session.add(p)
    session.commit()
    if start:
        _start(session, p)
    return project_out(session, p)


@router.get("/projects/{pid}", response_model=ProjectOut)
def get_project(pid: int, session: Session = Depends(get_session)):
    p = session.get(Project, pid)
    if not p:
        raise HTTPException(404, "Project not found")
    return project_out(session, p)


@router.post("/projects/{pid}/generate", response_model=ProjectOut)
def generate(pid: int, settings: Optional[GenerationSettings] = None, session: Session = Depends(get_session)):
    """(Re)run generation, optionally with new style settings. The transcript is cached."""
    p = session.get(Project, pid)
    if not p:
        raise HTTPException(404, "Project not found")
    if p.status in ("queued", "processing"):
        raise HTTPException(409, "Project is already processing")
    if settings:
        p.settings = _validate(settings).model_dump()
    _start(session, p)
    return project_out(session, p)


@router.delete("/projects/{pid}")
def delete_project(pid: int, session: Session = Depends(get_session)):
    p = session.get(Project, pid)
    if not p:
        raise HTTPException(404, "Project not found")
    for c in session.exec(select(Clip).where(Clip.project_id == pid)).all():
        session.delete(c)
    session.delete(p)
    session.commit()
    shutil.rmtree(project_dir(pid), ignore_errors=True)
    return {"ok": True}


# ------------------------------------------------------------------ clips
@router.get("/projects/{pid}/clips", response_model=list[ClipOut])
def list_clips(pid: int, session: Session = Depends(get_session)):
    rows = session.exec(select(Clip).where(Clip.project_id == pid).order_by(col(Clip.rank))).all()
    return [clip_out(c) for c in rows]


@router.get("/clips", response_model=list[ClipOut])
def all_ready_clips(review_status: Optional[str] = None, session: Session = Depends(get_session)):
    q = select(Clip).where(Clip.status == "ready")
    if review_status:
        q = q.where(Clip.review_status == review_status)
    return [clip_out(c) for c in session.exec(q.order_by(col(Clip.id).desc())).all()]


@router.patch("/clips/{cid}", response_model=ClipOut)
def update_clip(cid: int, body: ClipUpdate, session: Session = Depends(get_session)):
    c = session.get(Clip, cid)
    if not c:
        raise HTTPException(404, "Clip not found")
    data = body.model_dump(exclude_none=True)
    if "review_status" in data and data["review_status"] not in ("pending", "approved", "rejected"):
        raise HTTPException(400, "review_status must be pending|approved|rejected")
    if "hashtags" in data:
        data["hashtags"] = [t if t.startswith("#") else f"#{t}" for t in (h.strip() for h in data["hashtags"]) if t]
    for k, v in data.items():
        setattr(c, k, v)
    c.updated_at = utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return clip_out(c)


@router.post("/clips/{cid}/rerender", response_model=ClipOut)
def rerender_clip(cid: int, session: Session = Depends(get_session)):
    """Re-render one clip (e.g. after editing its hook title)."""
    c = session.get(Clip, cid)
    if not c:
        raise HTTPException(404, "Clip not found")
    c.status, c.error = "pending", None
    session.add(c)
    p = session.get(Project, c.project_id)
    if p and p.status in ("done", "failed"):
        p.status, p.stage = "processing", "Re-rendering clip"
        session.add(p)
    session.commit()
    enqueue("render_clip", {"clip_id": c.id}, priority=8)
    return clip_out(c)


@router.get("/clips/{cid}/download")
def download_clip(cid: int, session: Session = Depends(get_session)):
    c = session.get(Clip, cid)
    if not c or not c.video_path:
        raise HTTPException(404, "Clip not rendered")
    safe = re.sub(r"[^A-Za-z0-9 _-]", "", c.title)[:60].strip() or f"clip-{cid}"
    return FileResponse(c.video_path, media_type="video/mp4", filename=f"{safe}.mp4")


# ------------------------------------------------------------------ manual publishing
@router.get("/clips/{cid}/kit")
def clip_kit(cid: int, session: Session = Depends(get_session)):
    """Copy-ready title / caption / hashtags for every platform."""
    c = session.get(Clip, cid)
    if not c:
        raise HTTPException(404, "Clip not found")
    return build_kit(c.title, c.description, c.hashtags)


@router.post("/clips/{cid}/posted", response_model=ClipOut)
def mark_posted(cid: int, body: PostedUpdate, session: Session = Depends(get_session)):
    """Track where you've manually posted a clip."""
    if body.platform not in PLATFORMS:
        raise HTTPException(400, f"platform must be one of {', '.join(PLATFORMS)}")
    c = session.get(Clip, cid)
    if not c:
        raise HTTPException(404, "Clip not found")
    posted = dict(c.posted or {})
    if body.posted:
        posted[body.platform] = utcnow().isoformat()
    else:
        posted.pop(body.platform, None)
    c.posted = posted
    if body.posted and c.review_status == "pending":
        c.review_status = "approved"
    c.updated_at = utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return clip_out(c)


@router.get("/projects/{pid}/export.zip")
def export_zip(pid: int, background: BackgroundTasks, scope: str = "approved", session: Session = Depends(get_session)):
    """Download clips + caption files as one ZIP. scope = approved | all"""
    p = session.get(Project, pid)
    if not p:
        raise HTTPException(404, "Project not found")
    q = select(Clip).where(Clip.project_id == pid, Clip.status == "ready")
    if scope == "approved":
        q = q.where(Clip.review_status == "approved")
    clips = session.exec(q.order_by(col(Clip.rank))).all()
    if not clips:
        raise HTTPException(404, "No clips to export" + (" (approve some first)" if scope == "approved" else ""))
    tmp = get_settings().data_dir / "tmp"
    tmp.mkdir(exist_ok=True)
    dest = build_zip(clips, tmp / f"export-{pid}-{uuid.uuid4().hex[:8]}.zip")
    background.add_task(dest.unlink, missing_ok=True)
    name = re.sub(r"[^A-Za-z0-9 _-]", "", p.name)[:50].strip() or f"project-{pid}"
    return FileResponse(dest, media_type="application/zip", filename=f"{name} - clips.zip")


@router.get("/jobs")
def list_jobs(limit: int = 50, session: Session = Depends(get_session)):
    rows = session.exec(select(Job).order_by(col(Job.id).desc()).limit(limit)).all()
    return [j.model_dump() for j in rows]
