"""
Data models and database access layer.

Uses SQLite stored on a Modal Volume for persistence across deployments.
Supports jobs, pipelines, pipeline runs, and scheduled tasks.
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
    job_id           TEXT PRIMARY KEY,
    pipeline_id      TEXT,
    run_id           TEXT,
    batch_id         TEXT,
    step_name        TEXT,
    step_index       INTEGER,
    status           TEXT NOT NULL DEFAULT 'queued',
    repo_url         TEXT NOT NULL,
    task             TEXT NOT NULL,
    submitted_by     TEXT DEFAULT '',
    submitted_at     TEXT NOT NULL,
    started_at       TEXT,
    completed_at     TEXT,
    result_json      TEXT,
    step_output_json TEXT,
    error            TEXT,
    logs_json        TEXT DEFAULT '[]',
    attempt          INTEGER DEFAULT 1,
    max_attempts     INTEGER DEFAULT 3,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_submitted_at ON jobs(submitted_at);
CREATE INDEX IF NOT EXISTS idx_jobs_pipeline_id ON jobs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_jobs_batch_id ON jobs(batch_id);

-- Pipeline definitions (reusable templates)
CREATE TABLE IF NOT EXISTS pipelines (
    pipeline_id    TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    repo_url       TEXT,
    steps_json     TEXT NOT NULL DEFAULT '[]',
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Pipeline execution runs (one pipeline can be run many times)
CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id         TEXT PRIMARY KEY,
    pipeline_id    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    repo_url       TEXT,
    started_at     TEXT,
    completed_at   TEXT,
    error          TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

-- Scheduled tasks (Phase 3)
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
    for key in ("result_json", "logs_json", "steps_json", "repos_json", "step_output_json"):
        if key in d:
            clean_key = key.replace("_json", "") if key != "step_output_json" else "step_output"
            d[clean_key] = json.loads(d.pop(key)) if d[key] else ([] if "logs" in key or "steps" in key or "repos" in key else None)
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
    run_id: Optional[str] = None,
    batch_id: Optional[str] = None,
    step_name: Optional[str] = None,
    step_index: Optional[int] = None,
) -> dict:
    """Insert a new job record and return it as a dict."""
    ts = now_iso()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO jobs
               (job_id, repo_url, task, submitted_by, submitted_at,
                pipeline_id, run_id, batch_id, step_name, step_index, logs_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')""",
            (job_id, repo_url, task, user_id, ts,
             pipeline_id, run_id, batch_id, step_name, step_index),
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
    if "result" in fields:
        fields["result_json"] = json.dumps(fields.pop("result"))
    if "logs" in fields:
        fields["logs_json"] = json.dumps(fields.pop("logs"))
    if "step_output" in fields:
        fields["step_output_json"] = json.dumps(fields.pop("step_output"))

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


def get_jobs_for_run(run_id: str) -> list[dict]:
    """Return all jobs belonging to a pipeline run, ordered by step_index."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE run_id = ? ORDER BY step_index",
            (run_id,),
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


# ---------------------------------------------------------------------------
# Pipeline CRUD
# ---------------------------------------------------------------------------

def create_pipeline(pipeline_id: str, name: str, repo_url: str, steps: list) -> dict:
    """Create a new pipeline definition."""
    with get_db() as conn:
        conn.execute(
            """INSERT INTO pipelines (pipeline_id, name, repo_url, steps_json)
               VALUES (?, ?, ?, ?)""",
            (pipeline_id, name, repo_url, json.dumps(steps)),
        )
    return get_pipeline(pipeline_id)


def get_pipeline(pipeline_id: str) -> Optional[dict]:
    """Fetch a pipeline definition by ID."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM pipelines WHERE pipeline_id = ?", (pipeline_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_pipelines() -> list[dict]:
    """Return all pipeline definitions."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM pipelines ORDER BY created_at DESC"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_pipeline(pipeline_id: str) -> bool:
    """Delete a pipeline definition. Returns True if deleted."""
    with get_db() as conn:
        cursor = conn.execute(
            "DELETE FROM pipelines WHERE pipeline_id = ?", (pipeline_id,)
        )
    return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Pipeline Run CRUD
# ---------------------------------------------------------------------------

def create_pipeline_run(run_id: str, pipeline_id: str, repo_url: str) -> dict:
    """Create a new pipeline run record."""
    with get_db() as conn:
        conn.execute(
            """INSERT INTO pipeline_runs (run_id, pipeline_id, repo_url)
               VALUES (?, ?, ?)""",
            (run_id, pipeline_id, repo_url),
        )
    return get_pipeline_run(run_id)


def get_pipeline_run(run_id: str) -> Optional[dict]:
    """Fetch a pipeline run by ID."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM pipeline_runs WHERE run_id = ?", (run_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def update_pipeline_run(run_id: str, **fields) -> Optional[dict]:
    """Update a pipeline run record."""
    fields["updated_at"] = now_iso()
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [run_id]
    with get_db() as conn:
        conn.execute(
            f"UPDATE pipeline_runs SET {set_clause} WHERE run_id = ?",
            values,
        )
    return get_pipeline_run(run_id)


def list_pipeline_runs(pipeline_id: Optional[str] = None) -> list[dict]:
    """Return pipeline runs, optionally filtered by pipeline_id."""
    with get_db() as conn:
        if pipeline_id:
            rows = conn.execute(
                "SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY created_at DESC",
                (pipeline_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM pipeline_runs ORDER BY created_at DESC"
            ).fetchall()
    return [_row_to_dict(r) for r in rows]
