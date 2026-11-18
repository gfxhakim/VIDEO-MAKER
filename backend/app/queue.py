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

from .config import get_settings
from .db import engine, session_scope
from .models import Job, utcnow

log = logging.getLogger("autoclip.queue")
Handler = Callable[[dict], None]
_handlers: dict[str, Handler] = {}
_failure_hooks: dict[str, Callable[[dict, str], None]] = {}


def register(kind: str, handler: Handler, on_final_failure: Callable[[dict, str], None] | None = None) -> None:
    _handlers[kind] = handler
    if on_final_failure:
        _failure_hooks[kind] = on_final_failure


def enqueue(kind: str, payload: dict[str, Any], *, priority: int = 0, delay_seconds: float = 0, max_attempts: int | None = None) -> int:
    with session_scope() as s:
        job = Job(kind=kind, payload=payload, priority=priority,
                  max_attempts=max_attempts or get_settings().job_max_attempts,
                  run_after=utcnow() + timedelta(seconds=delay_seconds))
        s.add(job)
        s.commit()
        s.refresh(job)
        return job.id


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
    """Jobs left 'running' by a crashed/stopped worker go back to the queue."""
    with session_scope() as s:
        stale = s.exec(select(Job).where(Job.status == "running")).all()
        for j in stale:
            j.status = "queued"
            j.locked_by = None
            s.add(j)
        s.commit()
        return len(stale)


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
        self.concurrency = max(1, concurrency or get_settings().worker_concurrency)
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
