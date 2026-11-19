"""Central settings, loaded from environment variables / backend/.env."""
from __future__ import annotations

import math
import os
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

    # uploads (chunked + resumable, see api/uploads.py)
    # One chunk = one short request. Railway's proxy requires a request body to finish
    # uploading within 5 minutes, so chunks must stay small enough for slow home uplinks.
    upload_chunk_mb: int = 4
    max_upload_gb: float = 10
    upload_ttl_hours: int = 24  # unfinished uploads are deleted after this long without a new chunk
    upload_min_free_mb: int = 512  # keep this much of the volume free for renders
    max_active_uploads: int = 3  # unfinished uploads kept per user (oldest is dropped)

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
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

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
        for d in (self.data_dir, self.projects_dir, self.uploads_dir, self.music_dir, self.models_dir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def effective_cpus() -> int:
    """CPU cores this process may really use. Never below 1.

    Containers often see every core of the host while a cgroup quota allows far
    fewer, so thread counts based on os.cpu_count() waste memory and get slower.
    Order: CPU_LIMIT env override, then scheduler affinity capped by the cgroup quota.
    """
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
    try:  # cgroup v2: "max 100000" or "200000 100000"
        raw = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if len(raw) == 2 and raw[0] != "max":
            quota = float(raw[0]) / float(raw[1])
    except (OSError, ValueError, ZeroDivisionError):
        pass
    if quota is None:
        try:  # cgroup v1
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
            if raw.isdigit() and 0 < int(raw) < 1 << 60:  # cgroup v1 reports a huge number for "no limit"
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
    """How many jobs to run at once when WORKER_CONCURRENCY is 0.

    One render already uses about three cores, so a second worker only pays off from
    4 cores up. Each 1080x1920 render needs roughly 0.5 GB and the speech model plus a
    long video's audio can take 1.5 GB, so memory caps it too.
    """
    by_cpu = min(3, effective_cpus() // 2)
    mem = memory_limit_bytes()
    by_mem = 3 if not mem else int(mem // (2 * 1024**3))
    return max(1, min(by_cpu, by_mem))


def worker_count() -> int:
    return get_settings().worker_concurrency or auto_worker_concurrency()


def ffmpeg_thread_count() -> int:
    """Threads for one ffmpeg process: FFMPEG_THREADS if set, else the usable cores (max 8)."""
    return get_settings().ffmpeg_threads or min(effective_cpus(), 8)


@lru_cache
def nice_prefix() -> tuple[str, ...]:
    """Command prefix that runs heavy ffmpeg work at low priority, so the API stays responsive."""
    import shutil

    return ("nice", "-n", "10") if os.name == "posix" and shutil.which("nice") else ()
