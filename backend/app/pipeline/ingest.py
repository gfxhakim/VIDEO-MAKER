"""Source ingestion: uploaded file, local path, or URL (YouTube & 1000+ sites via yt-dlp)."""
from __future__ import annotations

import ipaddress
import logging
import os
import shutil
import socket
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlparse

from ..config import get_settings
from .media import MediaError

log = logging.getLogger(__name__)

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".ts"}


class DownloadCancelled(MediaError):
    """Raised inside yt-dlp progress hook when the project was deleted mid-download."""


def _is_forbidden_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str.split("%")[0])
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified


def validate_url_syntax(url: str) -> str:
    """Fast syntactic SSRF guard (blocks obvious localhost / private IPs without DNS)."""
    u = url.strip()
    parsed = urlparse(u)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or not parsed.hostname:
        raise MediaError("URL must start with http:// or https://")
    if get_settings().allow_private_urls:
        return u
    host = parsed.hostname.lower()
    if host in ("localhost", "localhost.localdomain") or host.endswith((".local", ".internal")):
        raise MediaError("Local or internal URLs are not allowed")
    if _is_forbidden_ip(host):
        raise MediaError("Private or loopback IP URLs are not allowed")
    return u


def validate_url_reachable(url: str) -> str:
    """Full SSRF guard including DNS resolution (called before yt-dlp fetches anything)."""
    u = validate_url_syntax(url)
    if get_settings().allow_private_urls:
        return u
    host = urlparse(u).hostname or ""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise MediaError(f"Could not resolve host '{host}': {e}") from e
    for info in infos:
        ip_str = info[4][0]
        if _is_forbidden_ip(ip_str):
            raise MediaError("URL resolves to a private or internal IP address")
    return u


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


def probe_url(url: str) -> dict[str, Any]:
    """Fetch metadata for a URL without downloading the video."""
    u = validate_url_reachable(url)
    try:
        import yt_dlp
    except ImportError as e:  # pragma: no cover
        raise MediaError("yt-dlp is not installed: pip install yt-dlp") from e

    opts = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 20,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(u, download=False)
    except Exception as e:
        raise MediaError(f"Could not inspect URL: {e}") from e
    if not isinstance(info, dict):
        raise MediaError("Could not read metadata for this URL")
    return {
        "title": info.get("title") or "Untitled video",
        "duration": float(info.get("duration") or 0) or None,
        "thumbnail": info.get("thumbnail") or None,
        "uploader": info.get("uploader") or info.get("channel") or None,
        "webpage_url": info.get("webpage_url") or u,
    }


def download_url(
    url: str,
    dest_dir: Path,
    on_progress: Optional[Callable[[float], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
) -> tuple[Path, str]:
    """Download with yt-dlp. Returns (file, title)."""
    u = validate_url_reachable(url)
    try:
        import yt_dlp
    except ImportError as e:  # pragma: no cover
        raise MediaError("yt-dlp is not installed: pip install yt-dlp") from e

    s = get_settings()

    def hook(d):
        if should_stop and should_stop():
            raise DownloadCancelled("Project was deleted during download")
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
        "socket_timeout": 30,
        "max_filesize": int(max(0.1, s.ytdlp_max_filesize_gb) * 1024**3),
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(u, download=True)
            filename = Path(ydl.prepare_filename(info))
    except DownloadCancelled:
        raise
    except Exception as e:
        raise MediaError(f"Download failed: {e}") from e
    if not filename.exists():
        candidates = sorted(dest_dir.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True)
        if not candidates:
            raise MediaError("Download finished but no file was produced")
        filename = candidates[0]
    return filename, info.get("title") or "Downloaded video"
