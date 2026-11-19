"""Final clip render: one FFmpeg pass does reframe + captions + emoji + hook card + music/ducking."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from ..config import ffmpeg_thread_count, get_settings, nice_prefix
from .captions import EmojiCue
from .media import MediaError, ffmpeg_escape_path, run, run_progress

log = logging.getLogger(__name__)


@dataclass
class MusicSpec:
    path: Path
    offset: float = 0.0  # seconds into the track at clip t=0 (negative = delay the music)
    volume: float = 0.18
    ducking: bool = True


@dataclass
class RenderSpec:
    source: Path
    start: float
    end: float
    out_path: Path
    work_dir: Path
    video_filter: str  # [0:v] ... [vbase]
    out_w: int
    out_h: int
    has_audio: bool = True
    ass_path: Optional[Path] = None
    emoji: list[EmojiCue] = field(default_factory=list)
    emoji_y: int = 0
    hook_png: Optional[Path] = None
    hook_xy: tuple[int, int] = (0, 0)
    music: Optional[MusicSpec] = None
    fps: float = 0.0  # source frame rate (0 = unknown); above ~31 the render drops to 30 fps first


def build_command(spec: RenderSpec) -> list[str]:
    s = get_settings()
    dur = spec.end - spec.start
    # One thread per usable core, at most 8: more buys no speed and costs ~30 MB each.
    threads = str(ffmpeg_thread_count())
    cmd: list[str] = [*nice_prefix(), s.ffmpeg_bin, "-y", "-hide_banner", "-v", "error",
                      "-filter_complex_threads", threads, "-threads", threads,
                      "-ss", f"{spec.start:.3f}", "-t", f"{dur:.3f}", "-i", str(spec.source)]
    n_inputs = 1
    music_idx = None
    if spec.music:
        if spec.music.offset > 0:
            cmd += ["-stream_loop", "-1", "-ss", f"{spec.music.offset:.3f}", "-i", str(spec.music.path)]
        else:
            cmd += ["-stream_loop", "-1", "-i", str(spec.music.path)]
        music_idx = n_inputs
        n_inputs += 1
    hook_idx = None
    if spec.hook_png:
        cmd += ["-i", str(spec.hook_png)]
        hook_idx = n_inputs
        n_inputs += 1
    emoji_idx = []
    for cue in spec.emoji:
        cmd += ["-i", str(cue.png)]
        emoji_idx.append(n_inputs)
        n_inputs += 1

    # ---------------- video
    parts = [spec.video_filter]
    if spec.fps > 31 and spec.video_filter.count("[0:v]") == 1:
        # 50/60 fps source: drop to 30 fps before the crop, scale and captions instead of
        # paying for every frame and throwing half of them away at the encoder.
        parts = ["[0:v]fps=30[v30]", spec.video_filter.replace("[0:v]", "[v30]")]
    last = "vbase"
    if spec.ass_path:
        fonts = ffmpeg_escape_path(s.fonts_dir)
        parts.append(f"[{last}]subtitles=filename={spec.ass_path.name}:fontsdir={fonts}[vsub]")
        last = "vsub"
    if hook_idx is not None:
        x, y = spec.hook_xy
        parts.append(f"[{last}][{hook_idx}:v]overlay={x}:{y}:format=auto[vhook]")
        last = "vhook"
    for i, (cue, idx) in enumerate(zip(spec.emoji, emoji_idx)):
        size = 150
        parts.append(f"[{idx}:v]scale={size}:{size}[em{i}]")
        parts.append(
            f"[{last}][em{i}]overlay=(W-w)/2:{spec.emoji_y}:enable='between(t,{cue.start:.2f},{cue.end:.2f})'[ve{i}]"
        )
        last = f"ve{i}"
    parts.append(f"[{last}]format=yuv420p[vout]")

    # ---------------- audio
    a_out = None
    if spec.music:
        m = spec.music
        fade_out_at = max(0.0, dur - 1.2)
        mchain = f"[{music_idx}:a]aresample=48000,aformat=channel_layouts=stereo,"
        if m.offset < 0:
            ms = int(-m.offset * 1000)
            mchain += f"adelay={ms}|{ms},"
        mchain += f"volume={m.volume:.3f},afade=t=in:d=0.4,afade=t=out:st={fade_out_at:.2f}:d=1.2,atrim=0:{dur:.3f}[mus]"
        parts.append(mchain)
        if spec.has_audio:
            parts.append("[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[voice][sc]")
            if m.ducking:
                # music ducks automatically whenever the creator speaks
                parts.append("[mus][sc]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=350:makeup=1[duck]")
                parts.append("[voice][duck]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[aout]")
            else:
                parts.append("[sc]anullsink")
                parts.append("[voice][mus]amix=inputs=2:duration=first:normalize=0[aout]")
        else:
            parts.append("[mus]anull[aout]")
        a_out = "[aout]"

    cmd += ["-filter_complex", ";".join(parts), "-map", "[vout]"]
    if a_out:
        cmd += ["-map", a_out]
    elif spec.has_audio:
        cmd += ["-map", "0:a:0"]
    cmd += [
        "-c:v", "libx264", "-preset", s.ffmpeg_preset, "-crf", str(s.ffmpeg_crf), "-maxrate", "10M", "-bufsize", "20M",
        "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", "30", "-g", "60",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", f"{dur:.3f}", "-movflags", "+faststart", "-threads", threads,
        str(spec.out_path),
    ]
    return cmd


def render(spec: RenderSpec, on_progress: Optional[Callable[[float], None]] = None) -> Path:
    """Encode the clip. `on_progress` gets a 0..1 fraction about once a second."""
    cmd = build_command(spec)
    (spec.work_dir / "ffmpeg_cmd.txt").write_text(" ".join(f"'{c}'" if " " in c or ";" in c else c for c in cmd))
    dur = spec.end - spec.start
    try:
        run_progress(cmd, dur, on_progress, timeout=max(600, dur * 40), cwd=spec.work_dir)
    except MediaError as e:
        raise MediaError(f"ffmpeg render failed: {e}") from e
    if not spec.out_path.exists() or spec.out_path.stat().st_size < 1000:
        raise MediaError("ffmpeg produced no output")
    return spec.out_path


__all__ = ["RenderSpec", "MusicSpec", "render", "build_command", "run"]
