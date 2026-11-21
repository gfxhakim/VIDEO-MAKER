"""Tests for the speed and robustness work: transcription input, cached analysis, live render
progress, crash recovery, the faster zoom graph and response compression."""
import json
import shutil
import subprocess
import threading
import time
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from app import config, queue
from app.config import get_settings
from app.db import init_db, session_scope
from app.models import Clip, Job, Project
from app.pipeline import audio_analysis, media, reframe, render, tasks, transcribe

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")


def _write_wav(path: Path, samples: np.ndarray, sr: int = 16000) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(samples.astype("<i2").tobytes())


# ------------------------------------------------------------------ transcription
def test_whisper_gets_samples_not_a_file_path(tmp_path, monkeypatch):
    """faster-whisper's own file loader breaks on PyAV 19, so we must hand it samples."""
    wav = tmp_path / "a.wav"
    pcm = (np.sin(np.linspace(0, 440 * 2 * np.pi, 16000)) * 12000).astype(np.int16)
    _write_wav(wav, pcm)
    seen = {}

    class FakeModel:
        def transcribe(self, audio, **kw):
            seen["audio"], seen["kw"] = audio, kw
            seg = SimpleNamespace(start=0.0, end=1.0, text=" hello world", words=[
                SimpleNamespace(word=" hello", start=0.0, end=0.4, probability=0.9),
                SimpleNamespace(word=" world", start=0.5, end=0.9, probability=0.8),
                SimpleNamespace(word=" ", start=0.9, end=1.0, probability=0.1),
            ])
            return iter([seg]), SimpleNamespace(language="en", duration=1.0)

    monkeypatch.setattr(transcribe, "_get_local_model", lambda: FakeModel())
    monkeypatch.setattr(get_settings(), "transcribe_backend", "local")
    ticks = []
    out = transcribe.transcribe(wav, None, ticks.append, 1.0)

    audio = seen["audio"]
    assert isinstance(audio, np.ndarray) and audio.dtype == np.float32 and audio.shape == (16000,)
    assert np.allclose(audio, pcm / 32768.0, atol=1e-6)
    assert seen["kw"]["word_timestamps"] is True and seen["kw"]["beam_size"] == 1
    assert [w["word"] for w in out["words"]] == ["hello", "world"]
    assert out["language"] == "en" and ticks and 0 < ticks[-1] <= 0.99


def test_whisper_threads_follow_the_machine(monkeypatch):
    monkeypatch.setattr(get_settings(), "whisper_threads", 0)
    for cpus, want in ((1, 1), (2, 2), (4, 2), (8, 4), (32, 4)):
        monkeypatch.setattr(transcribe, "effective_cpus", lambda c=cpus: c)
        assert transcribe.whisper_cpu_threads() == want
    monkeypatch.setattr(get_settings(), "whisper_threads", 6)
    assert transcribe.whisper_cpu_threads() == 6  # 32 cores from the loop above


# ------------------------------------------------------------------ audio energy
def test_streamed_energy_matches_the_in_memory_version(tmp_path):
    rng = np.random.default_rng(3)
    n = int(16000 * 95.3)  # not a whole number of blocks or steps
    pcm = (rng.normal(0, 3000, n) * np.linspace(0.05, 1, n)).clip(-32768, 32767).astype(np.int16)
    wav = tmp_path / "e.wav"
    _write_wav(wav, pcm)
    streamed = audio_analysis.energy_curve_wav(wav, 0.25, block_seconds=7)
    whole = audio_analysis.energy_curve(pcm.astype(np.float32) / 32768.0, 16000, 0.25)
    assert streamed.shape == whole.shape == (381,)
    assert np.allclose(streamed, whole, atol=1e-3)
    assert audio_analysis.energy_curve_wav(wav, 0.25).shape == whole.shape


def test_streamed_energy_rejects_other_formats(tmp_path):
    wav = tmp_path / "stereo.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0" * 6400)
    with pytest.raises(ValueError):
        audio_analysis.energy_curve_wav(wav)


