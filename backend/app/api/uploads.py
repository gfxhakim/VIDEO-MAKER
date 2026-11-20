"""Chunked, resumable video uploads.

    POST   /api/uploads                       start, or resume the same file  -> id, chunk_size, received[]
    PUT    /api/uploads/{id}/chunks/{index}   raw bytes of one chunk (safe to repeat)
    GET    /api/uploads/{id}                  which chunks have arrived
    GET    /api/uploads                       my unfinished uploads (resume after a refresh)
    POST   /api/uploads/{id}/complete         every chunk is in -> create the project, start generating
    DELETE /api/uploads/{id}                  cancel and free the space

Why: one giant multipart request has to restart from zero whenever a slow connection
blips, and Railway's proxy only gives a request body 5 minutes to finish. Small chunks
are each a short request, can run in parallel, and are retried on their own.

Bytes are written straight into one file on the data volume at `index * chunk_size`
(no temp copy, no assemble step); `received.map` holds one byte per chunk.
"""
from __future__ import annotations

import errno
import logging
import math
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path as FsPath
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import delete, inspect, update
from sqlmodel import Session, col, select
from starlette.requests import ClientDisconnect

from ..activity import log_activity
from ..auth import request_user_id
from ..config import get_settings
from ..db import get_session, session_scope
from ..models import Project, Upload, User, utcnow
from ..pipeline.ingest import VIDEO_EXTS
from ..pipeline.tasks import project_dir
from ..schemas import GenerationSettings, ProjectOut
from .deps import current_user
from .projects import _start, _validate, needs_start, project_out

router = APIRouter(prefix="/api/uploads", tags=["uploads"])
log = logging.getLogger(__name__)

# Uploads a complete() call in this process is working on right now. A row left in
# 'completing' that is not in here was interrupted (a crash, a failed commit) and can be
# finished or rolled back at once instead of waiting for the next restart.
_working: set[str] = set()
_working_lock = threading.Lock()

UPLOAD_ID = Path(pattern=r"^[0-9a-f]{32}$")  # never a path: only what uuid4().hex can produce
WRITE_BUFFER = 1024 * 1024
MB = 1024 * 1024


class UploadInit(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0)
    fingerprint: str = Field("", max_length=128, pattern=r"^[A-Za-z0-9_.:-]*$")


class UploadComplete(BaseModel):
    settings: Optional[GenerationSettings] = None
    name: Optional[str] = Field(None, max_length=120)
    start: bool = True


class UploadOut(BaseModel):
    id: str
    filename: str
    size: int
    chunk_size: int
    total_chunks: int
    received: list[int]
    received_bytes: int
    status: str
    project_id: Optional[int]
    created_at: datetime
    expires_at: datetime


# ------------------------------------------------------------------ files
def _dir(upload_id: str) -> FsPath:
    return get_settings().uploads_dir / upload_id


def _data(upload_id: str) -> FsPath:
    return _dir(upload_id) / "data.part"


def _map(upload_id: str) -> FsPath:
    return _dir(upload_id) / "received.map"


def _chunk_len(u: Upload, index: int) -> int:
    return min(u.chunk_size, u.size - index * u.chunk_size)


def _received(u: Upload) -> list[int]:
    try:
        raw = _map(u.id).read_bytes()
    except FileNotFoundError:
        return []
    return [i for i, b in enumerate(raw[: u.total_chunks]) if b]


def _received_bytes(u: Upload, received: list[int]) -> int:
    return sum(_chunk_len(u, i) for i in received)


def _pwrite(fd: int, data, offset: int) -> int:
    if hasattr(os, "pwrite"):
        return os.pwrite(fd, data, offset)
    os.lseek(fd, offset, os.SEEK_SET)  # Windows has no pwrite; every request opens its own descriptor
    return os.write(fd, data)


def _mark(upload_id: str, index: int) -> None:
    fd = os.open(_map(upload_id), os.O_WRONLY | getattr(os, "O_BINARY", 0))
    try:
        _pwrite(fd, b"\x01", index)
    finally:
        os.close(fd)


def _pwrite_all(fd: int, data: bytes, offset: int) -> None:
    view = memoryview(data)
    while view:
        n = _pwrite(fd, view, offset)
        view, offset = view[n:], offset + n


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _last_activity(u: Upload) -> float:
    """Last sign of life: a chunk marked, or bytes still arriving (data.part changes at least every 1 MB)."""
    t = _aware(u.updated_at).timestamp()
    for f in (_map(u.id), _data(u.id)):
        try:
            t = max(t, f.stat().st_mtime)
        except OSError:
            pass
    return t


