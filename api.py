"""
HTTP API for the Background Coding Agent.

Provides endpoints so anyone (Slack bot, web UI, curl) can trigger
an agent task and poll for results, without needing a local terminal.

Features:
    - WebSocket real-time updates (/ws/{job_id})
    - SQLite-backed persistent job storage
    - Automatic retry with exponential backoff

Usage:
    # One-time: store secrets in Modal
    modal secret create gemini-key GEMINI_API_KEY=AIza...
    modal secret create github-token GITHUB_TOKEN=ghp_...

    # Deploy (creates permanent public URLs)
    modal deploy api.py

    # Or run ephemerally for testing
    modal serve api.py
"""

import asyncio
import modal
import os
import shutil
import time
import uuid

from shared import (
    sandbox_image, setup_github_auth, clone_and_install, run_agent,
    workspace_volume, WORKSPACE_VOLUME_DIR,
)
from models import (
    db_volume, DB_DIR,
    create_job, get_job, update_job, list_jobs, now_iso,
    create_pipeline, get_pipeline, list_pipelines, delete_pipeline,
    create_pipeline_run, get_pipeline_run, update_pipeline_run,
    list_pipeline_runs, get_jobs_for_run,
)
from scheduler import topological_sort, resolve_templates

MAX_ATTEMPTS = 3
RETRY_BASE_DELAY = 10  # seconds, exponential: 10, 20, 40
WORKSPACE = "/app/workspace"

# ---------------------------------------------------------------------------
# 1. Modal App
# ---------------------------------------------------------------------------

app = modal.App("agent-api")

# Lightweight image for API endpoints and pipeline orchestrator
api_image = (
    modal.Image.debian_slim()
    .pip_install("fastapi[standard]")
    .add_local_file("shared.py", "/root/shared.py")
    .add_local_file("models.py", "/root/models.py")
    .add_local_file("scheduler.py", "/root/scheduler.py")
)

# ---------------------------------------------------------------------------
# 2. Async Agent Task — runs in the background after spawn()
# ---------------------------------------------------------------------------

