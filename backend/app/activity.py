"""Per-user activity tracking and live presence helpers."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import Request
from sqlmodel import Session

from .models import ActivityLog, User, utcnow

log = logging.getLogger("autoclip.activity")


def as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Attach UTC tzinfo when SQLite returns naive datetimes."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def client_ip(request: Optional[Request]) -> str:
    if request is None:
        return ""
    xff = (request.headers.get("x-forwarded-for") or "").strip()
    if xff:
        return xff.split(",")[0].strip()[:64]
    xri = (request.headers.get("x-real-ip") or "").strip()
    if xri:
        return xri[:64]
    if request.client and request.client.host:
        return str(request.client.host)[:64]
    return ""


def client_ua(request: Optional[Request]) -> str:
    if request is None:
        return ""
    return (request.headers.get("user-agent") or "").strip()[:240]


def touch_user_seen(session: Session, user: User, request: Optional[Request] = None) -> None:
    """Throttled update of user.last_seen_at / user.last_ip (at most once per ~60s)."""
    now = utcnow()
    last = as_utc(user.last_seen_at)
    ip = client_ip(request)
    elapsed = (now - last).total_seconds() if last else 9999.0
    if elapsed < 60.0 and (not ip or ip == user.last_ip):
        return
    try:
        user.last_seen_at = now
        if ip:
            user.last_ip = ip
        session.add(user)
        session.commit()
    except Exception:
        session.rollback()


def log_activity(
    session: Session,
    *,
    user: Optional[User] = None,
    user_id: Optional[int] = None,
    user_email: str = "",
    action: str,
    target_type: str = "",
    target_id: Optional[int] = None,
    detail: str = "",
    request: Optional[Request] = None,
    commit: bool = True,
) -> None:
    """Append an entry to ActivityLog without breaking the caller's workflow on errors."""
    try:
        uid = user.id if user is not None else user_id
        uemail = (user.email if user is not None else user_email) or ""
        entry = ActivityLog(
            user_id=uid,
            user_email=uemail[:200],
            action=action[:80],
            target_type=target_type[:40],
            target_id=target_id,
            detail=(detail or "")[:500],
            ip=client_ip(request),
            user_agent=client_ua(request),
        )
        session.add(entry)
        if commit:
            session.commit()
    except Exception as exc:
        log.warning("failed to write activity log (%s): %s", action, exc)
        try:
            session.rollback()
        except Exception:
            pass
