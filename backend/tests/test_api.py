"""API: first-run sign-up, auth protection, publish kit, posted tracking, ZIP export."""
import zipfile
from io import BytesIO

from fastapi.testclient import TestClient

from app.db import init_db, session_scope
from app.main import app
from app.models import Clip, Project
from app.pipeline.publish_kit import build_kit


def test_auth_flow_and_publish_kit(tmp_path):
    init_db()
    with TestClient(app) as c:
        assert c.get("/api/health").json()["ok"]
        assert c.get("/api/projects").status_code == 401  # locked before sign-in
        st = c.get("/api/auth/status").json()
        assert st["needs_setup"] and st["user"] is None

        r = c.post("/api/auth/signup", json={"email": "Me@Example.com", "password": "supersecret", "name": "Me"})
        assert r.status_code == 200 and r.json()["role"] == "admin"
        assert c.get("/api/auth/me").json()["email"] == "me@example.com"

        # second visitor sign-up succeeds by default as a regular user (and cannot touch /api/admin)
        r2 = c.post("/api/auth/signup", json={"email": "visitor@y.co", "password": "supersecret"})
        assert r2.status_code == 200 and r2.json()["role"] == "user"
        assert c.get("/api/admin/overview").status_code == 403

        # admin can pause & reopen visitor sign-up live
        assert c.post("/api/auth/signin", json={"email": "me@example.com", "password": "supersecret"}).status_code == 200
        assert c.put("/api/admin/settings", json={"allow_signup": False}).json()["allow_signup"] is False
        assert c.post("/api/auth/signup", json={"email": "x@y.co", "password": "supersecret"}).status_code == 403
        assert c.put("/api/admin/settings", json={"allow_signup": True}).json()["allow_signup"] is True

        c.post("/api/auth/signout")
        assert c.get("/api/presets").status_code == 401
        assert c.post("/api/auth/signin", json={"email": "me@example.com", "password": "wrongpass1"}).status_code == 401
        assert c.post("/api/auth/signin", json={"email": "me@example.com", "password": "supersecret"}).status_code == 200
        assert c.get("/api/presets").json()["clip_count"]["max"] == 50

        # clip count bounds
        assert c.post("/api/projects?start=false", json={"url": "https://e.com/v", "settings": {"clip_count": 60}}).status_code == 422

        video = tmp_path / "c.mp4"
        video.write_bytes(b"\x00" * 2048)
        with session_scope() as s:
            p = Project(name="Demo", source_type="url", source="u")
            s.add(p)
            s.commit()
            s.refresh(p)
            clip = Clip(project_id=p.id, rank=1, start=0, end=20, status="ready", title="Nobody tells you this",
                        description="desc", hashtags=["#money", "#truth"], video_path=str(video))
            s.add(clip)
            s.commit()
            pid, cid = p.id, clip.id

        kit = c.get(f"/api/clips/{cid}/kit").json()
        assert set(kit) == {"tiktok", "instagram", "youtube", "facebook"}
        assert "#shorts" in kit["youtube"]["title"]
        assert kit["tiktok"]["caption"].startswith("Nobody tells you this")

        assert c.get(f"/api/projects/{pid}/export.zip").status_code == 404  # nothing approved yet
        r = c.post(f"/api/clips/{cid}/posted", json={"platform": "tiktok"})
        assert "tiktok" in r.json()["posted"] and r.json()["review_status"] == "approved"
        z = c.get(f"/api/projects/{pid}/export.zip")
        assert z.status_code == 200
        names = zipfile.ZipFile(BytesIO(z.content)).namelist()
        assert any(n.endswith(".mp4") for n in names) and any(n.endswith(".txt") for n in names)


def test_kit_dedupes_and_limits_tags():
    kit = build_kit("Hi", "", ["#a", "#A", "b", "#c", "#d", "#e", "#f", "#g"])
    assert kit["tiktok"]["hashtags"] == ["#a", "#b", "#c", "#d", "#e"]
    assert kit["youtube"]["hashtags"][-1] != "#shorts" or len(kit["youtube"]["hashtags"]) <= 3