def _on_disk(u: Upload) -> int:
    """Bytes the upload really occupies (its file is sparse until chunks land)."""
    try:
        st = _data(u.id).stat()
    except OSError:
        return 0
    blocks = getattr(st, "st_blocks", None)
    return blocks * 512 if blocks is not None else _received_bytes(u, _received(u))


def _clean_name(name: str) -> str:
    """Display name only (paths are built from the server-made id and a whitelisted extension)."""
    name = re.split(r"[\\/]", name)[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    if len(name) > 200:  # shorten the name, never the extension
        stem, dot, ext = name.rpartition(".")
        name = f"{stem[:199 - len(ext)]}.{ext}" if dot and stem and len(ext) <= 10 else name[:200]
    return name or "upload"


def upload_out(u: Upload) -> UploadOut:
    received = _received(u) if u.status != "completed" else list(range(u.total_chunks))
    ttl = timedelta(hours=get_settings().upload_ttl_hours)
    return UploadOut(
        id=u.id, filename=u.filename, size=u.size, chunk_size=u.chunk_size, total_chunks=u.total_chunks,
        received=received, received_bytes=_received_bytes(u, received), status=u.status, project_id=u.project_id,
        created_at=u.created_at, expires_at=datetime.fromtimestamp(_last_activity(u), timezone.utc) + ttl,
    )


def _discard(session: Session, u: Upload, only: tuple[str, ...] = ("uploading",)) -> bool:
    """Delete the upload, but only if it is still in one of the `only` states (complete() may
    have claimed it since it was read). Commits; the files go only once the row is gone."""
    uid = u.id
    res = session.exec(delete(Upload).where(col(Upload.id) == uid, col(Upload.status).in_(only))
                       .execution_options(synchronize_session=False))
    session.commit()
    if res.rowcount != 1:
        return False
    if inspect(u).persistent:
        session.expunge(u)
    shutil.rmtree(_dir(uid), ignore_errors=True)
    return True


def _recover_one(session: Session, u: Upload) -> None:
    """Finish or roll back an upload left in 'completing' by an interrupted complete()."""
    p = session.get(Project, u.project_id) if u.project_id else None
    dest = get_settings().projects_dir / str(p.id) / f"source{u.ext}" if p else None  # look only, create nothing
    if _data(u.id).exists():  # nothing moved yet: back to 'uploading' (the project made for it goes)
        if p is not None and not p.source_path:
            shutil.rmtree(get_settings().projects_dir / str(p.id), ignore_errors=True)
            session.delete(p)
        u.status, u.project_id = "uploading", None
        session.add(u)
        session.commit()
    elif p is not None and dest is not None and dest.exists():  # moved: finish the bookkeeping
        p.source_path = str(dest)
        u.status, u.updated_at = "completed", utcnow()
        session.add(p)
        session.add(u)
        session.commit()
        shutil.rmtree(_dir(u.id), ignore_errors=True)
    else:
        _discard(session, u, only=("completing",))


def _claim(upload_id: str) -> bool:
    """Only one complete() or repair per upload at a time in this process."""
    with _working_lock:
        if upload_id in _working:
            return False
        _working.add(upload_id)
        return True


def _release(upload_id: str) -> None:
    with _working_lock:
        _working.discard(upload_id)


def _settle(session: Session, u: Upload) -> Upload:
    """A 'completing' row nobody is working on (its complete() was interrupted) is repaired
    before anyone looks at it. Raises if the repair deleted the row."""
    if u.status != "completing" or not _claim(u.id):
        return u
    try:
        session.refresh(u)  # read again now that nobody else can be finishing it
        if u.status == "completing":
            _recover_one(session, u)
            session.refresh(u)
    finally:
        _release(u.id)
    return u


def _mine(session: Session, upload_id: str, user_id: int) -> Upload:
    u = session.get(Upload, upload_id)
    if not u or u.user_id != user_id:  # someone else's upload looks exactly like a missing one
        raise HTTPException(404, "Upload not found (it may have expired). Start again.")
    try:
        return _settle(session, u)
    except Exception:  # noqa: BLE001  (row vanished meanwhile)
        raise HTTPException(404, "Upload not found (it may have expired). Start again.") from None


# ------------------------------------------------------------------ housekeeping
def purge_stale_uploads() -> int:
    """Delete uploads nobody touched for UPLOAD_TTL_HOURS, and folders without a row."""
    s = get_settings()
    cutoff = time.time() - s.upload_ttl_hours * 3600
    removed = 0
    with session_scope() as session:
        rows = session.exec(select(Upload)).all()
        keep = set()
        for u in rows:
            if u.status == "completing":
                keep.add(u.id)
                try:
                    _settle(session, u)  # interrupted ones are repaired; their folder stays either way
                except Exception:  # noqa: BLE001
                    session.rollback()
            elif _last_activity(u) >= cutoff:
                keep.add(u.id)
            elif not _discard(session, u, only=("uploading", "completed")):
                keep.add(u.id)  # claimed by complete() since it was read: not ours to delete
            else:
                removed += 1
    for d in s.uploads_dir.iterdir():
        if d.is_dir() and d.name not in keep and d.stat().st_mtime < cutoff:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed


def recover_uploads() -> None:
    """Startup: finish or roll back every upload a restart caught in the middle of `complete`.

    The file still in the upload folder: nothing moved yet, so it goes back to 'uploading'
    (and the project row made for it, which has no video, is removed). The file already in
    the project folder: the move happened, so the bookkeeping is finished; a repeated
    `complete` from the browser then returns that project and starts it.
    """
    with session_scope() as session:
        for u in session.exec(select(Upload).where(Upload.status == "completing")).all():
            try:
                _settle(session, u)
            except Exception:  # noqa: BLE001
                session.rollback()
                log.exception("could not recover upload %s", u.id)
    purge_stale_uploads()


# ------------------------------------------------------------------ endpoints
@router.post("", response_model=UploadOut)
def init_upload(body: UploadInit, request: Request, user: User = Depends(current_user), session: Session = Depends(get_session)):
    s = get_settings()
    purge_stale_uploads()
    name = _clean_name(body.filename)
    ext = FsPath(name).suffix.lower()
    if ext not in VIDEO_EXTS:
        raise HTTPException(400, f"Unsupported file type '{ext or name}'. Use MP4, MOV, MKV or WEBM.")
    if body.size > s.max_upload_gb * 1024**3:
        raise HTTPException(413, f"File is too large ({body.size / 1024**3:.1f} GB). The limit is {s.max_upload_gb:g} GB.")

    mine = sorted(session.exec(select(Upload).where(Upload.user_id == user.id, Upload.status == "uploading")).all(),
                  key=_last_activity)
    # same file again (page refresh, new tab, another day): carry on where it stopped
    for u in mine:
        if body.fingerprint and u.fingerprint == body.fingerprint and u.size == body.size:
            if _data(u.id).exists() and _map(u.id).exists():
                return upload_out(u)
            _discard(session, u)
            mine.remove(u)
            break
    # keep abandoned partial files from filling the volume: the least recently active go first
    evict = mine[: max(0, len(mine) - s.max_active_uploads + 1)]

    # Space check before anything is deleted, so a refused upload costs nothing. Unfinished
    # uploads reserve what they still need (their files are sparse), except the ones about
    # to be evicted (whose bytes count as free) and ones that never received a byte and
    # show no sign of life for 15 minutes (the app does not list those, so they could block
    # the volume for a whole day). 15 minutes is well above the browser's chunk timeout.
    idle = time.time() - 15 * 60
    dropping = {e.id for e in evict}
    promised = 0
    for o in session.exec(select(Upload).where(Upload.status != "completed")).all():
        if o.id in dropping:
            continue
        got = _received_bytes(o, _received(o))
        if got == 0 and o.status == "uploading" and _last_activity(o) < idle:
            continue
        promised += o.size - got
    free = shutil.disk_usage(s.data_dir).free + sum(_on_disk(e) for e in evict) - promised
    if free < body.size + s.upload_min_free_mb * 1024**2:
        raise HTTPException(
            507, f"Not enough storage on the server: {max(free, 0) / 1024**3:.1f} GB free, this video needs "
                 f"{body.size / 1024**3:.1f} GB. Delete old projects or make the volume bigger.")
    for e in evict:
        _discard(session, e)

    chunk = max(1, s.upload_chunk_mb) * MB
    u = Upload(id=uuid.uuid4().hex, user_id=user.id, filename=name, ext=ext, size=body.size, chunk_size=chunk,
               total_chunks=math.ceil(body.size / chunk), fingerprint=body.fingerprint)
    _dir(u.id).mkdir(parents=True)
    with open(_data(u.id), "wb") as f:
        f.truncate(u.size)  # sparse: takes no space until chunks land
    _map(u.id).write_bytes(bytes(u.total_chunks))
    session.add(u)
    session.commit()
    session.refresh(u)
    log_activity(session, user=user, action="upload_start", target_type="upload", detail=f"Started upload '{name}' ({body.size / 1024**2:.1f} MB)", request=request)
    return upload_out(u)


@router.get("", response_model=list[UploadOut])
def my_uploads(user: User = Depends(current_user), session: Session = Depends(get_session)):
    purge_stale_uploads()
    rows = session.exec(
        select(Upload).where(Upload.user_id == user.id, Upload.status == "uploading").order_by(col(Upload.created_at).desc())
    ).all()
    return [upload_out(u) for u in rows]


@router.get("/{upload_id}", response_model=UploadOut)
def upload_status(upload_id: str = UPLOAD_ID, user: User = Depends(current_user), session: Session = Depends(get_session)):
    return upload_out(_mine(session, upload_id, user.id))


def _load(upload_id: str, user_id: int) -> Upload:
    with session_scope() as session:  # short read; no DB connection is held while the chunk streams in
        u = _mine(session, upload_id, user_id)
        session.expunge(u)
        return u


@router.put("/{upload_id}/chunks/{index}")
async def put_chunk(request: Request, index: int, upload_id: str = UPLOAD_ID):
    # No body parameter on purpose: the session cookie is checked before a single body byte is read.
    user_id = request_user_id(request)
    if user_id is None:
        raise HTTPException(401, "Not signed in")
    u = await run_in_threadpool(_load, upload_id, user_id)
    if u.status != "uploading":
        raise HTTPException(409, "This upload is already finished")
    if not 0 <= index < u.total_chunks:
        raise HTTPException(404, f"Chunk {index} does not exist (this upload has {u.total_chunks})")
    expected = _chunk_len(u, index)
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) != expected:
        raise HTTPException(400, f"Chunk {index} must be exactly {expected} bytes, not {declared}")

    try:
        fd = os.open(_data(u.id), os.O_WRONLY | getattr(os, "O_BINARY", 0))
    except FileNotFoundError:
        await run_in_threadpool(_gone_or_finished, upload_id, user_id)
        raise HTTPException(404, "Upload not found (it may have expired). Start again.") from None
    offset, got, buf = index * u.chunk_size, 0, bytearray()
    try:
        async for block in request.stream():
            got += len(block)
            if got > expected:
                raise HTTPException(400, f"Chunk {index} is larger than {expected} bytes")
            buf += block
            if len(buf) >= WRITE_BUFFER:
                await run_in_threadpool(_pwrite_all, fd, bytes(buf), offset)
                offset += len(buf)
                buf.clear()
        if buf:
            await run_in_threadpool(_pwrite_all, fd, bytes(buf), offset)
    except ClientDisconnect:
        raise HTTPException(400, "Connection lost while receiving the chunk") from None  # nobody is listening; not marked
    except OSError as e:
        if e.errno == errno.ENOSPC:
            raise HTTPException(507, "The server ran out of storage. Delete old projects or make the volume bigger.") from e
        raise
    finally:
        os.close(fd)
    if got != expected:
        raise HTTPException(400, f"Chunk {index}: received {got} bytes, expected {expected}")
    try:
        _mark(u.id, index)  # only now does the chunk count
    except FileNotFoundError:
        await run_in_threadpool(_gone_or_finished, upload_id, user_id)
        raise HTTPException(404, "Upload not found (it was cancelled).") from None
    return {"index": index, "bytes": got}


