"""Provider registry, token handling, schedule planning and the publish job handler."""
from __future__ import annotations

import logging
import random
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from sqlmodel import Session, select

from ..config import get_settings
from ..core.crypto import decrypt, encrypt
from ..db import session_scope
from ..models import Clip, PublishJob, SocialAccount, to_utc, utcnow
from .base import ConnectedAccount, PostRequest, Provider, PublishError
from .meta import FacebookPublisher, InstagramPublisher, MetaProvider
from .tiktok import TikTokProvider
from .youtube import YouTubeProvider

log = logging.getLogger(__name__)

# OAuth entry points (what the "Connect" buttons use)
OAUTH_PROVIDERS: dict[str, Provider] = {
    "youtube": YouTubeProvider(),
    "tiktok": TikTokProvider(),
    "meta": MetaProvider(),
}
# Publishers per stored account platform
PUBLISHERS: dict[str, Provider] = {
    "youtube": OAUTH_PROVIDERS["youtube"],
    "tiktok": OAUTH_PROVIDERS["tiktok"],
    "instagram": InstagramPublisher(),
    "facebook": FacebookPublisher(),
}
PLATFORM_LABELS = {"youtube": "YouTube Shorts", "tiktok": "TikTok", "instagram": "Instagram Reels", "facebook": "Facebook Reels"}

# Gap kept between any two uploads to the same *platform* (across all accounts),
# so many accounts never hit an API in the same instant.
PLATFORM_GAP_SECONDS = {"youtube": 60, "tiktok": 90, "instagram": 90, "facebook": 60}


def upsert_accounts(session: Session, accounts: list[ConnectedAccount]) -> list[SocialAccount]:
    saved = []
    for a in accounts:
        row = session.exec(select(SocialAccount).where(SocialAccount.platform == a.platform,
                                                       SocialAccount.external_id == a.external_id)).first()
        if not row:
            row = SocialAccount(platform=a.platform, external_id=a.external_id)
            if a.platform == "youtube":  # API quota allows ~6 uploads/day by default
                row.daily_limit = 5
        row.display_name = a.display_name
        row.avatar_url = a.avatar_url
        row.access_token_enc = encrypt(a.access_token)
        if a.refresh_token:
            row.refresh_token_enc = encrypt(a.refresh_token)
        row.token_expires_at = a.expires_at
        row.extra = {**(row.extra or {}), **a.extra}
        session.add(row)
        saved.append(row)
    session.commit()
    return saved


def _fresh_token(session: Session, acc: SocialAccount) -> str:
    token = decrypt(acc.access_token_enc)
    if not token:
        raise PublishError("Account is not connected (missing token). Reconnect it in the Publish Hub.", retryable=False)
    if acc.token_expires_at and acc.token_expires_at < utcnow() + timedelta(minutes=5):
        refresh = decrypt(acc.refresh_token_enc)
        provider = PUBLISHERS[acc.platform]
        if not refresh:
            raise PublishError("Token expired and no refresh token. Reconnect the account.", retryable=False)
        bundle = provider.refresh(refresh)
        if bundle:
            acc.access_token_enc = encrypt(bundle.access_token)
            acc.refresh_token_enc = encrypt(bundle.refresh_token) if bundle.refresh_token else acc.refresh_token_enc
            acc.token_expires_at = utcnow() + timedelta(seconds=bundle.expires_in) if bundle.expires_in else None
            session.add(acc)
            session.commit()
            token = bundle.access_token
    return token


