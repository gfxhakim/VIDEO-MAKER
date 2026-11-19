"""Projects (ingestion + generation) and clips (review / trim / transcript / overrides / publish)."""
from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from sqlmodel import Session, col, or_, select

from ..config import get_settings
from ..db import get_session
from ..models import Clip, Job, MusicTrack, Project, User, utcnow
from ..pipeline import captions, highlights, ingest, llm, media
from ..pipeline.ingest import VIDEO_EXTS
from ..pipeline.publish_kit import PLATFORMS, build_kit, build_zip
from ..pipeline.tasks import project_dir, same_clip, stamp, words_for_clip
from ..presets import ASPECT_RATIOS, caption_styles, editing_styles
from ..queue import cancel_queued, enqueue
from ..schemas import (
    BulkClipAction,
    ClipOut,
    ClipUpdate,
    GenerationSettings,
    ManualClipCreate,
    PostedUpdate,
    ProjectCreateURL,
    ProjectOut,
    ThumbnailCapture,
    URLProbeRequest,
)
from .deps import current_user, media_url, owns

router = APIRouter(prefix="/api", tags=["projects"], dependencies=[Depends(current_user)])


def _validate(settings: GenerationSettings) -> GenerationSettings:
    if settings.editing_style not in editing_styles():
        raise HTTPException(400, f"Unknown editing_style '{settings.editing_style}'")
    if settings.caption_style not in caption_styles() and settings.caption_style != "none":
        raise HTTPException(400, f"Unknown caption_style '{settings.caption_style}'")
    if settings.aspect_ratio not in ASPECT_RATIOS:
        raise HTTPException(400, f"Unknown aspect_ratio '{settings.aspect_ratio}'")
    return settings


def _require_project(session: Session, pid: int, user: User) -> Project:
    p = session.get(Project, pid)
    if not p or not owns(p, user):
        raise HTTPException(404, "Project not found")
    return p


def _require_clip(session: Session, cid: int, user: User) -> tuple[Clip, Project]:
    c = session.get(Clip, cid)
    if not c:
        raise HTTPException(404, "Clip not found")
    p = session.get(Project, c.project_id)
    if not p or not owns(p, user):
        raise HTTPException(404, "Clip not found")
    return c, p


def project_out(session: Session, p: Project) -> ProjectOut:
    clips = session.exec(select(Clip).where(Clip.project_id == p.id)).all()
    ready = [c for c in clips if c.status == "ready"]
    best = max(ready, key=lambda c: c.score) if ready else None
    return ProjectOut(
        **p.model_dump(exclude={"source_path", "updated_at", "user_id"}),
        clip_count=len(clips),
        ready_count=len(ready),
        thumb_url=media_url(best.thumb_path) if best else None,
    )


def clip_out(c: Clip) -> ClipOut:
    v = c.updated_at.timestamp() if c.updated_at else None
    return ClipOut(
        **c.model_dump(exclude={"video_path", "thumb_path", "created_at", "updated_at", "words_override"}),
        duration=round(c.end - c.start, 2),
        video_url=media_url(c.video_path, v),
        thumb_url=media_url(c.thumb_path, v),
        has_words_override=bool(c.words_override),
    )


def _start(session: Session, p: Project, mode: str = "rescore") -> None:
    p.status, p.stage, p.progress, p.error, p.updated_at = "queued", "Waiting for worker", 0.0, None, utcnow()
    session.add(p)
    enqueue("analyze_project", {"project_id": p.id, "created": stamp(p.created_at), "mode": mode}, priority=10, session=session)
    session.commit()


def needs_start(session: Session, p: Project) -> bool:
    if p.status == "draft":
        return True
    if p.status != "queued":
        return False
    live = session.exec(select(Job).where(Job.kind == "analyze_project", col(Job.status).in_(("queued", "running")))).all()
    return not any(j.payload.get("project_id") == p.id for j in live)


# ------------------------------------------------------------------ projects
@router.get("/projects", response_model=list[ProjectOut])
def list_projects(user: User = Depends(current_user), session: Session = Depends(get_session)):
    rows = session.exec(
        select(Project)
        .where(or_(Project.user_id == user.id, col(Project.user_id).is_(None)))
        .order_by(col(Project.id).desc())
    ).all()
    return [project_out(session, p) for p in rows]