# ---------------------------------------------------------------- chunked, resumable uploads
import hashlib  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import time  # noqa: E402
from collections import namedtuple  # noqa: E402
from datetime import timedelta  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from sqlmodel import select  # noqa: E402

from app.api import uploads as uploads_api  # noqa: E402
from app.auth import hash_password  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.models import Upload, User  # noqa: E402

CHUNK = 1024  # tests use 1 KB chunks instead of 4 MB


def _signed_in(c: TestClient, email: str = "uploader@example.com") -> TestClient:
    """Works in any test order: make the account directly, then sign in over the API."""
    init_db()
    with session_scope() as s:
        if not s.exec(select(User).where(User.email == email)).first():
            s.add(User(email=email, name="U", password_hash=hash_password("supersecret")))
            s.commit()
    assert c.post("/api/auth/signin", json={"email": email, "password": "supersecret"}).status_code == 200
    return c


@pytest.fixture
def small_chunks(monkeypatch):
    monkeypatch.setattr(get_settings(), "upload_chunk_mb", 1)
    monkeypatch.setattr(uploads_api, "MB", CHUNK)  # so "1 MB" chunks are 1 KB
    yield
    with session_scope() as ses:  # leave nothing behind for the next test
        for u in ses.exec(select(Upload)).all():
            shutil.rmtree(uploads_api._dir(u.id), ignore_errors=True)
            ses.delete(u)
        ses.commit()


def _put(c: TestClient, uid: str, i: int, data: bytes):
    return c.put(f"/api/uploads/{uid}/chunks/{i}", content=data, headers={"content-type": "application/octet-stream"})


def test_chunked_upload_out_of_order_then_complete(small_chunks):
    data = os.urandom(CHUNK * 2 + 300)  # 3 chunks, the last one short
    with _signed_in(TestClient(app)) as c:
        up = c.post("/api/uploads", json={"filename": "My Stream.MP4", "size": len(data), "fingerprint": "fp-1"}).json()
        assert (up["chunk_size"], up["total_chunks"], up["received"], up["status"]) == (CHUNK, 3, [], "uploading")
        uid = up["id"]
        part = Path(get_settings().uploads_dir) / uid / "data.part"
        assert part.stat().st_size == len(data)  # written in place on the data volume, no temp copy

        for i in (2, 0):  # any order, like parallel requests
            assert _put(c, uid, i, data[i * CHUNK:(i + 1) * CHUNK]).status_code == 200
        st = c.get(f"/api/uploads/{uid}").json()
        assert st["received"] == [0, 2] and st["received_bytes"] == CHUNK + 300
        assert [u["id"] for u in c.get("/api/uploads").json()] == [uid]

        # cannot finish with a hole in the file
        r = c.post(f"/api/uploads/{uid}/complete", json={"start": False})
        assert r.status_code == 409 and "1 of 3" in r.json()["detail"]

        assert _put(c, uid, 1, data[CHUNK:2 * CHUNK]).status_code == 200
        assert _put(c, uid, 1, data[CHUNK:2 * CHUNK]).status_code == 200  # a retried chunk is harmless
        r = c.post(f"/api/uploads/{uid}/complete", json={"start": False, "settings": {"clip_count": 12}})
        assert r.status_code == 200, r.text
        p = r.json()
        assert (p["name"], p["source_type"], p["source"], p["status"]) == ("My Stream", "upload", "My Stream.MP4", "draft")
        assert p["settings"]["clip_count"] == 12
        with session_scope() as s:
            src = Path(s.get(Project, p["id"]).source_path)
        assert src.name == "source.mp4" and src.parent.name == str(p["id"])
        assert hashlib.sha256(src.read_bytes()).digest() == hashlib.sha256(data).digest()
        assert not part.parent.exists()  # moved, not copied

        # a retried "complete" (lost response) returns the same project, never a duplicate
        assert c.post(f"/api/uploads/{uid}/complete", json={"start": False}).json()["id"] == p["id"]
        assert c.get(f"/api/uploads/{uid}").json()["status"] == "completed"
        assert _put(c, uid, 0, data[:CHUNK]).status_code == 409
        assert c.get("/api/uploads").json() == []


