# Local Docker Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Modal cloud sandbox with a local Docker container so the agent runs locally while preserving all API endpoints, pipeline/workflow engine, dashboard, and agent engine.

**Architecture:** Single Docker container with Python 3.12 + Node.js 20 + git + gh. FastAPI (uvicorn) is the main process; agent jobs run as subprocesses via `npm run dev`. SQLite persists to `./data/`, workspaces to `./workspaces/`.

**Tech Stack:** FastAPI, uvicorn, Docker, Docker Compose, SQLite, Node.js 20, OpenCode SDK, Gemini API

**Design doc:** `docs/plans/2026-03-08-local-docker-migration-design.md`

---

### Task 1: Create environment and dependency files

**Files:**
- Create: `requirements.txt`
- Create: `.env.example`
- Create: `.dockerignore`

**Step 1: Create requirements.txt**

```
# requirements.txt
fastapi[standard]>=0.115.0
uvicorn[standard]>=0.30.0
```

**Step 2: Create .env.example**

```
# .env.example
GEMINI_API_KEY=your_gemini_api_key_here
GITHUB_TOKEN=your_github_personal_access_token_here
DATA_DIR=/data
WORKSPACES_DIR=/workspaces
PORT=8000
```

**Step 3: Create .dockerignore**

```
node_modules/
dashboard/node_modules/
.git/
data/
workspaces/
dummy-workspace/
__pycache__/
*.pyc
.env
.claude/
docs/
```

**Step 4: Commit**

```bash
git add requirements.txt .env.example .dockerignore
git commit -m "feat: add dependency and environment config files for local Docker setup"
```

---

### Task 2: Rewrite models.py — remove Modal dependency

**Files:**
- Modify: `models.py` (full file)

**Step 1: Rewrite models.py**

Remove `import modal` and `db_volume = modal.Volume.from_name(...)`. Replace with configurable paths via environment variables. Everything else stays the same — schema, CRUD functions, migrations are identical.

```python
"""
Data models and database access layer.

Uses SQLite for persistence. Supports jobs, pipelines, pipeline runs, and scheduled tasks.
"""

import json
import sqlite3
import os
from datetime import datetime, timezone
from contextlib import contextmanager
from typing import Optional

# ---------------------------------------------------------------------------
# Database configuration
# ---------------------------------------------------------------------------

DB_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DB_DIR, "agent.db")


# ---------------------------------------------------------------------------
# Schema (unchanged)
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
# Database connection management (unchanged except no Modal volume calls)
# ---------------------------------------------------------------------------

def _init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    _migrate(conn)
    conn.commit()


def _migrate(conn: sqlite3.Connection) -> None:
    _add_column(conn, "jobs", "iterations", "INTEGER DEFAULT 0")
    _add_column(conn, "jobs", "tests_passed", "INTEGER")
    _add_column(conn, "jobs", "subtasks_count", "INTEGER DEFAULT 1")
    _add_column(conn, "jobs", "total_cost", "REAL DEFAULT 0")
    _add_column(conn, "jobs", "total_tokens_in", "INTEGER DEFAULT 0")
    _add_column(conn, "jobs", "total_tokens_out", "INTEGER DEFAULT 0")


def _add_column(conn: sqlite3.Connection, table: str, column: str, typedef: str) -> None:
    cursor = conn.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cursor.fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {typedef}")


@contextmanager
def get_db():
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
# Utility (unchanged)
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    for key in ("result_json", "logs_json", "steps_json", "repos_json", "step_output_json"):
        if key in d:
            clean_key = key.replace("_json", "") if key != "step_output_json" else "step_output"
            d[clean_key] = json.loads(d.pop(key)) if d[key] else ([] if "logs" in key or "steps" in key or "repos" in key else None)
    return d


# ---------------------------------------------------------------------------
# Job CRUD (unchanged)
# ---------------------------------------------------------------------------

def create_job(
    job_id: str, repo_url: str, task: str, user_id: str = "",
    pipeline_id: Optional[str] = None, run_id: Optional[str] = None,
    batch_id: Optional[str] = None, step_name: Optional[str] = None,
    step_index: Optional[int] = None,
) -> dict:
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
    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    return _row_to_dict(row) if row else None


def update_job(job_id: str, **fields) -> Optional[dict]:
    if "result" in fields:
        fields["result_json"] = json.dumps(fields.pop("result"))
    if "logs" in fields:
        fields["logs_json"] = json.dumps(fields.pop("logs"))
    if "step_output" in fields:
        fields["step_output_json"] = json.dumps(fields.pop("step_output"))
    fields["updated_at"] = now_iso()
    if not fields:
        return get_job(job_id)
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [job_id]
    with get_db() as conn:
        conn.execute(f"UPDATE jobs SET {set_clause} WHERE job_id = ?", values)
    return get_job(job_id)


def list_jobs(limit: int = 100, offset: int = 0) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY submitted_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_jobs_for_run(run_id: str) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE run_id = ? ORDER BY step_index",
            (run_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def cleanup_old_jobs(days: int = 30) -> int:
    with get_db() as conn:
        cursor = conn.execute(
            """DELETE FROM jobs
               WHERE status IN ('completed', 'failed')
               AND completed_at < datetime('now', ?)""",
            (f"-{days} days",),
        )
    return cursor.rowcount


# ---------------------------------------------------------------------------
# Pipeline CRUD (unchanged)
# ---------------------------------------------------------------------------

def create_pipeline(pipeline_id: str, name: str, repo_url: str, steps: list) -> dict:
    with get_db() as conn:
        conn.execute(
            """INSERT INTO pipelines (pipeline_id, name, repo_url, steps_json)
               VALUES (?, ?, ?, ?)""",
            (pipeline_id, name, repo_url, json.dumps(steps)),
        )
    return get_pipeline(pipeline_id)


def get_pipeline(pipeline_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM pipelines WHERE pipeline_id = ?", (pipeline_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_pipelines() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM pipelines ORDER BY created_at DESC").fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_pipeline(pipeline_id: str) -> bool:
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM pipelines WHERE pipeline_id = ?", (pipeline_id,))
    return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Pipeline Run CRUD (unchanged)
# ---------------------------------------------------------------------------

def create_pipeline_run(run_id: str, pipeline_id: str, repo_url: str) -> dict:
    with get_db() as conn:
        conn.execute(
            """INSERT INTO pipeline_runs (run_id, pipeline_id, repo_url)
               VALUES (?, ?, ?)""",
            (run_id, pipeline_id, repo_url),
        )
    return get_pipeline_run(run_id)


def get_pipeline_run(run_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM pipeline_runs WHERE run_id = ?", (run_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def update_pipeline_run(run_id: str, **fields) -> Optional[dict]:
    fields["updated_at"] = now_iso()
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [run_id]
    with get_db() as conn:
        conn.execute(
            f"UPDATE pipeline_runs SET {set_clause} WHERE run_id = ?", values,
        )
    return get_pipeline_run(run_id)


def list_pipeline_runs(pipeline_id: Optional[str] = None) -> list[dict]:
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
```