# ------------------------------------------------------------------ queue recovery
def test_interrupted_job_out_of_attempts_is_failed_not_requeued():
    init_db()
    failed = []
    queue.register("t_recover", lambda p: None, on_final_failure=lambda p, e: failed.append((p, e)))
    with session_scope() as s:
        dead = Job(kind="t_recover", payload={"n": 1}, status="running", attempts=3, max_attempts=3, locked_by="x")
        alive = Job(kind="t_recover", payload={"n": 2}, status="running", attempts=1, max_attempts=3, locked_by="x")
        s.add(dead)
        s.add(alive)
        s.commit()
        dead_id, alive_id = dead.id, alive.id
    assert queue.recover_stale_jobs() >= 1
    with session_scope() as s:
        d, a = s.get(Job, dead_id), s.get(Job, alive_id)
        assert (d.status, d.locked_by) == ("failed", None) and d.finished_at and d.error
        assert (a.status, a.locked_by) == ("queued", None)
        a.status = "done"  # do not leave work behind for other tests
        s.add(a)
        s.commit()
    assert failed == [({"n": 1}, queue.INTERRUPTED_ERROR)]


def test_auto_worker_concurrency(monkeypatch):
    gb = 1024**3
    for cpus, mem, want in ((1, 8 * gb, 1), (2, 8 * gb, 1), (4, 8 * gb, 2), (8, 16 * gb, 3), (8, 3 * gb, 1),
                            (8, 1 * gb, 1), (4, 4 * gb, 2), (32, 0, 3)):
        monkeypatch.setattr(config, "effective_cpus", lambda c=cpus: c)
        monkeypatch.setattr(config, "memory_limit_bytes", lambda m=mem: m)
        assert config.auto_worker_concurrency() == want, (cpus, mem)
    monkeypatch.setattr(get_settings(), "worker_concurrency", 5)
    assert config.worker_count() == 5


# ------------------------------------------------------------------ render graph
def test_zoom_uses_single_pass_dynamic_crop_and_bicubic():
    style = {"zoom_on_emphasis": True, "zoom_amount": 1.15}
    lay = reframe.build_layout("center", src_w=1920, src_h=1080, out_w=1080, out_h=1920, track=reframe.FaceTrack(),
                               style=style, zoom_windows=[(1.0, 2.0), (5.0, 6.1)])
    f = lay.filter
    assert f.count("[0:v]") == 1 and "split=" not in f and "overlay=" not in f and f.endswith("[vbase]")
    assert "crop=w='if(gt(between(t,1.00,2.00)+between(t,5.00,6.10),0),528,608)'" in f
    assert "flags=bicubic:eval=frame" in f
    plain = reframe.build_layout("center", src_w=1920, src_h=1080, out_w=1080, out_h=1920, track=reframe.FaceTrack(),
                                 style=style, zoom_windows=[])
    assert "overlay" not in plain.filter and "split" not in plain.filter and "eval=frame" not in plain.filter


def test_render_command_caps_threads_bitrate_and_drops_high_fps_early(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "ffmpeg_threads", 0)
    spec = render.RenderSpec(source=Path("in.mp4"), start=3, end=13, out_path=tmp_path / "o.mp4", work_dir=tmp_path,
                             video_filter="[0:v]crop=608:1080:656:0[c0];[c0]scale=1080:1920[vbase]",
                             out_w=1080, out_h=1920, fps=59.94)
    cmd = render.build_command(spec)
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert graph.startswith("[0:v]fps=30[v30];[v30]crop=608:1080:656:0[c0];")
    threads = str(config.ffmpeg_thread_count())
    assert 1 <= int(threads) <= 8
    assert cmd[cmd.index("-filter_complex_threads") + 1] == threads
    assert cmd.index("-threads") < cmd.index("-i") and cmd[cmd.index("-threads") + 1] == threads  # decoder
    assert cmd[len(cmd) - 1 - cmd[::-1].index("-threads") + 1] == threads  # encoder
    assert cmd[cmd.index("-maxrate") + 1] == "10M" and cmd[cmd.index("-crf") + 1] == str(get_settings().ffmpeg_crf)

    spec.fps = 30.0
    graph = render.build_command(spec)[cmd.index("-filter_complex") + 1]
    assert graph.startswith("[0:v]crop=") and "fps=30" not in graph


