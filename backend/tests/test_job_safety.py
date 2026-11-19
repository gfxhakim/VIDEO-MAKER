"""Jobs never act on the wrong project or clip, renders of one clip never overlap, and the
upload edge cases the review found stay fixed."""
import os
import shutil
import subprocess
import threading
import time
from collections import namedtuple
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app import queue
from app.api import uploads as uploads_api
from app.config import get_settings
from app.db import init_db, session_scope
from app.main import app
from app.models import Clip, Job, Project, Upload
from app.pipeline import media, reframe, tasks

from test_api import CHUNK, _put, _signed_in, small_chunks  # noqa: F401  (fixture)

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")


def _project(**kw) -> Project:
    init_db()
    with session_scope() as s:
        p = Project(name="p", source_type=kw.pop("source_type", "upload"), source="x.mp4", **kw)
        s.add(p)
        s.commit()
        s.refresh(p)
        s.expunge(p)
        return p


def _clip(pid: int, **kw) -> Clip:
    with session_scope() as s:
        c = Clip(project_id=pid, start=kw.pop("start", 0.0), end=kw.pop("end", 12.0), **kw)
        s.add(c)
        s.commit()
        s.refresh(c)
        s.expunge(c)
        return c


def _jobs(kind: str) -> list[Job]:
    with session_scope() as s:
        return s.exec(select(Job).where(Job.kind == kind)).all()


@pytest.fixture(autouse=True)
def _no_leftover_jobs():
    yield
    with session_scope() as s:  # other tests run workers: leave no runnable work behind
        for j in s.exec(select(Job).where(Job.status == "queued")).all():
            j.status = "cancelled"
            s.add(j)
        s.commit()


# ------------------------------------------------------------------ identity
def test_stale_jobs_for_a_reused_id_do_nothing(monkeypatch):
    p = _project(status="processing")
    c = _clip(p.id, status="ready", video_path="/x/clip.mp4")
    ran = []
    monkeypatch.setattr(media, "probe", lambda *a: ran.append(a))

    tasks.render_clip({"clip_id": c.id, "created": "2001-01-01T00:00:00+00:00"})
    tasks.analyze_project({"project_id": p.id, "created": "2001-01-01T00:00:00+00:00"})
    assert ran == []
    with session_scope() as s:
        clip = s.get(Clip, c.id)
        assert (clip.status, clip.video_path) == ("ready", "/x/clip.mp4")
        assert s.get(Project, p.id).status == "processing"

    tasks.fail_project({"project_id": p.id, "created": "2001-01-01T00:00:00+00:00"}, "boom")
    tasks.fail_clip({"clip_id": c.id, "created": "2001-01-01T00:00:00+00:00"}, "boom")
    with session_scope() as s:
        assert s.get(Project, p.id).status == "processing" and s.get(Clip, c.id).status == "ready"

    # jobs queued by the old code have no stamp and still work
    tasks.fail_project({"project_id": p.id}, "boom")
    with session_scope() as s:
        assert s.get(Project, p.id).status == "failed"


def test_analysis_of_a_deleted_project_stops_without_writing(tmp_path, monkeypatch):
    src = tmp_path / "s.mp4"
    src.write_bytes(b"x" * 100)
    p = _project(source_path=str(src))
    pdir = tasks.project_dir(p.id)
    Info = namedtuple("Info", "duration width height fps has_audio")
    monkeypatch.setattr(media, "probe", lambda path: Info(60.0, 1280, 720, 30.0, True))
    monkeypatch.setattr(media, "scan_scene_changes", lambda *a, **k: [5.0])

    def audio(pid, created, stage, *a):
        # the user deletes the project while it is being transcribed; a new one gets its id
        with session_scope() as s:
            s.delete(s.get(Project, pid))
            s.commit()
            s.add(Project(id=pid, name="B", source_type="upload", source="b.mp4", status="done"))
            s.commit()
        stage("Transcribing speech", 0.3)
        raise AssertionError("must not get here")

    monkeypatch.setattr(tasks, "_analyze_audio", audio)
    tasks.analyze_project({"project_id": p.id})  # ends quietly, no retry
    with session_scope() as s:
        b = s.get(Project, p.id)
        assert (b.name, b.status, b.stage) == ("B", "done", "")
        assert s.exec(select(Clip).where(Clip.project_id == p.id)).all() == []
    assert not (pdir / "scenes.json").exists()


