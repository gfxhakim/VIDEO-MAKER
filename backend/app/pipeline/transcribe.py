"""Word-level transcription.

Everything runs locally with faster-whisper (CTranslate2): no API keys, no cloud.
  TRANSCRIBE_BACKEND=local  CPU int8 'base' runs ~5-10x realtime without a GPU. Use
                            WHISPER_MODEL=tiny on weak machines, small/medium for accuracy.
  TRANSCRIBE_BACKEND=none   skip speech; highlight scoring uses audio energy only.
The model downloads once into DATA_DIR/models (kept on the Railway volume).

Output format (saved as transcript.json):
  {"language": "en", "words": [{"word": "Hello", "start": 0.0, "end": 0.32}, ...],
   "segments": [{"start": 0.0, "end": 3.1, "text": "Hello there ..."}]}
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Callable, Optional

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
    raise MediaError(f"Unknown TRANSCRIBE_BACKEND '{backend}' (use local or none)")


# ---------------------------------------------------------------- local
def _get_local_model():
    s = get_settings()
    key = f"{s.whisper_model}:{s.whisper_device}:{s.whisper_compute_type}"
    with _model_lock:
        if key not in _model_cache:
            try:
                from faster_whisper import WhisperModel
            except ImportError as e:
                raise MediaError("faster-whisper is not installed: pip install faster-whisper") from e
            log.info("loading whisper model %s (first run downloads it)", key)
            _model_cache[key] = WhisperModel(s.whisper_model, device=s.whisper_device, compute_type=s.whisper_compute_type,
                                             download_root=str(s.models_dir), cpu_threads=s.whisper_threads)
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
