# Local Docker Migration Design

**Date:** 2026-03-08
**Status:** Approved
**Version:** v0.9

## Goal

Replace Modal cloud sandbox with a local Docker container while preserving all existing functionality: API endpoints, Pipeline/Workflow engine, Dashboard, Agent engine, and Session Persistence.

## Architecture

```
Browser Dashboard (React/Vite, port 5173)
  │  HTTP + WebSocket
  ▼
Docker Container (Python 3.12 + Node.js 20 + git + gh)
  │  Main process: uvicorn FastAPI (port 8000)
  │  Per-job: subprocess.Popen("npm run dev")
  ▼
src/index.ts (Agent Engine — unchanged)
  │  OpenCode SDK + Gemini agents (explore/plan/build)
  ▼
GitHub (git push + gh pr create)
```

### Single Container Strategy

One Docker container contains both Python and Node.js runtimes:
- **Main process**: `uvicorn api:app --host 0.0.0.0 --port 8000`
- **Job execution**: Each task spawns `npm run dev` as a subprocess (identical to current Modal behavior)
- **Data**: SQLite at `./data/agent.db`, workspaces at `./workspaces/{job_id}/`
- **Secrets**: Passed via environment variables (`GEMINI_API_KEY`, `GITHUB_TOKEN`)

### What Changes

| Component | Change | Details |
|-----------|--------|---------|
| `api.py` | **Rewrite** | Remove Modal decorators/volumes/secrets. Pure FastAPI + uvicorn. Async job execution via `asyncio.create_subprocess_exec` or threading |
| `shared.py` | **Rewrite** | Remove Modal dependency. `clone_and_install` and `run_agent` become local subprocess calls |
| `models.py` | **Minor** | Remove `db_volume.commit()`/`db_volume.reload()` calls. Direct local SQLite |
| `sandbox.py` | **Delete** | Functionality merged into shared.py |
| `scheduler.py` | **No change** | Pure logic, no Modal dependency |
| `src/*.ts` | **No change** | Agent engine is completely independent of execution platform |
| `dashboard/` | **Minor** | Make API URL configurable (env var or `.env`), default to `http://localhost:8000` |
| `Dockerfile` | **New** | Multi-stage build: Python 3.12 + Node.js 20 + git + gh + opencode-ai |
| `docker-compose.yml` | **New** | Single service for API+Agent, optional dashboard service |
| `.env.example` | **New** | Template for required environment variables |

### What Stays the Same

- All API endpoints (jobs, pipelines, runs, WebSocket)
- Pipeline DAG scheduler (`scheduler.py`)
- Agent engine (`src/index.ts`, `verify.ts`, `planner.ts`, `repomap.ts`, `context.ts`)
- Three-agent architecture (explore/plan/build with Gemini)
- Checkpoint/resume session persistence
- Debug agent mode (Jaccard similarity error detection)
- Dashboard UI and features
- Database schema and models

## Dockerfile Design

```dockerfile
# Stage 1: Node.js dependencies
FROM node:20-slim AS node-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production

# Stage 2: Runtime
FROM python:3.12-slim
# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs git curl && \
    npm install -g opencode-ai
# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh
# Python dependencies
COPY requirements.txt .
RUN pip install -r requirements.txt
# App code
COPY --from=node-deps /app/node_modules ./node_modules
COPY . .
EXPOSE 8000
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
```

## docker-compose.yml Design

```yaml
version: "3.8"
services:
  agent:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ./data:/data
      - ./workspaces:/workspaces
    env_file: .env
    restart: unless-stopped

  dashboard:
    build: ./dashboard
    ports:
      - "5173:5173"
    environment:
      - VITE_API_URL=http://localhost:8000
    depends_on:
      - agent
```

## API Changes (api.py)

### Before (Modal)
```python
@app.function(volumes={"/data": db_volume}, secrets=[...])
def run_agent_task(job_id, repo_url, task, token):
    db_volume.reload()
    # ... execute agent ...
    db_volume.commit()
```

### After (Local)
```python
import asyncio
from fastapi import FastAPI

app = FastAPI()

async def run_agent_task(job_id, repo_url, task, token):
    update_job(job_id, status="running")
    try:
        result = await asyncio.to_thread(run_agent_sync, job_id, repo_url, task, token)
        update_job(job_id, status="completed", **result)
    except Exception as e:
        update_job(job_id, status="failed", error=str(e))

@app.post("/submit")
async def submit(req: SubmitRequest):
    job_id = str(uuid4())
    create_job(job_id, req.repo_url, req.task)
    asyncio.create_task(run_agent_task(job_id, req.repo_url, req.task, token))
    return {"job_id": job_id, "status": "queued"}
```

### Key Differences
- No Modal decorators, volumes, or secrets
- `asyncio.create_task` replaces `Modal.spawn()` for fire-and-forget
- Direct SQLite access (no commit/reload cycle)
- Environment variables via `os.environ` instead of Modal Secrets
- Retry logic preserved (3 attempts with exponential backoff)

## shared.py Changes

Remove Modal-specific code:
- `sandbox_image` definition → Dockerfile handles this
- `Modal.Volume` references → direct filesystem
- `@modal.function` decorators → plain functions
- Keep: `setup_github_auth()`, `clone_and_install()`, `run_agent()` — same logic, just no Modal wrappers

## models.py Changes

Remove all `db_volume.commit()` and `db_volume.reload()` calls. SQLite with WAL mode works fine for local concurrent access. DB path changes from `/data/agent.db` to configurable `DATA_DIR/agent.db`.

## Dashboard Changes

Replace hardcoded Modal API URL:
```javascript
// Before
const API_URL = "https://hanwen-yang-hy3191--agent-api-api.modal.run";
// After
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
```

## Environment Variables

```env
GEMINI_API_KEY=your_gemini_key
GITHUB_TOKEN=your_github_token
DATA_DIR=/data
WORKSPACES_DIR=/workspaces
PORT=8000
```

## Migration Notes

1. Existing `api.py` Modal code preserved in `api.py.modal.bak` for reference
2. No database migration needed — same SQLite schema
3. Agent engine (`src/*.ts`) requires zero changes
4. Pipeline workspace sharing: first step clones to `./workspaces/{run_id}/`, subsequent steps reuse it (same as Modal Volume behavior but with local filesystem)
