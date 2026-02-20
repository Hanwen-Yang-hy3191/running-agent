"""
HTTP API for the Background Coding Agent.

Provides endpoints so anyone (Slack bot, web UI, curl) can trigger
an agent task and poll for results, without needing a local terminal.

Features:
    - API Key authentication (X-API-Key header or api_key query param)
    - WebSocket real-time updates (/ws/{job_id})
    - SQLite-backed persistent job storage

Usage:
    # One-time: store secrets in Modal
    modal secret create gemini-key GEMINI_API_KEY=AIza...
    modal secret create github-token GITHUB_TOKEN=ghp_...
    modal secret create api-auth API_KEY=your-secret-key

    # Deploy (creates permanent public URLs)
    modal deploy api.py

    # Or run ephemerally for testing
    modal serve api.py
"""

import asyncio
import json
import modal
import os
import time
import uuid

from shared import sandbox_image, setup_github_auth, clone_and_install, run_agent
from models import (
    db_volume, DB_DIR,
    create_job, get_job, update_job, list_jobs, now_iso,
)

MAX_ATTEMPTS = 3
RETRY_BASE_DELAY = 10  # seconds, exponential: 10, 20, 40

# ---------------------------------------------------------------------------
# 1. Modal App
# ---------------------------------------------------------------------------

app = modal.App("agent-api")

# ---------------------------------------------------------------------------
# 2. Async Agent Task — runs in the background after spawn()
# ---------------------------------------------------------------------------

@app.function(
    image=sandbox_image,
    timeout=1800,
    volumes={DB_DIR: db_volume},
    secrets=[
        modal.Secret.from_name("gemini-key", required_keys=["GEMINI_API_KEY"]),
        modal.Secret.from_name("github-token", required_keys=["GITHUB_TOKEN"]),
    ],
)
def run_agent_task(job_id: str, repo_url: str, task: str, github_token: str = ""):
    """
    The heavy lifter — runs entirely in Modal cloud.
    Uses shared.py for auth, clone, install, and agent execution.
    Supports automatic retry with exponential backoff (up to MAX_ATTEMPTS).
    """
    token = github_token or os.environ.get("GITHUB_TOKEN", "")

    update_job(job_id, status="running", started_at=now_iso())

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            update_job(
                job_id,
                attempt=attempt,
                logs=[f"[Attempt {attempt}/{MAX_ATTEMPTS}] Authenticating with GitHub..."],
            )
            setup_github_auth(token)

            update_job(job_id, logs=[f"[Attempt {attempt}/{MAX_ATTEMPTS}] Cloning repository..."])
            clone_and_install(repo_url)

            update_job(job_id, logs=[f"[Attempt {attempt}/{MAX_ATTEMPTS}] Agent engine starting..."])
            result = run_agent(task)

            update_job(
                job_id,
                status="completed",
                completed_at=now_iso(),
                attempt=attempt,
                result={
                    "pr_url": result["pr_url"],
                    "summary": (
                        f"Agent finished. PR: {result['pr_url']}"
                        if result["pr_url"]
                        else "Agent finished (no PR URL detected)."
                    ),
                    "exit_code": result["exit_code"],
                },
                logs=result["log_lines"],
            )

            db_volume.commit()
            return {"status": "completed", "pr_url": result["pr_url"]}

        except Exception as exc:
            last_error = exc
            error_msg = str(exc)[:500]

            if attempt < MAX_ATTEMPTS:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                update_job(
                    job_id,
                    status="retrying",
                    attempt=attempt,
                    error=f"Attempt {attempt} failed: {error_msg}. Retrying in {delay}s...",
                )
                db_volume.commit()
                time.sleep(delay)
            else:
                update_job(
                    job_id,
                    status="failed",
                    completed_at=now_iso(),
                    attempt=attempt,
                    error=f"All {MAX_ATTEMPTS} attempts failed. Last error: {error_msg}",
                )
                db_volume.commit()
                raise last_error


# ---------------------------------------------------------------------------
# 3. HTTP API — FastAPI app with CORS, Auth, and WebSocket
# ---------------------------------------------------------------------------

api_image = modal.Image.debian_slim().pip_install("fastapi[standard]")

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketState

web_app = FastAPI(title="Agent API")

web_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# 3a. API Key Authentication
# ---------------------------------------------------------------------------

PUBLIC_PATHS = {"/health", "/ws"}


async def verify_api_key(request: Request):
    """Check API key from header or query param. Skip for public paths."""
    # Allow WebSocket and health without auth
    if request.url.path == "/health" or request.url.path.startswith("/ws/"):
        return

    expected_key = os.environ.get("API_KEY", "")
    if not expected_key:
        # No key configured — auth disabled (development mode)
        return

    provided_key = (
        request.headers.get("X-API-Key")
        or request.query_params.get("api_key")
        or ""
    )

    if provided_key != expected_key:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


# Apply auth to all routes via dependency
web_app.dependency_overrides = {}


# ---------------------------------------------------------------------------
# 3b. Endpoints
# ---------------------------------------------------------------------------

@web_app.get("/health")
def ep_health():
    return {"status": "ok", "timestamp": now_iso()}


@web_app.post("/submit", dependencies=[Depends(verify_api_key)])
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
    run_agent_task.spawn(job_id, repo_url, task, github_token)

    return {
        "job_id": job_id,
        "status": "queued",
        "submitted_at": record["submitted_at"],
    }


@web_app.get("/status/{job_id}", dependencies=[Depends(verify_api_key)])
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


@web_app.get("/result/{job_id}", dependencies=[Depends(verify_api_key)])
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


@web_app.get("/jobs", dependencies=[Depends(verify_api_key)])
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
# 3c. WebSocket — real-time job updates
# ---------------------------------------------------------------------------

@web_app.websocket("/ws/{job_id}")
async def ws_job(websocket: WebSocket, job_id: str):
    """
    Stream real-time updates for a specific job.

    Polls the database and pushes changes to the client whenever
    the job status or logs change.  The connection closes automatically
    when the job reaches a terminal state (completed/failed).
    """
    await websocket.accept()

    last_status = None
    last_log_count = 0

    try:
        while True:
            # Reload volume to see latest writes from the agent task
            db_volume.reload()

            record = get_job(job_id)
            if not record:
                await websocket.send_json({"error": f"Job '{job_id}' not found."})
                break

            current_status = record["status"]
            current_logs = record.get("logs", [])

            # Send update if something changed
            if current_status != last_status or len(current_logs) != last_log_count:
                # Only send new log lines
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

            # Stop streaming on terminal states
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
# Mount the FastAPI app onto a single Modal function
# ---------------------------------------------------------------------------

@app.function(
    image=api_image,
    volumes={DB_DIR: db_volume},
    secrets=[modal.Secret.from_name("api-auth", required_keys=["API_KEY"])],
)
@modal.asgi_app()
def api():
    return web_app
