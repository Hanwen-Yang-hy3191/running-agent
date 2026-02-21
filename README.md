# Running Agent

An autonomous background coding agent that takes a GitHub repo and a task description, writes code in a cloud sandbox, and opens a Pull Request — all without human intervention.

Inspired by the [Ramp background agent architecture](https://builders.ramp.com/post/why-we-built-our-background-agent).

## How It Works

```
You (or any HTTP client)
  │  POST /submit { repo_url, task }
  ▼
Modal Cloud API (api.py)
  │  Spawns async agent task
  ▼
Cloud Sandbox (Node.js + OpenCode SDK)
  │  Clones repo → Reads code → Writes changes
  │  Creates branch → Commits → Pushes → Opens PR
  ▼
GitHub Pull Request
```

1. You submit a task via HTTP (or the web dashboard)
2. The agent spins up in a Modal cloud sandbox with Node.js, Git, and GitHub CLI
3. It uses the OpenCode SDK (powered by Gemini) to understand the codebase, write code, and run commands
4. It creates a branch, commits changes, pushes, and opens a PR
5. You poll for status or watch the dashboard — the PR URL appears when done

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Modal](https://modal.com/) account and CLI (`pip install modal`)
- A [Gemini API key](https://ai.google.dev/)
- A [GitHub personal access token](https://github.com/settings/tokens) with `repo` scope

### 1. Store secrets in Modal (one-time setup)

```bash
modal secret create gemini-key GEMINI_API_KEY=your_gemini_key
modal secret create github-token GITHUB_TOKEN=your_github_token
```

### 2. Deploy the API

```bash
modal deploy api.py
```

This gives you a permanent public URL like `https://your-name--agent-api-api.modal.run`.

### 3. Submit a task

```bash
curl -X POST https://your-name--agent-api-api.modal.run/submit \
  -H "Content-Type: application/json" \
  -d '{
    "repo_url": "https://github.com/you/your-repo.git",
    "task": "Add unit tests for the utils module"
  }'
```

Response:
```json
{ "job_id": "550e8400-...", "status": "queued" }
```

### 4. Check status

```bash
curl https://your-name--agent-api-api.modal.run/status/JOB_ID
```

### 5. Get the result

```bash
curl https://your-name--agent-api-api.modal.run/result/JOB_ID
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

### Running Locally

```bash
# Clone the repository
git clone <repo-url>
cd running-agent

# Install Node.js dependencies
npm install

# TypeScript compilation check
npx tsc --noEmit

# Run the agent engine locally (needs env vars)
GEMINI_API_KEY=... TASK_DESCRIPTION="..." WORKSPACE=/path/to/repo npm run dev
```

### Testing API Changes

```bash
# Deploy ephemeral version for testing
modal serve api.py

# Submit a test task
curl -X POST http://localhost:.../submit \
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
├── sandbox.py          # CLI-triggered cloud execution
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
- **Cloud Sandbox:** [Modal](https://modal.com/) (serverless containers)
- **API:** FastAPI on Modal
- **Frontend:** React + Vite
- **VCS:** Git + GitHub CLI (`gh`)

## License

MIT
