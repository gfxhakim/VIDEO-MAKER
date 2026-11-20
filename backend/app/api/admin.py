"""Admin Panel API: live user activity feed, user management, project/queue oversight, signup toggle."""
from __future__ import annotations

import re
import shutil
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlmodel import Session, col, func, or_, select

from ..activity import as_utc, log_activity
from ..auth import hash_password
from ..config import get_settings, is_signup_open, save_runtime_config, save_ytdlp_cookies
from ..db import get_session
from ..models import ActivityLog, BrollClip, Clip, Job, MusicTrack, Project, Upload, User, utcnow
from ..pipeline.tasks import project_dir, same_clip, stamp
from ..queue import cancel_queued
from .deps import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

ONLINE_WINDOW_SECONDS = 300


class AdminUserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=6, max_length=200)
    name: str = Field("", max_length=80)
    role: Literal["user", "admin"] = "user"


class AdminUserUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=80)
    role: Optional[Literal["user", "admin"]] = None
    is_active: Optional[bool] = None
    new_password: Optional[str] = Field(None, min_length=6, max_length=200)


class AdminSettingsUpdate(BaseModel):
    allow_signup: Optional[bool] = None
    ytdlp_cookies: Optional[str] = Field(None, max_length=500_000)


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


def _file_bytes(path_str: Optional[str]) -> int:
    if not path_str:
        return 0
    try:
        p = Path(path_str)
        return p.stat().st_size if p.is_file() else 0
    except OSError:
        return 0


def _is_online(u: User, now) -> bool:
    seen = as_utc(u.last_seen_at)
    return bool(seen and (now - seen).total_seconds() <= ONLINE_WINDOW_SECONDS)


def _safe_unlink_within(path_str: Optional[str], parent_dir: Path) -> None:
    if not path_str:
        return
    try:
        p = Path(path_str).resolve()
        parent_dir.resolve()
        if p.is_relative_to(parent_dir.resolve()):
            p.unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


@router.get("/overview")
def admin_overview(session: Session = Depends(get_session)):
    s = get_settings()
    now = utcnow()
    users = session.exec(select(User)).all()
    projects = session.exec(select(Project)).all()
    clips = session.exec(select(Clip)).all()
    jobs = session.exec(select(Job)).all()
    cutoff_24h = now - timedelta(hours=24)
    activity_24h = session.exec(
        select(func.count()).select_from(ActivityLog).where(ActivityLog.created_at >= cutoff_24h)
    ).one()
    usage = shutil.disk_usage(s.data_dir)
    return {
        "users": {
            "total": len(users),
            "active": sum(1 for u in users if u.is_active),
            "suspended": sum(1 for u in users if not u.is_active),
            "admins": sum(1 for u in users if u.role == "admin"),
            "online_now": sum(1 for u in users if u.is_active and _is_online(u, now)),
        },
        "projects": {
            "total": len(projects),
            "processing": sum(1 for p in projects if p.status == "processing"),
            "queued": sum(1 for p in projects if p.status == "queued"),
            "done": sum(1 for p in projects if p.status == "done"),
            "failed": sum(1 for p in projects if p.status == "failed"),
        },
        "clips": {
            "total": len(clips),
            "ready": sum(1 for c in clips if c.status == "ready"),
            "approved": sum(1 for c in clips if c.review_status == "approved"),
        },
        "jobs": {
            "queued": sum(1 for j in jobs if j.status == "queued"),
            "running": sum(1 for j in jobs if j.status == "running"),
            "failed": sum(1 for j in jobs if j.status == "failed"),
        },
        "activity_24h": int(activity_24h or 0),
        "storage": {
            "disk_total": usage.total,
            "disk_used": usage.used,
            "disk_free": usage.free,
            "data_dir_bytes": _dir_bytes(s.data_dir),
        },
        "signup_open": is_signup_open(),
        "ytdlp_cookies_configured": bool(s.effective_ytdlp_cookies_path()),
    }