@router.post("/projects/probe-url")
def probe_link(body: URLProbeRequest):
    """Inspect a remote video link before downloading."""
    try:
        return ingest.probe_url(body.url)
    except media.MediaError as e:
        raise HTTPException(400, str(e)) from None


@router.post("/projects", response_model=ProjectOut)
def create_from_link(body: ProjectCreateURL, start: bool = True, user: User = Depends(current_user),
                     session: Session = Depends(get_session)):
    if not body.url and not body.path:
        raise HTTPException(400, "Provide a url or a local path")
    if body.url:
        try:
            clean_url = ingest.validate_url_syntax(body.url)
        except media.MediaError as e:
            raise HTTPException(400, str(e)) from None
        src_type, src = "url", clean_url
    else:
        src_type, src = "path", body.path.strip()  # type: ignore[union-attr]
    if body.source_start is not None and body.source_end is not None and body.source_end <= body.source_start + 8:
        raise HTTPException(400, "Selected source range must be at least 8 seconds long")
    settings = _validate(body.settings or GenerationSettings())
    p = Project(
        user_id=user.id,
        name=body.name or src.rsplit("/", 1)[-1][:120],
        source_type=src_type,
        source=src,
        source_start=body.source_start,
        source_end=body.source_end,
        settings=settings.model_dump(),
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    if start:
        _start(session, p)
    return project_out(session, p)


@router.post("/projects/upload", response_model=ProjectOut)
def create_from_upload(file: UploadFile = File(...), settings: Optional[str] = Form(None), name: Optional[str] = Form(None),
                       start: bool = Form(True), user: User = Depends(current_user), session: Session = Depends(get_session)):
    try:
        gs = _validate(GenerationSettings(**json.loads(settings)) if settings else GenerationSettings())
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"Invalid settings: {e}") from e
    fname = re.split(r"[\\/]", file.filename or "upload.mp4")[-1] or "upload.mp4"
    ext = Path(fname).suffix.lower()
    if ext not in VIDEO_EXTS:
        raise HTTPException(400, f"Unsupported file type '{ext or fname}'. Use MP4, MOV, MKV or WEBM.")
    s_cfg = get_settings()
    if shutil.disk_usage(s_cfg.data_dir).free < s_cfg.upload_min_free_mb * 1024**2:
        raise HTTPException(507, "The server ran out of storage. Delete old projects or make the volume bigger.")
    p = Project(user_id=user.id, name=name or Path(fname).stem[:120], source_type="upload", source=fname, settings=gs.model_dump())
    session.add(p)
    session.commit()
    session.refresh(p)
    dest = project_dir(p.id) / f"source{ext}"
    try:
        with open(dest, "wb") as out:
            shutil.copyfileobj(file.file, out, length=8 * 1024 * 1024)
    except OSError:
        shutil.rmtree(project_dir(p.id), ignore_errors=True)
        session.delete(p)
        session.commit()
        raise HTTPException(507, "The server ran out of storage. Delete old projects or make the volume bigger.") from None
    p.source_path = str(dest)
    session.add(p)
    session.commit()
    if start:
        _start(session, p)
    return project_out(session, p)