**Step 2: Verify models.py has no Modal references**

Run: `grep -n "modal" models.py`
Expected: No matches

**Step 3: Commit**

```bash
git add models.py
git commit -m "refactor: remove Modal dependency from models.py, use local SQLite"
```

---

### Task 3: Rewrite shared.py — remove Modal dependency

**Files:**
- Modify: `shared.py` (full file)

**Step 1: Rewrite shared.py**

Remove `import modal`, `sandbox_image`, `workspace_volume`, and all Modal-specific code. Keep `setup_github_auth()`, `clone_and_install()`, `run_agent()` with the same logic. Add configurable paths via environment variables. Keep the system prompts.

```python
"""
Shared infrastructure for the Background Coding Agent.

Centralises GitHub/Git authentication, dependency installation, and agent
execution logic so that the API and any CLI entry points stay thin wrappers.
"""

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

APP_DIR = os.environ.get("APP_DIR", str(Path(__file__).parent.resolve()))
STEP_RESULT_PATH = os.path.join(APP_DIR, "step_result.json")
WORKSPACES_DIR = os.environ.get("WORKSPACES_DIR", "/workspaces")
DEFAULT_WORKSPACE = os.path.join(APP_DIR, "workspace")


# ---------------------------------------------------------------------------
# System Prompts for Specialized Agent Modes (Phase 5)
# ---------------------------------------------------------------------------

DEBUG_SYSTEM_PROMPT = """You are a debugging specialist. The previous attempts have not resolved the issue.

Your goal: Deeply analyze the error and identify the ROOT CAUSE.

Follow this debugging methodology:
1. **Reproduce** - Understand exactly how the error occurs
2. **Isolate** - Narrow down where the problem is
3. **Hypothesize** - Form a theory about the root cause
4. **Verify** - Check your hypothesis before making changes

When you find the root cause:
- Explain WHY previous fixes didn't work
- Describe the correct fix in detail
- Implement the fix carefully
- Add tests or assertions to prevent regression

Do NOT make superficial changes. Find and fix the actual problem."""

EXPLORE_SYSTEM_PROMPT = """You are a code exploration agent. Your job is to thoroughly understand a codebase.

Your exploration should cover:
1. **Architecture** - What are the main components and how do they interact?
2. **Entry Points** - Where does execution start? What are the public APIs?
3. **Key Abstractions** - What are the core types/classes/modules?
4. **Dependencies** - What external libraries are used? How?
5. **Patterns** - What coding patterns/conventions are used?

Output a structured exploration report with:
- Component diagram (text-based)
- Key files and their purposes
- Data flow description
- Any areas of concern or complexity

Be thorough but focused on information relevant to the task."""


# ---------------------------------------------------------------------------
# GitHub + Git Authentication (unchanged logic)
# ---------------------------------------------------------------------------

def setup_github_auth(token: str) -> None:
    """Authenticate the GitHub CLI and configure Git credentials."""
    if not token:
        print("[Agent] WARNING: GITHUB_TOKEN is empty — PR creation will fail.")

    proc = subprocess.run(
        ["gh", "auth", "login", "--with-token"],
        input=token, text=True, capture_output=True,
    )
    if proc.returncode != 0:
        print(f"[Agent] gh auth warning: {proc.stderr.strip()}")
    else:
        print("[Agent] gh auth OK")

    subprocess.run(["gh", "auth", "status"], check=False)

    subprocess.run(
        ["git", "config", "--global", "user.name", "Cloud Agent"], check=True
    )
    subprocess.run(
        ["git", "config", "--global", "user.email", "agent@cloud.bot"], check=True
    )

    subprocess.run(
        ["git", "config", "--global", "credential.helper", "store"], check=True
    )
    with open(os.path.expanduser("~/.git-credentials"), "w") as f:
        f.write(f"https://x-access-token:{token}@github.com\n")


# ---------------------------------------------------------------------------
# Clone + Install Dependencies (adapted for local paths)
# ---------------------------------------------------------------------------

def clone_and_install(
    repo_url: str,
    workspace: str = "",
    skip_clone: bool = False,
) -> None:
    """Clone the target repository and install agent engine dependencies.

    When skip_clone=True (pipeline workspace persistence), the workspace
    already exists from a previous step — skip cloning and reuse it.
    """
    workspace = workspace or DEFAULT_WORKSPACE

    if skip_clone and os.path.isdir(workspace):
        print(f"[Agent] Reusing existing workspace at {workspace} (skip_clone=True)")
        subprocess.run(
            ["git", "fetch", "--all"],
            cwd=workspace,
            check=False,
            capture_output=True,
        )
    else:
        print(f"[Agent] Cloning {repo_url} ...")
        os.makedirs(os.path.dirname(workspace), exist_ok=True)
        subprocess.run(["git", "clone", repo_url, workspace], check=True)

    os.chdir(APP_DIR)
    print("[Agent] Installing Agent dependencies...")
    subprocess.run(["npm", "install"], check=True, cwd=APP_DIR)
    subprocess.run(["npm", "install", "-g", "opencode-ai"], check=True)

    sdk_dist = os.path.join(APP_DIR, "node_modules/@opencode-ai/sdk/dist")
    os.makedirs(sdk_dist, exist_ok=True)
    try:
        os.symlink("src/index.js", os.path.join(sdk_dist, "index.js"))
        print("[Agent] SDK symlink fix applied.")
    except FileExistsError:
        pass


# ---------------------------------------------------------------------------
# Run Agent Engine (unchanged logic, adapted for local paths)
# ---------------------------------------------------------------------------

def run_agent(
    task: str,
    step_context: Optional[dict] = None,
    timeout: int = 3000,
    workspace: str = "",
) -> dict:
    """
    Execute the Node.js agent engine and return structured results.

    Returns a dict with keys:
        stdout, stderr, exit_code, pr_url, log_lines, step_output.
    """
    workspace = workspace or DEFAULT_WORKSPACE

    env = os.environ.copy()
    env["TASK_DESCRIPTION"] = task
    env["WORKSPACE"] = workspace

    if step_context:
        env["STEP_CONTEXT"] = json.dumps(step_context)

    if os.path.exists(STEP_RESULT_PATH):
        os.remove(STEP_RESULT_PATH)

    print("[Agent] Starting the Agent Engine...")
    result = subprocess.run(
        ["npm", "run", "dev"],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=APP_DIR,
    )

    stdout = result.stdout or ""
    stderr = result.stderr or ""
    combined = stdout + "\n" + stderr

    pr_url = None
    for line in combined.splitlines():
        if "github.com" in line and "/pull/" in line:
            match = re.search(r"https://github\.com/[^\s\"']+/pull/\d+", line)
            if match:
                pr_url = match.group(0)
                break

    log_lines = [
        l for l in combined.splitlines()
        if l.strip() and not l.startswith(">")
    ][-150:]

    step_output = None
    if os.path.exists(STEP_RESULT_PATH):
        try:
            with open(STEP_RESULT_PATH) as f:
                step_output = json.load(f)
            print(f"[Agent] Step result read from {STEP_RESULT_PATH}")
        except (json.JSONDecodeError, OSError) as e:
            print(f"[Agent] Warning: could not read step result: {e}")

    if step_output is None:
        step_output = {
            "pr_url": pr_url,
            "exit_code": result.returncode,
        }

    return {
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": result.returncode,
        "pr_url": pr_url,
        "log_lines": log_lines,
        "step_output": step_output,
    }
```

