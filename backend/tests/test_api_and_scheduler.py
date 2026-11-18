"""API + publishing scheduler tests (dry-run, no network)."""
from datetime import timedelta

from fastapi.testclient import TestClient

from app.db import init_db, session_scope
from app.main import app
from app.models import Clip, Project, PublishJob, SocialAccount, utcnow
from app.publishing import scheduler
from app.publishing.service import plan_schedule


def setup_module():
    init_db()


def test_presets_and_health():
    with TestClient(app) as c:
        assert c.get("/api/health").json()["ok"]
        p = c.get("/api/presets").json()
        assert p["clip_count"] == {"min": 10, "max": 50, "default": 20}


def test_clip_count_bounds_enforced():
    with TestClient(app) as c:
        r = c.post("/api/projects?start=false", json={"url": "https://example.com/v", "settings": {"clip_count": 60}})
        assert r.status_code == 422
        r = c.post("/api/projects?start=false", json={"url": "https://example.com/v", "settings": {"clip_count": 12}})
        assert r.status_code == 200 and r.json()["status"] == "draft"


def _seed(n_clips=3, n_accounts=2):
    with session_scope() as s:
        p = Project(name="x", source_type="url", source="u")
        s.add(p)
        s.commit()
        s.refresh(p)
        clips = [Clip(project_id=p.id, start=0, end=20, status="ready", title=f"c{i}", video_path="/nope.mp4") for i in range(n_clips)]
        accs = [SocialAccount(platform="tiktok", display_name=f"a{i}", external_id=f"e{i}", min_interval_minutes=60,
                              daily_limit=2, extra={"sandbox": True}) for i in range(n_accounts)]
        s.add_all(clips + accs)
        s.commit()
        return [c.id for c in clips], [a.id for a in accs]


def test_plan_schedule_staggers_and_caps_daily():
    clip_ids, acc_ids = _seed()
    with session_scope() as s:
        start = utcnow().replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=1)
        jobs = plan_schedule(s, clip_ids=clip_ids, account_ids=acc_ids, start_at=start, interval_minutes=30,
                             account_offset_minutes=10, jitter_minutes=0, privacy="public", publish_now=False)
        assert len(jobs) == 6
        for aid in acc_ids:
            times = sorted(j.scheduled_at for j in jobs if j.account_id == aid)
            assert times[1] - times[0] >= timedelta(minutes=60)  # account min interval beats requested 30
            assert times[2].date() > times[0].date()  # daily_limit=2 pushes the 3rd clip to the next day
        first = {aid: min(j.scheduled_at for j in jobs if j.account_id == aid) for aid in acc_ids}
        assert first[acc_ids[1]] - first[acc_ids[0]] == timedelta(minutes=10)


def test_scheduler_enforces_min_interval():
    clip_ids, acc_ids = _seed(2, 1)
    with session_scope() as s:
        now = utcnow()
        s.add(PublishJob(clip_id=clip_ids[0], account_id=acc_ids[0], status="published", published_at=now - timedelta(minutes=5)))
        due = PublishJob(clip_id=clip_ids[1], account_id=acc_ids[0], scheduled_at=now - timedelta(minutes=1))
        s.add(due)
        s.commit()
        due_id = due.id
    scheduler.tick()
    with session_scope() as s:
        j = s.get(PublishJob, due_id)
        assert j.status == "scheduled"
        assert j.scheduled_at >= utcnow() + timedelta(minutes=50)
