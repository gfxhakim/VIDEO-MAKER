"""Central settings, loaded from environment variables / backend/.env."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    # core
    data_dir: Path = BACKEND_DIR / "data"
    public_base_url: str = "http://localhost:8000"
    frontend_url: str = "http://localhost:3000"
    app_secret_key: str = "dev-insecure-secret-change-me"
    cors_origins: str = "*"

    # worker
    embedded_worker: bool = True
    worker_concurrency: int = 1
    worker_poll_seconds: float = 1.5
    job_max_attempts: int = 3

    # ffmpeg
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    ffmpeg_preset: str = "veryfast"
    ffmpeg_crf: int = 18
    ffmpeg_threads: int = 0
    output_width: int = 1080
    output_height: int = 1920

    # transcription
    transcribe_backend: str = "local"  # local | openai | groq | none
    whisper_model: str = "base"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    openai_api_key: str = ""
    groq_api_key: str = ""

    # downloads
    ytdlp_format: str = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b"
    allow_local_paths: bool = True

    # publishing
    google_client_id: str = ""
    google_client_secret: str = ""
    tiktok_client_key: str = ""
    tiktok_client_secret: str = ""
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_graph_version: str = "v21.0"
    publish_dry_run: bool = False
    scheduler_tick_seconds: float = 20.0

    # paths derived from data_dir
    @property
    def db_path(self) -> Path:
        return self.data_dir / "autoclip.db"

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def music_dir(self) -> Path:
        return self.data_dir / "music"

    @property
    def fonts_dir(self) -> Path:
        return BACKEND_DIR / "fonts"

    @property
    def assets_dir(self) -> Path:
        return BACKEND_DIR / "assets"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.projects_dir, self.music_dir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir = Path(s.data_dir).resolve()
    s.ensure_dirs()
    return s
