"""Word-level transcription.

Backends (TRANSCRIBE_BACKEND):
  local  - faster-whisper (CTranslate2). CPU int8 'base' runs ~5-10x realtime on a laptop
           without a GPU. Use 'tiny' for weaker machines, 'small'/'medium' for accuracy.
  openai - OpenAI whisper-1 API with word timestamps (nothing runs locally).
  groq   - Groq's OpenAI-compatible whisper-large-v3 API (has a free tier, very fast).
  none   - no speech; highlight scoring falls back to audio energy only.

Output format (saved as transcript.json):
  {"language": "en", "words": [{"word": "Hello", "start": 0.0, "end": 0.32}, ...],
   "segments": [{"start": 0.0, "end": 3.1, "text": "Hello there ..."}]}
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from ..config import get_settings
from .media import MediaError, run

log = logging.getLogger(__name__)

_model_lock = threading.Lock()
_model_cache: dict[str, Any] = {}


def transcribe(audio_path: Path, language: Optional[str] = None, on_progress: Optional[Callable[[float], None]] = None,
               duration: float = 0.0) -> dict:
    backend = get_settings().transcribe_backend.lower()
    if backend == "none":
        return {"language": language or "", "words": [], "segments": []}
    if backend == "local":
        return _local(audio_path, language, on_progress, duration)
    if backend in ("openai", "groq"):
        return _api(audio_path, language, backend)
    raise MediaError(f"Unknown TRANSCRIBE_BACKEND '{backend}'")


# ---------------------------------------------------------------- local
def _get_local_model():
    s = get_settings()
    key = f"{s.whisper_model}:{s.whisper_device}:{s.whisper_compute_type}"
    with _model_lock:
        if key not in _model_cache:
            try:
                from faster_whisper import WhisperModel
            except ImportError as e:
                raise MediaError("faster-whisper not installed. pip install faster-whisper, or set TRANSCRIBE_BACKEND=groq/openai") from e
            log.info("loading whisper model %s", key)
            _model_cache[key] = WhisperModel(s.whisper_model, device=s.whisper_device, compute_type=s.whisper_compute_type)
        return _model_cache[key]


def _local(audio_path: Path, language, on_progress, duration) -> dict:
    model = _get_local_model()
    segments_iter, info = model.transcribe(
        str(audio_path), language=language, word_timestamps=True, vad_filter=True,
        beam_size=1,  # greedy decoding: much faster on CPU, tiny accuracy cost
        condition_on_previous_text=False,
    )
    words, segments = [], []
    total = duration or getattr(info, "duration", 0) or 0
    for seg in segments_iter:
        segments.append({"start": seg.start, "end": seg.end, "text": seg.text.strip()})
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"word": text, "start": float(w.start), "end": float(w.end), "p": float(w.probability)})
        if on_progress and total:
            on_progress(min(0.99, seg.end / total))
    return {"language": info.language, "words": words, "segments": segments}


# ---------------------------------------------------------------- API
API_LIMIT_BYTES = 24 * 1024 * 1024


def _api(audio_path: Path, language, backend: str) -> dict:
    s = get_settings()
    if backend == "openai":
        url, key, model = "https://api.openai.com/v1/audio/transcriptions", s.openai_api_key, "whisper-1"
    else:
        url, key, model = "https://api.groq.com/openai/v1/audio/transcriptions", s.groq_api_key, "whisper-large-v3-turbo"
    if not key:
        raise MediaError(f"{backend.upper()}_API_KEY is not set")

    # APIs cap uploads at 25 MB: send compressed mono opus in ~10 min chunks.
    chunks = _chunk_audio(audio_path, seconds=600)
    words, segments, lang = [], [], language or ""
    for offset, chunk in chunks:
        data = {"model": model, "response_format": "verbose_json", "timestamp_granularities[]": ["word", "segment"]}
        if language:
            data["language"] = language
        with open(chunk, "rb") as f:
            resp = httpx.post(url, headers={"Authorization": f"Bearer {key}"}, data=data,
                              files={"file": (chunk.name, f, "audio/ogg")}, timeout=600)
        if resp.status_code >= 400:
            raise MediaError(f"{backend} transcription failed: {resp.status_code} {resp.text[:300]}")
        j = resp.json()
        lang = lang or j.get("language", "")
        for w in j.get("words", []) or []:
            words.append({"word": w["word"].strip(), "start": w["start"] + offset, "end": w["end"] + offset})
        for sg in j.get("segments", []) or []:
            segments.append({"start": sg["start"] + offset, "end": sg["end"] + offset, "text": sg["text"].strip()})
    return {"language": lang, "words": [w for w in words if w["word"]], "segments": segments}


def _chunk_audio(audio_path: Path, seconds: int) -> list[tuple[float, Path]]:
    s = get_settings()
    out_dir = audio_path.parent / "chunks"
    out_dir.mkdir(exist_ok=True)
    run([s.ffmpeg_bin, "-y", "-v", "error", "-i", str(audio_path), "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k",
         "-f", "segment", "-segment_time", str(seconds), str(out_dir / "c%03d.ogg")])
    files = sorted(out_dir.glob("c*.ogg"))
    return [(i * float(seconds), f) for i, f in enumerate(files)]
