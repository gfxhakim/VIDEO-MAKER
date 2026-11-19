"""Lightweight audio analysis with numpy only (no librosa/numba needed).

- energy_curve():   loudness per time-step for the source video (emotional spikes, dead air)
- analyze_music():  tempo (BPM), beat grid and the "drop" (largest sustained energy rise)
"""
from __future__ import annotations

import logging
import wave
from pathlib import Path

import numpy as np

from .media import load_pcm

log = logging.getLogger(__name__)


def energy_curve(pcm: np.ndarray, sr: int, step: float = 0.25) -> np.ndarray:
    """RMS loudness in dBFS per `step` seconds."""
    hop = max(1, int(sr * step))
    n = len(pcm) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    frames = pcm[: n * hop].reshape(n, hop)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
    return (20 * np.log10(rms + 1e-9)).astype(np.float32)


def energy_curve_wav(path: str | Path, step: float = 0.25, block_seconds: float = 60.0) -> np.ndarray:
    """energy_curve() for a 16-bit mono WAV, read a minute at a time.

    Same numbers as load_pcm() + energy_curve(), but memory stays flat: loading an hour of
    audio in one piece peaked above 900 MB, enough to get a small server killed.
    Raises ValueError for anything that is not 16-bit mono PCM.
    """
    out: list[np.ndarray] = []
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected a 16-bit mono WAV")
        hop = max(1, int(w.getframerate() * step))
        block = hop * max(1, int(round(block_seconds / step)))
        while True:
            raw = w.readframes(block)
            n = len(raw) // 2 // hop
            if n == 0:
                break
            frames = np.frombuffer(raw, dtype="<i2", count=n * hop).astype(np.float64) / 32768.0
            rms = np.sqrt(np.mean(frames.reshape(n, hop) ** 2, axis=1) + 1e-12)
            out.append((20 * np.log10(rms + 1e-9)).astype(np.float32))
            if len(raw) < block * 2:
                break
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


def _moving_avg(x: np.ndarray, k: int) -> np.ndarray:
    if k <= 1 or len(x) == 0:
        return x
    k = min(k, len(x))
    kernel = np.ones(k) / k
    return np.convolve(x, kernel, mode="same")


def onset_envelope(pcm: np.ndarray, sr: int, n_fft: int = 2048, hop: int = 512) -> np.ndarray:
    """Spectral-flux onset strength."""
    if len(pcm) < n_fft:
        return np.zeros(1)
    n_frames = 1 + (len(pcm) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = pcm[idx] * np.hanning(n_fft)[None, :]
    mag = np.log1p(np.abs(np.fft.rfft(frames, axis=1)))
    flux = np.maximum(0.0, np.diff(mag, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    flux -= _moving_avg(flux, 16)
    return np.maximum(flux, 0)


def estimate_tempo(onset: np.ndarray, frame_rate: float, lo: float = 70, hi: float = 180) -> float:
    if len(onset) < 64:
        return 0.0
    o = onset - onset.mean()
    ac = np.correlate(o, o, mode="full")[len(o) - 1:]
    min_lag = int(frame_rate * 60 / hi)
    max_lag = min(len(ac) - 1, int(frame_rate * 60 / lo))
    if max_lag <= min_lag:
        return 0.0
    lag = min_lag + int(np.argmax(ac[min_lag:max_lag]))
    return round(60.0 * frame_rate / lag, 1)


def beat_track(onset: np.ndarray, frame_rate: float, bpm: float) -> list[float]:
    """Simple beat grid: best phase of a fixed-tempo comb over the onset envelope."""
    if bpm <= 0 or len(onset) == 0:
        return []
    period = frame_rate * 60.0 / bpm
    best_phase, best = 0, -1.0
    for phase in range(int(period)):
        pos = np.arange(phase, len(onset), period).astype(int)
        val = onset[pos].sum()
        if val > best:
            best, best_phase = val, phase
    pos = np.arange(best_phase, len(onset), period)
    return [round(float(p / frame_rate), 3) for p in pos]


def find_drop(pcm: np.ndarray, sr: int, beats: list[float], window: float = 4.0, min_time: float = 3.0) -> float:
    """Time of the biggest jump from a quieter section into a louder one (the 'drop')."""
    step = 0.25
    e = energy_curve(pcm, sr, step)
    if len(e) < 8:
        return 0.0
    lin = 10 ** (e / 20)
    w = max(1, int(window / step))
    csum = np.concatenate([[0], np.cumsum(lin)])
    best_t, best_v = 0.0, -1e9
    for i in range(max(w, int(min_time / step)), len(lin) - w):
        before = (csum[i] - csum[i - w]) / w
        after = (csum[i + w] - csum[i]) / w
        v = after - before
        if v > best_v:
            best_v, best_t = v, i * step
    if beats:  # snap to nearest beat so the hit lands on the grid
        best_t = min(beats, key=lambda b: abs(b - best_t))
    return round(float(best_t), 3)


def analyze_music(path: Path, max_seconds: float = 240.0) -> dict:
    sr = 22050
    pcm = load_pcm(path, sr=sr, duration=max_seconds)
    hop = 512
    frame_rate = sr / hop
    onset = onset_envelope(pcm, sr, hop=hop)
    bpm = estimate_tempo(onset, frame_rate)
    beats = beat_track(onset, frame_rate, bpm)
    drop = find_drop(pcm, sr, beats)
    return {"bpm": bpm, "beats": beats[:2000], "drop_time": drop}
