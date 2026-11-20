"""Central settings, loaded from environment variables / backend/.env."""
from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

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
    allow_signup: bool = True  # allow new visitors to create accounts (toggleable live in Admin Panel)
    session_days: int = 30
    admin_email: str = ""
    admin_password: str = ""
    admin_name: str = "Admin"

    # worker
    embedded_worker: bool = True
    worker_concurrency: int = 0  # jobs run side by side; 0 = decide from the CPU cores and memory available
    worker_poll_seconds: float = 1.5
    job_max_attempts: int = 3

    # ffmpeg
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    ffmpeg_preset: str = "veryfast"
    ffmpeg_crf: int = 21  # 18 made ~35% larger files for no visible gain on a phone screen
    ffmpeg_threads: int = 0
    output_width: int = 1080
    output_height: int = 1920

    # transcription (runs locally, no API keys)
    transcribe_backend: str = "local"  # local | none (none = skip speech, energy-only scoring)
    whisper_model: str = "base"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_threads: int = 0  # 0 = auto (leaves a core for the scene scan that runs alongside)

    # face detection (YuNet ONNX downloaded once into models_dir; falls back to OpenCV Haar cascades)
    auto_download_yunet: bool = True

    # optional OpenAI-compatible / Ollama endpoint for semantic scoring & copywriting (disabled by default)
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"

    # uploads (chunked + resumable, see api/uploads.py)
    upload_chunk_mb: int = 4
    max_upload_gb: float = 10
    upload_ttl_hours: int = 24  # unfinished uploads are deleted after this long without a new chunk
    upload_min_free_mb: int = 512  # keep this much of the volume free for renders
    max_active_uploads: int = 3  # unfinished uploads kept per user (oldest is dropped)

    # downloads
    ytdlp_format: str = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b"
    ytdlp_max_filesize_gb: float = 4.0
    ytdlp_timeout_seconds: int = 1800
    ytdlp_cookies_file: str = ""
    ytdlp_cookies: str = ""
    allow_local_paths: bool = True
    allow_private_urls: bool = False

    # paths derived from data_dir
    @property
    def db_path(self) -> Path:
        return self.data_dir / "autoclip.db"

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def music_dir(self) -> Path:
        return self.data_dir / "music"

    @property
    def broll_dir(self) -> Path:
        return self.data_dir / "broll"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def app_settings_path(self) -> Path:
        return self.data_dir / "app_settings.json"

    @property
    def admin_credentials_path(self) -> Path:
        return self.data_dir / "admin_credentials.txt"

    @property
    def ytdlp_cookies_path(self) -> Path:
        return self.data_dir / "ytdlp_cookies.txt"

    def effective_ytdlp_cookies_path(self) -> Path | None:
        if self.ytdlp_cookies_file:
            p = Path(os.path.expanduser(self.ytdlp_cookies_file))
            if p.is_file() and p.stat().st_size > 0:
                return p
        p = self.ytdlp_cookies_path
        if p.is_file() and p.stat().st_size > 0:
            return p
        return None

    @property
    def fonts_dir(self) -> Path:
        return BACKEND_DIR / "fonts"

    @property
    def assets_dir(self) -> Path:
        return BACKEND_DIR / "assets"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.projects_dir, self.uploads_dir, self.music_dir, self.broll_dir, self.models_dir):
            d.mkdir(parents=True, exist_ok=True)


def load_runtime_config() -> dict[str, Any]:
    """User-editable runtime preferences saved in DATA_DIR/app_settings.json (brand defaults + optional LLM)."""
    s = get_settings()
    defaults: dict[str, Any] = {
        "default_watermark_text": "",
        "default_watermark_position": "bottom_right",
        "llm_base_url": s.llm_base_url,
        "llm_api_key": s.llm_api_key,
        "llm_model": s.llm_model,
        "allow_signup": s.allow_signup,
    }
    p = s.app_settings_path
    if p.exists():
        try:
            saved = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                for k in defaults:
                    if k in saved and saved[k] is not None:
                        defaults[k] = saved[k]
        except (OSError, ValueError):
            pass
    return defaults


def is_signup_open() -> bool:
    """Whether new visitor self-registration is currently open."""
    cfg = load_runtime_config()
    val = cfg.get("allow_signup")
    if isinstance(val, bool):
        return val
    return bool(get_settings().allow_signup)


def save_runtime_config(patch: dict[str, Any]) -> dict[str, Any]:
    cur = load_runtime_config()
    for k, v in patch.items():
        if k in cur and v is not None:
            cur[k] = v
    p = get_settings().app_settings_path
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(cur, indent=2), encoding="utf-8")
    os.replace(tmp, p)
    return cur


def save_ytdlp_cookies(raw: str) -> bool:
    """Persist Netscape cookies.txt under DATA_DIR (0600) or delete when empty."""
    s = get_settings()
    s.ensure_dirs()
    p = s.ytdlp_cookies_path
    cleaned = raw.replace("\r\n", "\n").replace("\r", "\n")
    if "\n" not in cleaned and "\\n" in cleaned:
        cleaned = cleaned.replace("\\n", "\n")
    if not cleaned.strip():
        p.unlink(missing_ok=True)
        return False
    if not cleaned.endswith("\n"):
        cleaned += "\n"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(cleaned, encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)
    return True


def sync_ytdlp_cookies_from_env() -> None:
    """If YTDLP_COOKIES env var is set on Railway, sync it into DATA_DIR/ytdlp_cookies.txt."""
    s = get_settings()
    if s.ytdlp_cookies.strip():
        save_ytdlp_cookies(s.ytdlp_cookies)


@lru_cache
def effective_cpus() -> int:
    """CPU cores this process may really use. Never below 1."""
    override = os.environ.get("CPU_LIMIT", "").strip()
    if override:
        try:
            return max(1, int(math.ceil(float(override))))
        except ValueError:
            pass
    try:
        n = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        n = os.cpu_count() or 1
    quota = None
    try:
        raw = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if len(raw) == 2 and raw[0] != "max":
            quota = float(raw[0]) / float(raw[1])
    except (OSError, ValueError, ZeroDivisionError):
        pass
    if quota is None:
        try:
            q = float(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())
            per = float(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
            if q > 0 and per > 0:
                quota = q / per
        except (OSError, ValueError):
            pass
    if quota is not None:
        n = min(n, int(math.ceil(quota)))
    return max(1, n)


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


@lru_cache
def memory_limit_bytes() -> int:
    """Memory this process may use: the container limit if there is one, else the machine's RAM. 0 = unknown."""
    for f in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = Path(f).read_text().strip()
            if raw.isdigit() and 0 < int(raw) < 1 << 60:
                return int(raw)
        except OSError:
            pass
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def auto_worker_concurrency() -> int:
    by_cpu = min(3, effective_cpus() // 2)
    mem = memory_limit_bytes()
    by_mem = 3 if not mem else int(mem // (2 * 1024**3))
    return max(1, min(by_cpu, by_mem))


def worker_count() -> int:
    return get_settings().worker_concurrency or auto_worker_concurrency()


def ffmpeg_thread_count() -> int:
    return get_settings().ffmpeg_threads or min(effective_cpus(), 8)


@lru_cache
def nice_prefix() -> tuple[str, ...]:
    import shutil

    return ("nice", "-n", "10") if os.name == "posix" and shutil.which("nice") else ()