**Step 2: Verify shared.py has no Modal references**

Run: `grep -n "modal" shared.py`
Expected: No matches

**Step 3: Commit**

```bash
git add shared.py
git commit -m "refactor: remove Modal dependency from shared.py, use local subprocess"
```

---

### Task 4: Rewrite api.py — remove Modal, pure FastAPI

**Files:**
- Modify: `api.py` (full file)
- Preserve: `api.py` → `api.py.modal.bak` (backup)

**Step 1: Backup the original api.py**

```bash
cp api.py api.py.modal.bak
```

**Step 2: Rewrite api.py**

Remove all Modal imports, decorators, volume operations, and image definitions. Replace `Modal.spawn()` with `asyncio.create_task()` + `asyncio.to_thread()`. Keep all HTTP endpoints, WebSocket, pipeline orchestration, and retry logic intact.

```python
"""
HTTP API for the Background Coding Agent.

Provides endpoints so anyone (Slack bot, web UI, curl) can trigger
an agent task and poll for results, without needing a local terminal.

Features:
    - WebSocket real-time updates (/ws/{job_id})
    - SQLite-backed persistent job storage
    - Automatic retry with exponential backoff

Usage:
    # Set environment variables
    export GEMINI_API_KEY=AIza...
    export GITHUB_TOKEN=ghp_...

    # Run the API server
    uvicorn api:app --host 0.0.0.0 --port 8000
"""

import asyncio
import os
import shutil
import time
import uuid

from shared import (
    setup_github_auth, clone_and_install, run_agent,
    DEFAULT_WORKSPACE, WORKSPACES_DIR,
)
from models import (
    create_job, get_job, update_job, list_jobs, now_iso,
    create_pipeline, get_pipeline, list_pipelines, delete_pipeline,
    create_pipeline_run, get_pipeline_run, update_pipeline_run,
    list_pipeline_runs, get_jobs_for_run,
)
from scheduler import topological_sort, resolve_templates

MAX_ATTEMPTS = 3
RETRY_BASE_DELAY = 10  # seconds, exponential: 10, 20, 40

# ---------------------------------------------------------------------------
# 1. FastAPI App with CORS and WebSocket
# ---------------------------------------------------------------------------

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketState

app = FastAPI(title="Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# 2. Synchronous agent execution (runs in thread via asyncio.to_thread)
# ---------------------------------------------------------------------------

def _run_agent_task_sync(
    job_id: str, repo_url: str, task: str, github_token: str = "",
):
    """
    The heavy lifter — runs the agent as a subprocess.
    Supports automatic retry with exponential backoff (up to MAX_ATTEMPTS).
    """
    token = github_token or os.environ.get("GITHUB_TOKEN", "")

    job = get_job(job_id)
    if not job:
        raise RuntimeError(f"Job {job_id} not found in database")

    all_logs = job.get("logs") or []

    update_job(job_id, status="running", started_at=now_iso())

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            if os.path.exists(DEFAULT_WORKSPACE):
                shutil.rmtree(DEFAULT_WORKSPACE)

            msg = f"[Attempt {attempt}/{MAX_ATTEMPTS}] Authenticating with GitHub..."
            all_logs.append(msg)
            update_job(job_id, attempt=attempt, logs=all_logs)
            setup_github_auth(token)

            msg = f"[Attempt {attempt}/{MAX_ATTEMPTS}] Cloning repository..."
            all_logs.append(msg)
            update_job(job_id, logs=all_logs)
            clone_and_install(repo_url)

            msg = f"[Attempt {attempt}/{MAX_ATTEMPTS}] Agent engine starting..."
            all_logs.append(msg)
            update_job(job_id, logs=all_logs)
            result = run_agent(task)

            all_logs.extend(result["log_lines"])

            step_out = result.get("step_output") or {}
            iterations = step_out.get("iterations", 0)
            verification_passed = step_out.get("verification_passed")
            tests_passed = 1 if verification_passed else (0 if verification_passed is False else None)
            subtasks_count = step_out.get("subtasks_count", 1)
            agent_total_cost = step_out.get("total_cost", 0)
            agent_tokens_in = step_out.get("total_tokens_in", 0)
            agent_tokens_out = step_out.get("total_tokens_out", 0)

            update_job(
                job_id,
                status="completed",
                completed_at=now_iso(),
                attempt=attempt,
                iterations=iterations,
                tests_passed=tests_passed,
                subtasks_count=subtasks_count,
                total_cost=agent_total_cost,
                total_tokens_in=agent_tokens_in,
                total_tokens_out=agent_tokens_out,
                result={
                    "pr_url": result["pr_url"],
                    "summary": (
                        f"Agent finished. PR: {result['pr_url']}"
                        if result["pr_url"]
                        else "Agent finished (no PR URL detected)."
                    ),
                    "exit_code": result["exit_code"],
                    "iterations": iterations,
                    "verification_passed": verification_passed,
                    "subtasks_count": subtasks_count,
                    "total_cost": agent_total_cost,
                },
                logs=all_logs,
            )

            return {"status": "completed", "pr_url": result["pr_url"]}

        except Exception as exc:
            last_error = exc
            error_msg = str(exc)[:500]

            if attempt < MAX_ATTEMPTS:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                msg = f"[Attempt {attempt}/{MAX_ATTEMPTS}] Failed: {error_msg}. Retrying in {delay}s..."
                all_logs.append(msg)
                update_job(
                    job_id, status="retrying", attempt=attempt,
                    error=error_msg, logs=all_logs,
                )
                time.sleep(delay)
            else:
                msg = f"[Attempt {attempt}/{MAX_ATTEMPTS}] Failed: {error_msg}"
                all_logs.append(msg)
                update_job(
                    job_id,
                    status="failed",
                    completed_at=now_iso(),
                    attempt=attempt,
                    error=f"All {MAX_ATTEMPTS} attempts failed. Last error: {error_msg}",
                    logs=all_logs,
                )
                raise last_error


# ---------------------------------------------------------------------------
# 2b. Pipeline step executor — runs a single step with context
# ---------------------------------------------------------------------------

def _run_pipeline_step_sync(
    job_id: str,
    repo_url: str,
    task: str,
    step_context: dict,
    github_token: str = "",
    workspace_path: str = "",
    skip_clone: bool = False,
):
    """
    Execute a single pipeline step. Similar to _run_agent_task_sync but passes
    step_context to the agent for upstream output awareness.
    """
    token = github_token or os.environ.get("GITHUB_TOKEN", "")
    workspace = workspace_path or DEFAULT_WORKSPACE

    job = get_job(job_id)
    if not job:
        raise RuntimeError(f"Pipeline step job {job_id} not found")

    all_logs = job.get("logs") or []

    update_job(job_id, status="running", started_at=now_iso())

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            if not skip_clone and os.path.exists(workspace):
                shutil.rmtree(workspace)

            if skip_clone and workspace_path:
                if not os.path.exists(workspace):
                    raise RuntimeError(
                        f"Workspace '{workspace}' does not exist but skip_clone=True. "
                        "This likely means a previous pipeline step failed."
                    )

            msg = f"[Step:{step_context.get('step_name', '?')}][Attempt {attempt}/{MAX_ATTEMPTS}] Authenticating..."
            all_logs.append(msg)
            update_job(job_id, attempt=attempt, logs=all_logs)
            setup_github_auth(token)

            msg = f"[Step:{step_context.get('step_name', '?')}][Attempt {attempt}/{MAX_ATTEMPTS}] {'Reusing workspace...' if skip_clone else 'Cloning...'}"
            all_logs.append(msg)
            update_job(job_id, logs=all_logs)
            clone_and_install(repo_url, workspace=workspace, skip_clone=skip_clone)

            msg = f"[Step:{step_context.get('step_name', '?')}][Attempt {attempt}/{MAX_ATTEMPTS}] Agent starting..."
            all_logs.append(msg)
            update_job(job_id, logs=all_logs)
            result = run_agent(task, step_context=step_context, workspace=workspace)

            all_logs.extend(result["log_lines"])

            step_out = result.get("step_output") or {}
            iterations = step_out.get("iterations", 0)
            verification_passed = step_out.get("verification_passed")
            tests_passed = 1 if verification_passed else (0 if verification_passed is False else None)
            subtasks_count = step_out.get("subtasks_count", 1)
            agent_total_cost = step_out.get("total_cost", 0)
            agent_tokens_in = step_out.get("total_tokens_in", 0)
            agent_tokens_out = step_out.get("total_tokens_out", 0)

            update_job(
                job_id,
                status="completed",
                completed_at=now_iso(),
                attempt=attempt,
                iterations=iterations,
                tests_passed=tests_passed,
                subtasks_count=subtasks_count,
                total_cost=agent_total_cost,
                total_tokens_in=agent_tokens_in,
                total_tokens_out=agent_tokens_out,
                result={
                    "pr_url": result["pr_url"],
                    "summary": (
                        f"Step completed. PR: {result['pr_url']}"
                        if result["pr_url"]
                        else "Step completed (no PR)."
                    ),
                    "exit_code": result["exit_code"],
                    "iterations": iterations,
                    "verification_passed": verification_passed,
                    "subtasks_count": subtasks_count,
                    "total_cost": agent_total_cost,
                },
                step_output=result["step_output"],
                logs=all_logs,
            )

            return result["step_output"]

        except Exception as exc:
            last_error = exc
            error_msg = str(exc)[:500]

            if attempt < MAX_ATTEMPTS:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                msg = f"[Step:{step_context.get('step_name', '?')}][Attempt {attempt}] Failed: {error_msg}. Retrying in {delay}s..."
                all_logs.append(msg)
                update_job(
                    job_id, status="retrying", attempt=attempt,
                    error=error_msg, logs=all_logs,
                )
                time.sleep(delay)
            else:
                msg = f"[Step:{step_context.get('step_name', '?')}][Attempt {attempt}] Failed: {error_msg}"
                all_logs.append(msg)
                update_job(
                    job_id, status="failed", completed_at=now_iso(),
                    attempt=attempt,
                    error=f"All {MAX_ATTEMPTS} attempts failed. Last: {error_msg}",
                    logs=all_logs,
                )
                raise last_error


# ---------------------------------------------------------------------------
# 2c. Pipeline orchestrator — executes all steps according to DAG order
# ---------------------------------------------------------------------------

def _run_pipeline_task_sync(
    run_id: str,
    pipeline_id: str,
    repo_url: str,
    steps: list,
    github_token: str = "",
):
    """Orchestrate a full pipeline run: execute steps in DAG order."""
    try:
        _execute_pipeline_steps(run_id, pipeline_id, repo_url, steps, github_token)
    except Exception as exc:
        update_pipeline_run(
            run_id,
            status="failed",
            completed_at=now_iso(),
            error=f"Pipeline crashed: {str(exc)[:500]}",
        )
        raise


def _execute_pipeline_steps(
    run_id: str,
    pipeline_id: str,
    repo_url: str,
    steps: list,
    github_token: str,
):
    """Inner pipeline execution logic.

    Uses a shared workspace directory so pipeline steps can build
    on each other's changes without re-cloning the repository.
    """
    update_pipeline_run(run_id, status="running", started_at=now_iso())

    step_map = {s["name"]: s for s in steps}
    layers = topological_sort(steps)

    run_workspace = os.path.join(WORKSPACES_DIR, run_id)

    job_ids: dict[str, str] = {}
    for idx, step in enumerate(steps):
        job_id = str(uuid.uuid4())
        create_job(
            job_id=job_id,
            repo_url=repo_url,
            task=step["task"],
            pipeline_id=pipeline_id,
            run_id=run_id,
            step_name=step["name"],
            step_index=idx,
        )
        job_ids[step["name"]] = job_id

    step_outputs: dict[str, dict] = {}
    failed = False
    is_first_step = True

    for layer in layers:
        if failed:
            for step_name in layer:
                jid = job_ids.get(step_name)
                if jid:
                    update_job(
                        jid, status="failed",
                        error="Skipped: upstream step failed",
                        completed_at=now_iso(),
                    )
            continue

        for step_name in layer:
            step_def = step_map[step_name]
            jid = job_ids[step_name]

            resolved_task = resolve_templates(step_def["task"], step_outputs)

            step_context = {
                "pipeline_id": pipeline_id,
                "run_id": run_id,
                "step_name": step_name,
                "upstream_outputs": step_outputs,
            }

            on_failure = step_def.get("on_failure", "stop")

            try:
                step_result = _run_pipeline_step_sync(
                    jid, repo_url, resolved_task, step_context, github_token,
                    workspace_path=run_workspace,
                    skip_clone=not is_first_step,
                )
                is_first_step = False

                if step_result:
                    step_outputs[step_name] = step_result
                else:
                    step_outputs[step_name] = {"exit_code": 0}

                updated_job = get_job(jid)
                if updated_job and updated_job.get("status") == "failed":
                    raise RuntimeError(updated_job.get("error", "Step failed"))

            except Exception as exc:
                step_outputs[step_name] = {"error": str(exc)[:500]}

                if on_failure == "stop":
                    failed = True
                    update_pipeline_run(
                        run_id,
                        error=f"Step '{step_name}' failed: {str(exc)[:500]}",
                    )
                    break

    final_status = "failed" if failed else "completed"
    update_pipeline_run(run_id, status=final_status, completed_at=now_iso())


# ---------------------------------------------------------------------------
# 3. Async wrappers — fire-and-forget via asyncio.create_task
# ---------------------------------------------------------------------------

async def _run_agent_task_async(job_id, repo_url, task, github_token):
    """Wrap sync agent execution in a thread so it doesn't block the event loop."""
    try:
        await asyncio.to_thread(
            _run_agent_task_sync, job_id, repo_url, task, github_token,
        )
    except Exception as exc:
        print(f"[API] Agent task {job_id} failed: {exc}")


async def _run_pipeline_task_async(run_id, pipeline_id, repo_url, steps, github_token):
    """Wrap sync pipeline execution in a thread."""
    try:
        await asyncio.to_thread(
            _run_pipeline_task_sync, run_id, pipeline_id, repo_url, steps, github_token,
        )
    except Exception as exc:
        print(f"[API] Pipeline run {run_id} failed: {exc}")


# ---------------------------------------------------------------------------
# 4. Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def ep_health():
    return {"status": "ok", "timestamp": now_iso()}


@app.post("/submit")
async def ep_submit(request: Request):
    body = await request.json()

    repo_url = body.get("repo_url")
    task = body.get("task")
    if not repo_url or not task:
        return JSONResponse(
            {"error": "Both 'repo_url' and 'task' are required."},
            status_code=400,
        )

    github_token = body.get("github_token", "")
    user_id = body.get("user_id", "anonymous")

    job_id = str(uuid.uuid4())
    record = create_job(job_id, repo_url, task, user_id)

    # Fire and forget — the task runs in the background
    asyncio.create_task(
        _run_agent_task_async(job_id, repo_url, task, github_token)
    )

    return {
        "job_id": job_id,
        "status": "queued",
        "submitted_at": record["submitted_at"],
    }


@app.get("/status/{job_id}")
def ep_status(job_id: str):
    record = get_job(job_id)
    if not record:
        return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)

    return {
        "job_id": record["job_id"],
        "status": record["status"],
        "submitted_at": record["submitted_at"],
        "started_at": record.get("started_at"),
        "completed_at": record.get("completed_at"),
    }


@app.get("/result/{job_id}")
def ep_result(job_id: str):
    record = get_job(job_id)
    if not record:
        return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)

    return {
        "job_id": record["job_id"],
        "status": record["status"],
        "repo_url": record["repo_url"],
        "task": record["task"],
        "submitted_by": record.get("submitted_by", ""),
        "submitted_at": record["submitted_at"],
        "started_at": record.get("started_at"),
        "completed_at": record.get("completed_at"),
        "result": record.get("result"),
        "error": record.get("error"),
        "logs": record.get("logs", []),
    }


@app.get("/jobs")
def ep_jobs():
    """List all jobs, newest first. Returns summary (no logs)."""
    jobs = list_jobs()
    return [
        {
            "job_id": j["job_id"],
            "status": j["status"],
            "repo_url": j["repo_url"],
            "task": j["task"][:100],
            "submitted_by": j.get("submitted_by", ""),
            "submitted_at": j["submitted_at"],
            "started_at": j.get("started_at"),
            "completed_at": j.get("completed_at"),
            "pr_url": (j.get("result") or {}).get("pr_url"),
        }
        for j in jobs
    ]


# ---------------------------------------------------------------------------
# 4b. Pipeline endpoints
# ---------------------------------------------------------------------------

@app.post("/pipelines")
async def ep_create_pipeline(request: Request):
    body = await request.json()

    name = body.get("name")
    steps = body.get("steps")
    if not name or not steps:
        return JSONResponse(
            {"error": "'name' and 'steps' are required."},
            status_code=400,
        )

    seen_names = set()
    for i, step in enumerate(steps):
        if "name" not in step or "task" not in step:
            return JSONResponse(
                {"error": f"Step {i} must have 'name' and 'task' fields."},
                status_code=400,
            )
        if step["name"] in seen_names:
            return JSONResponse(
                {"error": f"Duplicate step name: '{step['name']}'"},
                status_code=400,
            )
        seen_names.add(step["name"])

    try:
        topological_sort(steps)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    pipeline_id = str(uuid.uuid4())
    repo_url = body.get("repo_url", "")

    record = create_pipeline(pipeline_id, name, repo_url, steps)
    return record


@app.get("/pipelines")
def ep_list_pipelines():
    return list_pipelines()


@app.get("/pipelines/{pipeline_id}")
def ep_get_pipeline(pipeline_id: str):
    record = get_pipeline(pipeline_id)
    if not record:
        return JSONResponse(
            {"error": f"Pipeline '{pipeline_id}' not found."}, status_code=404
        )
    return record


@app.delete("/pipelines/{pipeline_id}")
def ep_delete_pipeline(pipeline_id: str):
    deleted = delete_pipeline(pipeline_id)
    if not deleted:
        return JSONResponse(
            {"error": f"Pipeline '{pipeline_id}' not found."}, status_code=404
        )
    return {"deleted": True}


@app.post("/pipelines/{pipeline_id}/run")
async def ep_run_pipeline(pipeline_id: str, request: Request):
    pipeline = get_pipeline(pipeline_id)
    if not pipeline:
        return JSONResponse(
            {"error": f"Pipeline '{pipeline_id}' not found."}, status_code=404
        )

    try:
        body = await request.json()
    except Exception:
        body = {}
    repo_url = body.get("repo_url") or pipeline.get("repo_url")
    github_token = body.get("github_token", "")

    if not repo_url:
        return JSONResponse(
            {"error": "No repo_url provided and pipeline has no default."},
            status_code=400,
        )

    run_id = str(uuid.uuid4())
    run = create_pipeline_run(run_id, pipeline_id, repo_url)

    # Fire and forget
    asyncio.create_task(
        _run_pipeline_task_async(
            run_id, pipeline_id, repo_url, pipeline["steps"], github_token,
        )
    )

    return {
        "run_id": run_id,
        "pipeline_id": pipeline_id,
        "status": "pending",
        "repo_url": repo_url,
    }


@app.get("/pipelines/{pipeline_id}/runs")
def ep_list_pipeline_runs(pipeline_id: str):
    return list_pipeline_runs(pipeline_id)


@app.get("/runs/{run_id}")
def ep_get_run(run_id: str):
    run = get_pipeline_run(run_id)
    if not run:
        return JSONResponse(
            {"error": f"Run '{run_id}' not found."}, status_code=404
        )

    jobs = get_jobs_for_run(run_id)
    run["jobs"] = [
        {
            "job_id": j["job_id"],
            "step_name": j.get("step_name"),
            "step_index": j.get("step_index"),
            "status": j["status"],
            "task": j["task"][:100],
            "started_at": j.get("started_at"),
            "completed_at": j.get("completed_at"),
            "error": j.get("error"),
            "step_output": j.get("step_output"),
            "pr_url": (j.get("result") or {}).get("pr_url"),
        }
        for j in jobs
    ]
    return run


# ---------------------------------------------------------------------------
# 4c. WebSocket — real-time job updates
# ---------------------------------------------------------------------------

@app.websocket("/ws/{job_id}")
async def ws_job(websocket: WebSocket, job_id: str):
    """Stream real-time updates for a specific job."""
    await websocket.accept()

    last_status = None
    last_log_count = 0

    try:
        while True:
            record = get_job(job_id)
            if not record:
                await websocket.send_json({"error": f"Job '{job_id}' not found."})
                break

            current_status = record["status"]
            current_logs = record.get("logs", [])

            if current_status != last_status or len(current_logs) != last_log_count:
                new_logs = current_logs[last_log_count:]
                await websocket.send_json({
                    "type": "update",
                    "job_id": job_id,
                    "status": current_status,
                    "started_at": record.get("started_at"),
                    "completed_at": record.get("completed_at"),
                    "result": record.get("result"),
                    "error": record.get("error"),
                    "new_logs": new_logs,
                    "total_logs": len(current_logs),
                })
                last_status = current_status
                last_log_count = len(current_logs)

            if current_status in ("completed", "failed"):
                await websocket.send_json({"type": "done", "status": current_status})
                break

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        pass
    except Exception:
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.close()


# ---------------------------------------------------------------------------
# 5. Run server directly (for local development without Docker)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
```