def test_chunked_upload_resumes_by_fingerprint(small_chunks):
    data = os.urandom(CHUNK * 3)
    body = {"filename": "talk.mov", "size": len(data), "fingerprint": "talk.mov:3072:1700000000000:abc"}
    with _signed_in(TestClient(app)) as c:
        uid = c.post("/api/uploads", json=body).json()["id"]
        assert _put(c, uid, 0, data[:CHUNK]).status_code == 200
    with _signed_in(TestClient(app)) as c:  # "page refresh": new client, same account, same file
        again = c.post("/api/uploads", json=body).json()
        assert again["id"] == uid and again["received"] == [0]
        other = c.post("/api/uploads", json={**body, "fingerprint": "something-else"}).json()
        assert other["id"] != uid and other["received"] == []


def test_chunked_upload_validation(small_chunks, monkeypatch):
    with _signed_in(TestClient(app)) as c:
        assert c.post("/api/uploads", json={"filename": "virus.exe", "size": 10}).status_code == 400
        assert c.post("/api/uploads", json={"filename": "noext", "size": 10}).status_code == 400
        assert c.post("/api/uploads", json={"filename": "a.mp4", "size": 0}).status_code == 422
        monkeypatch.setattr(get_settings(), "max_upload_gb", 0.000001)  # ~1 KB
        assert c.post("/api/uploads", json={"filename": "a.mp4", "size": 5000}).status_code == 413
        monkeypatch.setattr(get_settings(), "max_upload_gb", 10)

        # volume almost full -> refused up front with a readable message, not at 95%
        Usage = namedtuple("Usage", "total used free")
        real_usage = shutil.disk_usage
        monkeypatch.setattr(uploads_api.shutil, "disk_usage", lambda _p: Usage(10**9, 10**9, 1000))
        r = c.post("/api/uploads", json={"filename": "a.mp4", "size": 5000})
        assert r.status_code == 507 and "Not enough storage" in r.json()["detail"]
        monkeypatch.setattr(uploads_api.shutil, "disk_usage", real_usage)

        # the client-supplied name never reaches the filesystem
        up = c.post("/api/uploads", json={"filename": "../../../etc/cron.d/evil.mp4", "size": CHUNK + 10}).json()
        assert up["filename"] == "evil.mp4"
        uid = up["id"]
        root = Path(get_settings().uploads_dir)
        assert sorted(p.name for p in (root / uid).iterdir()) == ["data.part", "received.map"]

        assert _put(c, uid, 0, b"x" * (CHUNK - 1)).status_code == 400  # short
        assert _put(c, uid, 0, b"x" * (CHUNK + 1)).status_code == 400  # long
        assert _put(c, uid, 1, b"x" * CHUNK).status_code == 400  # last chunk is 10 bytes
        assert _put(c, uid, 2, b"x").status_code == 404  # no such chunk
        assert _put(c, uid, -1, b"x").status_code in (404, 422)
        assert c.get(f"/api/uploads/{uid}").json()["received"] == []  # none of the bad chunks counted
        for bad in ("..%2F..%2Fx", "ZZZ", uid.upper(), uid + "0"):
            assert c.get(f"/api/uploads/{bad}").status_code in (404, 422)  # never reaches the filesystem
            assert c.put(f"/api/uploads/{bad}/chunks/0", content=b"x").status_code in (404, 405, 422)
        r = c.post(f"/api/uploads/{uid}/complete", json={"settings": {"editing_style": "nope"}})
        assert r.status_code == 400  # bad settings are reported before anything is finalised