# ------------------------------------------------------------------ planning
def plan_schedule(session: Session, *, clip_ids: list[int], account_ids: list[int], start_at: Optional[datetime],
                  interval_minutes: int, account_offset_minutes: int, jitter_minutes: int, privacy: str,
                  publish_now: bool) -> list[PublishJob]:
    """Spread clips over time per account:

        account k, clip i  ->  start + k*account_offset + i*max(interval, account.min_interval) ± jitter

    then push each slot forward if the account's daily limit would be exceeded. The
    scheduler re-checks every rule at publish time anyway.
    """
    clips = [c for c in (session.get(Clip, cid) for cid in clip_ids) if c and c.status == "ready"]
    accounts = [a for a in (session.get(SocialAccount, aid) for aid in account_ids) if a and a.enabled]
    if not clips:
        raise ValueError("No rendered clips selected")
    if not accounts:
        raise ValueError("No enabled accounts selected")
    base = to_utc(start_at) if start_at else utcnow()
    jobs: list[PublishJob] = []
    for k, acc in enumerate(accounts):
        gap = 0 if publish_now else max(interval_minutes, acc.min_interval_minutes)
        offset = 0 if publish_now else k * account_offset_minutes
        per_day: dict[str, int] = {}
        t = base + timedelta(minutes=offset)
        # each account gets its own clip order so identical videos don't drop everywhere at once
        order = clips[k % len(clips):] + clips[: k % len(clips)]
        for c in order:
            jitter = 0 if publish_now or not jitter_minutes else random.uniform(-jitter_minutes, jitter_minutes)
            slot = max(base, t + timedelta(minutes=jitter))
            while per_day.get(slot.date().isoformat(), 0) >= acc.daily_limit:
                slot = datetime.combine(slot.date() + timedelta(days=1), base.time(), tzinfo=base.tzinfo)
            per_day[slot.date().isoformat()] = per_day.get(slot.date().isoformat(), 0) + 1
            job = PublishJob(clip_id=c.id, account_id=acc.id, scheduled_at=slot, title=c.title,
                             description=c.description, tags=list(c.hashtags), privacy=privacy)
            session.add(job)
            jobs.append(job)
            t = slot + timedelta(minutes=gap)
    session.commit()
    for j in jobs:
        session.refresh(j)
    return jobs


# ------------------------------------------------------------------ execution
def run_publish_job(payload: dict) -> None:
    pj_id = int(payload["publish_job_id"])
    s_cfg = get_settings()
    with session_scope() as s:
        pj = s.get(PublishJob, pj_id)
        if not pj or pj.status in ("published", "cancelled"):
            return
        acc = s.get(SocialAccount, pj.account_id)
        clip = s.get(Clip, pj.clip_id)
        pj.status, pj.attempts = "publishing", pj.attempts + 1
        s.add(pj)
        s.commit()
        if not clip or not clip.video_path or not Path(clip.video_path).exists():
            _finish(pj_id, error="Clip video file is missing", final=True)
            return
        post = PostRequest(video=Path(clip.video_path), title=pj.title or clip.title,
                           description=pj.description or clip.description, tags=list(pj.tags or clip.hashtags),
                           privacy=pj.privacy)
        try:
            if s_cfg.publish_dry_run or (acc.extra or {}).get("sandbox"):
                log.info("[dry-run] would publish clip %s to %s %s", clip.id, acc.platform, acc.display_name)
                fake = secrets.token_hex(6)
                _finish(pj_id, remote_id=f"dryrun-{fake}", url=None)
                return
            token = _fresh_token(s, acc)
            result = PUBLISHERS[acc.platform].publish(access_token=token, external_id=acc.external_id,
                                                      extra=acc.extra or {}, post=post)
        except PublishError as e:
            final = not e.retryable or pj.attempts >= 3
            _finish(pj_id, error=str(e), final=final, retry_minutes=10 * pj.attempts)
            return
        except Exception as e:  # network errors etc.: retry
            _finish(pj_id, error=f"{type(e).__name__}: {e}", final=pj.attempts >= 3, retry_minutes=10 * pj.attempts)
            return
    _finish(pj_id, remote_id=result.remote_id, url=result.url)


def _finish(pj_id: int, *, remote_id: str | None = None, url: str | None = None, error: str | None = None,
            final: bool = True, retry_minutes: int = 10) -> None:
    with session_scope() as s:
        pj = s.get(PublishJob, pj_id)
        if error is None:
            pj.status, pj.remote_id, pj.remote_url, pj.error, pj.published_at = "published", remote_id, url, None, utcnow()
        elif final:
            pj.status, pj.error = "failed", error[-1000:]
        else:  # back to the queue later; the scheduler picks it up again
            pj.status, pj.error = "scheduled", error[-1000:]
            pj.scheduled_at = utcnow() + timedelta(minutes=retry_minutes)
        s.add(pj)
        s.commit()


def fail_publish_job(payload: dict, error: str) -> None:
    _finish(int(payload["publish_job_id"]), error=error, final=True)
