"""Background music library (upload several songs, auto beat/drop analysis)."""
from __future__ import annotations

import re
import shutil
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlmodel import Session, col, select

from ..config import get_settings
from ..db import get_session
from ..models import MusicTrack
from ..queue import enqueue
from ..schemas import MusicOut
from .deps import media_url

router = APIRouter(prefix="/api/music", tags=["music"])
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"}


def music_out(t: MusicTrack) -> MusicOut:
    return MusicOut(id=t.id, name=t.name, duration=t.duration, bpm=t.bpm, drop_time=t.drop_time, analyzed=t.analyzed,
                    url=media_url(t.path) or "")


@router.get("", response_model=list[MusicOut])
def list_music(session: Session = Depends(get_session)):
    return [music_out(t) for t in session.exec(select(MusicTrack).order_by(col(MusicTrack.id).desc())).all()]


@router.post("", response_model=list[MusicOut])
def upload_music(files: list[UploadFile] = File(...), session: Session = Depends(get_session)):
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
        t = MusicTrack(name=name.rsplit(".", 1)[0][:120], path=str(dest))
        session.add(t)
        session.commit()
        session.refresh(t)
        enqueue("analyze_music", {"track_id": t.id}, priority=20)
        out.append(music_out(t))
    return out


@router.delete("/{tid}")
def delete_music(tid: int, session: Session = Depends(get_session)):
    t = session.get(MusicTrack, tid)
    if not t:
        raise HTTPException(404, "Track not found")
    try:
        from pathlib import Path

        Path(t.path).unlink(missing_ok=True)
    finally:
        session.delete(t)
        session.commit()
    return {"ok": True}