def _gone_or_finished(upload_id: str, user_id: int) -> None:
    """The bytes vanished under a chunk. If that is because the upload was just finished (from
    another tab, say), answer 409 like any chunk for a finished upload, not 'start again'."""
    try:
        u = _load(upload_id, user_id)
    except HTTPException:
        return
    if u.status != "uploading":
        raise HTTPException(409, "This upload is already finished")


@router.post("/{upload_id}/complete", response_model=ProjectOut)
def complete_upload(body: UploadComplete, request: Request, upload_id: str = UPLOAD_ID, user: User = Depends(current_user),
                    session: Session = Depends(get_session)):
    u = _mine(session, upload_id, user.id)
    if u.status == "completed":  # the client retried after a lost response: same answer, no second project
        p = session.get(Project, u.project_id) if u.project_id else None
        if not p:
            raise HTTPException(404, "Upload not found (it may have expired). Start again.")
        if body.start and p.source_path and needs_start(session, p):  # finished by a recovery, never started
            _start(session, p)
        return project_out(session, p)
    gs = _validate(body.settings or GenerationSettings())
    missing = u.total_chunks - len(_received(u))
    if missing:
        raise HTTPException(409, f"Upload is not finished: {missing} of {u.total_chunks} chunks are missing")
    if not _claim(upload_id):
        raise HTTPException(409, "This upload is already being finished")
    try:
        return _complete(session, u, upload_id, gs, body, user=user, request=request)
    finally:
        _release(upload_id)


