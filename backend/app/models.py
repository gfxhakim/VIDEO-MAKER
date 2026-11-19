"""Database tables."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    """All timestamps are timezone-aware UTC (SQLModel stores and returns them as UTC)."""
    return datetime.now(timezone.utc)


class Project(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, index=True)
    name: str
    source_type: str  # upload | url | path
    source: str  # original URL / path / filename
    source_path: Optional[str] = None  # resolved local media file
    source_start: Optional[float] = None  # optional ingest start trim (seconds)
    source_end: Optional[float] = None  # optional ingest end trim (seconds)
    source_deleted: bool = False  # true when heavy raw source was pruned after rendering
    status: str = "draft"  # draft | queued | processing | done | failed
    stage: str = ""  # human-readable current step
    progress: float = 0.0  # 0..1
    error: Optional[str] = None
    duration: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    # GenerationSettings as dict (see schemas.GenerationSettings)
    settings: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Clip(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    rank: int = 0
    start: float
    end: float
    score: float = 0.0
    score_breakdown: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    transcript: str = ""
    hook: str = ""
    title: str = ""
    description: str = ""
    hashtags: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    words_override: Optional[list[dict[str, Any]]] = Field(default=None, sa_column=Column(JSON))
    overrides: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    music_track_id: Optional[int] = None
    status: str = "pending"  # pending | rendering | ready | failed
    review_status: str = "pending"  # pending | approved | rejected
    # manual publishing tracker: {"tiktok": "2026-11-18T18:00:00Z", ...}
    posted: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error: Optional[str] = None
    video_path: Optional[str] = None
    thumb_path: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class MusicTrack(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, index=True)
    name: str
    path: str
    duration: Optional[float] = None
    bpm: Optional[float] = None
    drop_time: Optional[float] = None  # seconds into the track of the biggest energy rise
    beats: list[float] = Field(default_factory=list, sa_column=Column(JSON))
    analyzed: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class BrollClip(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, index=True)
    name: str
    path: str
    duration: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    created_at: datetime = Field(default_factory=utcnow)


class Upload(SQLModel, table=True):
    """A chunked, resumable upload. The bytes live in DATA_DIR/uploads/<id>/ until it is
    completed, then the file is moved (not copied) into the new project's folder."""

    id: str = Field(primary_key=True)  # uuid4 hex made by the server; the only thing used to build paths
    user_id: int = Field(foreign_key="user.id", index=True)
    filename: str  # display name only
    ext: str  # whitelisted extension, e.g. ".mp4"
    size: int
    chunk_size: int
    total_chunks: int
    fingerprint: str = Field(default="", index=True)  # client-side file identity, used to resume
    status: str = "uploading"  # uploading | completing | completed
    project_id: Optional[int] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Job(SQLModel, table=True):
    """Background work item for the worker queue."""

    id: Optional[int] = Field(default=None, primary_key=True)
    kind: str = Field(index=True)  # analyze_project | render_clip | analyze_music
    payload: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = Field(default="queued", index=True)  # queued | running | done | failed | cancelled
    priority: int = 0  # higher runs first
    attempts: int = 0
    max_attempts: int = 3
    error: Optional[str] = None
    run_after: datetime = Field(default_factory=utcnow, index=True)
    locked_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None


class User(SQLModel, table=True):
    """Self-hosted login. The first person to open the app creates the owner account."""

    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    name: str = ""
    password_hash: str
    created_at: datetime = Field(default_factory=utcnow)