def test_chunked_upload_needs_sign_in_and_is_per_user(small_chunks):
    with TestClient(app) as anon:
        assert anon.post("/api/uploads", json={"filename": "a.mp4", "size": 10}).status_code == 401
        assert anon.get("/api/uploads").status_code == 401
        assert anon.put("/api/uploads/" + "0" * 32 + "/chunks/0", content=b"x").status_code == 401
        assert anon.post("/api/projects/upload", files={"file": ("a.mp4", b"x")}).status_code == 401
    with _signed_in(TestClient(app), "alice@example.com") as alice, _signed_in(TestClient(app), "bob@example.com") as bob:
        uid = alice.post("/api/uploads", json={"filename": "a.mp4", "size": 10, "fingerprint": "same"}).json()["id"]
        assert bob.get(f"/api/uploads/{uid}").status_code == 404
        assert _put(bob, uid, 0, b"0123456789").status_code == 404
        assert bob.post(f"/api/uploads/{uid}/complete", json={}).status_code == 404
        assert bob.delete(f"/api/uploads/{uid}").json() == {"ok": True}  # no effect on alice's upload
        assert bob.get("/api/uploads").json() == []
        # bob picking a file with the same fingerprint gets his own upload, not alice's bytes
        assert bob.post("/api/uploads", json={"filename": "a.mp4", "size": 10, "fingerprint": "same"}).json()["id"] != uid
        assert alice.get(f"/api/uploads/{uid}").json()["received"] == []
        assert _put(alice, uid, 0, b"0123456789").status_code == 200


def test_chunked_upload_cancel_limit_and_stale_cleanup(small_chunks, monkeypatch):
    root = Path(get_settings().uploads_dir)
    with _signed_in(TestClient(app)) as c:
        uid = c.post("/api/uploads", json={"filename": "a.mp4", "size": 10}).json()["id"]
        assert (root / uid).is_dir()
        assert c.delete(f"/api/uploads/{uid}").json() == {"ok": True}
        assert not (root / uid).exists() and c.get(f"/api/uploads/{uid}").status_code == 404
        assert c.delete(f"/api/uploads/{uid}").json() == {"ok": True}  # cancelling twice is fine

        # only the newest MAX_ACTIVE_UPLOADS unfinished uploads are kept per user
        monkeypatch.setattr(get_settings(), "max_active_uploads", 2)
        ids = [c.post("/api/uploads", json={"filename": f"{i}.mp4", "size": 10, "fingerprint": f"f{i}"}).json()["id"] for i in range(3)]
        assert [u["id"] for u in c.get("/api/uploads").json()] == [ids[2], ids[1]]
        assert not (root / ids[0]).exists()

        # untouched for longer than UPLOAD_TTL_HOURS -> removed, with its bytes
        old = time.time() - (get_settings().upload_ttl_hours + 1) * 3600
        os.utime(root / ids[1] / "received.map", (old, old))
        os.utime(root / ids[1] / "data.part", (old, old))  # bytes arriving count as activity too
        with session_scope() as s:
            u = s.get(Upload, ids[1])
            u.updated_at = u.created_at = u.created_at - timedelta(days=3)
            s.add(u)
            s.commit()
        (root / ("f" * 32)).mkdir()  # a folder with no database row
        os.utime(root / ("f" * 32), (old, old))
        assert uploads_api.purge_stale_uploads() == 2
        assert [u["id"] for u in c.get("/api/uploads").json()] == [ids[2]]
        assert not (root / ids[1]).exists() and not (root / ("f" * 32)).exists()


def test_single_request_upload_still_works():
    """The original endpoint stays for scripts and old clients."""
    data = os.urandom(5000)
    with _signed_in(TestClient(app)) as c:
        r = c.post("/api/projects/upload", files={"file": ("Old Way.mp4", data, "video/mp4")},
                   data={"settings": '{"clip_count": 15}', "start": "false"})
        assert r.status_code == 200, r.text
        p = r.json()
        assert (p["name"], p["source_type"], p["settings"]["clip_count"]) == ("Old Way", "upload", 15)
        with session_scope() as s:
            assert Path(s.get(Project, p["id"]).source_path).read_bytes() == data
        before = len(c.get("/api/projects").json())
        assert c.post("/api/projects/upload", files={"file": ("setup.exe", b"MZ")}).status_code == 400
        assert c.post("/api/projects/upload", files={"file": ("a.b/c", b"x")}).status_code == 400
        assert len(c.get("/api/projects").json()) == before  # a refused upload leaves no empty project
