"""Request/response models for the API."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator


class GenerationSettings(BaseModel):
    """Everything the user picks in the pre-generation style selector."""

    clip_count: int = Field(20, ge=10, le=50)
    min_duration: float = Field(15, ge=5, le=120)
    max_duration: float = Field(60, ge=10, le=180)
    editing_style: str = "face_track_zoom"
    caption_style: str = "hormozi"
    aspect_ratio: str = "9:16"
    auto_emoji: bool = True
    hook_title: bool = False  # force the white hook-title card on any style
    music_track_ids: list[int] = Field(default_factory=list)
    music_volume: float = Field(0.18, ge=0.0, le=1.0)
    ducking: bool = True
    match_drop_to_hook: bool = True
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
    settings: Optional[GenerationSettings] = None


class ProjectOut(BaseModel):
    id: int
    name: str
    source_type: str
    source: str
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
    error: Optional[str]
    video_url: Optional[str]
    thumb_url: Optional[str]
    music_track_id: Optional[int]


class ClipUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    hashtags: Optional[list[str]] = None
    review_status: Optional[str] = None
    hook: Optional[str] = None


class MusicOut(BaseModel):
    id: int
    name: str
    duration: Optional[float]
    bpm: Optional[float]
    drop_time: Optional[float]
    analyzed: bool
    url: str


class AccountOut(BaseModel):
    id: int
    platform: str
    display_name: str
    external_id: str
    avatar_url: Optional[str]
    enabled: bool
    daily_limit: int
    min_interval_minutes: int
    token_expires_at: Optional[datetime]
    connected: bool
    created_at: datetime


class AccountUpdate(BaseModel):
    enabled: Optional[bool] = None
    daily_limit: Optional[int] = Field(None, ge=1, le=100)
    min_interval_minutes: Optional[int] = Field(None, ge=5, le=24 * 60)
    display_name: Optional[str] = None


class ScheduleRequest(BaseModel):
    clip_ids: list[int]
    account_ids: list[int]
    start_at: Optional[datetime] = None  # UTC; None = now
    interval_minutes: int = Field(60, ge=0, le=7 * 24 * 60)  # gap between clips on the same account
    account_offset_minutes: int = Field(7, ge=0, le=24 * 60)  # stagger between accounts
    jitter_minutes: int = Field(5, ge=0, le=120)
    privacy: str = "public"
    publish_now: bool = False


class PublishJobOut(BaseModel):
    id: int
    clip_id: int
    account_id: int
    platform: str
    account_name: str
    clip_title: str
    thumb_url: Optional[str]
    scheduled_at: datetime
    status: str
    attempts: int
    remote_url: Optional[str]
    error: Optional[str]
    published_at: Optional[datetime]


class PublishJobUpdate(BaseModel):
    scheduled_at: Optional[datetime] = None
    title: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    status: Optional[str] = None  # only "cancelled" or "scheduled" (retry)