def test_face_track_survives_json():
    t = reframe.FaceTrack(times=[0.0, 0.25, 0.5], faces=[[(0.5, 0.4, 0.2, 0.3)], [], [(0.1, 0.2, 0.3, 0.4), (0.9, 0.8, 0.1, 0.1)]])
    back = reframe.FaceTrack.from_dict(json.loads(json.dumps(t.to_dict())))
    assert back.times == t.times and back.faces == t.faces and back.hit_rate == t.hit_rate
    with pytest.raises(ValueError):
        reframe.FaceTrack.from_dict({"times": [0.0], "faces": []})


# ------------------------------------------------------------------ ffmpeg helpers
@needs_ffmpeg
def test_run_progress_reports_fails_and_times_out(tmp_path):
    ff = get_settings().ffmpeg_bin
    ticks = []
    out = tmp_path / "p.mp4"
    media.run_progress([ff, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=3:r=30",
                        "-c:v", "libx264", "-preset", "ultrafast", str(out)], 3.0, ticks.append)
    assert out.stat().st_size > 1000
    assert ticks and all(0.0 <= t <= 1.0 for t in ticks)

    with pytest.raises(media.MediaError, match="No such file"):
        media.run_progress([ff, "-y", "-v", "error", "-i", str(tmp_path / "missing.mp4"), str(tmp_path / "x.mp4")], 1.0)

    t0 = time.monotonic()
    with pytest.raises(media.MediaError, match="timed out"):
        media.run_progress([ff, "-y", "-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=s=160x120:d=30:r=10",
                            "-f", "null", "-"], 30.0, timeout=1.0)
    assert time.monotonic() - t0 < 10


@needs_ffmpeg
def test_scene_scan_finds_a_cut_and_can_be_stopped(tmp_path):
    src = tmp_path / "cut.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=3:r=30",
                    "-f", "lavfi", "-i", "color=c=white:s=320x240:d=3:r=30", "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]",
                    "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", str(src)], check=True)
    cuts = media.scan_scene_changes(src, threads=1)
    assert len(cuts) == 1 and 2.4 <= cuts[0] <= 3.6
    assert media.detect_scene_changes(src) == cuts

    stop = threading.Event()
    stop.set()
    with pytest.raises(media.MediaError, match="stopped"):
        media.scan_scene_changes(src, stop=stop)
    assert media.detect_scene_changes(tmp_path / "missing.mp4") == []


# ------------------------------------------------------------------ analysis caching
def _project(src: Path, **settings) -> int:
    init_db()
    with session_scope() as s:
        p = Project(name="t", source_type="path", source=str(src),
                    settings={"clip_count": 10, "min_duration": 10, "max_duration": 15, **settings})
        s.add(p)
        s.commit()
        s.refresh(p)
        return p.id