@router.get("/users")
def list_users(q: str = "", session: Session = Depends(get_session)):
    s = get_settings()
    now = utcnow()
    query = select(User)
    if q.strip():
        needle = f"%{q.strip().lower()}%"
        query = query.where(or_(func.lower(User.email).like(needle), func.lower(User.name).like(needle)))
    users = session.exec(query.order_by(col(User.last_seen_at).desc(), col(User.id).asc())).all()

    projects = session.exec(select(Project)).all()
    clips = session.exec(select(Clip)).all()
    tracks = session.exec(select(MusicTrack)).all()
    brolls = session.exec(select(BrollClip)).all()
    uploads = session.exec(select(Upload)).all()

    proj_by_user: dict[int, list[Project]] = {}
    proj_owner: dict[int, int] = {}
    for p in projects:
        if p.user_id is not None:
            proj_by_user.setdefault(p.user_id, []).append(p)
            proj_owner[p.id] = p.user_id

    clip_counts: dict[int, int] = {}
    for c in clips:
        uid = proj_owner.get(c.project_id)
        if uid is not None:
            clip_counts[uid] = clip_counts.get(uid, 0) + 1

    music_by_user: dict[int, list[MusicTrack]] = {}
    for t in tracks:
        if t.user_id is not None:
            music_by_user.setdefault(t.user_id, []).append(t)

    broll_by_user: dict[int, list[BrollClip]] = {}
    for b in brolls:
        if b.user_id is not None:
            broll_by_user.setdefault(b.user_id, []).append(b)

    uploads_by_user: dict[int, list[Upload]] = {}
    for up in uploads:
        uploads_by_user.setdefault(up.user_id, []).append(up)

    # Latest activity + count per user
    act_counts = {
        uid: int(cnt)
        for uid, cnt in session.exec(
            select(ActivityLog.user_id, func.count()).where(col(ActivityLog.user_id).is_not(None)).group_by(ActivityLog.user_id)
        ).all()
    }
    recent_logs = session.exec(
        select(ActivityLog).where(col(ActivityLog.user_id).is_not(None)).order_by(col(ActivityLog.id).desc()).limit(500)
    ).all()
    latest_action: dict[int, dict[str, Any]] = {}
    for row in recent_logs:
        if row.user_id is not None and row.user_id not in latest_action:
            latest_action[row.user_id] = {
                "action": row.action,
                "detail": row.detail,
                "target_type": row.target_type,
                "target_id": row.target_id,
                "created_at": row.created_at,
            }

    out = []
    for u in users:
        u_projs = proj_by_user.get(u.id, [])
        u_music = music_by_user.get(u.id, [])
        u_broll = broll_by_user.get(u.id, [])
        u_ups = uploads_by_user.get(u.id, [])
        storage = sum(_dir_bytes(s.projects_dir / str(p.id)) for p in u_projs)
        storage += sum(_file_bytes(t.path) for t in u_music)
        storage += sum(_file_bytes(b.path) for b in u_broll)
        storage += sum(_dir_bytes(s.uploads_dir / up.id) for up in u_ups if up.status != "completed")
        out.append({
            "id": u.id,
            "email": u.email,
            "name": u.name or u.email.split("@")[0],
            "role": u.role or "user",
            "is_active": bool(u.is_active),
            "online": bool(u.is_active) and _is_online(u, now),
            "created_at": u.created_at,
            "last_login_at": u.last_login_at,
            "last_seen_at": u.last_seen_at,
            "last_ip": u.last_ip,
            "project_count": len(u_projs),
            "clip_count": clip_counts.get(u.id, 0),
            "music_count": len(u_music),
            "broll_count": len(u_broll),
            "storage_bytes": storage,
            "activity_count": act_counts.get(u.id, 0),
            "last_action": latest_action.get(u.id),
        })
    return out


