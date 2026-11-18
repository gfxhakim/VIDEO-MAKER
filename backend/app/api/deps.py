"""Helpers shared by routers: URL building for media files."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from ..config import get_settings


def media_url(path: Optional[str], version: Optional[float] = None) -> Optional[str]:
    """Map a file inside DATA_DIR to its /media URL."""
    if not path:
        return None
    s = get_settings()
    try:
        rel = Path(path).resolve().relative_to(s.data_dir)
    except ValueError:
        return None
    url = f"{s.public_base_url.rstrip('/')}/media/{rel.as_posix()}"
    return f"{url}?v={int(version)}" if version else url