@needs_ffmpeg
def test_second_analysis_reuses_everything_and_cleans_up(tmp_path, monkeypatch):
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=40:r=30",
                    "-f", "lavfi", "-i", "sine=f=220:d=40", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", str(src)], check=True)
    queued = []
    monkeypatch.setattr(tasks, "enqueue", lambda kind, payload, **k: queued.append(payload["clip_id"]))
    pid = _project(src)
    pdir = tasks.project_dir(pid)

    tasks.analyze_project({"project_id": pid})
    first = list(queued)
    assert first
    assert (pdir / "scenes.json").exists() and (pdir / "energy.npy").exists() and (pdir / "transcript.json").exists()
    assert not (pdir / "audio16k.wav").exists(), "the extracted audio must not stay on the volume"
    energy = np.load(pdir / "energy.npy")
    assert len(energy) == pytest.approx(160, abs=3)

    # leftovers of the first run that the second one has to remove
    for cid in first:
        (pdir / "clips" / str(cid)).mkdir(parents=True)
        (pdir / "clips" / str(cid) / "clip.mp4").write_bytes(b"x" * 10)
    (pdir / "faces").mkdir(exist_ok=True)
    (pdir / "faces" / "1.000-2.000.json").write_text("{}")

    def must_not_run(*a, **k):
        raise AssertionError("work that is cached was done again")

    monkeypatch.setattr(media, "scan_scene_changes", must_not_run)
    monkeypatch.setattr(media, "extract_audio", must_not_run)
    monkeypatch.setattr(tasks.transcribe, "transcribe", must_not_run)
    queued.clear()
    tasks.analyze_project({"project_id": pid})
    assert queued
    # SQLite hands the freed ids to the new clips, so what matters is that no old file survives
    assert not any((pdir / "clips" / str(cid) / "clip.mp4").exists() for cid in first)
    assert not (pdir / "faces" / "1.000-2.000.json").exists()
    with session_scope() as s:
        p = s.get(Project, pid)
        assert p.progress == 0.7 and p.stage == f"Rendering {len(queued)} clips"


@needs_ffmpeg
def test_failed_audio_step_stops_the_background_scene_scan(tmp_path, monkeypatch):
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=12:r=30",
                    "-f", "lavfi", "-i", "sine=f=220:d=12", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", str(src)], check=True)
    pid = _project(src)
    stopped = []

    def slow_scan(path, threshold=0.32, *, threads=None, stop=None):
        stopped.append(stop.wait(20))
        raise media.MediaError("scene detection was stopped")

    def broken_audio(*a, **k):
        raise media.MediaError("boom")

    monkeypatch.setattr(media, "scan_scene_changes", slow_scan)
    monkeypatch.setattr(tasks, "_analyze_audio", broken_audio)
    t0 = time.monotonic()
    with pytest.raises(media.MediaError, match="boom"):
        tasks.analyze_project({"project_id": pid})
    assert stopped == [True] and time.monotonic() - t0 < 10
    assert not (tasks.project_dir(pid) / "scenes.json").exists()


# ------------------------------------------------------------------ live progress
def _project_with_clips(statuses: list[str]) -> tuple[int, list[int]]:
    init_db()
    with session_scope() as s:
        p = Project(name="p", source_type="upload", source="x.mp4", status="processing", progress=0.7)
        s.add(p)
        s.commit()
        s.refresh(p)
        ids = []
        for i, st in enumerate(statuses):
            c = Clip(project_id=p.id, rank=i + 1, start=i * 20.0, end=i * 20.0 + 15, status=st)
            s.add(c)
            s.commit()
            s.refresh(c)
            ids.append(c.id)
        return p.id, ids


def test_progress_moves_while_a_clip_renders():
    pid, ids = _project_with_clips(["ready", "rendering", "pending", "pending"])
    try:
        tasks._inflight[ids[1]] = (pid, 0.5)
        tasks.refresh_project_progress(pid)
        with session_scope() as s:
            p = s.get(Project, pid)
            assert p.progress == pytest.approx(0.7 + 0.3 * 1.5 / 4, abs=0.001)
            assert p.stage == "Rendering clip 2 of 4" and p.status == "processing"

        tasks._inflight[ids[2]] = (pid, 0.1)
        tasks.refresh_project_progress(pid)
        with session_scope() as s:
            p = s.get(Project, pid)
            assert p.stage == "Rendering clips 2 to 3 of 4"
            assert p.progress == pytest.approx(0.7 + 0.3 * 1.6 / 4, abs=0.001)

        # a throttled tick right after a write is skipped
        tasks._inflight[ids[1]] = (pid, 0.9)
        tasks.refresh_project_progress(pid, throttle=True)
        with session_scope() as s:
            assert s.get(Project, pid).progress == pytest.approx(0.7 + 0.3 * 1.6 / 4, abs=0.001)
    finally:
        tasks._inflight.pop(ids[1], None)
        tasks._inflight.pop(ids[2], None)
    tasks.refresh_project_progress(pid)
    with session_scope() as s:
        assert s.get(Project, pid).stage == "Rendered 1 of 4 clips"


