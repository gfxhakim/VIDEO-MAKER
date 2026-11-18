"""Common interface every social platform implements."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from ..config import get_settings
from ..models import utcnow


class PublishError(RuntimeError):
    def __init__(self, msg: str, retryable: bool = True):
        super().__init__(msg)
        self.retryable = retryable


@dataclass
class ConnectedAccount:
    """What an OAuth callback produces. One login can yield several accounts
    (e.g. one Meta login -> every Facebook Page + linked Instagram account)."""

    platform: str
    external_id: str
    display_name: str
    access_token: str
    refresh_token: Optional[str] = None
    expires_in: Optional[int] = None
    avatar_url: Optional[str] = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def expires_at(self) -> Optional[datetime]:
        return utcnow() + timedelta(seconds=self.expires_in) if self.expires_in else None


@dataclass
class TokenBundle:
    access_token: str
    refresh_token: Optional[str] = None
    expires_in: Optional[int] = None


@dataclass
class PostRequest:
    video: Path
    title: str
    description: str
    tags: list[str]
    privacy: str  # public | unlisted | private


@dataclass
class PostResult:
    remote_id: str
    url: Optional[str] = None


class Provider:
    platform: str = ""
    label: str = ""
    env_keys: tuple[str, ...] = ()
    docs_url: str = ""

    # ---- configuration -----------------------------------------------------
    def configured(self) -> bool:
        s = get_settings()
        return all(getattr(s, k.lower(), "") for k in self.env_keys)

    def redirect_uri(self) -> str:
        return f"{get_settings().public_base_url.rstrip('/')}/api/oauth/{self.oauth_slug}/callback"

    oauth_slug: str = ""

    # ---- OAuth -------------------------------------------------------------
    def authorize_url(self, state: str, code_challenge: Optional[str]) -> str:
        raise NotImplementedError

    def exchange_code(self, code: str, code_verifier: Optional[str]) -> list[ConnectedAccount]:
        raise NotImplementedError

    def refresh(self, refresh_token: str) -> Optional[TokenBundle]:
        return None

    # ---- publishing --------------------------------------------------------
    def publish(self, *, access_token: str, external_id: str, extra: dict, post: PostRequest) -> PostResult:
        raise NotImplementedError


def caption_text(post: PostRequest, max_len: int = 2200) -> str:
    tags = " ".join(t if t.startswith("#") else f"#{t}" for t in post.tags)
    body = post.description.strip()
    parts = [p for p in (post.title.strip(), body, tags) if p]
    text = "\n\n".join(dict.fromkeys(parts))  # drop duplicates, keep order
    return text[:max_len]
