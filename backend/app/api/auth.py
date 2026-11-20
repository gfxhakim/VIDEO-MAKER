"""Sign-in, visitor sign-up, and admin bootstrap."""
from __future__ import annotations

import logging
import os
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlmodel import Session, func, select

from ..activity import client_ip, log_activity
from ..auth import COOKIE, hash_password, make_session, request_user_id, verify_password
from ..config import get_settings, is_signup_open
from ..db import get_session, session_scope
from ..models import User, utcnow
from .deps import current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])
log = logging.getLogger("autoclip.auth")


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=6, max_length=200)
    name: str = Field("", max_length=80)


class SignInCredentials(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=6, max_length=200)


def _user_out(u: User) -> dict:
    return {
        "id": u.id,
        "email": u.email,
        "name": u.name or u.email.split("@")[0],
        "role": u.role or "user",
        "is_active": bool(u.is_active),
        "created_at": u.created_at,
        "last_login_at": u.last_login_at,
        "last_seen_at": u.last_seen_at,
    }


def _set_cookie(request: Request, response: Response, user_id: int) -> None:
    token, max_age = make_session(user_id)
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, token, max_age=max_age, httponly=True, samesite="lax", secure=secure, path="/")


def bootstrap_admin() -> None:
    """Ensure an admin account exists on startup.

    1. If ADMIN_EMAIL & ADMIN_PASSWORD are set (e.g. Railway Variables), create/promote & sync that admin.
    2. Else if users already exist on an upgraded DB without any admin, promote user #1 to admin.
    3. Else in production (outside pytest), auto-create one-time credentials into DATA_DIR/admin_credentials.txt
       and log them clearly on stdout so random visitors cannot claim admin first.
    """
    s = get_settings()
    s.ensure_dirs()
    with session_scope() as session:
        env_email = (s.admin_email or "").strip().lower()
        env_password = (s.admin_password or "").strip()
        if env_email and env_password:
            if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", env_email):
                log.warning("ADMIN_EMAIL (%r) is not a valid email; skipping admin bootstrap.", env_email)
                return
            u = session.exec(select(User).where(User.email == env_email)).first()
            if u:
                changed = False
                if u.role != "admin":
                    u.role = "admin"
                    changed = True
                if not u.is_active:
                    u.is_active = True
                    changed = True
                if not verify_password(env_password, u.password_hash):
                    u.password_hash = hash_password(env_password)
                    changed = True
                if not u.name and s.admin_name:
                    u.name = s.admin_name.strip()
                    changed = True
                if changed:
                    session.add(u)
                    session.commit()
                log.info("Admin account ready from ADMIN_EMAIL: %s", env_email)
            else:
                u = User(
                    email=env_email,
                    name=(s.admin_name or "Admin").strip() or "Admin",
                    password_hash=hash_password(env_password),
                    role="admin",
                    is_active=True,
                )
                session.add(u)
                session.commit()
                log.info("Created bootstrap admin account from ADMIN_EMAIL: %s", env_email)
            return

        admin_count = session.exec(select(func.count()).select_from(User).where(User.role == "admin")).one()
        if admin_count > 0:
            return

        first_user = session.exec(select(User).order_by(User.id)).first()
        if first_user:
            first_user.role = "admin"
            session.add(first_user)
            session.commit()
            log.info("Promoted earliest existing account (%s) to admin", first_user.email)
            return

        # Fresh database in production without ADMIN_EMAIL/ADMIN_PASSWORD: generate strong one-time admin creds.
        if os.environ.get("PYTEST_CURRENT_TEST"):
            return

        email = "admin@autoclip.local"
        password = secrets.token_urlsafe(12)
        u = User(
            email=email,
            name=(s.admin_name or "Admin").strip() or "Admin",
            password_hash=hash_password(password),
            role="admin",
            is_active=True,
        )
        session.add(u)
        session.commit()
        cred_path = s.admin_credentials_path
        try:
            cred_path.write_text(
                f"AutoClip Studio Admin Login\nEmail: {email}\nPassword: {password}\n"
                f"Tip: set ADMIN_EMAIL and ADMIN_PASSWORD in Railway Variables or change password in Settings.\n",
                encoding="utf-8",
            )
            os.chmod(cred_path, 0o600)
        except OSError:
            pass
        banner = (
            "\n" + "=" * 68 + "\n"
            "AUTOCLIP ADMIN CREDENTIALS (auto-generated on fresh database):\n"
            f"  Email:    {email}\n"
            f"  Password: {password}\n"
            f"  Saved to: {cred_path}\n"
            "  Recommended: set ADMIN_EMAIL & ADMIN_PASSWORD in Railway Variables\n"
            "  or change your password in Settings -> Security after signing in.\n"
            + "=" * 68
        )
        log.warning(banner)
        print(banner, flush=True)


