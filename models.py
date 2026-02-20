"""
Data models and database access layer.

Uses SQLite stored on a Modal Volume for persistence across deployments.
Schema is designed to support the current job system and future
pipeline/batch/schedule features (Phase 2-3).
"""

import json
import sqlite3
import os
from datetime import datetime, timezone
from contextlib import contextmanager
from typing import Optional

import modal

# ---------------------------------------------------------------------------
# Modal Volume for persistent SQLite storage
# ---------------------------------------------------------------------------

db_volume = modal.Volume.from_name("agent-db", create_if_missing=True)
DB_DIR = "/data"
DB_PATH = os.path.join(DB_DIR, "agent.db")


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id         TEXT PRIMARY KEY,
    pipeline_id    TEXT,
    batch_id       TEXT,
    step_index     INTEGER,
    status         TEXT NOT NULL DEFAULT 'queued',
    repo_url       TEXT NOT NULL,
    task           TEXT NOT NULL,
    submitted_by   TEXT DEFAULT '',
    submitted_at   TEXT NOT NULL,
    started_at     TEXT,
    completed_at   TEXT,
    result_json    TEXT,
    error          TEXT,
    logs_json      TEXT DEFAULT '[]',
    attempt        INTEGER DEFAULT 1,
    max_attempts   INTEGER DEFAULT 3,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_submitted_at ON jobs(submitted_at);
CREATE INDEX IF NOT EXISTS idx_jobs_pipeline_id ON jobs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_jobs_batch_id ON jobs(batch_id);

-- Future Phase 2: Pipeline definitions
CREATE TABLE IF NOT EXISTS pipelines (
    pipeline_id    TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    repo_url       TEXT,
    steps_json     TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'draft',
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Future Phase 3: Scheduled tasks
CREATE TABLE IF NOT EXISTS schedules (
    schedule_id    TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    cron_expr      TEXT NOT NULL,
    pipeline_id    TEXT,
    repos_json     TEXT DEFAULT '[]',
    task           TEXT,
    enabled        INTEGER DEFAULT 1,
    last_run       TEXT,
    next_run       TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
"""


# ---------------------------------------------------------------------------
# Database connection management
# ---------------------------------------------------------------------------

def _init_db(conn: sqlite3.Connection) -> None:
    """Create tables and indexes if they don't exist."""
    conn.executescript(_SCHEMA)
    conn.commit()


@contextmanager
def get_db():
    """Yield a SQLite connection with WAL mode and auto-commit on success."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _init_db(conn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def now_iso() -> str:
    """ISO-8601 timestamp in UTC."""
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: sqlite3.Row) -> dict:
    """Convert a sqlite3.Row to a plain dict, deserialising JSON fields."""
    d = dict(row)
    if "result_json" in d:
        d["result"] = json.loads(d.pop("result_json")) if d["result_json"] else None
    if "logs_json" in d:
        d["logs"] = json.loads(d.pop("logs_json")) if d["logs_json"] else []
    if "steps_json" in d:
        d["steps"] = json.loads(d.pop("steps_json")) if d["steps_json"] else []
    if "repos_json" in d:
        d["repos"] = json.loads(d.pop("repos_json")) if d["repos_json"] else []
    return d


# ---------------------------------------------------------------------------
# Job CRUD
# ---------------------------------------------------------------------------

def create_job(
    job_id: str,
    repo_url: str,
    task: str,
    user_id: str = "",
    pipeline_id: Optional[str] = None,
    batch_id: Optional[str] = None,
    step_index: Optional[int] = None,
) -> dict:
    """Insert a new job record and return it as a dict."""
    ts = now_iso()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO jobs
               (job_id, repo_url, task, submitted_by, submitted_at,
                pipeline_id, batch_id, step_index, logs_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')""",
            (job_id, repo_url, task, user_id, ts,
             pipeline_id, batch_id, step_index),
        )
    return get_job(job_id)


def get_job(job_id: str) -> Optional[dict]:
    """Fetch a single job by ID."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def update_job(job_id: str, **fields) -> Optional[dict]:
    """Update specific fields on a job record."""
    # Serialise complex fields
    if "result" in fields:
        fields["result_json"] = json.dumps(fields.pop("result"))
    if "logs" in fields:
        fields["logs_json"] = json.dumps(fields.pop("logs"))

    fields["updated_at"] = now_iso()

    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [job_id]

    with get_db() as conn:
        conn.execute(
            f"UPDATE jobs SET {set_clause} WHERE job_id = ?",
            values,
        )
    return get_job(job_id)


def list_jobs(limit: int = 100, offset: int = 0) -> list[dict]:
    """Return jobs newest-first with pagination."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY submitted_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def cleanup_old_jobs(days: int = 30) -> int:
    """Delete completed/failed jobs older than `days`. Returns count deleted."""
    with get_db() as conn:
        cursor = conn.execute(
            """DELETE FROM jobs
               WHERE status IN ('completed', 'failed')
               AND completed_at < datetime('now', ?)""",
            (f"-{days} days",),
        )
    return cursor.rowcount
