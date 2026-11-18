"""Auto-Publish Hub: accounts (OAuth 2.0), schedule queue, publish jobs."""
from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlmodel import Session, col, select

from ..config import get_settings
from ..core.crypto import encrypt
from ..db import get_session
from ..models import Clip, OAuthState, PublishJob, SocialAccount, to_utc, utcnow
from ..publishing.base import PublishError
from ..publishing.service import OAUTH_PROVIDERS, PLATFORM_LABELS, plan_schedule, upsert_accounts
from ..schemas import AccountOut, AccountUpdate, PublishJobOut, PublishJobUpdate, ScheduleRequest
from .deps import media_url

router = APIRouter(prefix="/api", tags=["publish"])


def account_out(a: SocialAccount) -> AccountOut:
    return AccountOut(**a.model_dump(exclude={"access_token_enc", "refresh_token_enc", "extra"}),
                      connected=bool(a.access_token_enc))


@router.get("/platforms")
def platforms():
    """Which OAuth apps are configured on this server (env vars present)."""
    s = get_settings()
    return {
        "dry_run": s.publish_dry_run,
        "redirect_base": s.public_base_url,
        "providers": [
            {"slug": slug, "label": p.label, "configured": p.configured(), "env_keys": list(p.env_keys),
             "redirect_uri": p.redirect_uri(), "docs_url": p.docs_url,
             "platforms": ["instagram", "facebook"] if slug == "meta" else [slug]}
            for slug, p in OAUTH_PROVIDERS.items()
        ],
    }


# ------------------------------------------------------------------ OAuth
@router.get("/oauth/{slug}/start")
def oauth_start(slug: str, redirect: bool = True, session: Session = Depends(get_session)):
    provider = OAUTH_PROVIDERS.get(slug)
    if not provider:
        raise HTTPException(404, "Unknown provider")
    if not provider.configured():
        raise HTTPException(400, f"{provider.label} is not configured. Set {', '.join(provider.env_keys)} in backend/.env")
    # clean old states
    for old in session.exec(select(OAuthState).where(OAuthState.created_at < utcnow() - timedelta(hours=1))).all():
        session.delete(old)
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(64) if slug in ("youtube", "tiktok") else None
    challenge = None
    if verifier:
        digest = hashlib.sha256(verifier.encode()).digest()
        challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
        if slug == "tiktok":  # TikTok expects hex-encoded SHA256 for its PKCE challenge
            challenge = hashlib.sha256(verifier.encode()).hexdigest()
    session.add(OAuthState(state=state, platform=slug, code_verifier=verifier))
    session.commit()
    url = provider.authorize_url(state, challenge)
    return RedirectResponse(url) if redirect else {"url": url}


@router.get("/oauth/{slug}/callback")
def oauth_callback(slug: str, code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None,
                   error_description: Optional[str] = None, session: Session = Depends(get_session)):
    front = get_settings().frontend_url.rstrip("/")
    if error or not code:
        return RedirectResponse(f"{front}/publish?error={error_description or error or 'cancelled'}")
    st = session.get(OAuthState, state or "")
    if not st or st.platform != slug:
        return RedirectResponse(f"{front}/publish?error=invalid_state")
    verifier = st.code_verifier
    session.delete(st)
    session.commit()
    try:
        accounts = OAUTH_PROVIDERS[slug].exchange_code(code, verifier)
    except PublishError as e:
        return RedirectResponse(f"{front}/publish?error={str(e)[:200]}")
    saved = upsert_accounts(session, accounts)
    return RedirectResponse(f"{front}/publish?connected={len(saved)}")


# ------------------------------------------------------------------ accounts
@router.get("/accounts", response_model=list[AccountOut])
def list_accounts(session: Session = Depends(get_session)):
    return [account_out(a) for a in session.exec(select(SocialAccount).order_by(col(SocialAccount.platform), col(SocialAccount.id))).all()]