**Step 3: Verify api.py has no Modal references**

Run: `grep -n "modal\|Modal\|db_volume\|workspace_volume\|sandbox_image\|api_image\|\.spawn\|\.remote\|\.reload\|\.commit" api.py`
Expected: No matches

**Step 4: Commit**

```bash
git add api.py api.py.modal.bak
git commit -m "refactor: rewrite api.py to use local FastAPI + asyncio instead of Modal"
```

---

### Task 5: Delete sandbox.py

**Files:**
- Delete: `sandbox.py`

**Step 1: Delete the file**

```bash
git rm sandbox.py
```

**Step 2: Commit**

```bash
git commit -m "chore: remove sandbox.py (Modal CLI entry point no longer needed)"
```

---

### Task 6: Update Dashboard — configurable API URL

**Files:**
- Modify: `dashboard/src/App.jsx:5-6`
- Create: `dashboard/.env.example`

**Step 1: Update App.jsx API_BASE**

Change lines 5-6 from:
```javascript
const API_BASE = "https://hanwen-yang-hy3191--agent-api-api.modal.run";
const WS_BASE = API_BASE.replace(/^http/, "ws");
```

To:
```javascript
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const WS_BASE = API_BASE.replace(/^http/, "ws");
```

**Step 2: Create dashboard/.env.example**

