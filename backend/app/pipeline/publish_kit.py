"""Manual publishing helpers: ready-to-paste captions per platform + ZIP export.

Posting stays 100% manual (you upload in each app yourself), so there is no API
access to your accounts and nothing automated that a platform could flag.
"""
from __future__ import annotations

import re
import zipfile
from pathlib import Path

PLATFORMS = {
    "tiktok": {"label": "TikTok", "caption_limit": 2200, "max_tags": 5},
    "instagram": {"label": "Instagram Reels", "caption_limit": 2200, "max_tags": 5},
    "youtube": {"label": "YouTube Shorts", "caption_limit": 5000, "max_tags": 3, "title_limit": 100},
    "facebook": {"label": "Facebook Reels", "caption_limit": 2200, "max_tags": 3},
}


def _tags(hashtags: list[str], n: int, extra: list[str] = ()) -> list[str]:
    seen, out = set(), []
    for t in [*hashtags, *extra]:
        t = "#" + re.sub(r"[^\w]", "", t.lstrip("#"))
        if len(t) > 1 and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out[:n]


def build_kit(title: str, description: str, hashtags: list[str]) -> dict:
    """Return {platform: {title, caption, hashtags}} formatted for each app's conventions."""
    title = title.strip()
    desc = description.strip()
    kit = {}
    for key, cfg in PLATFORMS.items():
        extra = ["#shorts"] if key == "youtube" else []
        tags = _tags(hashtags, cfg["max_tags"], extra)
        if key == "youtube":
            yt_title = title[: cfg["title_limit"] - 8].rstrip()
            yt_title = f"{yt_title} #shorts" if "#shorts" not in yt_title.lower() else yt_title
            caption = "\n\n".join(p for p in (desc, " ".join(tags)) if p)
            kit[key] = {"label": cfg["label"], "title": yt_title, "caption": caption[: cfg["caption_limit"]], "hashtags": tags}
        else:
            # short apps: the hook line is the caption, hashtags at the end
            caption = "\n\n".join(p for p in (title, " ".join(tags)) if p)
            kit[key] = {"label": cfg["label"], "title": title, "caption": caption[: cfg["caption_limit"]], "hashtags": tags}
    return kit


def _safe(name: str, fallback: str) -> str:
    s = re.sub(r"[^A-Za-z0-9 _-]", "", name).strip()[:60]
    return s or fallback


def build_zip(clips: list, dest: Path) -> Path:
    """ZIP with every clip's mp4 plus a captions .txt per clip (all platforms).
    Written to disk, not memory, so 50 clips don't blow up RAM on a small server."""
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_STORED) as z:  # mp4 is already compressed
        for c in clips:
            if not c.video_path or not Path(c.video_path).exists():
                continue
            base = f"{c.rank:02d} - {_safe(c.title, f'clip-{c.id}')}"
            z.write(c.video_path, f"{base}.mp4")
            kit = build_kit(c.title, c.description, c.hashtags)
            lines = []
            for v in kit.values():
                lines += [f"=== {v['label']} ===", *( [f"Title: {v['title']}"] if v['label'].startswith("YouTube") else []), v["caption"], ""]
            z.writestr(f"{base}.txt", "\n".join(lines))
    return dest
