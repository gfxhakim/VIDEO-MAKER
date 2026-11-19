"""Looping B-roll video library for the Speaker + B-Roll split layout."""
from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlmodel import Session, col, or_, select

from ..config import get_settings
from ..db import get_session
from ..models import BrollClip, User
from ..pipeline.ingest import VIDEO_EXTS
from ..pipeline.media import MediaError, probe
from ..schemas import BrollOut
from .deps import current_user, media_url, owns

router = APIRouter(prefix="/api/broll", tags=["broll"], dependencies=[Depends(current_user)])


def broll_out(b: BrollClip) -> BrollOut:
    return BrollOut(
        id=b.id,
        name=b.name,
        duration=b.duration,
        width=b.width,
        height=b.height,
        url=media_url(b.path) or "",
    )


@router.get("", response_model=list[BrollOut])
def list_broll(user: User = Depends(current_user), session: Session = Depends(get_session)):
    rows = session.exec(
        select(BrollClip)
        .where(or_(BrollClip.user_id == user.id, col(BrollClip.user_id).is_(None)))
        .order_by(col(BrollClip.id).desc())
    ).all()
    return [broll_out(b) for b in rows]


@router.post("", response_model=list[BrollOut])
def upload_broll(files: list[UploadFile] = File(...), user: User = Depends(current_user), session: Session = Depends(get_session)):
    out = []
    for f in files:
        name = f.filename or "broll.mp4"
        ext = Path(name).suffix.lower()
        if ext not in VIDEO_EXTS:
            raise HTTPException(400, f"{name}: unsupported video type")
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", Path(name).stem)[:60] or "broll"
        dest = get_settings().broll_dir / f"{uuid.uuid4().hex[:8]}_{safe}{ext}"
        try:
            with open(dest, "wb") as fh:
                shutil.copyfileobj(f.file, fh, length=4 * 1024 * 1024)
            info = probe(dest)
        except (OSError, MediaError) as e:
            dest.unlink(missing_ok=True)
            raise HTTPException(400, f"{name}: {e}") from None
        b = BrollClip(
            user_id=user.id,
            name=Path(name).stem[:120],
            path=str(dest),
            duration=info.duration,
            width=info.width,
            height=info.height,
        )
        session.add(b)
        session.commit()
        session.refresh(b)
        out.append(broll_out(b))
    return out


@router.delete("/{bid}")
def delete_broll(bid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    b = session.get(BrollClip, bid)
    if not b or not owns(b, user):
        raise HTTPException(404, "B-roll clip not found")
    try:
        Path(b.path).unlink(missing_ok=True)
    finally:
        session.delete(b)
        session.commit()
    return {"ok": True}
