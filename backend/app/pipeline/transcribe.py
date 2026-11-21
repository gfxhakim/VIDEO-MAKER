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
import time
import wave
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

from ..config import effective_cpus, get_settings
from .media import MediaError, load_pcm, run

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
            threads = whisper_cpu_threads()
            log.info("loading whisper model %s on %s thread(s) (first run downloads it)", key, threads)
            _model_cache[key] = WhisperModel(s.whisper_model, device=s.whisper_device, compute_type=s.whisper_compute_type,
                                             download_root=str(s.models_dir), cpu_threads=threads)
        return _model_cache[key]


def whisper_cpu_threads() -> int:
    """Threads for the speech model: WHISPER_THREADS if set, else 2 on small machines and 4 on bigger ones.

    Measured on 4 cores, 2 threads were faster than 3 or 4 (the decoder slows down with
    more), and they leave cores free for the scene scan that runs at the same time.
    """
    cpus = effective_cpus()
    wanted = get_settings().whisper_threads or (2 if cpus <= 4 else 4)
    return max(1, min(wanted, cpus))


def load_audio(audio_path: Path, sr: int = 16000) -> np.ndarray:
    """Read the 16 kHz mono WAV we extracted ourselves into float32 samples.

    faster-whisper would otherwise decode the file again through PyAV, and PyAV 19 broke
    that call (open() no longer accepts metadata_errors), which failed every transcription
    on a fresh install. Handing over samples avoids the decoder completely.
    """
    try:
        with wave.open(str(audio_path), "rb") as w:
            if w.getframerate() == sr and w.getnchannels() == 1 and w.getsampwidth() == 2:
                samples = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
                samples *= 1.0 / 32768.0  # in place: a two-hour video is ~460 MB of samples
                return samples
    except (wave.Error, EOFError, OSError):
        pass
    return load_pcm(audio_path, sr=sr)  # anything else: let ffmpeg convert it


def _local(audio_path: Path, language, on_progress, duration) -> dict:
    model = _get_local_model()
    samples = load_audio(audio_path)
    total = duration or (len(samples) / 16000.0)
    t0 = time.monotonic()
    segments_iter, info = model.transcribe(
        samples, language=language, word_timestamps=True, vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=1,
        best_of=1,
        temperature=(0.0, 0.4),
        condition_on_previous_text=False,
    )
    words, segments = [], []
    last_tick = 0.0
    for seg in segments_iter:
        segments.append({"start": seg.start, "end": seg.end, "text": seg.text.strip()})
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"word": text, "start": float(w.start), "end": float(w.end), "p": float(w.probability)})
        now = time.monotonic()
        if on_progress and total and now - last_tick >= 1.0:  # at most one progress write a second
            last_tick = now
            on_progress(min(0.99, seg.end / total))
    took = time.monotonic() - t0
    if total and took > 0:
        log.info("transcribed %.0fs of audio in %.0fs (%.1fx realtime, %d words)", total, took, total / took, len(words))
    return {"language": info.language, "words": words, "segments": segments}