def test_interrupted_render_marks_its_clip_failed():
    pid, ids = _project_with_clips(["ready", "rendering"])
    tasks.fail_clip({"clip_id": ids[1]}, "server restarted")
    with session_scope() as s:
        c, p = s.get(Clip, ids[1]), s.get(Project, pid)
        assert (c.status, c.error) == ("failed", "server restarted")
        assert (p.status, p.progress, p.stage) == ("done", 1.0, "1 of 2 clips ready")
    tasks.fail_clip({"clip_id": ids[0]}, "late")  # a finished clip is never flipped back
    with session_scope() as s:
        assert s.get(Clip, ids[0]).status == "ready"


# ------------------------------------------------------------------ delivery
def test_text_is_compressed_and_cached_but_media_is_left_alone():
    from app.main import FastDelivery

    body = "const x = 1;\n" * 600
    inner = Starlette(routes=[Route("/{p:path}", lambda r: PlainTextResponse(body))])
    c = TestClient(FastDelivery(inner))
    gz = {"accept-encoding": "gzip"}

    r = c.get("/_next/static/chunks/app-abc123.js", headers=gz)
    assert r.headers.get("content-encoding") == "gzip" and r.text == body
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"

    r = c.get("/project/", headers=gz)
    assert r.headers.get("content-encoding") == "gzip" and r.headers["cache-control"] == "no-cache"

    r = c.get("/api/projects", headers=gz)
    assert r.headers.get("content-encoding") == "gzip" and "cache-control" not in r.headers

    for path in ("/media/projects/1/clips/2/clip.mp4", "/api/projects/3/export.zip", "/api/clips/4/download",
                 "/api/uploads/abc/chunks/0", "/_next/static/media/font.woff2", "/icon.png"):
        r = c.get(path, headers=gz)
        assert "content-encoding" not in r.headers, path
        assert r.text == body


# ------------------------------------------------------------------ small robustness fixes
def test_face_track_is_cached_per_clip(tmp_path, monkeypatch):
    import os

    src = tmp_path / "s.mp4"
    src.write_bytes(b"x")
    calls = []
    track = reframe.FaceTrack(times=[0.0, 0.25], faces=[[(0.5, 0.4, 0.2, 0.3)], []])
    monkeypatch.setattr(reframe, "analyze_faces", lambda *a, **k: (calls.append(a), track)[1])

    first = tasks._face_track(tmp_path, src, 1.5, 20.25)
    again = tasks._face_track(tmp_path, src, 1.5, 20.25)
    assert len(calls) == 1 and again.times == first.times and again.faces == first.faces
    tasks._face_track(tmp_path, src, 2.0, 20.25)  # another clip
    assert len(calls) == 2
    (tmp_path / "faces" / "1.500-20.250.json").write_text("{broken")
    tasks._face_track(tmp_path, src, 1.5, 20.25)  # unreadable cache: detect again
    assert len(calls) == 3
    later = time.time() + 60
    os.utime(src, (later, later))
    tasks._face_track(tmp_path, src, 1.5, 20.25)  # the source changed: detect again
    assert len(calls) == 4


def test_words_past_the_end_of_the_video_do_not_break_scoring():
    from app.pipeline import highlights

    words = [{"word": w, "start": 0.5 + i * 0.4, "end": 0.8 + i * 0.4}
             for i, w in enumerate(("Here's why money changed my life forever! " * 25).split())]
    assert words[-1]["end"] > 60
    energy = np.full(120, -25.0, dtype=np.float32)  # 30 s of audio
    clips = highlights.select_highlights(duration=30.0, words=words, energy_db=energy, energy_step=0.25,
                                         scene_cuts=[12.0, 44.0], count=10, min_len=10, max_len=20)
    assert isinstance(clips, list)