@app.function(
    image=sandbox_image,
    timeout=3600,  # 60 min: enough for multi-subtask execution (agent timeout=3000s + buffer)
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
    all_logs = []

    # Ensure we have the latest DB state (API container committed the job record)
    db_volume.reload()

    job = get_job(job_id)
    if not job:
        raise RuntimeError(f"Job {job_id} not found in database after reload — possible volume sync issue")

    update_job(job_id, status="running", started_at=now_iso())
    db_volume.commit()

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            # Clean up workspace from previous attempt
            if os.path.exists(WORKSPACE):
                shutil.rmtree(WORKSPACE)

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

            # Merge agent log lines into accumulated logs
            all_logs.extend(result["log_lines"])

            # Extract metrics from step_output
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

            db_volume.commit()
            return {"status": "completed", "pr_url": result["pr_url"]}

        except Exception as exc:
            last_error = exc
            error_msg = str(exc)[:500]

            if attempt < MAX_ATTEMPTS:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                msg = f"[Attempt {attempt}/{MAX_ATTEMPTS}] Failed: {error_msg}. Retrying in {delay}s..."
                all_logs.append(msg)
                update_job(
                    job_id,
                    status="retrying",
                    attempt=attempt,
                    error=error_msg,
                    logs=all_logs,
                )
                db_volume.commit()
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
                db_volume.commit()
                raise last_error


# ---------------------------------------------------------------------------
# 2b. Pipeline step executor — runs a single step with context
# ---------------------------------------------------------------------------

@app.function(
    image=sandbox_image,
    timeout=3600,  # 60 min: enough for multi-subtask execution (agent timeout=3000s + buffer)
    volumes={
        DB_DIR: db_volume,
        WORKSPACE_VOLUME_DIR: workspace_volume,
    },
    secrets=[
        modal.Secret.from_name("gemini-key", required_keys=["GEMINI_API_KEY"]),
        modal.Secret.from_name("github-token", required_keys=["GITHUB_TOKEN"]),
    ],
)
def run_pipeline_step(
    job_id: str,
    repo_url: str,
    task: str,
    step_context: dict,
    github_token: str = "",
    workspace_path: str = "",
    skip_clone: bool = False,
):
    """
    Execute a single pipeline step. Similar to run_agent_task but passes
    step_context to the agent for upstream output awareness.

    When workspace_path is set and skip_clone=True, reuses the workspace
    from a previous pipeline step (workspace persistence).
    """
    token = github_token or os.environ.get("GITHUB_TOKEN", "")
    all_logs = []
    workspace = workspace_path or WORKSPACE

    db_volume.reload()
    if workspace_path:
        workspace_volume.reload()

    job = get_job(job_id)
    if not job:
        raise RuntimeError(f"Pipeline step job {job_id} not found after reload")

    update_job(job_id, status="running", started_at=now_iso())
    db_volume.commit()

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            # Only clean up workspace if not using shared persistence
            if not skip_clone and os.path.exists(workspace):
                shutil.rmtree(workspace)

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

            # Extract metrics from step_output
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

            db_volume.commit()
            # Persist workspace for subsequent pipeline steps
            if workspace_path:
                workspace_volume.commit()
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
                db_volume.commit()
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
                db_volume.commit()
                raise last_error


# ---------------------------------------------------------------------------
# 2c. Pipeline orchestrator — executes all steps according to DAG order
# ---------------------------------------------------------------------------

@app.function(
    image=api_image,
    timeout=7200,  # pipelines can take longer
    volumes={DB_DIR: db_volume},
)
def run_pipeline_task(
    run_id: str,
    pipeline_id: str,
    repo_url: str,
    steps: list,
    github_token: str = "",
):
    """
    Orchestrate a full pipeline run: execute steps in DAG order,
    passing upstream outputs to downstream steps.
    """
    db_volume.reload()
    try:
        _execute_pipeline_steps(run_id, pipeline_id, repo_url, steps, github_token)
    except Exception as exc:
        # Catch-all: ensure the run never gets stuck in "running"
        update_pipeline_run(
            run_id,
            status="failed",
            completed_at=now_iso(),
            error=f"Pipeline crashed: {str(exc)[:500]}",
        )
        db_volume.commit()
        raise


def _execute_pipeline_steps(
    run_id: str,
    pipeline_id: str,
    repo_url: str,
    steps: list,
    github_token: str,
):
    """Inner pipeline execution logic, wrapped by run_pipeline_task for safety.

    Uses a shared workspace on a Modal Volume so pipeline steps can build
    on each other's changes without re-cloning the repository.
    """
    update_pipeline_run(run_id, status="running", started_at=now_iso())

    step_map = {s["name"]: s for s in steps}
    layers = topological_sort(steps)

    # Shared workspace path on the workspace volume for this run
    run_workspace = f"{WORKSPACE_VOLUME_DIR}/{run_id}"

    # Create job records for each step
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

    db_volume.commit()

    # Execute layer by layer
    step_outputs: dict[str, dict] = {}
    failed = False
    is_first_step = True

    for layer in layers:
        if failed:
            # Skip remaining layers
            for step_name in layer:
                jid = job_ids.get(step_name)
                if jid:
                    update_job(
                        jid, status="failed",
                        error="Skipped: upstream step failed",
                        completed_at=now_iso(),
                    )
            db_volume.commit()
            continue

        for step_name in layer:
            step_def = step_map[step_name]
            jid = job_ids[step_name]

            # Resolve template variables
            resolved_task = resolve_templates(step_def["task"], step_outputs)

            step_context = {
                "pipeline_id": pipeline_id,
                "run_id": run_id,
                "step_name": step_name,
                "upstream_outputs": step_outputs,
            }

            on_failure = step_def.get("on_failure", "stop")

            try:
                # First step clones; subsequent steps reuse the workspace
                step_result = run_pipeline_step.remote(
                    jid, repo_url, resolved_task, step_context, github_token,
                    workspace_path=run_workspace,
                    skip_clone=not is_first_step,
                )
                is_first_step = False

                # Reload volume to see the step's DB writes
                db_volume.reload()

                if step_result:
                    step_outputs[step_name] = step_result
                else:
                    step_outputs[step_name] = {"exit_code": 0}

                # Verify the job didn't fail
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
                    db_volume.commit()
                    break

    # Finalize the run
    final_status = "failed" if failed else "completed"
    update_pipeline_run(run_id, status=final_status, completed_at=now_iso())
    db_volume.commit()


# ---------------------------------------------------------------------------
# 3. HTTP API — FastAPI app with CORS and WebSocket
# ---------------------------------------------------------------------------

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
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
# 3a. Endpoints
# ---------------------------------------------------------------------------

@web_app.get("/health")
def ep_health():
    return {"status": "ok", "timestamp": now_iso()}


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
    record = create_job(job_id, repo_url, task, user_id)
    db_volume.commit()  # ensure the spawned container can see this job

    # Fire and forget — the task runs in the background
    run_agent_task.spawn(job_id, repo_url, task, github_token)

    return {
        "job_id": job_id,
        "status": "queued",
        "submitted_at": record["submitted_at"],
    }


@web_app.get("/status/{job_id}")
def ep_status(job_id: str):
    db_volume.reload()
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


@web_app.get("/result/{job_id}")
def ep_result(job_id: str):
    db_volume.reload()
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


@web_app.get("/jobs")
def ep_jobs():
    """List all jobs, newest first. Returns summary (no logs)."""
    db_volume.reload()
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
# 3b. Pipeline endpoints
# ---------------------------------------------------------------------------

@web_app.post("/pipelines")
async def ep_create_pipeline(request: Request):
    """Create a new pipeline definition."""
    body = await request.json()

    name = body.get("name")
    steps = body.get("steps")
    if not name or not steps:
        return JSONResponse(
            {"error": "'name' and 'steps' are required."},
            status_code=400,
        )

    # Validate each step
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

    # Validate DAG (no cycles, valid depends_on references)
    try:
        topological_sort(steps)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    pipeline_id = str(uuid.uuid4())
    repo_url = body.get("repo_url", "")

    record = create_pipeline(pipeline_id, name, repo_url, steps)
    db_volume.commit()
    return record


@web_app.get("/pipelines")
def ep_list_pipelines():
    """List all pipeline definitions."""
    db_volume.reload()
    return list_pipelines()


@web_app.get("/pipelines/{pipeline_id}")
def ep_get_pipeline(pipeline_id: str):
    """Get a pipeline definition by ID."""
    db_volume.reload()
    record = get_pipeline(pipeline_id)
    if not record:
        return JSONResponse(
            {"error": f"Pipeline '{pipeline_id}' not found."}, status_code=404
        )
    return record


@web_app.delete("/pipelines/{pipeline_id}")
def ep_delete_pipeline(pipeline_id: str):
    """Delete a pipeline definition."""
    db_volume.reload()
    deleted = delete_pipeline(pipeline_id)
    db_volume.commit()
    if not deleted:
        return JSONResponse(
            {"error": f"Pipeline '{pipeline_id}' not found."}, status_code=404
        )
    return {"deleted": True}


@web_app.post("/pipelines/{pipeline_id}/run")
async def ep_run_pipeline(pipeline_id: str, request: Request):
    """Trigger a pipeline execution."""
    db_volume.reload()
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
    db_volume.commit()  # ensure the spawned container can see this run

    # Fire and forget — pipeline orchestrator runs in background
    run_pipeline_task.spawn(
        run_id, pipeline_id, repo_url, pipeline["steps"], github_token,
    )

    return {
        "run_id": run_id,
        "pipeline_id": pipeline_id,
        "status": "pending",
        "repo_url": repo_url,
    }


@web_app.get("/pipelines/{pipeline_id}/runs")
def ep_list_pipeline_runs(pipeline_id: str):
    """List all runs for a pipeline."""
    db_volume.reload()
    return list_pipeline_runs(pipeline_id)


@web_app.get("/runs/{run_id}")
def ep_get_run(run_id: str):
    """Get pipeline run details including all step jobs."""
    db_volume.reload()
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

@app.function(image=api_image, volumes={DB_DIR: db_volume})
@modal.asgi_app()
def api():
    return web_app
