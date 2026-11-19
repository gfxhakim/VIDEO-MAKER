"""Background music library (upload several songs, auto beat/drop analysis, manual drop override)."""
from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlmodel import Session, col, or_, select

from ..config import get_settings
from ..db import get_session
from ..models import Clip, MusicTrack, User
from ..queue import enqueue
from ..schemas import MusicOut, MusicUpdate
from .deps import current_user, media_url, owns

router = APIRouter(prefix="/api/music", tags=["music"], dependencies=[Depends(current_user)])
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"}


def music_out(t: MusicTrack) -> MusicOut:
    return MusicOut(
        id=t.id,
        name=t.name,
        duration=t.duration,
        bpm=t.bpm,
        drop_time=t.drop_time,
        beats=list(t.beats or [])[:400],
        analyzed=t.analyzed,
        url=media_url(t.path) or "",
    )


@router.get("", response_model=list[MusicOut])
def list_music(user: User = Depends(current_user), session: Session = Depends(get_session)):
    rows = session.exec(
        select(MusicTrack)
        .where(or_(MusicTrack.user_id == user.id, col(MusicTrack.user_id).is_(None)))
        .order_by(col(MusicTrack.id).desc())
    ).all()
    return [music_out(t) for t in rows]


@router.post("", response_model=list[MusicOut])
def upload_music(files: list[UploadFile] = File(...), user: User = Depends(current_user), session: Session = Depends(get_session)):
    out = []
    for f in files:
        name = f.filename or "track.mp3"
        ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in AUDIO_EXTS:
            raise HTTPException(400, f"{name}: unsupported audio type")
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", name.rsplit(".", 1)[0])[:60]
        dest = get_settings().music_dir / f"{uuid.uuid4().hex[:8]}_{safe}{ext}"
        with open(dest, "wb") as fh:
            shutil.copyfileobj(f.file, fh)
        t = MusicTrack(user_id=user.id, name=name.rsplit(".", 1)[0][:120], path=str(dest))
        session.add(t)
        session.commit()
        session.refresh(t)
        enqueue("analyze_music", {"track_id": t.id}, priority=20)
        out.append(music_out(t))
    return out


@router.patch("/{tid}", response_model=MusicOut)
def update_music(tid: int, body: MusicUpdate, user: User = Depends(current_user), session: Session = Depends(get_session)):
    t = session.get(MusicTrack, tid)
    if not t or not owns(t, user):
        raise HTTPException(404, "Track not found")
    if body.name is not None:
        t.name = body.name.strip()[:120] or t.name
    if body.drop_time is not None:
        if t.duration and body.drop_time > t.duration:
            raise HTTPException(400, "Drop time cannot be after the end of the track")
        t.drop_time = round(body.drop_time, 3)
    session.add(t)
    session.commit()
    session.refresh(t)
    return music_out(t)


@router.post("/{tid}/reanalyze", response_model=MusicOut)
def reanalyze_music(tid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    t = session.get(MusicTrack, tid)
    if not t or not owns(t, user):
        raise HTTPException(404, "Track not found")
    t.analyzed = False
    session.add(t)
    session.commit()
    enqueue("analyze_music", {"track_id": t.id}, priority=20)
    session.refresh(t)
    return music_out(t)


@router.delete("/{tid}")
def delete_music(tid: int, user: User = Depends(current_user), session: Session = Depends(get_session)):
    t = session.get(MusicTrack, tid)
    if not t or not owns(t, user):
        raise HTTPException(404, "Track not found")
    for c in session.exec(select(Clip).where(Clip.music_track_id == tid)).all():
        c.music_track_id = None
        session.add(c)
    try:
        Path(t.path).unlink(missing_ok=True)
    finally:
        session.delete(t)
        session.commit()
    return {"ok": True}
