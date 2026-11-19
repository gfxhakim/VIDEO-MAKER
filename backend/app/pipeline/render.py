"""Final clip render: one FFmpeg pass does trim/concat + reframe + captions + emoji + hook card + progress bar + watermark + audio polish/music."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from PIL import Image, ImageDraw, ImageFont

from ..config import ffmpeg_thread_count, get_settings, nice_prefix
from .captions import EmojiCue
from .effects import apply_video_effect
from .media import MediaError, ffmpeg_escape_path, run, run_progress

log = logging.getLogger(__name__)


@dataclass
class MusicSpec:
    path: Path
    offset: float = 0.0
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
    hook_duration: float = 0.0  # 0 = full clip
    music: Optional[MusicSpec] = None
    broll_path: Optional[Path] = None
    keep_segments: Optional[list[tuple[float, float]]] = None  # clip-relative kept speech slices (jump-cut)
    normalize_audio: bool = False
    denoise_audio: bool = False
    progress_bar: bool = False
    watermark_text: str = ""
    watermark_position: str = "bottom_right"
    video_effect: str = "none"
    speed: float = 1.0
    fps: float = 0.0


def _render_watermark_png(text: str, dst: Path, out_w: int) -> tuple[Path, int, int]:
    """Render semi-transparent text watermark via Pillow (safe for @, quotes, Unicode)."""
    fs = max(20, int(round(28 * (out_w / 1080.0))))
    fonts = get_settings().fonts_dir
    font = None
    for name in ("Poppins-700.ttf", "Montserrat-800.ttf", "Montserrat-600.ttf"):
        p = fonts / name
        if p.exists():
            try:
                font = ImageFont.truetype(str(p), fs)
                break
            except OSError:
                pass
    if font is None:
        for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",):
            if Path(p).exists():
                font = ImageFont.truetype(p, fs)
                break
    if font is None:
        font = ImageFont.load_default()
    pad_x, pad_y = 16, 10
    tw = int(font.getlength(text))
    ascent, descent = font.getmetrics()
    th = ascent + descent
    w, h = max(20, tw + pad_x * 2), max(20, th + pad_y * 2)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=(12, 12, 16, 130))
    d.text((pad_x + 1, pad_y + 1), text, font=font, fill=(0, 0, 0, 170))
    d.text((pad_x, pad_y), text, font=font, fill=(255, 255, 255, 215))
    img.save(dst)
    return dst, w, h


def build_command(spec: RenderSpec) -> list[str]:
    s = get_settings()
    src_dur = spec.end - spec.start
    segs = spec.keep_segments if spec.keep_segments and len(spec.keep_segments) > 1 else None
    base_dur = sum(b - a for a, b in segs) if segs else src_dur
    spd = max(0.75, min(1.5, float(spec.speed or 1.0)))
    has_speed = abs(spd - 1.0) > 1e-3
    dur = base_dur / spd
    threads = str(ffmpeg_thread_count())
    cmd: list[str] = [*nice_prefix(), s.ffmpeg_bin, "-y", "-hide_banner", "-v", "error",
                      "-filter_complex_threads", threads, "-threads", threads,
                      "-ss", f"{spec.start:.3f}", "-t", f"{src_dur:.3f}", "-i", str(spec.source)]
    n_inputs = 1
    broll_idx = None
    if spec.broll_path and "[broll:v]" in spec.video_filter:
        cmd += ["-stream_loop", "-1", "-i", str(spec.broll_path)]
        broll_idx = n_inputs
        n_inputs += 1
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
    wm_idx = None
    if spec.watermark_text.strip():
        wm_path, _, _ = _render_watermark_png(spec.watermark_text.strip(), spec.work_dir / "watermark.png", spec.out_w)
        cmd += ["-i", str(wm_path)]
        wm_idx = n_inputs
        n_inputs += 1
    emoji_idx = []
    for cue in spec.emoji:
        cmd += ["-i", str(cue.png)]
        emoji_idx.append(n_inputs)
        n_inputs += 1

    # ---------------- video
    parts: list[str] = []
    v_label = "[0:v]"
    a_label = "[0:a]"
    if spec.fps > 31 and spec.video_filter.count("[0:v]") == 1:
        parts.append("[0:v]fps=30[v30]")
        v_label = "[v30]"

    if segs:
        v_trims = [f"{v_label}trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[kv{i}]" for i, (a, b) in enumerate(segs)]
        v_refs = "".join(f"[kv{i}]" for i in range(len(segs)))
        parts.extend(v_trims)
        parts.append(f"{v_refs}concat=n={len(segs)}:v=1:a=0[vcut]")
        v_label = "[vcut]"
        if spec.has_audio:
            a_trims = [f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[ka{i}]" for i, (a, b) in enumerate(segs)]
            a_refs = "".join(f"[ka{i}]" for i in range(len(segs)))
            parts.extend(a_trims)
            parts.append(f"{a_refs}concat=n={len(segs)}:v=0:a=1[acut]")
            a_label = "[acut]"

    if has_speed:
        parts.append(f"{v_label}setpts=PTS/{spd:.4f}[vspd]")
        v_label = "[vspd]"

    vf = spec.video_filter.replace("[0:v]", v_label) if v_label != "[0:v]" else spec.video_filter
    if broll_idx is not None:
        vf = vf.replace("[broll:v]", f"[{broll_idx}:v]")
    parts.append(vf)

    last = "vbase"
    if spec.video_effect and spec.video_effect != "none":
        fx_parts = apply_video_effect(last, spec.video_effect, spec.out_w, spec.out_h, "vefx")
        if fx_parts:
            parts.extend(fx_parts)
            last = "vefx"
    if spec.ass_path:
        fonts = ffmpeg_escape_path(s.fonts_dir)
        parts.append(f"[{last}]subtitles=filename={spec.ass_path.name}:fontsdir={fonts}[vsub]")
        last = "vsub"
    if hook_idx is not None:
        x, y = spec.hook_xy
        en = f":enable='between(t,0,{spec.hook_duration:.2f})'" if spec.hook_duration > 0 else ""
        parts.append(f"[{last}][{hook_idx}:v]overlay={x}:{y}:format=auto{en}[vhook]")
        last = "vhook"
    em_size = max(84, min(156, int(round(150 * (min(spec.out_w, spec.out_h) / 1080.0)))))
    for i, (cue, idx) in enumerate(zip(spec.emoji, emoji_idx)):
        parts.append(f"[{idx}:v]scale={em_size}:{em_size}[em{i}]")
        parts.append(
            f"[{last}][em{i}]overlay=(W-w)/2:{spec.emoji_y}:enable='between(t,{cue.start:.2f},{cue.end:.2f})'[ve{i}]"
        )
        last = f"ve{i}"
    if wm_idx is not None:
        margin_x = max(20, int(spec.out_w * 0.03))
        margin_y = max(24, int(spec.out_h * 0.035))
        pos_map = {
            "top_left": f"{margin_x}:{margin_y}",
            "top_right": f"W-w-{margin_x}:{margin_y}",
            "bottom_left": f"{margin_x}:H-h-{margin_y}",
            "bottom_right": f"W-w-{margin_x}:H-h-{margin_y}",
        }
        xy = pos_map.get(spec.watermark_position, pos_map["bottom_right"])
        parts.append(f"[{last}][{wm_idx}:v]overlay={xy}:format=auto[vwm]")
        last = "vwm"
    if spec.progress_bar and dur > 0.5:
        bar_h = max(6, int(round(8 * (spec.out_h / 1920.0))))
        parts.append(f"color=c=#18181b@0.5:s={spec.out_w}x{bar_h}:r=30[pbg]")
        parts.append(f"color=c=#d946ef:s={spec.out_w}x{bar_h}:r=30[pfg]")
        parts.append(f"[{last}][pbg]overlay=0:H-{bar_h}:shortest=1[vpb0]")
        parts.append(f"[vpb0][pfg]overlay=x='-W+(t/{dur:.3f})*W':y=H-{bar_h}:shortest=1[vpb1]")
        last = "vpb1"
    parts.append(f"[{last}]format=yuv420p[vout]")

    # ---------------- audio
    a_out = None
    if spec.has_audio:
        achain = [f"{a_label}aresample=48000", "aformat=channel_layouts=stereo"]
        if has_speed:
            achain.append(f"atempo={spd:.4f}")
        if spec.denoise_audio:
            achain.append("highpass=f=80,afftdn=nf=-22")
        if spec.normalize_audio:
            achain.append("loudnorm=I=-14:TP=-1.5:LRA=11")
        if dur > 0.2:
            achain.append(f"afade=t=in:d=0.03,afade=t=out:st={max(0.0, dur - 0.05):.3f}:d=0.05")
        voice_filters = ",".join(achain)
    else:
        voice_filters = ""

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
            parts.append(f"{voice_filters},asplit=2[voice][sc]")
            if m.ducking:
                parts.append("[mus][sc]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=350:makeup=1[duck]")
                parts.append("[voice][duck]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[aout]")
            else:
                parts.append("[sc]anullsink")
                parts.append("[voice][mus]amix=inputs=2:duration=first:normalize=0[aout]")
        else:
            parts.append("[mus]anull[aout]")
        a_out = "[aout]"
    elif spec.has_audio and (segs or spec.denoise_audio or spec.normalize_audio or has_speed):
        parts.append(f"{voice_filters}[aout]")
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
    segs = spec.keep_segments if spec.keep_segments and len(spec.keep_segments) > 1 else None
    base_dur = sum(b - a for a, b in segs) if segs else (spec.end - spec.start)
    spd = max(0.75, min(1.5, float(spec.speed or 1.0)))
    dur = base_dur / spd
    try:
        run_progress(cmd, dur, on_progress, timeout=max(600, dur * 40), cwd=spec.work_dir)
    except MediaError as e:
        raise MediaError(f"ffmpeg render failed: {e}") from e
    if not spec.out_path.exists() or spec.out_path.stat().st_size < 1000:
        raise MediaError("ffmpeg produced no output")
    return spec.out_path


__all__ = ["RenderSpec", "MusicSpec", "render", "build_command", "run"]