@router.get("/projects/{pid}", response_model=ProjectOut)
def get_project(pid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    p = _require_project(session, pid, user)
    return project_out(session, p)


@router.post("/projects/{pid}/generate", response_model=ProjectOut)
def generate(pid: int, body: Optional[dict[str, Any]] = Body(default=None), user: User = Depends(current_user),
             session: Session = Depends(get_session)):
    """(Re)run generation. Accepts either {settings, mode: 'rescore'|'restyle'} or bare GenerationSettings."""
    p = _require_project(session, pid, user)
    if p.status == "processing" or (p.status == "queued" and not needs_start(session, p)):
        raise HTTPException(409, "Project is already processing")
    mode = "rescore"
    settings_obj: Optional[GenerationSettings] = None
    if body:
        if "settings" in body or "mode" in body:
            mode = body.get("mode", "rescore")
            if mode not in ("rescore", "restyle"):
                raise HTTPException(400, "mode must be 'rescore' or 'restyle'")
            if body.get("settings") is not None:
                settings_obj = GenerationSettings(**body["settings"])
        else:
            settings_obj = GenerationSettings(**body)
    if settings_obj:
        p.settings = _validate(settings_obj).model_dump()
    if mode == "restyle" and p.source_deleted:
        raise HTTPException(400, "Raw source video was deleted; cannot re-render clips")
    _start(session, p, mode=mode)
    return project_out(session, p)


@router.post("/projects/{pid}/prune-source")
def prune_source(pid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    """Delete the large raw source file while keeping rendered clips and cached transcript."""
    p = _require_project(session, pid, user)
    if p.status in ("queued", "processing"):
        raise HTTPException(409, "Wait until the project finishes processing before removing the source video")
    freed = 0
    if p.source_path:
        sp = Path(p.source_path)
        if sp.exists() and sp.is_file():
            freed = sp.stat().st_size
            sp.unlink(missing_ok=True)
    p.source_deleted = True
    p.updated_at = utcnow()
    session.add(p)
    session.commit()
    return {"ok": True, "freed_bytes": freed}


@router.delete("/projects/{pid}")
def delete_project(pid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    p = _require_project(session, pid, user)
    clips: dict[int, str] = {}
    for c in session.exec(select(Clip).where(Clip.project_id == pid)).all():
        clips[c.id] = stamp(c.created_at)
        session.delete(c)
    created = stamp(p.created_at)
    session.delete(p)
    session.commit()
    cancel_queued("analyze_project", lambda pl: pl.get("project_id") == pid and pl.get("created", created) == created)
    cancel_queued("render_clip", lambda pl: same_clip(pl, clips))
    shutil.rmtree(project_dir(pid), ignore_errors=True)
    return {"ok": True}


@router.get("/projects/{pid}/transcript")
def get_transcript(pid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    """Return cached transcript sentences + words for browsing and manual clip creation."""
    p = _require_project(session, pid, user)
    tpath = project_dir(p.id) / "transcript.json"
    if not tpath.exists():
        return {"language": "", "sentences": [], "words": []}
    try:
        tr = json.loads(tpath.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"language": "", "sentences": [], "words": []}
    words = tr.get("words") or []
    sents = [
        {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text}
        for s in highlights.build_sentences(words)
    ]
    return {"language": tr.get("language", ""), "sentences": sents, "words": words}


@router.post("/projects/{pid}/clips", response_model=ClipOut)
def create_manual_clip(pid: int, body: ManualClipCreate, user: User = Depends(current_user),
                       session: Session = Depends(get_session)):
    """Create a custom clip at [start, end] and queue it for rendering."""
    p = _require_project(session, pid, user)
    if p.source_deleted or not p.source_path or not Path(p.source_path).exists():
        raise HTTPException(400, "Raw source video is not available on disk")
    if body.end <= body.start + 1.0:
        raise HTTPException(400, "Clip must be at least 1 second long")
    if p.duration and body.end > p.duration + 0.5:
        raise HTTPException(400, f"Clip end exceeds video duration ({p.duration:.1f}s)")
    pdir = project_dir(p.id)
    tpath = pdir / "transcript.json"
    all_words = []
    if tpath.exists():
        try:
            all_words = json.loads(tpath.read_text(encoding="utf-8")).get("words", [])
        except (OSError, ValueError):
            pass
    words = captions.clip_words(all_words, body.start, body.end)
    text = " ".join(w["word"] for w in words).strip()
    existing = session.exec(select(Clip).where(Clip.project_id == pid)).all()
    next_rank = max((c.rank for c in existing), default=0) + 1
    music_ids = list((p.settings or {}).get("music_track_ids") or [])
    title = (body.title or "").strip() or highlights.make_title("", text)
    hook = (body.hook or "").strip() or title[:90]
    clip = Clip(
        project_id=pid,
        rank=next_rank,
        start=round(body.start, 3),
        end=round(body.end, 3),
        score=80.0,
        score_breakdown={"manual": 1.0},
        transcript=text,
        hook=hook,
        title=title,
        hashtags=highlights.make_hashtags(text),
        description=(text[:280] + ("…" if len(text) > 280 else "")) if text else "",
        music_track_id=music_ids[0] if music_ids else None,
        status="pending",
    )
    session.add(clip)
    session.commit()
    session.refresh(clip)
    enqueue("render_clip", {"clip_id": clip.id, "created": stamp(clip.created_at)}, priority=8)
    return clip_out(clip)


# ------------------------------------------------------------------ clips
@router.get("/projects/{pid}/clips", response_model=list[ClipOut])
def list_clips(pid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    _require_project(session, pid, user)
    rows = session.exec(select(Clip).where(Clip.project_id == pid).order_by(col(Clip.rank))).all()
    return [clip_out(c) for c in rows]


@router.get("/clips", response_model=list[ClipOut])
def all_ready_clips(
    review_status: Optional[str] = None,
    project_id: Optional[int] = None,
    q: Optional[str] = None,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    allowed_pids = session.exec(
        select(Project.id).where(or_(Project.user_id == user.id, col(Project.user_id).is_(None)))
    ).all()
    if not allowed_pids:
        return []
    stmt = select(Clip).where(Clip.status == "ready", col(Clip.project_id).in_(allowed_pids))
    if project_id is not None:
        stmt = stmt.where(Clip.project_id == project_id)
    if review_status:
        stmt = stmt.where(Clip.review_status == review_status)
    rows = session.exec(stmt.order_by(col(Clip.id).desc())).all()
    if q and q.strip():
        term = q.strip().lower()
        rows = [
            c for c in rows
            if term in c.title.lower()
            or term in c.description.lower()
            or term in c.transcript.lower()
            or any(term in tag.lower() for tag in (c.hashtags or []))
        ]
    return [clip_out(c) for c in rows]


@router.post("/clips/bulk")
def bulk_clips(body: BulkClipAction, user: User = Depends(current_user), session: Session = Depends(get_session)):
    """Bulk approve / reject / reset / delete / rerender clips."""
    updated = 0
    for cid in body.clip_ids:
        c = session.get(Clip, cid)
        if not c:
            continue
        p = session.get(Project, c.project_id)
        if not p or not owns(p, user):
            continue
        if body.action in ("approve", "reject", "pending"):
            c.review_status = {"approve": "approved", "reject": "rejected", "pending": "pending"}[body.action]
            c.updated_at = utcnow()
            session.add(c)
            updated += 1
        elif body.action == "delete":
            cstamp = stamp(c.created_at)
            session.delete(c)
            session.commit()
            cancel_queued("render_clip", lambda pl, id_=cid, st_=cstamp: pl.get("clip_id") == id_ and pl.get("created", st_) == st_)
            shutil.rmtree(project_dir(p.id) / "clips" / str(cid), ignore_errors=True)
            updated += 1
            continue
        elif body.action == "rerender":
            if p.source_deleted:
                continue
            c.status, c.error = "pending", None
            c.updated_at = utcnow()
            session.add(c)
            cancel_queued("render_clip", lambda pl, id_=cid: pl.get("clip_id") == id_)
            enqueue("render_clip", {"clip_id": c.id, "created": stamp(c.created_at)}, priority=8, session=session)
            updated += 1
    session.commit()
    return {"ok": True, "count": updated}


@router.get("/clips/{cid}/words")
def get_clip_words(cid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    c, _ = _require_clip(session, cid, user)
    return {"words": words_for_clip(c, project_dir(c.project_id)), "is_override": bool(c.words_override)}


@router.patch("/clips/{cid}", response_model=ClipOut)
def update_clip(cid: int, body: ClipUpdate, user: User = Depends(current_user), session: Session = Depends(get_session)):
    c, p = _require_clip(session, cid, user)
    data = body.model_dump(exclude_none=True)
    if "review_status" in data and data["review_status"] not in ("pending", "approved", "rejected"):
        raise HTTPException(400, "review_status must be pending|approved|rejected")
    if "hashtags" in data:
        data["hashtags"] = [t if t.startswith("#") else f"#{t}" for t in (h.strip() for h in data["hashtags"]) if t]

    new_start = data.pop("start", c.start)
    new_end = data.pop("end", c.end)
    if new_end <= new_start + 1.0:
        raise HTTPException(400, "Clip duration must be at least 1 second")
    if p.duration and new_end > p.duration + 0.5:
        raise HTTPException(400, f"Clip end cannot exceed video duration ({p.duration:.1f}s)")
    if new_start != c.start or new_end != c.end:
        c.start = round(float(new_start), 3)
        c.end = round(float(new_end), 3)
        if "words_override" not in data:
            c.words_override = None
            tpath = project_dir(p.id) / "transcript.json"
            if tpath.exists():
                try:
                    all_words = json.loads(tpath.read_text(encoding="utf-8")).get("words", [])
                    ws = captions.clip_words(all_words, c.start, c.end)
                    c.transcript = " ".join(w["word"] for w in ws)
                except (OSError, ValueError):
                    pass

    if data.pop("clear_music", False):
        c.music_track_id = None
        data.pop("music_track_id", None)
    elif "music_track_id" in data:
        mt = session.get(MusicTrack, data["music_track_id"])
        if not mt or not owns(mt, user):
            raise HTTPException(404, "Music track not found")

    if "words_override" in data:
        cleaned_words = [
            {"word": str(w.get("word", "")).strip(), "start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3)}
            for w in data.pop("words_override")
            if str(w.get("word", "")).strip()
        ]
        c.words_override = cleaned_words or None
        if cleaned_words:
            c.transcript = " ".join(w["word"] for w in cleaned_words)

    if "overrides" in data:
        ov = dict(data.pop("overrides") or {})
        if "editing_style" in ov and ov["editing_style"] not in editing_styles():
            raise HTTPException(400, f"Unknown editing_style '{ov['editing_style']}'")
        if "caption_style" in ov and ov["caption_style"] not in caption_styles() and ov["caption_style"] != "none":
            raise HTTPException(400, f"Unknown caption_style '{ov['caption_style']}'")
        if "aspect_ratio" in ov and ov["aspect_ratio"] not in ASPECT_RATIOS:
            raise HTTPException(400, f"Unknown aspect_ratio '{ov['aspect_ratio']}'")
        c.overrides = {**dict(c.overrides or {}), **ov}

    for k, v in data.items():
        setattr(c, k, v)
    c.updated_at = utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return clip_out(c)


@router.delete("/clips/{cid}")
def delete_clip(cid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    c, p = _require_clip(session, cid, user)
    cstamp = stamp(c.created_at)
    session.delete(c)
    session.commit()
    cancel_queued("render_clip", lambda pl: pl.get("clip_id") == cid and pl.get("created", cstamp) == cstamp)
    shutil.rmtree(project_dir(p.id) / "clips" / str(cid), ignore_errors=True)
    return {"ok": True}


@router.post("/clips/{cid}/rerender", response_model=ClipOut)
def rerender_clip(cid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    c, p = _require_clip(session, cid, user)
    if p.source_deleted:
        raise HTTPException(400, "Raw source video was deleted; cannot re-render this clip")
    c.status, c.error = "pending", None
    session.add(c)
    if p.status in ("done", "failed"):
        p.status, p.stage = "processing", "Re-rendering clip"
        session.add(p)
    session.commit()
    cancel_queued("render_clip", lambda pl: pl.get("clip_id") == cid)
    enqueue("render_clip", {"clip_id": c.id, "created": stamp(c.created_at)}, priority=8)
    return clip_out(c)


@router.post("/clips/{cid}/ai-copy", response_model=ClipOut)
def ai_rewrite_clip(cid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    c, _ = _require_clip(session, cid, user)
    try:
        res = llm.rewrite_clip_copy(c.transcript, c.title)
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from None
    if res["title"]:
        c.title = res["title"]
    if res["hook"]:
        c.hook = res["hook"]
    if res["description"]:
        c.description = res["description"]
    if res["hashtags"]:
        c.hashtags = res["hashtags"]
    c.updated_at = utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return clip_out(c)


@router.post("/clips/{cid}/thumbnail", response_model=ClipOut)
def capture_thumbnail(cid: int, body: ThumbnailCapture, user: User = Depends(current_user),
                      session: Session = Depends(get_session)):
    """Update the clip's cover image to a specific timestamp inside the rendered video."""
    c, p = _require_clip(session, cid, user)
    if not c.video_path or not Path(c.video_path).exists():
        raise HTTPException(404, "Clip not rendered yet")
    thumb_path = Path(c.thumb_path) if c.thumb_path else (project_dir(p.id) / "clips" / str(cid) / "thumb.jpg")
    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    dur = max(0.1, c.end - c.start)
    at = max(0.0, min(dur - 0.1, body.at))
    try:
        media.make_thumbnail(c.video_path, thumb_path, at=at)
    except media.MediaError as e:
        raise HTTPException(500, str(e)) from None
    c.thumb_path = str(thumb_path)
    c.updated_at = utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return clip_out(c)


@router.get("/clips/{cid}/thumbnail")
def download_thumbnail(cid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    c, _ = _require_clip(session, cid, user)
    if not c.thumb_path or not Path(c.thumb_path).exists():
        raise HTTPException(404, "Thumbnail not found")
    safe = re.sub(r"[^A-Za-z0-9 _-]", "", c.title)[:60].strip() or f"clip-{cid}"
    return FileResponse(c.thumb_path, media_type="image/jpeg", filename=f"{safe}.jpg")


@router.get("/clips/{cid}/subtitles/{fmt}")
def download_subtitles(cid: int, fmt: str, user: User = Depends(current_user), session: Session = Depends(get_session)):
    if fmt not in ("srt", "vtt"):
        raise HTTPException(400, "Format must be srt or vtt")
    c, _ = _require_clip(session, cid, user)
    words = words_for_clip(c, project_dir(c.project_id))
    content = captions.build_srt(words) if fmt == "srt" else captions.build_vtt(words)
    safe = re.sub(r"[^A-Za-z0-9 _-]", "", c.title)[:60].strip() or f"clip-{cid}"
    return PlainTextResponse(
        content,
        media_type="text/vtt; charset=utf-8" if fmt == "vtt" else "application/x-subrip; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe}.{fmt}"'},
    )


@router.get("/clips/{cid}/download")
def download_clip(cid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    c, _ = _require_clip(session, cid, user)
    if not c.video_path or not Path(c.video_path).exists():
        raise HTTPException(404, "Clip not rendered")
    safe = re.sub(r"[^A-Za-z0-9 _-]", "", c.title)[:60].strip() or f"clip-{cid}"
    return FileResponse(c.video_path, media_type="video/mp4", filename=f"{safe}.mp4")


# ------------------------------------------------------------------ manual publishing
@router.get("/clips/{cid}/kit")
def clip_kit(cid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    c, _ = _require_clip(session, cid, user)
    return build_kit(c.title, c.description, c.hashtags)


@router.post("/clips/{cid}/posted", response_model=ClipOut)
def mark_posted(cid: int, body: PostedUpdate, user: User = Depends(current_user), session: Session = Depends(get_session)):
    if body.platform not in PLATFORMS:
        raise HTTPException(400, f"platform must be one of {', '.join(PLATFORMS)}")
    c, _ = _require_clip(session, cid, user)
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
def export_zip(pid: int, background: BackgroundTasks, scope: str = "approved", subtitles: bool = True,
               user: User = Depends(current_user), session: Session = Depends(get_session)):
    p = _require_project(session, pid, user)
    q = select(Clip).where(Clip.project_id == pid, Clip.status == "ready")
    if scope == "approved":
        q = q.where(Clip.review_status == "approved")
    clips = session.exec(q.order_by(col(Clip.rank))).all()
    if not clips:
        raise HTTPException(404, "No clips to export" + (" (approve some first)" if scope == "approved" else ""))
    tmp = get_settings().data_dir / "tmp"
    tmp.mkdir(exist_ok=True)
    pdir = project_dir(pid)
    dest = build_zip(
        clips,
        tmp / f"export-{pid}-{uuid.uuid4().hex[:8]}.zip",
        clip_words_fn=(lambda cl: words_for_clip(cl, pdir)) if subtitles else None,
    )
    background.add_task(dest.unlink, missing_ok=True)
    name = re.sub(r"[^A-Za-z0-9 _-]", "", p.name)[:50].strip() or f"project-{pid}"
    return FileResponse(dest, media_type="application/zip", filename=f"{name} - clips.zip")


@router.get("/jobs")
def list_jobs(limit: int = 50, session: Session = Depends(get_session)):
    rows = session.exec(select(Job).order_by(col(Job.id).desc()).limit(limit)).all()
    return [j.model_dump() for j in rows]
