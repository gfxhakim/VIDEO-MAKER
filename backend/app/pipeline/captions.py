"""Kinetic word-level captions rendered as ASS (libass), plus auto-emoji timing.

Every visual decision comes from a preset in app/presets/caption_styles.json:
  mode=word   one word at a time, pop-in bounce (Single Word Pop, Neon Glow, Cinematic)
  mode=chunk  2-4 word phrase, active word recolored + bounced (Hormozi, Netflix, Minimal)
  mode=stack  small lead-in line, giant keyword underneath (Gaming Stack)
Glow is two stacked layers: a blurred, thick, colored border underneath crisp text.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

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
    w = re.sub(r"[^a-z]", "", word.lower())
    if len(w) < 2:
        return None
    m = emoji_map()
    if w in m:
        return m[w]
    for k, v in m.items():  # stem/prefix match: "laughing" -> "laugh"
        if len(k) >= 4 and w.startswith(k):
            return v
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


def build_ass(words: list[dict], style: dict, *, out_w: int, out_h: int, caption_y: float, clip_duration: float,
              auto_emoji: bool = True) -> tuple[str, list[EmojiCue]]:
    """words: clip-relative [{word,start,end}]. Returns (ass_text, emoji cues)."""
    font = style.get("font", "Montserrat")
    size = int(style.get("size", 90))
    weight = int(style.get("weight", 800))
    italic = -1 if style.get("italic") else 0
    outline = float(style.get("outline", 6))
    shadow = float(style.get("shadow", 0))
    spacing = float(style.get("spacing", 0))
    primary = style.get("primary", "#FFFFFF")
    highlight = style.get("highlight", "#FFE500")
    accent = style.get("accent", highlight)
    cycle = style.get("accent_cycle") or [accent]
    glow = float(style.get("glow", 0))
    bounce = float(style.get("bounce", 1.0))
    upper = bool(style.get("uppercase", False))
    mode = style.get("mode", "chunk")
    n_words = int(style.get("words_per_chunk", 3))
    x, y = out_w // 2, int(out_h * caption_y)

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {out_w}
PlayResY: {out_h}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{font},{size},{_ass_color(primary)},{_ass_color(highlight)},{_ass_color(style.get('outline_color', '#000000'))},&H96000000,{-1 if weight >= 600 else 0},{italic},0,0,100,100,{spacing},0,1,{outline},{shadow},5,70,70,0,1

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

    def add_glow(a: float, b: float, inner: str, color: str):
        """Layer 0 = blurred colored halo, layer 1 = crisp text."""
        c = _ass_color(color)
        add(0, a, b, f"{{{base}\\bord{glow:.0f}\\blur{glow:.0f}\\3c{c}\\1c{c}\\3a&H30&{pop}}}{inner}")
        add(1, a, b, f"{{{base}\\bord{max(2, glow / 4):.0f}\\blur{glow / 3:.0f}\\3c{c}\\3a&H10&\\shad0\\1c&HFFFFFF&{pop}}}{inner}")
        add(2, a, b, f"{{{base}\\bord0\\shad0\\1c{c}\\1a&H60&{pop}}}{inner}")

    def maybe_emoji(ws: list[dict], a: float, b: float):
        if not auto_emoji or not style.get("emoji"):
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
        lead_size = int(style.get("lead_size", size // 2.3))
        chunks = chunk_words(words, n_words)
        for ci, chunk in enumerate(chunks):
            a = chunk[0]["start"]
            b = min(chunk[-1]["end"] + 0.15, clip_duration, _next_start(chunks, ci))
            key = chunk[-1]
            lead = " ".join(fmt(w["word"]) for w in chunk[:-1])
            color = _ass_color(cycle[cyc % len(cycle)])
            cyc += 1
            lead_part = f"{{\\fs{lead_size}\\b700\\i0\\1c{_ass_color(primary)}}}{lead}\\N" if lead else ""
            # reveal the keyword when it is spoken
            add(0, a, key["start"], f"{{{base}}}{lead_part}")
            add(0, key["start"], b, f"{{{base}}}{lead_part}{{\\fs{size}\\1c{color}{pop}}}{fmt(key['word'])}")
            maybe_emoji(chunk, a, b)
    else:  # chunk
        chunks = chunk_words(words, n_words)
        for ci, chunk in enumerate(chunks):
            # never overlap the next phrase (events are pinned with \pos, so libass won't move them)
            c_end = min(chunk[-1]["end"] + 0.12, clip_duration, _next_start(chunks, ci))
            for j, w in enumerate(chunk):
                a = chunk[0]["start"] if j == 0 else w["start"]
                b = chunk[j + 1]["start"] if j + 1 < len(chunk) else c_end
                parts = []
                for k, o in enumerate(chunk):
                    if k == j:
                        parts.append(f"{{\\1c{_ass_color(highlight)}{pop}}}{fmt(o['word'])}{{\\r}}")
                    elif is_keyword(o["word"]):
                        parts.append(f"{{\\1c{_ass_color(accent)}}}{fmt(o['word'])}{{\\r}}")
                    else:
                        parts.append(fmt(o["word"]))
                text = f"{{{base}}}" + " ".join(parts).replace("{\\r}", "{\\r" + "}" + "{" + base + "}")
                if glow:
                    add_glow(a, b, " ".join(fmt(o["word"]) for o in chunk), highlight)
                else:
                    add(0, a, b, text)
            maybe_emoji(chunk, chunk[0]["start"], c_end)

    return header + "\n".join(events) + "\n", cues[:12]


def clip_words(all_words: list[dict], start: float, end: float) -> list[dict]:
    """Words inside [start, end], shifted to clip time."""
    out = []
    for w in all_words:
        if w["end"] <= start or w["start"] >= end:
            continue
        out.append({"word": w["word"], "start": max(0.0, w["start"] - start), "end": min(end, w["end"]) - start})
    return out


def write_ass(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path
