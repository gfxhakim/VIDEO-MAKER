"""TikTok via the Content Posting API (Direct Post).

Setup: developers.tiktok.com -> create app -> add Login Kit + Content Posting API
(enable Direct Post) -> scopes user.info.basic, video.publish, video.upload ->
redirect URI {PUBLIC_BASE_URL}/api/oauth/tiktok/callback.
Until TikTok audits your app, every post is forced to private (SELF_ONLY) visibility.
"""
from __future__ import annotations

import math
import time
from urllib.parse import urlencode

import httpx

from ..config import get_settings
from .base import ConnectedAccount, PostRequest, PostResult, Provider, PublishError, TokenBundle

AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/"
API = "https://open.tiktokapis.com/v2"
SCOPES = "user.info.basic,video.publish,video.upload"
MIN_CHUNK = 5 * 1024 * 1024
MAX_CHUNK = 64 * 1024 * 1024


class TikTokProvider(Provider):
    platform = "tiktok"
    label = "TikTok"
    oauth_slug = "tiktok"
    env_keys = ("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET")
    docs_url = "https://developers.tiktok.com/doc/content-posting-api-get-started"

    def authorize_url(self, state, code_challenge):
        s = get_settings()
        q = {"client_key": s.tiktok_client_key, "scope": SCOPES, "response_type": "code",
             "redirect_uri": self.redirect_uri(), "state": state}
        if code_challenge:
            q.update(code_challenge=code_challenge, code_challenge_method="S256")
        return f"{AUTH_URL}?{urlencode(q)}"

    def _token(self, data: dict) -> dict:
        s = get_settings()
        data = {"client_key": s.tiktok_client_key, "client_secret": s.tiktok_client_secret, **data}
        r = httpx.post(f"{API}/oauth/token/", data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
        j = r.json()
        if r.status_code >= 400 or "access_token" not in j:
            raise PublishError(f"TikTok token error: {j}", retryable=False)
        return j

    def exchange_code(self, code, code_verifier):
        data = {"code": code, "grant_type": "authorization_code", "redirect_uri": self.redirect_uri()}
        if code_verifier:
            data["code_verifier"] = code_verifier
        tok = self._token(data)
        info = httpx.get(f"{API}/user/info/", params={"fields": "open_id,avatar_url,display_name"},
                         headers={"Authorization": f"Bearer {tok['access_token']}"}, timeout=30).json()
        user = (info.get("data") or {}).get("user") or {}
        return [ConnectedAccount(
            platform="tiktok", external_id=tok.get("open_id") or user.get("open_id", ""),
            display_name=user.get("display_name") or "TikTok account", avatar_url=user.get("avatar_url"),
            access_token=tok["access_token"], refresh_token=tok.get("refresh_token"), expires_in=tok.get("expires_in"),
        )]

    def refresh(self, refresh_token):
        j = self._token({"grant_type": "refresh_token", "refresh_token": refresh_token})
        return TokenBundle(j["access_token"], j.get("refresh_token") or refresh_token, j.get("expires_in"))

    def publish(self, *, access_token, external_id, extra, post: PostRequest) -> PostResult:
        h = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json; charset=UTF-8"}
        # 1. creator info is required before every post (tells us allowed privacy levels)
        ci = httpx.post(f"{API}/post/publish/creator_info/query/", headers=h, timeout=30).json()
        data = ci.get("data") or {}
        if (ci.get("error") or {}).get("code") not in (None, "ok"):
            raise PublishError(f"TikTok creator_info: {ci['error']}", retryable=False)
        options = data.get("privacy_level_options") or ["SELF_ONLY"]
        wanted = {"public": "PUBLIC_TO_EVERYONE", "unlisted": "MUTUAL_FOLLOW_FRIENDS", "private": "SELF_ONLY"}[post.privacy]
        # unaudited apps only get SELF_ONLY; fall back to whatever TikTok allows
        privacy = wanted if wanted in options else ("SELF_ONLY" if "SELF_ONLY" in options else options[0])

        size = post.video.stat().st_size
        chunk = size if size <= MAX_CHUNK else MAX_CHUNK
        count = 1 if size <= MAX_CHUNK else math.floor(size / chunk)
        title = " ".join([post.title, *[t if t.startswith("#") else f"#{t}" for t in post.tags]])[:2200]
        body = {
            "post_info": {"title": title, "privacy_level": privacy, "disable_duet": False, "disable_comment": False,
                          "disable_stitch": False, "video_cover_timestamp_ms": 1000},
            "source_info": {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk, "total_chunk_count": count},
        }
        init = httpx.post(f"{API}/post/publish/video/init/", headers=h, json=body, timeout=60).json()
        err = (init.get("error") or {})
        if err.get("code") not in (None, "ok"):
            retry = err.get("code") in ("rate_limit_exceeded", "internal_error")
            raise PublishError(f"TikTok init failed: {err}", retryable=retry)
        publish_id, upload_url = init["data"]["publish_id"], init["data"]["upload_url"]

        # 2. upload chunks (last chunk absorbs the remainder)
        with open(post.video, "rb") as f:
            for i in range(count):
                first = i * chunk
                last = size - 1 if i == count - 1 else first + chunk - 1
                f.seek(first)
                part = f.read(last - first + 1)
                r = httpx.put(upload_url, content=part, timeout=900, headers={
                    "Content-Type": "video/mp4", "Content-Length": str(len(part)),
                    "Content-Range": f"bytes {first}-{last}/{size}"})
                if r.status_code >= 400:
                    raise PublishError(f"TikTok upload failed: {r.status_code} {r.text[:200]}")

        # 3. wait for processing
        for _ in range(60):
            st = httpx.post(f"{API}/post/publish/status/fetch/", headers=h, json={"publish_id": publish_id}, timeout=30).json()
            status = (st.get("data") or {}).get("status")
            if status == "PUBLISH_COMPLETE":
                ids = (st["data"].get("publicaly_available_post_id") or st["data"].get("publicly_available_post_id") or [])
                url = f"https://www.tiktok.com/@{extra.get('username', '')}/video/{ids[0]}" if ids else None
                return PostResult(remote_id=str(ids[0]) if ids else publish_id, url=url)
            if status == "FAILED":
                raise PublishError(f"TikTok processing failed: {st['data'].get('fail_reason')}", retryable=False)
            time.sleep(5)
        # still processing: TikTok will finish it; record the publish id
        return PostResult(remote_id=publish_id)