@router.get("/status")
def status(request: Request, session: Session = Depends(get_session)):
    """What the sign-in page needs: is this a fresh install, is signup open, and who am I?"""
    users = session.exec(select(func.count()).select_from(User)).one()
    uid = request_user_id(request)
    user = session.get(User, uid) if uid else None
    if user and not user.is_active:
        user = None
    return {
        "needs_setup": users == 0,
        "signup_open": users == 0 or is_signup_open(),
        "user": _user_out(user) if user else None,
    }


@router.post("/signup")
def signup(body: Credentials, request: Request, response: Response, session: Session = Depends(get_session)):
    users = session.exec(select(func.count()).select_from(User)).one()
    if users > 0 and not is_signup_open():
        raise HTTPException(403, "New account registration is currently paused by the administrator.")
    email = body.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(400, "Enter a valid email address")
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(409, "An account with this email already exists")
    now = utcnow()
    ip = client_ip(request)
    role = "admin" if users == 0 else "user"
    u = User(
        email=email,
        name=body.name.strip(),
        password_hash=hash_password(body.password),
        role=role,
        is_active=True,
        last_login_at=now,
        last_seen_at=now,
        last_ip=ip,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    _set_cookie(request, response, u.id)
    log_activity(session, user=u, action="signup", target_type="user", target_id=u.id, detail=f"Created account ({role})", request=request)
    return _user_out(u)


@router.post("/signin")
def signin(body: SignInCredentials, request: Request, response: Response, session: Session = Depends(get_session)):
    email = body.email.strip().lower()
    u = session.exec(select(User).where(User.email == email)).first()
    if not u or not verify_password(body.password, u.password_hash):
        log_activity(session, user=u, user_email=email, action="signin_failed", target_type="user", detail="Invalid email or password", request=request)
        raise HTTPException(401, "Wrong email or password")
    if not u.is_active:
        log_activity(session, user=u, action="signin_blocked", target_type="user", target_id=u.id, detail="Suspended account attempted sign-in", request=request)
        raise HTTPException(403, "Your account is suspended. Contact the administrator.")
    now = utcnow()
    ip = client_ip(request)
    u.last_login_at = now
    u.last_seen_at = now
    if ip:
        u.last_ip = ip
    session.add(u)
    session.commit()
    session.refresh(u)
    _set_cookie(request, response, u.id)
    log_activity(session, user=u, action="signin", target_type="user", target_id=u.id, detail="Signed in", request=request)
    return _user_out(u)


@router.post("/signout")
def signout(request: Request, response: Response, session: Session = Depends(get_session)):
    uid = request_user_id(request)
    user = session.get(User, uid) if uid else None
    if user:
        log_activity(session, user=user, action="signout", target_type="user", target_id=user.id, detail="Signed out", request=request)
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return _user_out(user)


@router.post("/password")
def change_password(
    body: PasswordChange,
    request: Request,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is wrong")
    user.password_hash = hash_password(body.new_password)
    session.add(user)
    session.commit()
    log_activity(session, user=user, action="password_change", target_type="user", target_id=user.id, detail="Updated own password", request=request)
    return {"ok": True}
