"""Source ingestion: uploaded file, local path, or URL (YouTube & 1000+ sites via yt-dlp)."""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Callable, Optional

from ..config import get_settings
from .media import MediaError

log = logging.getLogger(__name__)

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".ts"}


def resolve_local_path(path: str, dest_dir: Path) -> Path:
    """Use a file already on disk. We hard-link (or copy) it into the project folder
    so later deletes of the original don't break renders."""
    s = get_settings()
    if not s.allow_local_paths:
        raise MediaError("Local paths are disabled on this server (ALLOW_LOCAL_PATHS=false)")
    src = Path(os.path.expanduser(path.strip().strip('"'))).resolve()
    if not src.is_file():
        raise MediaError(f"File not found: {src}")
    if src.suffix.lower() not in VIDEO_EXTS:
        raise MediaError(f"Unsupported file type: {src.suffix}")
    dest = dest_dir / f"source{src.suffix.lower()}"
    if dest.exists():
        return dest
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)
    return dest


def download_url(url: str, dest_dir: Path, on_progress: Optional[Callable[[float], None]] = None) -> tuple[Path, str]:
    """Download with yt-dlp. Returns (file, title)."""
    try:
        import yt_dlp
    except ImportError as e:  # pragma: no cover
        raise MediaError("yt-dlp is not installed: pip install yt-dlp") from e

    s = get_settings()

    def hook(d):
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                on_progress(min(0.99, d.get("downloaded_bytes", 0) / total))

    opts = {
        "format": s.ytdlp_format,
        "outtmpl": str(dest_dir / "source.%(ext)s"),
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "retries": 5,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = Path(ydl.prepare_filename(info))
    except Exception as e:  # yt-dlp raises many types
        raise MediaError(f"Download failed: {e}") from e
    # merged output may change extension
    if not filename.exists():
        candidates = sorted(dest_dir.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True)
        if not candidates:
            raise MediaError("Download finished but no file was produced")
        filename = candidates[0]
    return filename, info.get("title") or "Downloaded video"