```
# Dashboard environment variables
VITE_API_URL=http://localhost:8000
```

**Step 3: Verify the change**

Run: `grep -n "modal.run\|hanwen-yang" dashboard/src/App.jsx`
Expected: No matches

**Step 4: Commit**

```bash
git add dashboard/src/App.jsx dashboard/.env.example
git commit -m "feat: make dashboard API URL configurable via VITE_API_URL env var"
```

---

### Task 7: Create Dockerfile

**Files:**
- Create: `Dockerfile`

**Step 1: Create the Dockerfile**

```dockerfile
# ── Stage 1: Install Node.js dependencies ────────────────────────────────────
FROM node:20-slim AS node-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install opencode-ai globally
RUN npm install -g opencode-ai tsx

# Set up Python dependencies
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Node.js dependencies from stage 1
COPY --from=node-deps /app/node_modules ./node_modules

# Copy application code
COPY package.json ./
COPY tsconfig.json* ./
COPY opencode.json ./
COPY api.py shared.py models.py scheduler.py ./
COPY src/ ./src/

# Create directories for data and workspaces
RUN mkdir -p /data /workspaces

# Environment defaults
ENV PYTHONPATH=/app
ENV APP_DIR=/app
ENV DATA_DIR=/data
ENV WORKSPACES_DIR=/workspaces
ENV PORT=8000

EXPOSE 8000

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add Dockerfile for local container execution"
```