def test_deleting_a_project_cancels_its_queued_work():
    with _signed_in(TestClient(app)) as c:
        p = _project(status="processing")
        a, b = _clip(p.id), _clip(p.id)
        other = _project()
        oc = _clip(other.id)
        queue.enqueue("analyze_project", {"project_id": p.id}, delay_seconds=60)
        queue.enqueue("render_clip", {"clip_id": a.id}, delay_seconds=60)
        queue.enqueue("render_clip", {"clip_id": b.id}, delay_seconds=60)
        queue.enqueue("render_clip", {"clip_id": oc.id}, delay_seconds=60)
        # jobs of a newer project and clip that already took over these ids (other creation time)
        queue.enqueue("analyze_project", {"project_id": p.id, "created": "newer"}, delay_seconds=60)
        queue.enqueue("render_clip", {"clip_id": a.id, "created": "newer"}, delay_seconds=60)
        queue.enqueue("render_clip", {"clip_id": b.id, "created": tasks.stamp(b.created_at)}, delay_seconds=60)
        assert c.delete(f"/api/projects/{p.id}").status_code == 200
    left = {(j.kind, tuple(sorted(j.payload.items()))): j.status for j in _jobs("render_clip") + _jobs("analyze_project")
            if j.payload.get("project_id") in (p.id,) or j.payload.get("clip_id") in (a.id, b.id, oc.id)}
    assert left[("analyze_project", (("project_id", p.id),))] == "cancelled"
    assert left[("render_clip", (("clip_id", a.id),))] == "cancelled"
    assert left[("render_clip", (("clip_id", b.id),))] == "cancelled"
    assert left[("render_clip", (("clip_id", oc.id),))] == "queued"
    assert left[("analyze_project", (("created", "newer"), ("project_id", p.id)))] == "queued"
    assert left[("render_clip", (("clip_id", a.id), ("created", "newer")))] == "queued"
    assert left[("render_clip", (("clip_id", b.id), ("created", tasks.stamp(b.created_at))))] == "cancelled"


def test_rerender_replaces_a_waiting_retry_and_stamps_the_job():
    with _signed_in(TestClient(app)) as c:
        p = _project(status="done")
        cl = _clip(p.id, status="failed")
        queue.enqueue("render_clip", {"clip_id": cl.id}, delay_seconds=30)  # automatic retry waiting
        assert c.post(f"/api/clips/{cl.id}/rerender").status_code == 200
    mine = [j for j in _jobs("render_clip") if j.payload.get("clip_id") == cl.id]
    assert sorted(j.status for j in mine) == ["cancelled", "queued"]
    fresh = next(j for j in mine if j.status == "queued")
    assert fresh.payload["created"] == tasks.stamp(cl.created_at)


def test_a_clip_never_renders_twice_at_once(monkeypatch):
    p = _project()
    cl = _clip(p.id)
    with tasks._inflight_lock:
        tasks._inflight[cl.id] = (p.id, 0.4)  # another worker is rendering it right now
    try:
        tasks.render_clip({"clip_id": cl.id})
    finally:
        with tasks._inflight_lock:
            tasks._inflight.pop(cl.id, None)
    with session_scope() as s:
        assert s.get(Clip, cl.id).status == "pending"  # untouched
    again = [j for j in _jobs("render_clip") if j.payload.get("clip_id") == cl.id and j.status == "queued"]
    assert len(again) == 1 and again[0].payload["created"] == tasks.stamp(cl.created_at)


