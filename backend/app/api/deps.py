"""Helpers shared by routers."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlmodel import Session

from ..auth import request_user_id
from ..config import get_settings
from ..db import get_session
from ..models import User


def media_url(path: Optional[str], version: Optional[float] = None) -> Optional[str]:
    """Map a file inside DATA_DIR to its same-origin /media URL."""
    if not path:
        return None
    try:
        rel = Path(path).resolve().relative_to(get_settings().data_dir)
    except ValueError:
        return None
    url = f"/media/{rel.as_posix()}"
    return f"{url}?v={int(version)}" if version else url


def current_user(request: Request, session: Session = Depends(get_session)) -> User:
    uid = request_user_id(request)
    user = session.get(User, uid) if uid else None
    if not user:
        raise HTTPException(401, "Not signed in")
    return user


def owns(record, user: User) -> bool:
    """True when `record` has no owner (legacy/fixture) or belongs to `user`."""
    uid = getattr(record, "user_id", None)
    return uid is None or uid == user.id
