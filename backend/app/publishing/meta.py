"""Instagram Reels + Facebook Page Reels via the Meta Graph API.

One "Connect Meta" login imports every Facebook Page the user manages AND every
Instagram professional (Business/Creator) account linked to those Pages, so you can
add as many accounts as you manage. Uploads use Meta's resumable upload host
(rupload.facebook.com), so no public video URL is needed.

Setup: developers.facebook.com -> app (type Business) -> add Facebook Login for Business
+ Instagram Graph API -> redirect URI {PUBLIC_BASE_URL}/api/oauth/meta/callback ->
permissions: instagram_basic, instagram_content_publish, pages_show_list,
pages_read_engagement, pages_manage_posts, business_management.
"""
from __future__ import annotations

import time
from urllib.parse import urlencode

import httpx

from ..config import get_settings
from .base import ConnectedAccount, PostRequest, PostResult, Provider, PublishError, caption_text

SCOPES = ",".join([
    "instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement",
    "pages_manage_posts", "business_management",
])


def _graph() -> str:
    return f"https://graph.facebook.com/{get_settings().meta_graph_version}"


def _check(r: httpx.Response, what: str) -> dict:
    try:
        j = r.json()
    except ValueError:
        j = {"raw": r.text[:300]}
    if r.status_code >= 400 or "error" in j:
        err = j.get("error", j)
        code = err.get("code") if isinstance(err, dict) else None
        # 4/17/32/613 = rate limits -> retry later
        raise PublishError(f"{what}: {err}", retryable=code in (1, 2, 4, 17, 32, 341, 613) or r.status_code >= 500)
    return j


class MetaProvider(Provider):
    platform = "meta"
    label = "Instagram + Facebook"
    oauth_slug = "meta"
    env_keys = ("META_APP_ID", "META_APP_SECRET")
    docs_url = "https://developers.facebook.com/docs/instagram-platform/content-publishing"

    def authorize_url(self, state, code_challenge):
        s = get_settings()
        q = {"client_id": s.meta_app_id, "redirect_uri": self.redirect_uri(), "state": state,
             "scope": SCOPES, "response_type": "code"}
        return f"https://www.facebook.com/{s.meta_graph_version}/dialog/oauth?{urlencode(q)}"

    def exchange_code(self, code, code_verifier):
        s = get_settings()
        short = _check(httpx.get(f"{_graph()}/oauth/access_token", params={
            "client_id": s.meta_app_id, "client_secret": s.meta_app_secret,
            "redirect_uri": self.redirect_uri(), "code": code}, timeout=30), "Meta token exchange")
        long = _check(httpx.get(f"{_graph()}/oauth/access_token", params={
            "grant_type": "fb_exchange_token", "client_id": s.meta_app_id, "client_secret": s.meta_app_secret,
            "fb_exchange_token": short["access_token"]}, timeout=30), "Meta long-lived token")
        user_token = long["access_token"]
        pages = _check(httpx.get(f"{_graph()}/me/accounts", params={
            "fields": "id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}",
            "limit": 200, "access_token": user_token}, timeout=30), "Meta pages")
        accounts: list[ConnectedAccount] = []
        for p in pages.get("data", []):
            # Page tokens derived from a long-lived user token do not expire.
            accounts.append(ConnectedAccount(
                platform="facebook", external_id=p["id"], display_name=p.get("name", "Facebook Page"),
                access_token=p["access_token"], avatar_url=((p.get("picture") or {}).get("data") or {}).get("url"),
            ))
            ig = p.get("instagram_business_account")
            if ig:
                accounts.append(ConnectedAccount(
                    platform="instagram", external_id=ig["id"], display_name="@" + ig.get("username", "instagram"),
                    access_token=p["access_token"], avatar_url=ig.get("profile_picture_url"),
                    extra={"page_id": p["id"], "username": ig.get("username")},
                ))
        if not accounts:
            raise PublishError("No Facebook Pages or Instagram professional accounts found on this login", retryable=False)
        return accounts

    # ------------------------------------------------------------- publishing
    def publish(self, *, access_token, external_id, extra, post: PostRequest) -> PostResult:
        raise NotImplementedError  # use the per-platform subclasses below


class InstagramPublisher(MetaProvider):
    platform = "instagram"
    label = "Instagram Reels"

    def publish(self, *, access_token, external_id, extra, post: PostRequest) -> PostResult:
        size = post.video.stat().st_size
        container = _check(httpx.post(f"{_graph()}/{external_id}/media", data={
            "media_type": "REELS", "upload_type": "resumable", "caption": caption_text(post),
            "share_to_feed": "true", "access_token": access_token}, timeout=60), "IG container")
        cid, upload_uri = container["id"], container.get("uri") or f"https://rupload.facebook.com/ig-api-upload/{get_settings().meta_graph_version}/{container['id']}"
        with open(post.video, "rb") as f:
            _check(httpx.post(upload_uri, content=f.read(), timeout=1800, headers={
                "Authorization": f"OAuth {access_token}", "offset": "0", "file_size": str(size)}), "IG upload")
        for _ in range(90):  # IG transcodes the video; poll until ready (max ~7.5 min)
            st = _check(httpx.get(f"{_graph()}/{cid}", params={"fields": "status_code,status", "access_token": access_token},
                                  timeout=30), "IG status")
            code = st.get("status_code")
            if code == "FINISHED":
                break
            if code in ("ERROR", "EXPIRED"):
                raise PublishError(f"Instagram processing failed: {st.get('status')}", retryable=False)
            time.sleep(5)
        else:
            raise PublishError("Instagram processing timed out")
        pub = _check(httpx.post(f"{_graph()}/{external_id}/media_publish",
                                data={"creation_id": cid, "access_token": access_token}, timeout=60), "IG publish")
        media_id = pub["id"]
        link = httpx.get(f"{_graph()}/{media_id}", params={"fields": "permalink", "access_token": access_token}, timeout=30)
        return PostResult(remote_id=media_id, url=(link.json() or {}).get("permalink") if link.status_code < 400 else None)


class FacebookPublisher(MetaProvider):
    platform = "facebook"
    label = "Facebook Page Reels"

    def publish(self, *, access_token, external_id, extra, post: PostRequest) -> PostResult:
        start = _check(httpx.post(f"{_graph()}/{external_id}/video_reels",
                                  data={"upload_phase": "start", "access_token": access_token}, timeout=60), "FB reel start")
        vid, upload_url = start["video_id"], start.get("upload_url") or f"https://rupload.facebook.com/video-upload/{get_settings().meta_graph_version}/{start['video_id']}"
        size = post.video.stat().st_size
        with open(post.video, "rb") as f:
            _check(httpx.post(upload_url, content=f.read(), timeout=1800, headers={
                "Authorization": f"OAuth {access_token}", "offset": "0", "file_size": str(size)}), "FB reel upload")
        _check(httpx.post(f"{_graph()}/{external_id}/video_reels", data={
            "upload_phase": "finish", "video_id": vid, "video_state": "PUBLISHED",
            "description": caption_text(post, 5000), "access_token": access_token}, timeout=60), "FB reel finish")
        return PostResult(remote_id=vid, url=f"https://www.facebook.com/reel/{vid}")