@needs_ffmpeg
def test_render_dropped_when_its_clip_is_replaced_meanwhile(tmp_path, monkeypatch):
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=20:r=30",
                    "-f", "lavfi", "-i", "sine=f=220:d=20", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", str(src)], check=True)
    p = _project(source_path=str(src), width=640, height=360,
                 settings={"editing_style": "center_crop", "caption_style": "none"})
    cl = _clip(p.id, start=2.0, end=14.0)
    final = tasks.project_dir(p.id) / "clips" / str(cl.id)
    final.mkdir(parents=True)
    (final / "clip.mp4").write_bytes(b"the clip on screen")

    real_render = tasks.render.render

    def render_then_replace(spec, on_progress=None):
        out = real_render(spec, on_progress)
        with session_scope() as s:  # a re-style replaced the clip (same id) while ffmpeg ran
            s.delete(s.get(Clip, cl.id))
            s.commit()
            s.add(Clip(id=cl.id, project_id=p.id, start=3.0, end=9.0, status="pending"))
            s.commit()
        return out

    monkeypatch.setattr(tasks.render, "render", render_then_replace)
    tasks.render_clip({"clip_id": cl.id})
    with session_scope() as s:
        c = s.get(Clip, cl.id)
        assert (c.status, c.video_path, c.end) == ("pending", None, 9.0)
    assert (final / "clip.mp4").read_bytes() == b"the clip on screen"
    assert [d.name for d in final.parent.iterdir()] == [str(cl.id)]  # the half-built folder is gone


@needs_ffmpeg
def test_render_swaps_the_new_clip_into_place(tmp_path):
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=20:r=30",
                    "-c:v", "libx264", "-preset", "ultrafast", str(src)], check=True)
    p = _project(source_path=str(src), width=640, height=360,
                 settings={"editing_style": "center_crop", "caption_style": "none"})
    cl = _clip(p.id, start=1.0, end=11.0, status="failed", error="old")
    final = tasks.project_dir(p.id) / "clips" / str(cl.id)
    final.mkdir(parents=True)
    (final / "clip.mp4").write_bytes(b"old render")
    for name in (f"{cl.id}.part-dead0001", f"{cl.id}.old-dead0002", f"{cl.id + 1000}.part-busy0003"):
        (final.parent / name).mkdir()  # left by a crash or a redeploy (the last one is another clip's)
        (final.parent / name / "clip.mp4").write_bytes(b"x" * 1000)
    tasks.render_clip({"clip_id": cl.id, "created": tasks.stamp(cl.created_at)})
    with session_scope() as s:
        c = s.get(Clip, cl.id)
        assert (c.status, c.error, c.video_path) == ("ready", None, str(final / "clip.mp4"))
    assert media.probe(final / "clip.mp4").duration == pytest.approx(10.0, abs=0.2)
    assert (final / "thumb.jpg").exists()
    assert sorted(d.name for d in final.parent.iterdir()) == sorted([str(cl.id), f"{cl.id + 1000}.part-busy0003"])
    assert tasks._inflight.get(cl.id) is None


def test_failed_swap_puts_the_old_clip_back(tmp_path, monkeypatch):
    p = _project(source_path=str(tmp_path / "src.mp4"))
    cl = _clip(p.id, status="ready")
    final = tasks.project_dir(p.id) / "clips" / str(cl.id)
    final.mkdir(parents=True)
    (final / "clip.mp4").write_bytes(b"the clip on screen")

    def fake_render(spec, on_progress=None):
        spec.out_path.write_bytes(b"new")

    monkeypatch.setattr(tasks.render, "render", fake_render)
    monkeypatch.setattr(tasks.media, "make_thumbnail", lambda *a, **k: None)
    monkeypatch.setattr(tasks.media, "probe", lambda path: media.MediaInfo(
        duration=20.0, width=640, height=360, fps=30.0, has_audio=False))
    real_replace = tasks.os.replace

    def replace(a, b):
        if ".part-" in str(a):
            raise OSError("disk trouble")
        return real_replace(a, b)

    monkeypatch.setattr(tasks.os, "replace", replace)
    monkeypatch.setattr(tasks, "_face_track", lambda *a, **k: reframe.FaceTrack())
    with pytest.raises(Exception):
        tasks.render_clip({"clip_id": cl.id, "created": tasks.stamp(cl.created_at)})
    assert (final / "clip.mp4").read_bytes() == b"the clip on screen"
    assert sorted(d.name for d in final.parent.iterdir()) == [str(cl.id)]


