"""Storage metrics, job queue actions, and runtime Brand / AI configuration."""
from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, col, or_, select

from ..activity import log_activity
from ..config import get_settings, load_runtime_config, save_runtime_config
from ..db import get_session
from ..models import Job, Project, User, utcnow
from ..pipeline import llm
from ..schemas import RuntimeConfigUpdate
from .deps import current_user

router = APIRouter(prefix="/api", tags=["system"], dependencies=[Depends(current_user)])


def _dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            pass
    return total


@router.get("/system/storage")
def storage_overview(user: User = Depends(current_user), session: Session = Depends(get_session)):
    s = get_settings()
    usage = shutil.disk_usage(s.data_dir)
    rows = session.exec(
        select(Project)
        .where(or_(Project.user_id == user.id, col(Project.user_id).is_(None)))
        .order_by(col(Project.id).desc())
    ).all()
    projects = []
    for p in rows:
        pdir = s.projects_dir / str(p.id)
        src_bytes = 0
        if p.source_path and Path(p.source_path).exists():
            try:
                src_bytes = Path(p.source_path).stat().st_size
            except OSError:
                pass
        clips_bytes = _dir_bytes(pdir / "clips")
        total_bytes = _dir_bytes(pdir)
        projects.append({
            "id": p.id,
            "name": p.name,
            "status": p.status,
            "source_deleted": p.source_deleted,
            "source_bytes": src_bytes,
            "clips_bytes": clips_bytes,
            "total_bytes": total_bytes,
        })
    return {
        "disk": {"total": usage.total, "used": usage.used, "free": usage.free},
        "music_bytes": _dir_bytes(s.music_dir),
        "broll_bytes": _dir_bytes(s.broll_dir),
        "uploads_bytes": _dir_bytes(s.uploads_dir),
        "models_bytes": _dir_bytes(s.models_dir),
        "projects": projects,
    }


@router.get("/settings")
def get_runtime_settings():
    cfg = load_runtime_config()
    return {
        "default_watermark_text": cfg.get("default_watermark_text", ""),
        "default_watermark_position": cfg.get("default_watermark_position", "bottom_right"),
        "llm_base_url": cfg.get("llm_base_url", ""),
        "llm_model": cfg.get("llm_model", "gpt-4o-mini"),
        "llm_has_key": bool((cfg.get("llm_api_key") or "").strip()),
        "llm_configured": llm.is_configured(),
    }


@router.put("/settings")
def update_runtime_settings(
    body: RuntimeConfigUpdate,
    request: Request,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    patch = body.model_dump(exclude_none=True)
    # Keep existing API key if UI sends empty placeholder unless explicitly clearing base_url
    if patch.get("llm_api_key") == "" and patch.get("llm_base_url", "x") != "":
        patch.pop("llm_api_key", None)
    save_runtime_config(patch)
    log_activity(session, user=user, action="settings_update", target_type="settings", detail="Updated Brand / AI settings", request=request)
    return get_runtime_settings()


@router.post("/settings/test-llm")
def test_llm_connection():
    try:
        return llm.test_connection()
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from None


@router.post("/jobs/{jid}/retry")
def retry_job(jid: int, request: Request, user: User = Depends(current_user), session: Session = Depends(get_session)):
    j = session.get(Job, jid)
    if not j:
        raise HTTPException(404, "Job not found")
    if j.status == "running":
        raise HTTPException(409, "Job is already running")
    j.status = "queued"
    j.attempts = 0
    j.error = None
    j.run_after = utcnow()
    j.finished_at = None
    session.add(j)
    session.commit()
    log_activity(session, user=user, action="job_retry", target_type="job", target_id=j.id, detail=f"Retried job #{j.id} ({j.kind})", request=request)
    return j.model_dump()


@router.post("/jobs/{jid}/cancel")
def cancel_job(jid: int, request: Request, user: User = Depends(current_user), session: Session = Depends(get_session)):
    j = session.get(Job, jid)
    if not j:
        raise HTTPException(404, "Job not found")
    if j.status == "queued":
        j.status = "cancelled"
        j.finished_at = utcnow()
        j.error = "Cancelled by user"
        session.add(j)
        session.commit()
        log_activity(session, user=user, action="job_cancel", target_type="job", target_id=j.id, detail=f"Cancelled job #{j.id} ({j.kind})", request=request)
    return j.model_dump()
