"""Kinetic word-level captions rendered as ASS (libass), SRT/VTT export, and iOS auto-emoji timing."""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional

from PIL import ImageFont

from ..config import get_settings
from ..presets import emoji_map
from .highlights import EMOTION_WORDS


@dataclass
class EmojiCue:
    start: float
    end: float
    png: Path


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _srt_time(t: float, sep: str = ",") -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms >= 1000:
        ms -= 1000
        s += 1
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _clean(word: str) -> str:
    return word.replace("\\", "").replace("{", "(").replace("}", ")")


def is_keyword(word: str) -> bool:
    w = re.sub(r"[^a-z0-9$%]", "", word.lower())
    return bool(re.search(r"\d|\$|%", w)) or w in EMOTION_WORDS


def _emoji_png(emoji: str) -> Optional[Path]:
    code = "-".join(f"{ord(c):x}" for c in emoji if ord(c) != 0xFE0F)
    p = get_settings().assets_dir / "emoji" / f"{code}.png"
    return p if p.exists() else None


def emoji_for(word: str) -> Optional[str]:
    """Match a spoken word (or safe inflected form) to an emoji without false substring hits."""
    w = re.sub(r"[^a-z]", "", word.lower())
    if len(w) < 2:
        return None
    m = emoji_map()
    if w in m:
        return m[w]
    candidates: list[str] = []
    if w.endswith("ies") and len(w) > 4:
        candidates.append(w[:-3] + "y")
    for suf in ("ing", "ed", "es", "s", "ly"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            stem = w[: -len(suf)]
            # Prefer silent-e restoration first (e.g. "caring" -> "care", not "car")
            if suf in ("ing", "ed"):
                candidates.append(stem + "e")
            candidates.append(stem)
            if len(stem) >= 4 and stem[-1] == stem[-2]:  # "winning" -> "win", "running" -> "run"
                candidates.append(stem[:-1])
    for c in candidates:
        if c in m:
            return m[c]
    return None


def chunk_words(words: list[dict], n: int, max_gap: float = 0.6) -> list[list[dict]]:
    chunks: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        if cur and (len(cur) >= n or w["start"] - cur[-1]["end"] > max_gap or re.search(r"[.!?,]$", cur[-1]["word"])):
            chunks.append(cur)
            cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


def _next_start(chunks: list[list[dict]], i: int) -> float:
    return chunks[i + 1][0]["start"] if i + 1 < len(chunks) else 1e9


@lru_cache(maxsize=32)
def _pil_font(font_name: str, size: int, weight: int, italic: bool) -> ImageFont.FreeTypeFont | None:
    fonts_dir = get_settings().fonts_dir
    stem = font_name.replace(" ", "")
    candidates = [
        f"{stem}-{weight}{'Italic' if italic else ''}.ttf",
        f"{stem}-900{'Italic' if italic else ''}.ttf",
        f"{stem}-700.ttf",
        f"{stem}-400.ttf",
    ]
    for c in candidates:
        p = fonts_dir / c
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except OSError:
                pass
    for p in sorted(fonts_dir.glob(f"{stem}*")):
        try:
            return ImageFont.truetype(str(p), size)
        except OSError:
            pass
    return None


def _text_width(text: str, font_name: str, size: int, weight: int, italic: bool, spacing: float) -> float:
    f = _pil_font(font_name, size, weight, italic)
    if f is not None:
        return float(f.getlength(text)) + max(0, len(text) - 1) * spacing
    return len(text) * (size * 0.58 + spacing)


def _wrap_chunk(chunk: list[dict], fmt_fn, *, max_px: float, font_name: str, size: int, weight: int, italic: bool,
                spacing: float) -> list[list[tuple[int, dict]]]:
    """Split a chunk into 1+ lines that never exceed `max_px` (prevents libass \\pos overflow)."""
    lines: list[list[tuple[int, dict]]] = [[]]
    cur_text = ""
    for idx, w in enumerate(chunk):
        tok = fmt_fn(w["word"])
        candidate = f"{cur_text} {tok}".strip()
        if lines[-1] and _text_width(candidate, font_name, size, weight, italic, spacing) > max_px:
            lines.append([(idx, w)])
            cur_text = tok
        else:
            lines[-1].append((idx, w))
            cur_text = candidate
    return lines


def build_ass(words: list[dict], style: dict, *, out_w: int, out_h: int, caption_y: float, clip_duration: float,
              auto_emoji: bool = True) -> tuple[str, list[EmojiCue]]:
    """words: clip-relative [{word,start,end}]. Returns (ass_text, emoji cues)."""
    font = style.get("font", "Montserrat")
    # Scale font gently for square/landscape ratios while keeping 1080-wide defaults identical
    scale_factor = min(out_w, out_h) / 1080.0
    size = max(32, int(round(int(style.get("size", 90)) * scale_factor)))
    weight = int(style.get("weight", 800))
    italic = -1 if style.get("italic") else 0
    outline = float(style.get("outline", 6)) * scale_factor
    shadow = float(style.get("shadow", 0)) * scale_factor
    spacing = float(style.get("spacing", 0)) * scale_factor
    primary = style.get("primary", "#FFFFFF")
    highlight = style.get("highlight", "#FFE500")
    accent = style.get("accent", highlight)
    cycle = style.get("accent_cycle") or [accent]
    glow = float(style.get("glow", 0)) * scale_factor
    bounce = float(style.get("bounce", 1.0))
    upper = bool(style.get("uppercase", False))
    mode = style.get("mode", "chunk")
    n_words = int(style.get("words_per_chunk", 3))
    x, y = out_w // 2, int(out_h * caption_y)
    max_line_px = out_w * 0.84

    is_boxed = mode == "boxed"
    border_style = 3 if is_boxed else 1
    outline_col = style.get("box_color", style.get("outline_color", "#000000")) if is_boxed else style.get("outline_color", "#000000")
    outline_alpha = 0x26 if is_boxed else 0

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {out_w}
PlayResY: {out_h}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{font},{size},{_ass_color(primary)},{_ass_color(highlight)},{_ass_color(outline_col, outline_alpha)},&H96000000,{-1 if weight >= 600 else 0},{italic},0,0,100,100,{spacing:.1f},0,{border_style},{outline:.1f},{shadow:.1f},5,70,70,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []
    cues: list[EmojiCue] = []
    base = f"\\an5\\pos({x},{y})\\b{weight}"
    pop = (f"\\fscx{int(bounce * 100)}\\fscy{int(bounce * 100)}\\t(0,110,\\fscx100\\fscy100)" if bounce > 1.0 else "")
    cyc = 0

    def fmt(w: str) -> str:
        w = _clean(w)
        return w.upper() if upper else w

    def add(layer: int, a: float, b: float, text: str):
        if b - a > 0.02:
            events.append(f"Dialogue: {layer},{_ass_time(a)},{_ass_time(b)},Main,,0,0,0,,{text}")

    def add_glow(a: float, b: float, inner: str, color: str, *, plain_inner: str | None = None):
        """Layer 0 = blurred colored halo, layer 1 = crisp text."""
        c = _ass_color(color)
        halo = plain_inner if plain_inner is not None else inner
        add(0, a, b, f"{{{base}\\bord{glow:.0f}\\blur{glow:.0f}\\3c{c}\\1c{c}\\3a&H30&{pop}}}{halo}")
        add(1, a, b, f"{{{base}\\bord{max(2, glow / 4):.0f}\\blur{glow / 3:.0f}\\3c{c}\\3a&H10&\\shad0\\1c&HFFFFFF&{pop}}}{inner}")
        add(2, a, b, f"{{{base}\\bord0\\shad0\\1c{c}\\1a&H60&{pop}}}{halo}")

    def maybe_emoji(ws: list[dict], a: float, b: float):
        if not auto_emoji:
            return
        if cues and a - cues[-1].end < 1.2:
            return
        for w in ws:
            e = emoji_for(w["word"])
            png = _emoji_png(e) if e else None
            if png:
                cues.append(EmojiCue(a, b, png))
                return

    if mode == "word":
        for i, w in enumerate(words):
            a = w["start"]
            b = words[i + 1]["start"] if i + 1 < len(words) and words[i + 1]["start"] - w["end"] < 0.5 else w["end"] + 0.25
            b = min(b, clip_duration)
            color = primary
            if is_keyword(w["word"]) or (glow and i % 2 == 0):
                color = cycle[cyc % len(cycle)]
                cyc += 1
            if glow:
                add_glow(a, b, fmt(w["word"]), color)
            else:
                add(0, a, b, f"{{{base}\\1c{_ass_color(color)}{pop}}}{fmt(w['word'])}")
            maybe_emoji([w], a, b)
    elif mode == "stack":
        lead_size = max(24, int(round(int(style.get("lead_size", size // 2.3)) * scale_factor)))
        chunks = chunk_words(words, n_words)
        for ci, chunk in enumerate(chunks):
            a = chunk[0]["start"]
            b = min(chunk[-1]["end"] + 0.15, clip_duration, _next_start(chunks, ci))
            key = chunk[-1]
            lead_words = chunk[:-1]
            lead_lines = _wrap_chunk(
                lead_words, fmt, max_px=max_line_px, font_name=font, size=lead_size,
                weight=700, italic=False, spacing=spacing,
            ) if lead_words else []
            lead = "\\N".join(" ".join(fmt(w["word"]) for _, w in ln) for ln in lead_lines)
            color = _ass_color(cycle[cyc % len(cycle)])
            cyc += 1
            lead_part = f"{{\\fs{lead_size}\\b700\\i0\\1c{_ass_color(primary)}}}{lead}\\N" if lead else ""
            add(0, a, key["start"], f"{{{base}}}{lead_part}")
            add(0, key["start"], b, f"{{{base}}}{lead_part}{{\\fs{size}\\1c{color}{pop}}}{fmt(key['word'])}")
            maybe_emoji(chunk, a, b)
    else:  # chunk or boxed
        chunks = chunk_words(words, n_words)
        for ci, chunk in enumerate(chunks):
            c_end = min(chunk[-1]["end"] + 0.12, clip_duration, _next_start(chunks, ci))
            wrapped = _wrap_chunk(
                chunk, fmt, max_px=max_line_px, font_name=font, size=size,
                weight=weight, italic=bool(italic), spacing=spacing,
            )
            for j, w in enumerate(chunk):
                a = chunk[0]["start"] if j == 0 else w["start"]
                b = chunk[j + 1]["start"] if j + 1 < len(chunk) else c_end
                line_strs = []
                plain_strs = []
                for ln in wrapped:
                    parts = []
                    plain_parts = []
                    for k, o in ln:
                        plain_parts.append(fmt(o["word"]))
                        if k == j:
                            parts.append(f"{{\\1c{_ass_color(highlight)}{pop}}}{fmt(o['word'])}{{\\r}}")
                        elif is_keyword(o["word"]):
                            parts.append(f"{{\\1c{_ass_color(accent)}}}{fmt(o['word'])}{{\\r}}")
                        else:
                            parts.append(fmt(o["word"]))
                    line_strs.append(" ".join(parts).replace("{\\r}", "{\\r" + "}" + "{" + base + "}"))
                    plain_strs.append(" ".join(plain_parts))
                joined = "\\N".join(line_strs)
                text = f"{{{base}}}" + joined
                if glow:
                    add_glow(a, b, joined, highlight, plain_inner="\\N".join(plain_strs))
                else:
                    add(0, a, b, text)
            maybe_emoji(chunk, chunk[0]["start"], c_end)

    return header + "\n".join(events) + "\n", cues[:12]


def build_srt(words: list[dict], *, words_per_line: int = 6) -> str:
    """Standard SubRip (.srt) subtitles from clip-relative word timestamps."""
    chunks = chunk_words(words, words_per_line, max_gap=0.7)
    blocks: list[str] = []
    for idx, ch in enumerate(chunks, start=1):
        a = ch[0]["start"]
        b = max(a + 0.1, ch[-1]["end"])
        txt = " ".join(w["word"].strip() for w in ch if w.get("word"))
        if txt:
            blocks.append(f"{idx}\n{_srt_time(a, ',')} --> {_srt_time(b, ',')}\n{txt}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def build_vtt(words: list[dict], *, words_per_line: int = 6) -> str:
    """WebVTT (.vtt) subtitles from clip-relative word timestamps."""
    chunks = chunk_words(words, words_per_line, max_gap=0.7)
    blocks: list[str] = ["WEBVTT"]
    for ch in chunks:
        a = ch[0]["start"]
        b = max(a + 0.1, ch[-1]["end"])
        txt = " ".join(w["word"].strip() for w in ch if w.get("word"))
        if txt:
            blocks.append(f"{_srt_time(a, '.')} --> {_srt_time(b, '.')}\n{txt}")
    return "\n\n".join(blocks) + "\n"


def clip_words(all_words: list[dict], start: float, end: float) -> list[dict]:
    """Words inside [start, end], shifted to clip time."""
    out = []
    for w in all_words:
        if w["end"] <= start or w["start"] >= end:
            continue
        out.append({"word": w["word"], "start": max(0.0, w["start"] - start), "end": min(end, w["end"]) - start})
    return out


def remap_words_after_cuts(words: list[dict], keep_segments: list[tuple[float, float]]) -> list[dict]:
    """Shift clip-relative word timestamps when internal silent segments are removed."""
    if not keep_segments or len(keep_segments) == 1 and keep_segments[0][0] <= 0.001:
        return words
    out: list[dict] = []
    offset = 0.0
    for seg_a, seg_b in keep_segments:
        seg_len = max(0.0, seg_b - seg_a)
        for w in words:
            if w["end"] <= seg_a or w["start"] >= seg_b:
                continue
            ws = max(0.0, w["start"] - seg_a) + offset
            we = min(seg_len, w["end"] - seg_a) + offset
            if we > ws + 0.01:
                out.append({"word": w["word"], "start": round(ws, 3), "end": round(we, 3)})
        offset += seg_len
    return out


def write_ass(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path