def test_a_dropped_render_does_not_write_the_face_cache(tmp_path, monkeypatch):
    src = tmp_path / "s.mp4"
    src.write_bytes(b"x")
    track = reframe.FaceTrack(times=[0.0], faces=[[(0.5, 0.4, 0.2, 0.3)]])
    monkeypatch.setattr(reframe, "analyze_faces", lambda *a, **k: track)

    def replaced():
        raise tasks.ProjectGone(1)

    with pytest.raises(tasks.ProjectGone):
        tasks._face_track(tmp_path, src, 1.0, 5.0, replaced)
    assert not (tmp_path / "faces" / "1.000-5.000.json").exists()
    assert tasks._face_track(tmp_path, src, 1.0, 5.0).times == [0.0]
    assert (tmp_path / "faces" / "1.000-5.000.json").exists()


def test_old_empty_transcript_is_not_reused_once_speech_is_on(tmp_path, monkeypatch):
    src = tmp_path / "s.mp4"
    src.write_bytes(b"x")
    pdir = tmp_path / "p"
    pdir.mkdir()
    (pdir / "transcript.json").write_text('{"language": "", "words": [], "segments": []}')  # written by the old code
    np.save(pdir / "energy.npy", np.zeros(8, dtype=np.float32))
    later = time.time() + 5
    for f in pdir.iterdir():
        os.utime(f, (later, later))
    calls = []
    monkeypatch.setattr(media, "extract_audio", lambda *a, **k: (pdir / "audio16k.wav").write_bytes(b"RIFF"))
    monkeypatch.setattr(tasks.transcribe, "transcribe", lambda *a, **k: calls.append(1) or {"words": [{"word": "hi", "start": 1.0, "end": 1.2}]})
    monkeypatch.setattr(tasks, "_still_current", lambda *a: None)
    Info = namedtuple("Info", "duration")
    monkeypatch.setattr(get_settings(), "transcribe_backend", "local")
    energy, words = tasks._analyze_audio(1, "", lambda *a: None, pdir, src, Info(30.0), {})
    assert calls == [1] and words[0]["word"] == "hi"
    monkeypatch.setattr(get_settings(), "transcribe_backend", "none")
    (pdir / "transcript.json").write_text('{"language": "", "words": [], "segments": []}')
    os.utime(pdir / "transcript.json", (later, later))
    tasks._analyze_audio(1, "", lambda *a: None, pdir, src, Info(30.0), {})
    assert calls == [1]  # with speech off, the empty transcript is the right answer


def test_odd_source_sizes_fit_every_layout():
    tr = reframe.FaceTrack(times=[i * 0.25 for i in range(12)], faces=[[(0.2, 0.4, 0.1, 0.18), (0.8, 0.4, 0.1, 0.18)]] * 12)
    for layout in ("gameplay_facecam", "split_faces"):
        for w, h in ((853, 479), (479, 853), (1921, 1081)):
            f = reframe.build_layout(layout, src_w=w, src_h=h, out_w=1080, out_h=1920, track=tr, style={}).filter
            for part in f.split("crop=")[1:]:
                cw, ch, x, y = (int(v) for v in part.split(",")[0].split("[")[0].split(":")[:4])
                assert cw % 2 == 0 and ch % 2 == 0 and 0 <= x and x + cw <= w and 0 <= y and y + ch <= h, (layout, w, h, part)


