"""
Phase 4 — HTTP API for the Background Coding Agent.

Provides webhook endpoints so anyone (Slack bot, web UI, curl) can trigger
an agent task and poll for results, without needing a local terminal.

Usage:
    # One-time: store secrets in Modal
    modal secret create gemini-key GEMINI_API_KEY=AIza...
    modal secret create github-token GITHUB_TOKEN=ghp_...

    # Deploy (creates permanent public URLs)
    modal deploy api.py

    # Or run ephemerally for testing
    modal serve api.py
"""

import modal
import os
import subprocess
import uuid
import json
import re
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# 1. Modal App + Shared Resources
# ---------------------------------------------------------------------------

app = modal.App("agent-api")

# Persistent KV store — survives across function invocations & deploys.
# Each key is a job_id (str), each value is a JobRecord dict (serialised).
job_store = modal.Dict.from_name("agent-jobs", create_if_missing=True)

# ---------------------------------------------------------------------------
# 2. Container Image (same as sandbox.py)
# ---------------------------------------------------------------------------

sandbox_image = (
    modal.Image.debian_slim()
    .apt_install("git", "curl", "python3")
    .pip_install("fastapi[standard]")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
    )
    .run_commands(
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
        "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
        'echo "deb [arch=$(dpkg --print-architecture) '
        "signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] "
        'https://cli.github.com/packages stable main" '
        "| tee /etc/apt/sources.list.d/github-cli.list > /dev/null",
        "apt-get update && apt-get install -y gh",
    )
    .add_local_dir(
        local_path=".",
        remote_path="/app",
        ignore=["dummy-workspace/**", "node_modules/**"],
    )
)

# ---------------------------------------------------------------------------
# 3. Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    """ISO-8601 timestamp in UTC."""
    return datetime.now(timezone.utc).isoformat()


_JOB_INDEX_KEY = "__job_index__"


def _make_job(job_id: str, repo_url: str, task: str, user_id: str = "") -> dict:
    """Create a fresh job record and register it in the global index."""
    record = {
        "job_id": job_id,
        "status": "queued",
        "repo_url": repo_url,
        "task": task,
        "submitted_by": user_id,
        "submitted_at": _now(),
        "started_at": None,
        "completed_at": None,
        "result": None,
        "error": None,
        "logs": [],
    }
    # Store the record
    job_store[job_id] = record

    # Append to the global index so we can list all jobs later
    try:
        index = job_store[_JOB_INDEX_KEY]
    except KeyError:
        index = []
    index.append(job_id)
    job_store[_JOB_INDEX_KEY] = index

    return record


def _update_job(job_id: str, **fields) -> dict:
    """Read-modify-write a job record in the Dict store."""
    record = job_store[job_id]
    record.update(fields)
    job_store[job_id] = record
    return record


def _list_jobs() -> list[dict]:
    """Return all job records, newest first."""
    try:
        index = job_store[_JOB_INDEX_KEY]
    except KeyError:
        return []
    records = []
    for jid in reversed(index):  # newest first
        try:
            records.append(job_store[jid])
        except KeyError:
            pass
    return records

# ---------------------------------------------------------------------------
# 4. Async Agent Task — runs in the background after spawn()
# ---------------------------------------------------------------------------

