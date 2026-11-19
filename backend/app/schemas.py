"""Request/response models for the API."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class GenerationSettings(BaseModel):
    """Everything the user picks in the pre-generation style selector."""

    clip_count: int = Field(20, ge=1, le=50)
    min_duration: float = Field(15, ge=5, le=120)
    max_duration: float = Field(60, ge=10, le=180)
    editing_style: str = "face_track_zoom"
    caption_style: str = "hormozi"
    aspect_ratio: str = "9:16"
    video_effect: str = "none"
    playback_speed: float = Field(1.0, ge=0.75, le=1.5)
    auto_emoji: bool = True
    hook_title: bool = False  # force the hook-title card on any style
    hook_card_style: Literal["light", "dark", "accent", "glass"] = "light"
    hook_card_duration: float = Field(0.0, ge=0.0, le=30.0)  # 0 = full clip, >0 = fade out after N seconds
    music_track_ids: list[int] = Field(default_factory=list)
    music_volume: float = Field(0.18, ge=0.0, le=1.0)
    ducking: bool = True
    match_drop_to_hook: bool = True
    beat_sync_zoom: bool = False
    normalize_audio: bool = True
    denoise_audio: bool = False
    remove_silences: bool = False
    progress_bar: bool = False
    watermark_text: str = Field("", max_length=60)
    watermark_position: Literal["top_left", "top_right", "bottom_left", "bottom_right"] = "bottom_right"
    broll_id: Optional[int] = None
    use_ai: bool = False
    language: Optional[str] = None  # None = auto detect
    caption_position: Optional[float] = Field(None, ge=0.1, le=0.9)  # override, fraction of height

    @field_validator("max_duration")
    @classmethod
    def _max_ge_min(cls, v: float, info):
        mn = info.data.get("min_duration", 15)
        return max(v, mn + 5)


class ProjectCreateURL(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    path: Optional[str] = None
    source_start: Optional[float] = Field(None, ge=0.0)
    source_end: Optional[float] = Field(None, gt=0.0)
    settings: Optional[GenerationSettings] = None


class URLProbeRequest(BaseModel):
    url: str


class GenerateRequest(BaseModel):
    settings: Optional[GenerationSettings] = None
    mode: Literal["rescore", "restyle"] = "rescore"


class ProjectOut(BaseModel):
    id: int
    name: str
    source_type: str
    source: str
    source_start: Optional[float] = None
    source_end: Optional[float] = None
    source_deleted: bool = False
    status: str
    stage: str
    progress: float
    error: Optional[str]
    duration: Optional[float]
    width: Optional[int]
    height: Optional[int]
    settings: dict[str, Any]
    created_at: datetime
    clip_count: int = 0
    ready_count: int = 0
    thumb_url: Optional[str] = None


class ClipOut(BaseModel):
    id: int
    project_id: int
    rank: int
    start: float
    end: float
    duration: float
    score: float
    score_breakdown: dict[str, Any]
    transcript: str
    hook: str
    title: str
    description: str
    hashtags: list[str]
    status: str
    review_status: str
    posted: dict[str, Any]
    error: Optional[str]
    video_url: Optional[str]
    thumb_url: Optional[str]
    music_track_id: Optional[int]
    overrides: dict[str, Any] = Field(default_factory=dict)
    has_words_override: bool = False


class ClipUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    hashtags: Optional[list[str]] = None
    review_status: Optional[str] = None
    hook: Optional[str] = None
    start: Optional[float] = Field(None, ge=0.0)
    end: Optional[float] = Field(None, gt=0.0)
    music_track_id: Optional[int] = None
    clear_music: bool = False
    words_override: Optional[list[dict[str, Any]]] = None
    overrides: Optional[dict[str, Any]] = None


class ManualClipCreate(BaseModel):
    start: float = Field(ge=0.0)
    end: float = Field(gt=0.0)
    title: Optional[str] = None
    hook: Optional[str] = None
    snap_speech: bool = False


class BulkClipAction(BaseModel):
    clip_ids: list[int] = Field(min_length=1, max_length=200)
    action: Literal["approve", "reject", "pending", "delete", "rerender", "apply"]
    overrides: Optional[dict[str, Any]] = None
    music_track_id: Optional[int] = None
    clear_music: bool = False
    rerender: bool = True


class ThumbnailCapture(BaseModel):
    at: float = Field(ge=0.0)


class MusicOut(BaseModel):
    id: int
    name: str
    duration: Optional[float]
    bpm: Optional[float]
    drop_time: Optional[float]
    beats: list[float] = Field(default_factory=list)
    analyzed: bool
    url: str


class MusicUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    drop_time: Optional[float] = Field(None, ge=0.0)


class BrollOut(BaseModel):
    id: int
    name: str
    duration: Optional[float]
    width: Optional[int]
    height: Optional[int]
    url: str


class PostedUpdate(BaseModel):
    platform: str
    posted: bool = True


class RuntimeConfigUpdate(BaseModel):
    default_watermark_text: Optional[str] = Field(None, max_length=60)
    default_watermark_position: Optional[Literal["top_left", "top_right", "bottom_left", "bottom_right"]] = None
    llm_base_url: Optional[str] = Field(None, max_length=300)
    llm_api_key: Optional[str] = Field(None, max_length=300)
    llm_model: Optional[str] = Field(None, max_length=120)