# ------------------------------------------------------------------ uploads
def test_long_file_name_keeps_its_extension():
    long = "a" * 240 + ".mp4"
    assert uploads_api._clean_name(long).endswith(".mp4") and len(uploads_api._clean_name(long)) == 200
    assert uploads_api._clean_name("x" * 300) == "x" * 200


def test_refused_upload_does_not_evict_and_idle_empty_uploads_do_not_reserve(small_chunks, monkeypatch):
    Usage = namedtuple("Usage", "total used free")
    free = {"bytes": 10 * 1024**2}
    monkeypatch.setattr(uploads_api.shutil, "disk_usage", lambda p: Usage(0, 0, free["bytes"]))
    monkeypatch.setattr(get_settings(), "upload_min_free_mb", 0)
    monkeypatch.setattr(get_settings(), "max_active_uploads", 2)
    with _signed_in(TestClient(app), "space@example.com") as c:
        a = c.post("/api/uploads", json={"filename": "a.mp4", "size": CHUNK * 3}).json()["id"]
        assert _put(c, a, 0, b"a" * CHUNK).status_code == 200
        b = c.post("/api/uploads", json={"filename": "b.mp4", "size": CHUNK * 3}).json()["id"]
        assert _put(c, b, 0, b"b" * CHUNK).status_code == 200
        free["bytes"] = CHUNK  # the volume fills up from elsewhere
        r = c.post("/api/uploads", json={"filename": "c.mp4", "size": CHUNK * 50})
        assert r.status_code == 507
        assert {u["id"] for u in c.get("/api/uploads").json()} == {a, b}  # nothing was thrown away

        free["bytes"] = CHUNK * 60
        c.delete(f"/api/uploads/{a}")
        c.delete(f"/api/uploads/{b}")
        big = c.post("/api/uploads", json={"filename": "big.mp4", "size": CHUNK * 50}).json()["id"]  # never sent a byte
        assert c.post("/api/uploads", json={"filename": "d.mp4", "size": CHUNK * 20}).status_code == 507  # still fresh
        with session_scope() as s:  # ... but once it has sat idle, it stops blocking
            u = s.get(Upload, big)
            old = time.time() - 20 * 60
            os.utime(uploads_api._map(big), (old, old))
            os.utime(uploads_api._data(big), (old, old))
            u.updated_at = u.updated_at.replace(year=2001)
            s.add(u)
            s.commit()
        assert c.post("/api/uploads", json={"filename": "d.mp4", "size": CHUNK * 20}).status_code == 200


def test_chunk_for_an_upload_finished_elsewhere_gets_409(small_chunks):
    data = os.urandom(CHUNK * 2)
    with _signed_in(TestClient(app)) as c:
        uid = c.post("/api/uploads", json={"filename": "t.mp4", "size": len(data)}).json()["id"]
        assert _put(c, uid, 0, data[:CHUNK]).status_code == 200
        assert _put(c, uid, 1, data[CHUNK:]).status_code == 200
        real_open = uploads_api.os.open
        state = {"done": False}

        def open_after_finish(path, *a, **k):  # the other tab finishes between our checks and our write
            if str(path).endswith("data.part") and not state["done"]:
                state["done"] = True
                with session_scope() as s:  # what complete() leaves behind: row completed, folder moved away
                    u = s.get(Upload, uid)
                    u.status = "completed"
                    s.add(u)
                    s.commit()
                shutil.rmtree(uploads_api._dir(uid))
            return real_open(path, *a, **k)

        uploads_api.os.open = open_after_finish
        try:
            r = _put(c, uid, 0, data[:CHUNK])
        finally:
            uploads_api.os.open = real_open
        assert r.status_code == 409, r.text


