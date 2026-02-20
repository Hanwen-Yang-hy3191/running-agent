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

Response includes the PR URL, logs, and timing info.

## Web Dashboard

A React frontend for submitting tasks and monitoring agent jobs in real time.

```bash
cd dashboard
npm install
npm run dev
```

Open `http://localhost:5173` — you can submit tasks, watch status updates, view logs, and click through to the PR.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/submit` | Submit a new agent task |
| `GET` | `/status/{job_id}` | Check task status |
| `GET` | `/result/{job_id}` | Get full result (PR URL, logs, error) |
| `GET` | `/jobs` | List all tasks |
| `GET` | `/health` | Health check |

### POST /submit

```json
{
  "repo_url": "https://github.com/owner/repo.git",
  "task": "What the agent should do",
  "github_token": "optional — overrides server default",
  "user_id": "optional — for audit tracking"
}
```

## Project Structure

```
running_agent/
├── api.py              # Phase 4 — HTTP API + async job management
├── sandbox.py          # Phase 2/3 — CLI-triggered cloud execution
├── src/
│   └── index.ts        # Agent engine — OpenCode SDK + Git PR workflow
├── opencode.json       # LLM provider config (Gemini)
├── dashboard/          # React web UI
│   └── src/App.jsx     # Single-file dashboard app
└── package.json
```

## Architecture

**Phase 1 — Local Engine:** OpenCode SDK provides the agent with file read/write and bash execution tools, powered by Gemini.

**Phase 2 — Cloud Sandbox:** Modal runs the agent in an isolated container with Node.js, Python, Git, and GitHub CLI pre-installed.

**Phase 3 — Git PR Loop:** The agent creates branches, commits, pushes, and opens PRs autonomously via a structured system prompt.

**Phase 4 — HTTP API:** Modal web endpoints expose an async job queue. Submit tasks via HTTP, poll for status, get results. State persists in Modal Dict.

**Phase 5 — Dashboard:** React frontend for visual task management (current).

## Tech Stack

- **Agent Engine:** [OpenCode SDK](https://github.com/nichochar/opencode) + TypeScript
- **LLM:** Google Gemini (via OpenCode)
- **Cloud Sandbox:** [Modal](https://modal.com/) (serverless containers)
- **API:** FastAPI on Modal
- **Frontend:** React + Vite
- **VCS:** Git + GitHub CLI (`gh`)

## License

MIT
