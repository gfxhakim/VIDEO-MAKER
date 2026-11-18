# Connecting social accounts

AutoClip Studio uses each platform's **official API with OAuth 2.0**. You create one developer app per platform
(free) and put its keys in `backend/.env`. After that, press **Connect account** in the Publish Hub as many times as
you like: every login adds another account, there is no limit in the app.

All redirect URIs are built from `PUBLIC_BASE_URL` (default `http://localhost:8000`). The Publish Hub shows the exact
URI to paste for each platform. Tokens are stored encrypted with `APP_SECRET_KEY`.

> Test first with `PUBLISH_DRY_RUN=true`: posts are simulated and you can add sandbox accounts from the Publish Hub.

## YouTube Shorts

1. https://console.cloud.google.com → new project → **APIs & Services → Library** → enable **YouTube Data API v3**.
2. **OAuth consent screen**: External, add your Google account(s) as test users (or publish the app).
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URI: `http://localhost:8000/api/oauth/youtube/callback`.
4. `.env`: `GOOGLE_CLIENT_ID=…`, `GOOGLE_CLIENT_SECRET=…`

Limits: the default quota is 10,000 units/day per Google project, and one upload costs about 1,600, so roughly six uploads
per day across all channels on that project. New YouTube accounts default to `daily_limit=5`. Videos are tagged `#Shorts`.
Uploads from unverified API projects may be locked to private until Google audits the app.

## TikTok

1. https://developers.tiktok.com → **Manage apps → Connect an app**.
2. Add products **Login Kit** and **Content Posting API** (turn on **Direct Post**).
3. Scopes: `user.info.basic`, `video.upload`, `video.publish`.
4. Redirect URI: `http://localhost:8000/api/oauth/tiktok/callback` (TikTok may require https; use a tunnel such as
   `cloudflared tunnel --url http://localhost:8000` and set `PUBLIC_BASE_URL` to the https URL).
5. `.env`: `TIKTOK_CLIENT_KEY=…`, `TIKTOK_CLIENT_SECRET=…`

Until TikTok audits your app, every post is **private (SELF_ONLY)** and only a few users can authorize it. The app reads
the allowed privacy levels before each post and falls back automatically.

## Instagram Reels + Facebook Page Reels (Meta)

One Meta login imports **every Facebook Page you manage and every Instagram Business/Creator account linked to them**.

1. https://developers.facebook.com → **Create app → Business**.
2. Add **Facebook Login for Business** and **Instagram Graph API**.
3. Valid OAuth redirect URI: `http://localhost:8000/api/oauth/meta/callback` (Meta requires https outside development
   mode; use a tunnel and set `PUBLIC_BASE_URL`).
4. Permissions: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`,
   `pages_manage_posts`, `business_management`. In development mode these work for app admins/testers; other users need
   App Review.
5. Each Instagram account must be a **professional account linked to a Facebook Page**.
6. `.env`: `META_APP_ID=…`, `META_APP_SECRET=…`

Videos are sent with Meta's resumable upload, so no public video URL is needed. Instagram allows 50 API posts per
account per 24 h; the app's default is far lower.

## Anti-spam scheduling

When you schedule N clips to M accounts:

- account *k*, clip *i* is planned at `start + k × account_stagger + i × max(interval, account.min_gap) ± jitter`
- each account gets the clips in a rotated order, so the same clip doesn't hit every account at once
- each account's `Max/day` pushes overflow to the next day

At publish time the scheduler re-checks every rule (min gap, rolling 24 h cap, one upload in flight per account, a
60–90 s gap between uploads to the same platform) and nudges a post later if needed. Failed uploads retry with
back-off (10, 20, 30 min); permanent errors (bad token, policy rejection) stop and show in the Schedule queue.