def test_restart_after_the_move_finishes_the_upload(small_chunks):
    data = os.urandom(CHUNK * 2)
    with _signed_in(TestClient(app)) as c:
        uid = c.post("/api/uploads", json={"filename": "r.mp4", "size": len(data)}).json()["id"]
        _put(c, uid, 0, data[:CHUNK])
        _put(c, uid, 1, data[CHUNK:])
        # the server dies right after moving the file, before its bookkeeping
        with session_scope() as s:
            p = Project(name="r", source_type="upload", source="r.mp4")
            s.add(p)
            s.commit()
            s.refresh(p)
            u = s.get(Upload, uid)
            u.status, u.project_id = "completing", p.id
            s.add(u)
            s.commit()
            pid = p.id
        os.replace(uploads_api._data(uid), tasks.project_dir(pid) / "source.mp4")

        assert c.delete(f"/api/uploads/{uid}").status_code == 200  # a cancel meanwhile must not drop it
        uploads_api.recover_uploads()
        r = c.post(f"/api/uploads/{uid}/complete", json={"start": True})  # the browser asks again
        assert r.status_code == 200 and r.json()["id"] == pid and r.json()["status"] == "queued"
        with session_scope() as s:
            assert Path(s.get(Project, pid).source_path).read_bytes() == data


def test_restart_before_the_move_rolls_back(small_chunks):
    data = os.urandom(CHUNK * 2)
    with _signed_in(TestClient(app)) as c:
        uid = c.post("/api/uploads", json={"filename": "q.mp4", "size": len(data)}).json()["id"]
        _put(c, uid, 0, data[:CHUNK])
        _put(c, uid, 1, data[CHUNK:])
        with session_scope() as s:
            p = Project(name="q", source_type="upload", source="q.mp4")
            s.add(p)
            s.commit()
            s.refresh(p)
            u = s.get(Upload, uid)
            u.status, u.project_id = "completing", p.id
            s.add(u)
            s.commit()
            pid = p.id
        uploads_api.recover_uploads()
        with session_scope() as s:
            assert s.get(Project, pid) is None  # the empty project made for it is gone
            assert s.get(Upload, uid).status == "uploading"
        r = c.post(f"/api/uploads/{uid}/complete", json={"start": False})
        assert r.status_code == 200
        with session_scope() as s:
            assert Path(s.get(Project, r.json()["id"]).source_path).read_bytes() == data


def test_failed_completion_is_undone_and_can_be_retried(small_chunks, monkeypatch):
    data = os.urandom(CHUNK * 2)
    with _signed_in(TestClient(app, raise_server_exceptions=False)) as c:
        uid = c.post("/api/uploads", json={"filename": "f.mp4", "size": len(data)}).json()["id"]
        _put(c, uid, 0, data[:CHUNK])
        _put(c, uid, 1, data[CHUNK:])
        with session_scope() as s:
            before = len(s.exec(select(Project)).all())
        real = uploads_api.project_dir

        def broken(pid):  # fails after the project row was committed, before the move
            raise OSError("volume hiccup")

        monkeypatch.setattr(uploads_api, "project_dir", broken)
        assert c.post(f"/api/uploads/{uid}/complete", json={"start": False}).status_code == 500
        monkeypatch.setattr(uploads_api, "project_dir", real)
        with session_scope() as s:
            u = s.get(Upload, uid)
            assert (u.status, u.project_id) == ("uploading", None)
            assert len(s.exec(select(Project)).all()) == before  # the half-made project is gone
        r = c.post(f"/api/uploads/{uid}/complete", json={"start": False})
        assert r.status_code == 200
        with session_scope() as s:
            assert Path(s.get(Project, r.json()["id"]).source_path).read_bytes() == data


def test_interrupted_completion_is_repaired_without_a_restart(small_chunks):
    data = os.urandom(CHUNK * 2)
    with _signed_in(TestClient(app)) as c:
        uid = c.post("/api/uploads", json={"filename": "g.mp4", "size": len(data)}).json()["id"]
        _put(c, uid, 0, data[:CHUNK])
        _put(c, uid, 1, data[CHUNK:])
        with session_scope() as s:  # a complete() that died half way (no restart since)
            p = Project(name="g", source_type="upload", source="g.mp4")
            s.add(p)
            s.commit()
            s.refresh(p)
            u = s.get(Upload, uid)
            u.status, u.project_id = "completing", p.id
            s.add(u)
            s.commit()
            pid = p.id
        assert c.get(f"/api/uploads/{uid}").json()["status"] == "uploading"
        with session_scope() as s:
            assert s.get(Project, pid) is None
        assert c.post(f"/api/uploads/{uid}/complete", json={"start": False}).status_code == 200


