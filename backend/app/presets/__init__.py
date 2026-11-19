"""Preset registry. Presets are plain JSON so new styles need no code changes."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

PRESET_DIR = Path(__file__).resolve().parent


def _load(name: str) -> dict[str, Any]:
    data = json.loads((PRESET_DIR / name).read_text(encoding="utf-8"))
    data.pop("_doc", None)
    return data


@lru_cache
def editing_styles() -> dict[str, dict[str, Any]]:
    return _load("editing_styles.json")


@lru_cache
def caption_styles() -> dict[str, dict[str, Any]]:
    return _load("caption_styles.json")


@lru_cache
def emoji_map() -> dict[str, str]:
    return _load("emoji_map.json")


ASPECT_RATIOS: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "4:5": (1080, 1350),
    "1:1": (1080, 1080),
    "16:9": (1920, 1080),
}


def get_editing_style(key: str) -> dict[str, Any]:
    styles = editing_styles()
    return {"key": key, **styles.get(key, styles["face_track_zoom"])}


def get_caption_style(key: str) -> dict[str, Any] | None:
    if key in ("", "none", None):
        return None
    styles = caption_styles()
    return {"key": key, **styles.get(key, styles["hormozi"])}
