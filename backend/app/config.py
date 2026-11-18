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
    # Signs login sessions. Leave empty and a random key is generated once and
    # saved in DATA_DIR/secret.key (so sessions survive restarts on a volume).
    app_secret_key: str = ""
    # Dev only: the Next.js dev server origin. In production the API serves the
    # built frontend itself (same origin), so CORS is not needed.
    cors_origins: str = "http://localhost:3000"
    # Built frontend (Next.js static export) served at "/"; empty = don't serve.
    static_dir: Path = BACKEND_DIR.parent / "frontend" / "out"

    # auth
    allow_signup: bool = False  # after the first (owner) account, allow more sign-ups?
    session_days: int = 30

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

    # transcription (runs locally, no API keys)
    transcribe_backend: str = "local"  # local | none (none = skip speech, energy-only scoring)
    whisper_model: str = "base"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_threads: int = 0  # 0 = let CTranslate2 decide

    # downloads
    ytdlp_format: str = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b"
    allow_local_paths: bool = True

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
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def fonts_dir(self) -> Path:
        return BACKEND_DIR / "fonts"

    @property
    def assets_dir(self) -> Path:
        return BACKEND_DIR / "assets"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.projects_dir, self.music_dir, self.models_dir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir = Path(s.data_dir).resolve()
    s.ensure_dirs()
    if not s.app_secret_key:
        key_file = s.data_dir / "secret.key"
        if not key_file.exists():
            import secrets

            key_file.write_text(secrets.token_urlsafe(48))
        s.app_secret_key = key_file.read_text().strip()
    return s