@router.post("/accounts/sandbox", response_model=AccountOut)
def add_sandbox_account(platform: str = "tiktok", session: Session = Depends(get_session)):
    """Test account for trying the scheduler with PUBLISH_DRY_RUN=true (no real posting)."""
    if not get_settings().publish_dry_run:
        raise HTTPException(400, "Sandbox accounts need PUBLISH_DRY_RUN=true")
    if platform not in PLATFORM_LABELS:
        raise HTTPException(400, "Unknown platform")
    n = len(session.exec(select(SocialAccount).where(SocialAccount.platform == platform)).all()) + 1
    a = SocialAccount(platform=platform, display_name=f"Sandbox {PLATFORM_LABELS[platform]} #{n}",
                      external_id=f"sandbox-{secrets.token_hex(4)}", access_token_enc=encrypt("sandbox"),
                      extra={"sandbox": True}, min_interval_minutes=30)
    session.add(a)
    session.commit()
    session.refresh(a)
    return account_out(a)


@router.patch("/accounts/{aid}", response_model=AccountOut)
def update_account(aid: int, body: AccountUpdate, session: Session = Depends(get_session)):
    a = session.get(SocialAccount, aid)
    if not a:
        raise HTTPException(404, "Account not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(a, k, v)
    session.add(a)
    session.commit()
    session.refresh(a)
    return account_out(a)


@router.delete("/accounts/{aid}")
def delete_account(aid: int, session: Session = Depends(get_session)):
    a = session.get(SocialAccount, aid)
    if not a:
        raise HTTPException(404, "Account not found")
    for pj in session.exec(select(PublishJob).where(PublishJob.account_id == aid)).all():
        session.delete(pj)
    session.delete(a)
    session.commit()
    return {"ok": True}


# ------------------------------------------------------------------ schedule
def job_out(session: Session, pj: PublishJob) -> PublishJobOut:
    a = session.get(SocialAccount, pj.account_id)
    c = session.get(Clip, pj.clip_id)
    return PublishJobOut(
        id=pj.id, clip_id=pj.clip_id, account_id=pj.account_id, platform=a.platform if a else "?",
        account_name=a.display_name if a else "(removed)", clip_title=pj.title or (c.title if c else ""),
        thumb_url=media_url(c.thumb_path) if c else None, scheduled_at=pj.scheduled_at, status=pj.status,
        attempts=pj.attempts, remote_url=pj.remote_url, error=pj.error, published_at=pj.published_at,
    )


@router.post("/publish/schedule", response_model=list[PublishJobOut])
def schedule(body: ScheduleRequest, session: Session = Depends(get_session)):
    try:
        jobs = plan_schedule(session, clip_ids=body.clip_ids, account_ids=body.account_ids, start_at=body.start_at,
                             interval_minutes=body.interval_minutes, account_offset_minutes=body.account_offset_minutes,
                             jitter_minutes=body.jitter_minutes, privacy=body.privacy, publish_now=body.publish_now)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    for cid in body.clip_ids:  # scheduling implies approval
        c = session.get(Clip, cid)
        if c and c.review_status == "pending":
            c.review_status = "approved"
            session.add(c)
    session.commit()
    return [job_out(session, j) for j in jobs]


@router.get("/publish/jobs", response_model=list[PublishJobOut])
def list_publish_jobs(status: Optional[str] = None, limit: int = 300, session: Session = Depends(get_session)):
    q = select(PublishJob)
    if status:
        q = q.where(PublishJob.status == status)
    rows = session.exec(q.order_by(col(PublishJob.scheduled_at)).limit(limit)).all()
    return [job_out(session, j) for j in rows]


@router.patch("/publish/jobs/{jid}", response_model=PublishJobOut)
def update_publish_job(jid: int, body: PublishJobUpdate, session: Session = Depends(get_session)):
    pj = session.get(PublishJob, jid)
    if not pj:
        raise HTTPException(404, "Not found")
    data = body.model_dump(exclude_none=True)
    if "status" in data:
        if data["status"] not in ("cancelled", "scheduled"):
            raise HTTPException(400, "status can only be set to cancelled or scheduled")
        if pj.status in ("publishing", "published"):
            raise HTTPException(409, f"Job is already {pj.status}")
        if data["status"] == "scheduled":
            pj.error = None
    if "scheduled_at" in data:
        data["scheduled_at"] = to_utc(data["scheduled_at"])
    for k, v in data.items():
        setattr(pj, k, v)
    session.add(pj)
    session.commit()
    session.refresh(pj)
    return job_out(session, pj)
