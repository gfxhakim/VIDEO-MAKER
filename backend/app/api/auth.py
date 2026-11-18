"""Sign-in / first-run account setup."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlmodel import Session, func, select

from ..auth import COOKIE, hash_password, make_session, request_user_id, verify_password
from ..config import get_settings
from ..db import get_session
from ..models import User
from .deps import current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    name: str = Field("", max_length=80)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


def _user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name or u.email.split("@")[0]}


def _set_cookie(request: Request, response: Response, user_id: int) -> None:
    token, max_age = make_session(user_id)
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, token, max_age=max_age, httponly=True, samesite="lax", secure=secure, path="/")


@router.get("/status")
def status(request: Request, session: Session = Depends(get_session)):
    """What the sign-in page needs: is this a fresh install, and who am I?"""
    users = session.exec(select(func.count()).select_from(User)).one()
    uid = request_user_id(request)
    user = session.get(User, uid) if uid else None
    return {
        "needs_setup": users == 0,
        "signup_open": users == 0 or get_settings().allow_signup,
        "user": _user_out(user) if user else None,
    }


@router.post("/signup")
def signup(body: Credentials, request: Request, response: Response, session: Session = Depends(get_session)):
    users = session.exec(select(func.count()).select_from(User)).one()
    if users > 0 and not get_settings().allow_signup:
        raise HTTPException(403, "Sign-up is closed. Ask the owner to set ALLOW_SIGNUP=true.")
    email = body.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(400, "Enter a valid email address")
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(409, "An account with this email already exists")
    u = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password))
    session.add(u)
    session.commit()
    session.refresh(u)
    _set_cookie(request, response, u.id)
    return _user_out(u)


@router.post("/signin")
def signin(body: Credentials, request: Request, response: Response, session: Session = Depends(get_session)):
    u = session.exec(select(User).where(User.email == body.email.strip().lower())).first()
    if not u or not verify_password(body.password, u.password_hash):
        raise HTTPException(401, "Wrong email or password")
    _set_cookie(request, response, u.id)
    return _user_out(u)


@router.post("/signout")
def signout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return _user_out(user)


@router.post("/password")
def change_password(body: PasswordChange, user: User = Depends(current_user), session: Session = Depends(get_session)):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is wrong")
    user.password_hash = hash_password(body.new_password)
    session.add(user)
    session.commit()
    return {"ok": True}
