"""Self-hosted email + password sign-in. No external services or API keys.

* Passwords: PBKDF2-HMAC-SHA256 (600k iterations) with a random salt.
* Sessions:  an HMAC-signed cookie "uid.expiry.signature" (httpOnly, SameSite=Lax),
             signed with APP_SECRET_KEY (auto-generated into the data volume if unset).
* The first person to open the app creates the owner account; after that sign-up is
  closed unless ALLOW_SIGNUP=true.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Optional

from fastapi import Request

from .config import get_settings

COOKIE = "autoclip_session"
_ITER = 600_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITER)
    return f"pbkdf2_sha256${_ITER}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt_b64, dk_b64 = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(dk_b64))
    except (ValueError, TypeError):
        return False


def _sign(msg: str) -> str:
    key = get_settings().app_secret_key.encode()
    return base64.urlsafe_b64encode(hmac.new(key, msg.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def make_session(user_id: int) -> tuple[str, int]:
    max_age = get_settings().session_days * 86400
    msg = f"{user_id}.{int(time.time()) + max_age}"
    return f"{msg}.{_sign(msg)}", max_age


def read_session(token: Optional[str]) -> Optional[int]:
    if not token or token.count(".") != 2:
        return None
    uid, exp, sig = token.split(".")
    if not hmac.compare_digest(sig, _sign(f"{uid}.{exp}")):
        return None
    try:
        if int(exp) < time.time():
            return None
        return int(uid)
    except ValueError:
        return None


def request_user_id(request: Request) -> Optional[int]:
    return read_session(request.cookies.get(COOKIE))