@app.function(
    image=sandbox_image,
    timeout=1800,
    secrets=[
        modal.Secret.from_name("gemini-key", required_keys=["GEMINI_API_KEY"]),
        modal.Secret.from_name("github-token", required_keys=["GITHUB_TOKEN"]),
    ],
)
def run_agent_task(job_id: str, repo_url: str, task: str, github_token: str = ""):
    """
    The heavy lifter — runs entirely in Modal cloud.
    Identical logic to sandbox.py's run_agent_in_cloud, but wrapped with
    job-store status updates so callers can poll for progress.
    """

    # Use caller-supplied token, fall back to Modal secret
    token = github_token or os.environ.get("GITHUB_TOKEN", "")

    # ── Mark job as running ────────────────────────────────────────────────
    _update_job(job_id, status="running", started_at=_now())

    try:
        # ── GitHub CLI authentication ──────────────────────────────────────
        _update_job(job_id, logs=["Authenticating with GitHub..."])
        proc = subprocess.run(
            ["gh", "auth", "login", "--with-token"],
            input=token, text=True, capture_output=True,
        )
        if proc.returncode != 0:
            print(f"[Cloud] gh auth warning: {proc.stderr.strip()}")

        subprocess.run(["gh", "auth", "status"], check=False)

        # ── Git identity ───────────────────────────────────────────────────
        subprocess.run(
            ["git", "config", "--global", "user.name", "Cloud Agent"], check=True
        )
        subprocess.run(
            ["git", "config", "--global", "user.email", "agent@cloud.bot"], check=True
        )

        # ── Git credential store ───────────────────────────────────────────
        subprocess.run(
            ["git", "config", "--global", "credential.helper", "store"], check=True
        )
        with open(os.path.expanduser("~/.git-credentials"), "w") as f:
            f.write(f"https://x-access-token:{token}@github.com\n")

        # ── Clone ──────────────────────────────────────────────────────────
        _update_job(job_id, logs=["Cloning repository..."])
        subprocess.run(["git", "clone", repo_url, "/app/workspace"], check=True)

        # ── Install deps ───────────────────────────────────────────────────
        os.chdir("/app")
        _update_job(job_id, logs=["Installing dependencies..."])
        subprocess.run(["npm", "install"], check=True)
        subprocess.run(["npm", "install", "-g", "opencode-ai"], check=True)

        # SDK symlink fix
        os.makedirs("node_modules/@opencode-ai/sdk/dist", exist_ok=True)
        try:
            os.symlink("src/index.js", "node_modules/@opencode-ai/sdk/dist/index.js")
        except FileExistsError:
            pass

        # ── Run the Node.js agent engine ───────────────────────────────────
        _update_job(job_id, logs=["Agent engine starting..."])

        env = os.environ.copy()
        env["TASK_DESCRIPTION"] = task

        result = subprocess.run(
            ["npm", "run", "dev"],
            env=env,
            capture_output=True,
            text=True,
            timeout=1500,  # leave some headroom within the 1800s function timeout
        )

        stdout = result.stdout or ""
        stderr = result.stderr or ""
        combined_output = stdout + "\n" + stderr

        # ── Extract PR URL from agent output ───────────────────────────────
        pr_url = None
        for line in combined_output.splitlines():
            if "github.com" in line and "/pull/" in line:
                match = re.search(r"https://github\.com/[^\s\"']+/pull/\d+", line)
                if match:
                    pr_url = match.group(0)
                    break

        # Grab last ~50 meaningful log lines for the job record
        log_lines = [
            l for l in combined_output.splitlines()
            if l.strip() and not l.startswith(">")
        ][-50:]

        # ── Mark completed ─────────────────────────────────────────────────
        _update_job(
            job_id,
            status="completed",
            completed_at=_now(),
            result={
                "pr_url": pr_url,
                "summary": f"Agent finished. PR: {pr_url}" if pr_url else "Agent finished (no PR URL detected).",
                "exit_code": result.returncode,
            },
            logs=log_lines,
        )

        return {"status": "completed", "pr_url": pr_url}

    except Exception as exc:
        _update_job(
            job_id,
            status="failed",
            completed_at=_now(),
            error=str(exc)[:500],
        )
        raise


# ---------------------------------------------------------------------------
# 5. HTTP API — single FastAPI app with CORS
# ---------------------------------------------------------------------------

api_image = modal.Image.debian_slim().pip_install("fastapi[standard]")

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

web_app = FastAPI(title="Agent API")

web_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)


@web_app.get("/health")
def ep_health():
    return {"status": "ok", "timestamp": _now()}


@web_app.post("/submit")
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
    record = _make_job(job_id, repo_url, task, user_id)

    # Fire and forget — the task runs in the background
    run_agent_task.spawn(job_id, repo_url, task, github_token)

    return {
        "job_id": job_id,
        "status": "queued",
        "submitted_at": record["submitted_at"],
    }


@web_app.get("/status/{job_id}")
def ep_status(job_id: str):
    try:
        record = job_store[job_id]
    except KeyError:
        return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)

    return {
        "job_id": record["job_id"],
        "status": record["status"],
        "submitted_at": record["submitted_at"],
        "started_at": record.get("started_at"),
        "completed_at": record.get("completed_at"),
    }


@web_app.get("/result/{job_id}")
def ep_result(job_id: str):
    try:
        record = job_store[job_id]
    except KeyError:
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


@web_app.get("/jobs")
def ep_jobs():
    """List all jobs, newest first. Returns summary (no logs)."""
    jobs = _list_jobs()
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


# Mount the FastAPI app onto a single Modal function
@app.function(image=api_image)
@modal.asgi_app()
def api():
    return web_app
