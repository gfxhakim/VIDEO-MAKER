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
        assert r.status_code == 200
        assert c.get("/api/auth/me").json()["email"] == "me@example.com"
        # second sign-up is closed by default
        assert c.post("/api/auth/signup", json={"email": "x@y.co", "password": "supersecret"}).status_code == 403

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