---

### Task 8: Create docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

**Step 1: Create docker-compose.yml**

```yaml
services:
  agent:
    build: .
    ports:
      - "${PORT:-8000}:8000"
    volumes:
      - ./data:/data
      - ./workspaces:/workspaces
    env_file:
      - .env
    environment:
      - DATA_DIR=/data
      - WORKSPACES_DIR=/workspaces
    restart: unless-stopped

  dashboard:
    build: ./dashboard
    ports:
      - "5173:5173"
    environment:
      - VITE_API_URL=http://localhost:${PORT:-8000}
    depends_on:
      - agent
```

**Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add docker-compose.yml for single-command local deployment"
```

---

### Task 9: Create dashboard Dockerfile

**Files:**
- Create: `dashboard/Dockerfile`

**Step 1: Create dashboard/Dockerfile**

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
```

**Step 2: Commit**

```bash
git add dashboard/Dockerfile
git commit -m "feat: add dashboard Dockerfile for containerized frontend"
```

---

### Task 10: Update README.md

**Files:**
- Modify: `README.md`

**Step 1: Update the Quick Start section to reflect Docker-based usage**

Add a new "Local Docker" section near the top and update the architecture section to mention v0.9. Keep the existing content about Modal as a "Cloud Deployment (Legacy)" section.