def _complete(session: Session, u: Upload, upload_id: str, gs: GenerationSettings, body: UploadComplete, *,
              user: Optional[User] = None, request: Optional[Request] = None) -> ProjectOut:
    claimed = session.exec(update(Upload).where(col(Upload.id) == u.id, col(Upload.status) == "uploading").values(status="completing"))
    session.commit()
    if claimed.rowcount != 1:
        raise HTTPException(409, "This upload is already being finished")

    src = _data(upload_id)
    p: Optional[Project] = None
    try:
        if src.stat().st_size != u.size:
            raise HTTPException(409, "Uploaded file has the wrong size. Start again.")
        with open(src, "rb") as f:
            os.fsync(f.fileno())
        p = Project(user_id=u.user_id, name=(body.name or FsPath(u.filename).stem or "Upload")[:120], source_type="upload", source=u.filename,
                    settings=gs.model_dump())
        session.add(p)
        session.flush()
        u.project_id = p.id  # written with the project, so a restart after the move can finish the job
        session.add(u)
        session.commit()
        session.refresh(p)
        dest = project_dir(p.id) / f"source{u.ext}"
        os.replace(src, dest)  # same volume: a rename, not a second copy of a multi-GB file
        p.source_path = str(dest)
        u.status, u.updated_at = "completed", utcnow()
        session.add(p)
        session.add(u)
        session.commit()
    except BaseException:
        # Undo what did not finish, from what is really in the database and on disk (the
        # session itself may be broken): the file not moved yet -> back to 'uploading', so
        # the client can call complete again; moved -> finish the bookkeeping.
        try:
            session.rollback()
        except Exception:  # noqa: BLE001
            pass
        try:
            with session_scope() as fresh:
                row = fresh.get(Upload, upload_id)
                if row is not None and row.status == "completing":
                    _recover_one(fresh, row)
        except Exception:  # noqa: BLE001
            log.exception("could not undo the failed completion of upload %s", upload_id)
        raise
    shutil.rmtree(_dir(upload_id), ignore_errors=True)
    if body.start:
        _start(session, p)
    log_activity(session, user=user, user_id=u.user_id, action="upload_complete", target_type="project", target_id=p.id, detail=f"Completed upload '{u.filename}' -> project '{p.name}'", request=request)
    return project_out(session, p)


@router.delete("/{upload_id}")
def abort_upload(request: Request, upload_id: str = UPLOAD_ID, user: User = Depends(current_user), session: Session = Depends(get_session)):
    u = session.get(Upload, upload_id)
    if u and u.user_id == user.id:
        was = u.status
        fname = u.filename
        try:
            _settle(session, u)
        except Exception:  # noqa: BLE001  (the repair removed it: nothing left to do)
            return {"ok": True}
        if was == "completing" and u.status == "completed":
            return {"ok": True}  # the video is already in its project: the browser's next complete() starts it
        # being turned into a project right now: left alone. A completed upload only loses its
        # bookkeeping row; the project stays.
        _discard(session, u, only=("uploading", "completed"))
        log_activity(session, user=user, action="upload_cancel", target_type="upload", detail=f"Cancelled upload '{fname}'", request=request)
    return {"ok": True}
