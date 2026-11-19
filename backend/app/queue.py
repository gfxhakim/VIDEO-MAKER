"""A small, durable job queue on top of SQLite.

Why not Celery? Celery needs Redis/RabbitMQ running next to the app. This queue gives
the same guarantees we need for a single machine (durable jobs, retries with backoff,
crash recovery, N parallel workers) with zero extra services. Run the worker either
inside the API (EMBEDDED_WORKER=true) or as its own process: `python -m app.worker`.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
import time
import traceback
from datetime import timedelta
from typing import Any, Callable

from sqlalchemy import text
from sqlmodel import select

from .config import get_settings, worker_count
from .db import engine, session_scope
from .models import Job, utcnow

log = logging.getLogger("autoclip.queue")
Handler = Callable[[dict], None]
INTERRUPTED_ERROR = ("The server restarted while this was running, several times in a row. "
                     "It may have run out of memory: try a shorter video or fewer clips.")
_handlers: dict[str, Handler] = {}
_failure_hooks: dict[str, Callable[[dict, str], None]] = {}


def register(kind: str, handler: Handler, on_final_failure: Callable[[dict, str], None] | None = None) -> None:
    _handlers[kind] = handler
    if on_final_failure:
        _failure_hooks[kind] = on_final_failure


def enqueue(kind: str, payload: dict[str, Any], *, priority: int = 0, delay_seconds: float = 0, max_attempts: int | None = None,
            session=None) -> int | None:
    """Queue a job. With `session`, the job is only added to it, so it is saved in the same
    commit as the caller's own changes (both or neither); the id is then not known yet."""
    job = Job(kind=kind, payload=payload, priority=priority,
              max_attempts=max_attempts or get_settings().job_max_attempts,
              run_after=utcnow() + timedelta(seconds=delay_seconds))
    if session is not None:
        session.add(job)
        return None
    with session_scope() as s:
        s.add(job)
        s.commit()
        s.refresh(job)
        return job.id


def cancel_queued(kind: str, match: Callable[[dict], bool]) -> int:
    """Cancel jobs of `kind` that have not started yet and whose payload matches.
    Running jobs are left alone (they check for themselves whether their work still matters)."""
    with session_scope() as s:
        ids = []
        for j in s.exec(select(Job).where(Job.kind == kind, Job.status == "queued")).all():
            try:
                if match(dict(j.payload or {})):
                    ids.append(j.id)
            except Exception:  # noqa: BLE001
                pass
    if not ids:
        return 0
    now = utcnow().replace(tzinfo=None).isoformat(sep=" ")
    with engine.begin() as conn:  # only jobs still queued: one a worker claimed meanwhile keeps running
        res = conn.execute(
            text("UPDATE job SET status='cancelled', finished_at=:now, error='No longer needed' "
                 "WHERE status='queued' AND id IN (" + ",".join(str(int(i)) for i in ids) + ")"),
            {"now": now},
        )
    return res.rowcount or 0


def _claim(worker_id: str) -> Job | None:
    """Atomically claim the next runnable job (single UPDATE ... RETURNING)."""
    now = utcnow().replace(tzinfo=None).isoformat(sep=" ")  # SQLite stores UTC without offset
    with engine.begin() as conn:
        row = conn.execute(
            text(
                """
                UPDATE job SET status='running', locked_by=:w, started_at=:now, attempts=attempts+1
                WHERE id = (
                    SELECT id FROM job WHERE status='queued' AND run_after <= :now
                    ORDER BY priority DESC, id ASC LIMIT 1
                ) RETURNING id
                """
            ),
            {"w": worker_id, "now": now},
        ).first()
    if not row:
        return None
    with session_scope() as s:
        return s.get(Job, row[0])


def recover_stale_jobs() -> int:
    """Jobs left 'running' by a crashed/stopped worker go back to the queue.

    A job that has already used every attempt is failed instead. Without this a job that
    kills the whole process (out of memory on a very long video, say) would be picked up
    again on every restart, forever.
    """
    requeued = 0
    dead: list[tuple[str, dict]] = []
    with session_scope() as s:
        stale = s.exec(select(Job).where(Job.status == "running")).all()
        for j in stale:
            j.locked_by = None
            if j.attempts >= j.max_attempts:
                j.status, j.finished_at = "failed", utcnow()
                j.error = (j.error or "") or INTERRUPTED_ERROR
                dead.append((j.kind, dict(j.payload or {})))
            else:
                j.status = "queued"
                requeued += 1
            s.add(j)
        s.commit()
    for kind, payload in dead:
        log.error("job of kind %s was interrupted on its last attempt; marking it failed", kind)
        hook = _failure_hooks.get(kind)
        if hook:
            try:
                hook(payload, INTERRUPTED_ERROR)
            except Exception:  # noqa: BLE001
                log.exception("failure hook crashed")
    return requeued


def _run_one(job: Job) -> None:
    handler = _handlers.get(job.kind)
    try:
        if not handler:
            raise RuntimeError(f"No handler registered for job kind '{job.kind}'")
        handler(job.payload)
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {e}"
        log.error("job %s (%s) failed attempt %s: %s\n%s", job.id, job.kind, job.attempts, err, traceback.format_exc())
        retry = job.attempts < job.max_attempts and not isinstance(e, (FileNotFoundError,))
        with session_scope() as s:
            j = s.get(Job, job.id)
            j.error = err[-2000:]
            if retry:
                j.status = "queued"
                j.run_after = utcnow() + timedelta(seconds=15 * (2 ** (j.attempts - 1)))  # 15s, 30s, 60s...
            else:
                j.status = "failed"
                j.finished_at = utcnow()
            s.add(j)
            s.commit()
        if not retry and job.kind in _failure_hooks:
            try:
                _failure_hooks[job.kind](job.payload, err)
            except Exception:  # noqa: BLE001
                log.exception("failure hook crashed")
        return
    with session_scope() as s:
        j = s.get(Job, job.id)
        j.status, j.finished_at, j.error = "done", utcnow(), None
        s.add(j)
        s.commit()


class Worker:
    def __init__(self, concurrency: int | None = None):
        self.concurrency = max(1, concurrency or worker_count())
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.id = f"{socket.gethostname()}:{os.getpid()}"

    def _loop(self, n: int) -> None:
        wid = f"{self.id}:{n}"
        poll = get_settings().worker_poll_seconds
        while not self._stop.is_set():
            try:
                job = _claim(wid)
            except Exception:  # noqa: BLE001  (db busy etc.)
                log.exception("claim failed")
                job = None
            if job is None:
                self._stop.wait(poll)
                continue
            log.info("[%s] running job %s %s", wid, job.id, job.kind)
            _run_one(job)

    def start(self) -> None:
        recovered = recover_stale_jobs()
        if recovered:
            log.info("re-queued %s interrupted job(s)", recovered)
        for i in range(self.concurrency):
            t = threading.Thread(target=self._loop, args=(i,), daemon=True, name=f"worker-{i}")
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()

    def run_forever(self) -> None:
        self.start()
        try:
            while not self._stop.is_set():
                time.sleep(1)
        except KeyboardInterrupt:
            self.stop()