Key sections to add:

**Quick Start (Docker):**
```bash
# 1. Clone and configure
git clone <repo-url>
cd running-agent
cp .env.example .env
# Edit .env with your GEMINI_API_KEY and GITHUB_TOKEN

# 2. Start everything
docker compose up --build

# 3. Open the dashboard
open http://localhost:5173

# Or submit via curl
curl -X POST http://localhost:8000/submit \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "https://github.com/you/your-repo.git", "task": "Add unit tests"}'
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for local Docker deployment (v0.9)"
```

---

### Task 11: Smoke test — build and verify

**Step 1: Verify no Modal imports remain in Python files**

Run: `grep -rn "import modal\|from modal\|modal\." api.py shared.py models.py`
Expected: No matches

**Step 2: Verify Python syntax is valid**

Run: `python3 -c "import ast; [ast.parse(open(f).read()) for f in ['api.py', 'shared.py', 'models.py', 'scheduler.py']]" && echo "OK"`
Expected: `OK`

**Step 3: Verify Docker build succeeds**

Run: `docker compose build agent`
Expected: Build succeeds without errors

**Step 4: Verify API starts**

Run: `docker compose up -d agent && sleep 3 && curl -s http://localhost:8000/health`
Expected: `{"status":"ok","timestamp":"..."}`

