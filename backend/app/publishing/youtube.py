"""YouTube Shorts via YouTube Data API v3 (OAuth 2.0 + resumable upload).

Setup: Google Cloud console -> enable "YouTube Data API v3" -> OAuth client (Web) ->
redirect URI  {PUBLIC_BASE_URL}/api/oauth/youtube/callback. Default quota is 10,000
units/day and one upload costs ~1,600, so about 6 uploads per day per project.
"""
from __future__ import annotations

from urllib.parse import urlencode

import httpx

from ..config import get_settings
from .base import ConnectedAccount, PostRequest, PostResult, Provider, PublishError, TokenBundle

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/youtube/v3"
UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos"
SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"


class YouTubeProvider(Provider):
    platform = "youtube"
    label = "YouTube Shorts"
    oauth_slug = "youtube"
    env_keys = ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
    docs_url = "https://developers.google.com/youtube/v3/guides/uploading_a_video"

    def authorize_url(self, state, code_challenge):
        s = get_settings()
        q = {
            "client_id": s.google_client_id, "redirect_uri": self.redirect_uri(), "response_type": "code",
            "scope": SCOPES, "access_type": "offline", "prompt": "consent select_account",
            "include_granted_scopes": "true", "state": state,
        }
        if code_challenge:
            q.update(code_challenge=code_challenge, code_challenge_method="S256")
        return f"{AUTH_URL}?{urlencode(q)}"

    def exchange_code(self, code, code_verifier):
        s = get_settings()
        data = {"code": code, "client_id": s.google_client_id, "client_secret": s.google_client_secret,
                "redirect_uri": self.redirect_uri(), "grant_type": "authorization_code"}
        if code_verifier:
            data["code_verifier"] = code_verifier
        r = httpx.post(TOKEN_URL, data=data, timeout=30)
        if r.status_code >= 400:
            raise PublishError(f"Google token exchange failed: {r.text[:300]}", retryable=False)
        tok = r.json()
        ch = httpx.get(f"{API}/channels", params={"part": "snippet", "mine": "true"},
                       headers={"Authorization": f"Bearer {tok['access_token']}"}, timeout=30).json()
        accounts = []
        for item in ch.get("items", []):
            sn = item.get("snippet", {})
            accounts.append(ConnectedAccount(
                platform="youtube", external_id=item["id"], display_name=sn.get("title", "YouTube channel"),
                access_token=tok["access_token"], refresh_token=tok.get("refresh_token"), expires_in=tok.get("expires_in"),
                avatar_url=(sn.get("thumbnails", {}).get("default", {}) or {}).get("url"),
            ))
        if not accounts:
            raise PublishError("This Google account has no YouTube channel", retryable=False)
        return accounts

    def refresh(self, refresh_token):
        s = get_settings()
        r = httpx.post(TOKEN_URL, data={"client_id": s.google_client_id, "client_secret": s.google_client_secret,
                                        "refresh_token": refresh_token, "grant_type": "refresh_token"}, timeout=30)
        if r.status_code >= 400:
            raise PublishError(f"YouTube token refresh failed: {r.text[:300]}", retryable=False)
        j = r.json()
        return TokenBundle(j["access_token"], j.get("refresh_token") or refresh_token, j.get("expires_in"))

    def publish(self, *, access_token, external_id, extra, post: PostRequest) -> PostResult:
        title = post.title.strip()[:95] or "Short"
        if "#shorts" not in (title + post.description).lower():
            title = f"{title[:88]} #Shorts"
        tags = [t.lstrip("#") for t in post.tags][:15]
        desc = (post.description + "\n\n" + " ".join(f"#{t}" for t in tags)).strip()[:4900]
        privacy = {"public": "public", "unlisted": "unlisted", "private": "private"}.get(post.privacy, "public")
        body = {
            "snippet": {"title": title, "description": desc, "tags": tags, "categoryId": "22"},
            "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
        }
        size = post.video.stat().st_size
        headers = {"Authorization": f"Bearer {access_token}", "X-Upload-Content-Type": "video/mp4",
                   "X-Upload-Content-Length": str(size)}
        init = httpx.post(UPLOAD, params={"uploadType": "resumable", "part": "snippet,status"}, json=body, headers=headers, timeout=60)
        if init.status_code >= 400:
            raise PublishError(f"YouTube upload init failed: {init.status_code} {init.text[:300]}",
                               retryable=init.status_code >= 500 or init.status_code == 429)
        loc = init.headers.get("Location")
        with open(post.video, "rb") as f:
            up = httpx.put(loc, content=f.read(), headers={"Content-Type": "video/mp4"}, timeout=1800)
        if up.status_code >= 400:
            raise PublishError(f"YouTube upload failed: {up.status_code} {up.text[:300]}", retryable=up.status_code >= 500)
        vid = up.json()["id"]
        return PostResult(remote_id=vid, url=f"https://youtube.com/shorts/{vid}")
