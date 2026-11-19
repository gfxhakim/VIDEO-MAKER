"""SQLite database (SQLModel). One file, zero setup, safe for a worker + API."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import event, text
from sqlmodel import Session, SQLModel, create_engine

from .config import get_settings

_settings = get_settings()
engine = create_engine(
    f"sqlite:///{_settings.db_path}",
    connect_args={"check_same_thread": False, "timeout": 30},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")  # API and worker can read/write concurrently
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


_MIGRATIONS: dict[str, list[tuple[str, str]]] = {
    "project": [
        ("user_id", "INTEGER"),
        ("source_start", "REAL"),
        ("source_end", "REAL"),
        ("source_deleted", "INTEGER NOT NULL DEFAULT 0"),
    ],
    "clip": [
        ("words_override", "JSON"),
        ("overrides", "JSON NOT NULL DEFAULT '{}'"),
    ],
    "musictrack": [
        ("user_id", "INTEGER"),
    ],
}


def _migrate_sqlite() -> None:
    """Safely add new columns to pre-existing SQLite databases on startup."""
    with engine.begin() as conn:
        for table, cols in _MIGRATIONS.items():
            existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})")).all()}
            if not existing:
                continue
            for name, ddl in cols:
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


def init_db() -> None:
    from . import models  # noqa: F401  (register tables)

    SQLModel.metadata.create_all(engine)
    _migrate_sqlite()


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    with Session(engine) as session:
        yield session


@contextmanager
def session_scope() -> Iterator[Session]:
    """For worker / pipeline code."""
    with Session(engine) as session:
        yield session