@router.post("/users")
def create_user(
    body: AdminUserCreate,
    request: Request,
    admin: User = Depends(require_admin),
    session: Session = Depends(get_session),
):
    email = body.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(400, "Enter a valid email address")
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(409, "An account with this email already exists")
    u = User(
        email=email,
        name=body.name.strip(),
        password_hash=hash_password(body.password),
        role=body.role,
        is_active=True,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    log_activity(
        session,
        user=admin,
        action="admin_user_create",
        target_type="user",
        target_id=u.id,
        detail=f"Created user {u.email} ({u.role})",
        request=request,
    )
    return {
        "id": u.id,
        "email": u.email,
        "name": u.name or u.email.split("@")[0],
        "role": u.role,
        "is_active": u.is_active,
        "created_at": u.created_at,
    }


@router.patch("/users/{uid}")
def update_user(
    uid: int,
    body: AdminUserUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    session: Session = Depends(get_session),
):
    u = session.get(User, uid)
    if not u:
        raise HTTPException(404, "User not found")
    admin_count = session.exec(select(func.count()).select_from(User).where(User.role == "admin", User.is_active == True)).one()  # noqa: E712
    changes: list[str] = []

    if body.role is not None and body.role != u.role:
        if u.id == admin.id and body.role != "admin":
            raise HTTPException(400, "You cannot remove your own admin role")
        if u.role == "admin" and body.role != "admin" and admin_count <= 1:
            raise HTTPException(400, "Cannot demote the last active admin")
        u.role = body.role
        changes.append(f"role={body.role}")

    if body.is_active is not None and body.is_active != u.is_active:
        if u.id == admin.id and not body.is_active:
            raise HTTPException(400, "You cannot suspend your own account")
        if u.role == "admin" and not body.is_active and admin_count <= 1:
            raise HTTPException(400, "Cannot suspend the last active admin")
        u.is_active = body.is_active
        changes.append("activated" if body.is_active else "suspended")

    if body.name is not None:
        u.name = body.name.strip()
        changes.append("name")

    if body.new_password:
        u.password_hash = hash_password(body.new_password)
        changes.append("password_reset")

    session.add(u)
    session.commit()
    session.refresh(u)
    if changes:
        log_activity(
            session,
            user=admin,
            action="admin_user_update",
            target_type="user",
            target_id=u.id,
            detail=f"Updated {u.email}: {', '.join(changes)}",
            request=request,
        )
    return {
        "id": u.id,
        "email": u.email,
        "name": u.name or u.email.split("@")[0],
        "role": u.role,
        "is_active": bool(u.is_active),
    }


@router.delete("/users/{uid}")
def delete_user(
    uid: int,
    request: Request,
    admin: User = Depends(require_admin),
    session: Session = Depends(get_session),
):
    if uid == admin.id:
        raise HTTPException(400, "You cannot delete your own active admin account")
    u = session.get(User, uid)
    if not u:
        raise HTTPException(404, "User not found")
    if u.role == "admin":
        admin_count = session.exec(select(func.count()).select_from(User).where(User.role == "admin")).one()
        if admin_count <= 1:
            raise HTTPException(400, "Cannot delete the last admin account")

    s = get_settings()
    email = u.email
    projects_to_clean: list[tuple[int, str, dict[int, str]]] = []
    for p in session.exec(select(Project).where(Project.user_id == uid)).all():
        clips_map: dict[int, str] = {}
        for c in session.exec(select(Clip).where(Clip.project_id == p.id)).all():
            clips_map[c.id] = stamp(c.created_at)
            session.delete(c)
        projects_to_clean.append((p.id, stamp(p.created_at), clips_map))
        session.delete(p)

    upload_ids: list[str] = []
    for up in session.exec(select(Upload).where(Upload.user_id == uid)).all():
        upload_ids.append(up.id)
        session.delete(up)

    music_paths: list[str] = []
    for t in session.exec(select(MusicTrack).where(MusicTrack.user_id == uid)).all():
        music_paths.append(t.path)
        session.delete(t)

    broll_paths: list[str] = []
    for b in session.exec(select(BrollClip).where(BrollClip.user_id == uid)).all():
        broll_paths.append(b.path)
        session.delete(b)

    session.delete(u)
    session.commit()

    for pid, created_stamp, clips_map in projects_to_clean:
        cancel_queued("analyze_project", lambda pl, pid=pid, cs=created_stamp: pl.get("project_id") == pid and pl.get("created", cs) == cs)
        cancel_queued("render_clip", lambda pl, cm=clips_map: same_clip(pl, cm))
        shutil.rmtree(project_dir(pid), ignore_errors=True)
    for up_id in upload_ids:
        shutil.rmtree(s.uploads_dir / up_id, ignore_errors=True)
    for mp in music_paths:
        _safe_unlink_within(mp, s.music_dir)
    for bp in broll_paths:
        _safe_unlink_within(bp, s.broll_dir)

    log_activity(
        session,
        user=admin,
        action="admin_user_delete",
        target_type="user",
        target_id=uid,
        detail=f"Deleted user {email} ({len(projects_to_clean)} projects)",
        request=request,
    )
    return {"ok": True}


@router.get("/activity")
def list_activity(
    user_id: Optional[int] = None,
    action: str = "",
    q: str = "",
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    stmt = select(ActivityLog)
    count_stmt = select(func.count()).select_from(ActivityLog)
    if user_id is not None:
        stmt = stmt.where(ActivityLog.user_id == user_id)
        count_stmt = count_stmt.where(ActivityLog.user_id == user_id)
    if action.strip():
        act = action.strip()
        stmt = stmt.where(ActivityLog.action == act)
        count_stmt = count_stmt.where(ActivityLog.action == act)
    if q.strip():
        needle = f"%{q.strip().lower()}%"
        cond = or_(
            func.lower(ActivityLog.user_email).like(needle),
            func.lower(ActivityLog.action).like(needle),
            func.lower(ActivityLog.detail).like(needle),
            func.lower(ActivityLog.ip).like(needle),
        )
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)

    total = int(session.exec(count_stmt).one() or 0)
    rows = session.exec(stmt.order_by(col(ActivityLog.id).desc()).offset(offset).limit(limit)).all()
    users = {u.id: u for u in session.exec(select(User)).all()}
    distinct_actions = [
        a for a in session.exec(select(ActivityLog.action).distinct().order_by(ActivityLog.action)).all() if a
    ]
    items = []
    for r in rows:
        u = users.get(r.user_id) if r.user_id is not None else None
        items.append({
            "id": r.id,
            "user_id": r.user_id,
            "user_email": r.user_email or (u.email if u else ""),
            "user_name": (u.name or u.email.split("@")[0]) if u else (r.user_email.split("@")[0] if r.user_email else "Unknown"),
            "user_role": u.role if u else None,
            "action": r.action,
            "target_type": r.target_type,
            "target_id": r.target_id,
            "detail": r.detail,
            "ip": r.ip,
            "user_agent": r.user_agent,
            "created_at": r.created_at,
        })
    return {"items": items, "total": total, "actions": distinct_actions}


@router.get("/projects")
def list_all_projects(
    user_id: Optional[int] = None,
    status: str = "",
    limit: int = Query(100, ge=1, le=300),
    session: Session = Depends(get_session),
):
    stmt = select(Project)
    if user_id is not None:
        stmt = stmt.where(Project.user_id == user_id)
    if status.strip():
        stmt = stmt.where(Project.status == status.strip())
    projects = session.exec(stmt.order_by(col(Project.id).desc()).limit(limit)).all()
    users = {u.id: u for u in session.exec(select(User)).all()}
    clips = session.exec(select(Clip)).all()
    counts: dict[int, tuple[int, int]] = {}
    for c in clips:
        tot, rdy = counts.get(c.project_id, (0, 0))
        counts[c.project_id] = (tot + 1, rdy + (1 if c.status == "ready" else 0))
    s = get_settings()
    out = []
    for p in projects:
        u = users.get(p.user_id) if p.user_id is not None else None
        tot, rdy = counts.get(p.id, (0, 0))
        out.append({
            "id": p.id,
            "name": p.name,
            "owner": {"id": u.id, "email": u.email, "name": u.name or u.email.split("@")[0]} if u else None,
            "source_type": p.source_type,
            "source": p.source,
            "status": p.status,
            "stage": p.stage,
            "progress": p.progress,
            "duration": p.duration,
            "clip_count": tot,
            "ready_count": rdy,
            "storage_bytes": _dir_bytes(s.projects_dir / str(p.id)),
            "created_at": p.created_at,
            "updated_at": p.updated_at,
        })
    return out


@router.delete("/projects/{pid}")
def admin_delete_project(
    pid: int,
    request: Request,
    admin: User = Depends(require_admin),
    session: Session = Depends(get_session),
):
    p = session.get(Project, pid)
    if not p:
        raise HTTPException(404, "Project not found")
    owner = session.get(User, p.user_id) if p.user_id is not None else None
    pname = p.name
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
    log_activity(
        session,
        user=admin,
        action="admin_project_delete",
        target_type="project",
        target_id=pid,
        detail=f"Deleted project '{pname}'" + (f" (owner: {owner.email})" if owner else ""),
        request=request,
    )
    return {"ok": True}


@router.get("/jobs")
def list_all_jobs(limit: int = Query(60, ge=1, le=200), session: Session = Depends(get_session)):
    jobs = session.exec(select(Job).order_by(col(Job.id).desc()).limit(limit)).all()
    projects = {p.id: p for p in session.exec(select(Project)).all()}
    users = {u.id: u for u in session.exec(select(User)).all()}
    out = []
    for j in jobs:
        pid = j.payload.get("project_id") if isinstance(j.payload, dict) else None
        p = projects.get(pid) if isinstance(pid, int) else None
        u = users.get(p.user_id) if p and p.user_id is not None else None
        out.append({
            "id": j.id,
            "kind": j.kind,
            "status": j.status,
            "attempts": j.attempts,
            "max_attempts": j.max_attempts,
            "error": j.error,
            "project_id": pid,
            "project_name": p.name if p else None,
            "owner_email": u.email if u else None,
            "created_at": j.created_at,
            "started_at": j.started_at,
            "finished_at": j.finished_at,
        })
    return out


def _admin_settings_out() -> dict[str, Any]:
    from datetime import datetime, timezone

    s = get_settings()
    cp = s.effective_ytdlp_cookies_path()
    source = None
    updated_at = None
    if cp is not None:
        source = "env_file" if (s.ytdlp_cookies_file and cp == Path(s.ytdlp_cookies_file).expanduser()) else "saved"
        try:
            updated_at = datetime.fromtimestamp(cp.stat().st_mtime, tz=timezone.utc).isoformat()
        except OSError:
            pass
    return {
        "allow_signup": is_signup_open(),
        "ytdlp_cookies_configured": cp is not None,
        "ytdlp_cookies_source": source,
        "ytdlp_cookies_updated_at": updated_at,
    }


@router.get("/settings")
def get_admin_settings():
    return _admin_settings_out()


@router.put("/settings")
def update_admin_settings(
    body: AdminSettingsUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    session: Session = Depends(get_session),
):
    notes: list[str] = []
    if body.allow_signup is not None:
        save_runtime_config({"allow_signup": body.allow_signup})
        notes.append(f"allow_signup={body.allow_signup}")
    if body.ytdlp_cookies is not None:
        saved = save_ytdlp_cookies(body.ytdlp_cookies)
        notes.append("ytdlp_cookies=saved" if saved else "ytdlp_cookies=cleared")
    if notes:
        log_activity(
            session,
            user=admin,
            action="admin_settings_update",
            target_type="settings",
            detail=", ".join(notes),
            request=request,
        )
    return _admin_settings_out()
