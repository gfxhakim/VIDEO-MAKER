"""Thin FFmpeg / ffprobe helpers."""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

from ..config import get_settings

log = logging.getLogger(__name__)


class MediaError(RuntimeError):
    pass


@dataclass
class MediaInfo:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool


def check_binaries() -> dict[str, bool]:
    s = get_settings()
    return {"ffmpeg": bool(shutil.which(s.ffmpeg_bin)), "ffprobe": bool(shutil.which(s.ffprobe_bin))}


def run(cmd: Sequence[str], *, timeout: float | None = None) -> subprocess.CompletedProcess:
    """Run a command, raising MediaError with the tail of stderr on failure."""
    log.debug("run: %s", " ".join(map(str, cmd)))
    try:
        proc = subprocess.run(list(map(str, cmd)), capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise MediaError(f"{Path(str(cmd[0])).name} timed out after {timeout}s") from e
    if proc.returncode != 0:
        tail = proc.stderr.decode(errors="replace")[-1500:]
        raise MediaError(f"{Path(str(cmd[0])).name} failed ({proc.returncode}): {tail}")
    return proc


def probe(path: str | Path) -> MediaInfo:
    s = get_settings()
    out = run([s.ffprobe_bin, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)])
    data = json.loads(out.stdout)
    v = next((st for st in data.get("streams", []) if st.get("codec_type") == "video"), None)
    a = next((st for st in data.get("streams", []) if st.get("codec_type") == "audio"), None)
    if v is None:
        raise MediaError("No video stream found in source")
    duration = float(data.get("format", {}).get("duration") or v.get("duration") or 0)
    num, _, den = (v.get("avg_frame_rate") or "30/1").partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    w, h = int(v["width"]), int(v["height"])
    # respect rotation metadata (phone footage)
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = abs(int(sd["rotation"]))
    if rot in (90, 270):
        w, h = h, w
    return MediaInfo(duration=duration, width=w, height=h, fps=fps or 30.0, has_audio=a is not None)


def extract_audio(src: str | Path, dst: str | Path, sr: int = 16000) -> Path:
    s = get_settings()
    run([s.ffmpeg_bin, "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", str(dst)])
    return Path(dst)


def load_pcm(path: str | Path, sr: int = 16000, start: float | None = None, duration: float | None = None) -> np.ndarray:
    """Decode any audio file to mono float32 PCM via ffmpeg (no librosa needed)."""
    s = get_settings()
    cmd = [s.ffmpeg_bin, "-v", "error"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    if duration:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    out = run(cmd)
    return np.frombuffer(out.stdout, dtype=np.float32)


def detect_scene_changes(src: str | Path, threshold: float = 0.32) -> list[float]:
    """Timestamps of hard cuts. Runs on a tiny 2 fps proxy so it is cheap."""
    s = get_settings()
    cmd = [
        s.ffmpeg_bin, "-v", "info", "-i", str(src), "-an",
        "-vf", f"fps=2,scale=160:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-",
    ]
    try:
        proc = run(cmd)
    except MediaError as e:
        log.warning("scene detection failed: %s", e)
        return []
    times: list[float] = []
    for line in proc.stderr.decode(errors="replace").splitlines():
        if "pts_time:" in line:
            try:
                times.append(float(line.split("pts_time:")[1].split()[0]))
            except (IndexError, ValueError):
                pass
    return times


def make_thumbnail(video: str | Path, dst: str | Path, at: float = 1.0) -> Path:
    s = get_settings()
    run([s.ffmpeg_bin, "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", str(dst)])
    return Path(dst)


def ffmpeg_escape_path(p: str | Path) -> str:
    """Escape a path for use inside an ffmpeg filter argument (subtitles=..., sendcmd f=...)."""
    s = str(Path(p).resolve()).replace("\\", "/")
    return s.replace(":", r"\:").replace("'", r"\'").replace(",", r"\,").replace("[", r"\[").replace("]", r"\]")
