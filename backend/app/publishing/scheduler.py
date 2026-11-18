"""Publish scheduler: every tick, hand due posts to the worker queue, but only when
it is safe for that account and platform.

Anti-spam rules enforced at publish time (on top of the planned schedule):
  * per account:  at least `min_interval_minutes` between posts
  * per account:  at most `daily_limit` posts in any rolling 24 h
  * per platform: PLATFORM_GAP_SECONDS between any two uploads (all accounts)
  * one in-flight upload per account
A post that breaks a rule is moved to the earliest allowed time (+ small random jitter).
"""
from __future__ import annotations

import logging
import random
import threading
from datetime import timedelta

from sqlmodel import col, func, select

from ..config import get_settings
from ..db import session_scope
from ..models import PublishJob, SocialAccount, utcnow
from ..queue import enqueue
from .service import PLATFORM_GAP_SECONDS

log = logging.getLogger("autoclip.scheduler")


def tick() -> int:
    now = utcnow()
    dispatched = 0
    with session_scope() as s:
        due = s.exec(select(PublishJob).where(PublishJob.status == "scheduled", PublishJob.scheduled_at <= now)
                     .order_by(col(PublishJob.scheduled_at))).all()
        platform_last: dict[str, object] = {}
        for pj in due:
            acc = s.get(SocialAccount, pj.account_id)
            if not acc or not acc.enabled:
                pj.status, pj.error = "failed", "Account disabled or removed"
                s.add(pj)
                continue
            # in-flight on this account?
            busy = s.exec(select(func.count()).select_from(PublishJob).where(
                PublishJob.account_id == acc.id, PublishJob.status == "publishing")).one()
            last = s.exec(select(func.max(PublishJob.published_at)).where(
                PublishJob.account_id == acc.id, PublishJob.status == "published")).one()
            day_count = s.exec(select(func.count()).select_from(PublishJob).where(
                PublishJob.account_id == acc.id, PublishJob.status == "published",
                PublishJob.published_at >= now - timedelta(hours=24))).one()
            next_ok = now
            if busy:
                next_ok = now + timedelta(minutes=2)
            if last and last + timedelta(minutes=acc.min_interval_minutes) > next_ok:
                next_ok = last + timedelta(minutes=acc.min_interval_minutes)
            if day_count >= acc.daily_limit:
                oldest = s.exec(select(func.min(PublishJob.published_at)).where(
                    PublishJob.account_id == acc.id, PublishJob.status == "published",
                    PublishJob.published_at >= now - timedelta(hours=24))).one()
                next_ok = max(next_ok, (oldest or now) + timedelta(hours=24))
            gap = PLATFORM_GAP_SECONDS.get(acc.platform, 60)
            pl = platform_last.get(acc.platform)
            if pl and pl + timedelta(seconds=gap) > next_ok:
                next_ok = pl + timedelta(seconds=gap)
            if next_ok > now:
                pj.scheduled_at = next_ok + timedelta(seconds=random.randint(5, 120))
                s.add(pj)
                continue
            pj.status = "publishing"
            s.add(pj)
            s.commit()
            platform_last[acc.platform] = now
            enqueue("publish", {"publish_job_id": pj.id}, priority=5, max_attempts=1)
            dispatched += 1
        s.commit()
    return dispatched


class Scheduler:
    def __init__(self):
        self._stop = threading.Event()

    def _loop(self):
        every = get_settings().scheduler_tick_seconds
        while not self._stop.is_set():
            try:
                n = tick()
                if n:
                    log.info("dispatched %s publish job(s)", n)
            except Exception:  # noqa: BLE001
                log.exception("scheduler tick failed")
            self._stop.wait(every)

    def start(self):
        threading.Thread(target=self._loop, daemon=True, name="publish-scheduler").start()

    def stop(self):
        self._stop.set()