**Step 5: Verify dashboard connects**

Run: `curl -s http://localhost:8000/jobs`
Expected: `[]` (empty job list)

**Step 6: Stop containers**

Run: `docker compose down`

**Step 7: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```

(Only if there were fixes needed.)

---

### Task 12: Final commit and summary

**Step 1: Verify all files are committed**

Run: `git status`
Expected: clean working tree

**Step 2: Tag the release**

```bash
git tag v0.9-local-docker
```

**Step 3: Summary of changes**

Files created:
- `Dockerfile` — multi-stage container with Python 3.12 + Node.js 20 + git + gh
- `docker-compose.yml` — single-command deployment
- `dashboard/Dockerfile` — containerized frontend
- `requirements.txt` — Python dependencies
- `.env.example` — environment variable template
- `.dockerignore` — Docker build exclusions
- `api.py.modal.bak` — original Modal-based API (backup)

Files modified:
- `api.py` — Pure FastAPI + asyncio (no Modal)
- `shared.py` — Local subprocess execution (no Modal)
- `models.py` — Direct SQLite (no Modal Volume)
- `dashboard/src/App.jsx` — Configurable API URL
- `README.md` — Docker deployment instructions

Files deleted:
- `sandbox.py` — Modal CLI entry point (no longer needed)

Files unchanged:
- `scheduler.py` — Pure logic, no Modal dependency
- `src/index.ts` — Agent engine
- `src/verify.ts` — Verification engine
- `src/planner.ts` — Task planner
- `src/repomap.ts` — Repo map generator
- `src/context.ts` — Context budgeting
- `opencode.json` — LLM config
- `package.json` — Node.js dependencies
