# Running Agent

An autonomous background coding agent that takes a GitHub repo and a task description, writes code in a cloud sandbox, and opens a Pull Request — all without human intervention.

Inspired by the [Ramp background agent architecture](https://builders.ramp.com/post/why-we-built-our-background-agent).

## How It Works

```
You (or any HTTP client)
  │  POST /submit { repo_url, task }
  ▼
Docker Container (FastAPI + uvicorn)
  │  Spawns subprocess for agent task
  ▼
Agent Engine (Node.js + OpenCode SDK)
  │  Clones repo → Reads code → Writes changes
  │  Creates branch → Commits → Pushes → Opens PR
  ▼
GitHub Pull Request
```

1. You submit a task via HTTP (or the web dashboard)
2. The agent runs inside a local Docker container with Node.js, Git, and GitHub CLI
3. It uses the OpenCode SDK (powered by Gemini) to understand the codebase, write code, and run commands
4. It creates a branch, commits changes, pushes, and opens a PR
5. You poll for status or watch the dashboard — the PR URL appears when done

## Quick Start

### Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose
- A [Gemini API key](https://ai.google.dev/)
- A [GitHub personal access token](https://github.com/settings/tokens) with `repo` scope

### Setup

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
  -d '{"repo_url": "https://github.com/you/your-repo.git", "task": "Add unit tests for the utils module"}'
```

Response:
```json
{ "job_id": "550e8400-...", "status": "queued" }
```

### Check status

```bash
curl http://localhost:8000/status/JOB_ID
```

### Get the result

```bash
curl http://localhost:8000/result/JOB_ID
```

Response includes the PR URL, logs, timing info, and cost metrics:

```json
{
  "job_id": "550e8400-...",
  "status": "completed",
  "pr_url": "https://github.com/owner/repo/pull/42",
  "total_cost": 0.0234,
  "total_tokens_in": 125000,
  "total_tokens_out": 8500,
  "iterations": 2,
  "tests_passed": true,
  "debug_mode": false,
  "resumed_from_checkpoint": false,
  "exploration_report_generated": true,
  "logs": ["..."]
}
```

## Local Development

### Running with Docker

```bash
# Clone and configure
git clone <repo-url>
cd running-agent
cp .env.example .env
# Edit .env with your GEMINI_API_KEY and GITHUB_TOKEN

# Start everything
docker compose up --build
```

### Running without Docker

```bash
# Without Docker (needs Python 3.12+ and Node.js 20+)
pip install -r requirements.txt
npm install
export GEMINI_API_KEY=... GITHUB_TOKEN=...
python api.py  # Starts uvicorn on port 8000
```

### Testing

```bash
# Submit a test task
curl -X POST http://localhost:8000/submit \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "https://github.com/you/test-repo.git", "task": "Add a hello world function"}'
```

## Web Dashboard

A React frontend for submitting tasks and monitoring agent jobs in real time.

```bash
cd dashboard
npm install
npm run dev
```

Open `http://localhost:5173` — you can submit tasks, watch status updates, view logs, and click through to the PR.

## API Endpoints

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/submit` | Submit a new agent task |
| `GET` | `/status/{job_id}` | Check task status |
| `GET` | `/result/{job_id}` | Get full result (PR URL, logs, error) |
| `GET` | `/jobs` | List all tasks |
| `GET` | `/health` | Health check |
| `WS` | `/ws/{job_id}` | WebSocket real-time job updates |

### Pipelines

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/pipelines` | Create a pipeline definition |
| `GET` | `/pipelines` | List all pipelines |
| `GET` | `/pipelines/{id}` | Get pipeline details |
| `DELETE` | `/pipelines/{id}` | Delete a pipeline |
| `POST` | `/pipelines/{id}/run` | Trigger a pipeline execution |
| `GET` | `/pipelines/{id}/runs` | List runs for a pipeline |
| `GET` | `/runs/{run_id}` | Get run details with step jobs |

### POST /submit

```json
{
  "repo_url": "https://github.com/owner/repo.git",
  "task": "What the agent should do",
  "github_token": "optional — overrides server default",
  "user_id": "optional — for audit tracking"
}
```

### POST /pipelines

```json
{
  "name": "Full CI Pipeline",
  "repo_url": "https://github.com/owner/repo.git",
  "steps": [
    { "name": "lint",  "task": "Run eslint and fix all errors" },
    { "name": "test",  "task": "Run all unit tests", "depends_on": ["lint"] },
    { "name": "pr",    "task": "Create a PR with all changes", "depends_on": ["test"] }
  ]
}
```

Steps support `depends_on` for DAG ordering, `on_failure: "stop" | "continue"` for error handling, and `{{steps.<name>.output.<key>}}` template variables for referencing upstream outputs.

## Project Structure

```
running_agent/
├── api.py              # HTTP API + pipeline endpoints + WebSocket
├── Dockerfile          # Container image (Python 3.12 + Node.js 20 + git + gh)
├── docker-compose.yml  # Single-command local deployment
├── shared.py           # Shared infrastructure (image, auth, agent runner)
├── models.py           # SQLite data models (jobs, pipelines, runs)
├── scheduler.py        # DAG scheduler + template resolution
├── src/
│   ├── index.ts        # Agent engine — OpenCode SDK + step context + structured output
│   ├── verify.ts       # Project detection + test/build execution + error extraction
│   ├── planner.ts      # Task decomposition prompts, plan parsing, diff formatting
│   ├── repomap.ts      # Repository structure map generator with annotations
│   └── context.ts      # Token estimation, context budgets, truncation, compaction
├── opencode.json       # LLM provider config (Gemini)
├── dashboard/          # React web UI
│   └── src/App.jsx     # Dashboard app with WebSocket support
└── package.json
```

## Architecture

**Phase 1 — Local Engine:** OpenCode SDK provides the agent with file read/write and bash execution tools, powered by Gemini.

**Phase 2 — Cloud Sandbox:** Modal runs the agent in an isolated container with Node.js, Python, Git, and GitHub CLI pre-installed.

**Phase 3 — Git PR Loop:** The agent creates branches, commits, pushes, and opens PRs autonomously via a structured system prompt.

**Phase 4 — HTTP API:** Modal web endpoints expose an async job queue with WebSocket real-time updates, error retry (3 attempts with exponential backoff), and SQLite-backed persistent storage.

**Phase 5 — Dashboard:** React frontend for visual task management with WebSocket live updates.

**Phase 6 — Workflow Engine:** Multi-step pipelines with DAG scheduling, step-to-step context passing, template variables, and failure handling.

**v0.7.1 — Reliability Improvements:** Critical bug fixes including proper resource cleanup (file descriptor leak fix), robust error handling (SDK operations wrapped in try-catch), accurate cost tracking (global state fix), and improved Python project detection.

**v0.8 — Advanced Agent Behaviors:**
- **Debug Agent Mode:** Detects repeated similar errors and switches to root-cause analysis mode
- **Explore Agent Mode:** Pre-planning codebase exploration for better context understanding
- **Session Persistence:** Checkpoint/resume capability for crash recovery

**v0.9 — Local Docker Execution:**
- Replaced Modal cloud sandbox with local Docker container
- Single container with Python 3.12 + Node.js 20 + git + gh
- FastAPI API server with asyncio-based job execution
- All existing features preserved (pipelines, WebSocket, dashboard)

## Key Features

### Multi-Agent Architecture

The system uses three specialized agents:

| Agent | Model | Purpose |
|-------|-------|---------|
| `explore` | `gemini-2.5-pro` | Codebase exploration and understanding (read-only) |
| `plan` | `gemini-2.5-pro` | Task decomposition and planning (read-only) |
| `build` | `gemini-3-flash-preview` | Code execution and modifications (full access) |

### Debug Mode

When the agent encounters repeated similar errors (detected via Jaccard similarity on normalized error text), it automatically switches to a debug-focused approach:
- Emphasizes root cause analysis over superficial fixes
- Provides error history context for better diagnosis
- Uses structured debugging methodology (Reproduce → Isolate → Hypothesize → Verify)

### Session Persistence

The agent saves checkpoints after each major phase (explore, plan, each verification iteration):
- Enables crash recovery and session resumption
- Preserves error history and debug mode state
- Skips already-completed phases on resume

## Tech Stack

- **Agent Engine:** [OpenCode SDK](https://github.com/nichochar/opencode) + TypeScript
- **LLM:** Google Gemini (via OpenCode)
- **Containers:** [Docker](https://www.docker.com/) (local containers)
- **API:** FastAPI + uvicorn
- **Frontend:** React + Vite
- **VCS:** Git + GitHub CLI (`gh`)

## License

MIT