def test_completion_in_progress_is_left_alone(small_chunks):
    with _signed_in(TestClient(app)) as c:
        uid = c.post("/api/uploads", json={"filename": "h.mp4", "size": CHUNK}).json()["id"]
        with session_scope() as s:
            u = s.get(Upload, uid)
            u.status = "completing"
            s.add(u)
            s.commit()
        assert uploads_api._claim(uid)  # complete() is working on it right now
        try:
            assert c.get(f"/api/uploads/{uid}").json()["status"] == "completing"
            assert c.delete(f"/api/uploads/{uid}").status_code == 200
            assert uploads_api.purge_stale_uploads() == 0
            with session_scope() as s:
                assert s.get(Upload, uid).status == "completing"
            assert c.post(f"/api/uploads/{uid}/complete", json={"start": False}).status_code == 409
        finally:
            uploads_api._release(uid)


def test_evicted_bytes_count_as_free_space(small_chunks, monkeypatch):
    Usage = namedtuple("Usage", "total used free")
    free = {"bytes": CHUNK * 100}
    monkeypatch.setattr(uploads_api.shutil, "disk_usage", lambda p: Usage(0, 0, free["bytes"]))
    monkeypatch.setattr(get_settings(), "upload_min_free_mb", 0)
    monkeypatch.setattr(get_settings(), "max_active_uploads", 1)
    monkeypatch.setattr(uploads_api, "_on_disk", lambda u: CHUNK * 3 if u.id == state["a"] else 0)
    state = {}
    with _signed_in(TestClient(app), "evict@example.com") as c:
        state["a"] = c.post("/api/uploads", json={"filename": "a.mp4", "size": CHUNK * 3}).json()["id"]
        for i in range(3):
            assert _put(c, state["a"], i, b"a" * CHUNK).status_code == 200
        free["bytes"] = CHUNK * 2
        # 2 chunks free on the volume + 3 that dropping the old upload gives back
        r = c.post("/api/uploads", json={"filename": "b.mp4", "size": CHUNK * 4})
        assert r.status_code == 200, r.text
        assert [u["id"] for u in c.get("/api/uploads").json()] == [r.json()["id"]]


def test_start_saves_status_and_job_together(monkeypatch):
    p = _project(status="draft", source_path="/nowhere/x.mp4")
    from app.api import projects as projects_api

    with session_scope() as s:
        row = s.get(Project, p.id)

        def fail_commit():
            raise RuntimeError("database locked")

        monkeypatch.setattr(s, "commit", fail_commit)
        with pytest.raises(RuntimeError):
            projects_api._start(s, row)
        s.rollback()
    with session_scope() as s:
        assert s.get(Project, p.id).status == "draft"  # neither the status ...
    assert not [j for j in _jobs("analyze_project") if j.payload.get("project_id") == p.id]  # ... nor the job
    with session_scope() as s:
        projects_api._start(s, s.get(Project, p.id))
    with session_scope() as s:
        assert s.get(Project, p.id).status == "queued"
    assert [j for j in _jobs("analyze_project") if j.payload.get("project_id") == p.id]


def test_a_queued_project_with_no_job_can_be_started_again():
    from app.api import projects as projects_api

    p = _project(status="queued", source_path="/nowhere/x.mp4")  # left so by a crash in an older version
    with session_scope() as s:
        assert projects_api.needs_start(s, s.get(Project, p.id))
    queue.enqueue("analyze_project", {"project_id": p.id}, delay_seconds=60)
    with session_scope() as s:
        assert not projects_api.needs_start(s, s.get(Project, p.id))
