"""Optional OpenAI-compatible / Ollama client for semantic hook scoring and copywriting.

Zero external API keys are required for AutoClip Studio: this module is only used when the
user explicitly configures LLM_BASE_URL (or local Ollama) in Settings / env.
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any

from ..config import load_runtime_config

log = logging.getLogger(__name__)


def is_configured() -> bool:
    cfg = load_runtime_config()
    return bool((cfg.get("llm_base_url") or "").strip())


def chat_json(system_prompt: str, user_prompt: str, *, timeout: float = 25.0) -> dict[str, Any]:
    cfg = load_runtime_config()
    base = (cfg.get("llm_base_url") or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("No AI endpoint configured. Add one in Settings (e.g. Ollama or an OpenAI-compatible API).")
    url = base if base.endswith("/chat/completions") else f"{base}/chat/completions"
    headers = {"Content-Type": "application/json"}
    api_key = (cfg.get("llm_api_key") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": (cfg.get("llm_model") or "gpt-4o-mini").strip(),
        "temperature": 0.4,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_text = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"AI endpoint returned HTTP {e.code}: {err_text}") from e
    except Exception as e:
        raise RuntimeError(f"Could not reach AI endpoint: {e}") from e
    content = body["choices"][0]["message"]["content"]
    try:
        return json.loads(content)
    except ValueError:
        # Some local models wrap JSON in markdown fences
        stripped = content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        return json.loads(stripped)


def test_connection() -> dict[str, Any]:
    res = chat_json("Reply with JSON: {\"ok\": true}", "Ping", timeout=10.0)
    return {"ok": bool(res.get("ok", True))}


def rewrite_clip_copy(transcript: str, current_title: str = "") -> dict[str, Any]:
    """Rewrite viral title, hook card text, description, and hashtags for one clip."""
    data = chat_json(
        "You are a viral short-form editor. Reply ONLY in JSON with keys: "
        "title (<= 70 chars, punchy curiosity gap), hook (<= 55 chars, great for an on-screen white card), "
        "description (<= 220 chars, engaging caption), hashtags (array of 4-6 short lowercase #tags without spaces).",
        f"Transcript:\n{transcript[:2500]}\n\nCurrent title: {current_title}",
    )
    tags = [str(t).strip() for t in (data.get("hashtags") or []) if str(t).strip()]
    tags = [t if t.startswith("#") else f"#{t}" for t in tags][:6]
    return {
        "title": str(data.get("title") or current_title)[:120].strip(),
        "hook": str(data.get("hook") or data.get("title") or current_title)[:90].strip(),
        "description": str(data.get("description") or "")[:500].strip(),
        "hashtags": tags,
    }


def enhance_candidates(clips: list[Any]) -> None:
    """Optionally boost/rerank candidate clips and improve titles/hooks in one batched prompt."""
    if not is_configured() or not clips:
        return
    items = [
        {
            "index": i,
            "duration": round(float(c.duration), 1),
            "hook_line": str(c.hook)[:140],
            "text": c.text[:600],
            "heuristic_score": c.score,
        }
        for i, c in enumerate(clips[:25])
    ]
    try:
        res = chat_json(
            "You evaluate short video clips for viral retention on TikTok, Reels & Shorts. "
            "Score higher when the first sentence creates curiosity/stakes, the middle builds tension or clear insight, "
            "and the ending lands cleanly with a complete takeaway (never cut mid-thought). "
            "Reply ONLY in JSON: "
            "{\"clips\": [{\"index\": int, \"boost\": float (-18 to +18), \"title\": str, \"hook\": str, \"hashtags\": [str]}]}.",
            json.dumps({"clips": items}),
            timeout=30.0,
        )
        for entry in res.get("clips") or []:
            idx = int(entry.get("index", -1))
            if 0 <= idx < len(clips):
                c = clips[idx]
                boost = max(-18.0, min(18.0, float(entry.get("boost", 0.0))))
                c.score = round(max(0.0, min(100.0, c.score + boost)), 1)
                if entry.get("title"):
                    c.hook = str(entry["title"])[:90]
                if entry.get("hook"):
                    c.hook = str(entry["hook"])[:90]
                c.breakdown = {**c.breakdown, "ai_boost": round(boost, 2)}
        clips.sort(key=lambda x: x.score, reverse=True)
    except Exception as e:
        log.warning("AI enhancement skipped: %s", e)
