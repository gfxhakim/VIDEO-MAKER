"""Thin FFmpeg / ffprobe helpers."""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

import numpy as np

from ..config import ffmpeg_thread_count, get_settings, nice_prefix

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


def run_progress(cmd: Sequence[str], total_seconds: float, on_progress: Optional[Callable[[float], None]] = None, *,
                 timeout: float | None = None, cwd: str | Path | None = None) -> None:
    """Run an ffmpeg command and report how far through `total_seconds` of output it is.

    ffmpeg writes machine-readable progress to stdout (-progress pipe:1), so the command
    must not use stdout for its own output. `on_progress` gets a 0..1 fraction at most
    once a second; an error inside it never stops the encode.
    """
    cmd = list(map(str, cmd))
    try:
        at = cmd.index(get_settings().ffmpeg_bin) + 1
    except ValueError:
        at = 1
    cmd[at:at] = ["-progress", "pipe:1", "-nostats"]
    name = Path(cmd[at - 1]).name
    log.debug("run: %s", " ".join(cmd))
    timed_out = threading.Event()
    with tempfile.TemporaryFile() as err:  # stderr goes to a file: a full pipe would stall ffmpeg
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, cwd=cwd)

        def _kill() -> None:
            timed_out.set()
            proc.kill()

        timer = threading.Timer(timeout, _kill) if timeout else None
        if timer:
            timer.daemon = True
            timer.start()
        last = 0.0
        try:
            for raw in proc.stdout:  # type: ignore[union-attr]
                key, _, val = raw.decode("ascii", "replace").strip().partition("=")
                if key != "out_time_us" and key != "out_time_ms":  # both are microseconds
                    continue
                now = time.monotonic()
                if not on_progress or total_seconds <= 0 or now - last < 1.0:
                    continue
                try:
                    frac = int(val) / 1e6 / total_seconds
                except ValueError:  # "N/A" before the first frame
                    continue
                last = now
                try:
                    on_progress(max(0.0, min(1.0, frac)))
                except Exception:  # noqa: BLE001
                    log.debug("progress callback failed", exc_info=True)
            proc.wait()
        finally:
            if timer:
                timer.cancel()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            if proc.stdout:
                proc.stdout.close()
        if timed_out.is_set():
            raise MediaError(f"{name} timed out after {timeout:.0f}s")
        if proc.returncode != 0:
            err.seek(0)
            tail = err.read().decode(errors="replace")[-2000:]
            raise MediaError(f"{name} failed ({proc.returncode}): {tail}")


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


def extract_audio(src: str | Path, dst: str | Path, sr: int = 16000, *, duration: float = 0.0,
                  on_progress: Optional[Callable[[float], None]] = None) -> Path:
    s = get_settings()
    cmd = [*nice_prefix(), s.ffmpeg_bin, "-y", "-v", "error", "-threads", str(ffmpeg_thread_count()), "-i", str(src),
           "-vn", "-sn", "-dn", "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", str(dst)]
    if on_progress and duration > 0:
        run_progress(cmd, duration, on_progress)
    else:
        run(cmd)
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


def scan_scene_changes(src: str | Path, threshold: float = 0.32, *, threads: int | None = None,
                       stop: threading.Event | None = None,
                       start: float | None = None, end: float | None = None) -> list[float]:
    """Timestamps of hard cuts. Raises MediaError if ffmpeg fails or the scan is stopped."""
    s = get_settings()
    t_off = max(0.0, float(start or 0.0))
    cmd = [
        *nice_prefix(), s.ffmpeg_bin, "-hide_banner", "-nostats", "-v", "info",
        "-skip_frame", "bidir",
        "-threads", str(threads or ffmpeg_thread_count()),
    ]
    if t_off > 0:
        cmd += ["-ss", f"{t_off:.3f}"]
    if end is not None and end > t_off + 1.0:
        cmd += ["-t", f"{end - t_off:.3f}"]
    cmd += [
        "-i", str(src), "-an", "-sn", "-dn",
        "-vf", f"fps=1.5,scale=128:-2:flags=fast_bilinear,select='gt(scene,{threshold})',showinfo", "-f", "null", "-",
    ]
    log.debug("run: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if stop is not None:
        def _watch() -> None:
            while proc.poll() is None:
                if stop.wait(0.5):
                    proc.kill()
                    return

        threading.Thread(target=_watch, daemon=True, name="scene-scan-watch").start()
    times: list[float] = []
    tail: deque[str] = deque(maxlen=12)
    try:
        for raw in proc.stderr:  # type: ignore[union-attr]
            line = raw.decode(errors="replace")
            if "pts_time:" in line:
                try:
                    times.append(t_off + float(line.split("pts_time:")[1].split()[0]))
                except (IndexError, ValueError):
                    pass
            else:
                tail.append(line)
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if proc.stderr:
            proc.stderr.close()
    if stop is not None and stop.is_set():
        raise MediaError("scene detection was stopped")
    if proc.returncode != 0:
        raise MediaError(f"scene detection failed ({proc.returncode}): {''.join(tail)[-1500:]}")
    return times


def detect_scene_changes(src: str | Path, threshold: float = 0.32) -> list[float]:
    """scan_scene_changes(), but a failure only costs the "action" score: it returns []."""
    try:
        return scan_scene_changes(src, threshold)
    except MediaError as e:
        log.warning("%s", e)
        return []


def make_thumbnail(video: str | Path, dst: str | Path, at: float = 1.0) -> Path:
    s = get_settings()
    run([s.ffmpeg_bin, "-y", "-v", "error", "-threads", "2", "-ss", f"{at:.2f}", "-i", str(video), "-an", "-frames:v", "1",
         "-vf", "scale=360:-2", "-q:v", "4", str(dst)])
    return Path(dst)


def ffmpeg_escape_path(p: str | Path) -> str:
    """Escape a path for use inside an ffmpeg filter argument (subtitles=..., sendcmd f=...)."""
    s = str(Path(p).resolve()).replace("\\", "/")
    return s.replace(":", r"\:").replace("'", r"\'").replace(",", r"\,").replace("[", r"\[").replace("]", r"\]")
