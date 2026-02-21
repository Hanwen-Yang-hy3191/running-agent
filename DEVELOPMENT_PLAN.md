# Running Agent — Development Plan & Technical Reference

> Last updated: 2026-02-21 (v0.8)
>
> This document covers everything a new contributor needs to understand, extend, and deploy the Running Agent system. It is the single source of truth for project status, architecture, and roadmap.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Completed Work — Phase-by-Phase](#3-completed-work--phase-by-phase)
4. [Current System Capabilities (v0.7)](#4-current-system-capabilities-v07)
5. [File Reference](#5-file-reference)
6. [Data Flow Walkthrough](#6-data-flow-walkthrough)
7. [Known Issues & Technical Debt](#7-known-issues--technical-debt)
8. [Future Roadmap](#8-future-roadmap)
9. [Development Setup](#9-development-setup)
10. [Deployment](#10-deployment)

---

## 1. Project Overview

Running Agent is an autonomous background coding agent. You give it a GitHub repository URL and a task description — it clones the repo in a cloud sandbox, understands the codebase, writes code, runs tests, and opens a Pull Request. No human in the loop.

**Core value proposition:** Developers submit coding tasks via HTTP API or web dashboard, and the agent handles everything end-to-end — from understanding the codebase structure to verifying the changes pass tests.

**Tech stack:**
- **Agent Engine:** TypeScript + [OpenCode SDK](https://github.com/nichochar/opencode) (`@opencode-ai/sdk ^1.2.9`)
- **LLM:** Google Gemini (plan agent: `gemini-2.5-pro`, build agent: `gemini-3-flash-preview`)
- **Cloud Sandbox:** [Modal](https://modal.com/) (serverless containers with Volume persistence)
- **API:** Python FastAPI on Modal
- **Database:** SQLite on Modal Volume
- **Frontend:** React + Vite (dashboard)

---

## 2. Architecture

### High-Level Flow

```
User / HTTP Client / Dashboard
  │  POST /submit { repo_url, task }
  ▼
Modal Cloud API (api.py / FastAPI)
  │  Creates job record → Spawns agent container
  ▼
Cloud Sandbox Container (sandbox_image)
  │  shared.py: auth → clone → install → run agent
  ▼
Agent Engine (src/index.ts)
  │  Phase 1: Boot OpenCode + configure agents
  │  Phase 2: Generate repo map + inject context
  │  Phase 3: Explore phase (codebase understanding)
  │  Phase 4: Plan agent decomposes task → subtasks
  │  Phase 5: Build agent executes subtasks (SubtaskPartInput)
  │  Phase 6: Verification loop (test/build, up to 5 iterations, with debug mode)
  │  Phase 7: Context summarization (if session is long)
  │  Phase 8: Final review → push → open PR
  ▼
step_result.json (written to disk)
  │  Contains: pr_url, iterations, verification status,
  │  cost, tokens, subtask count, plan reasoning
  ▼
shared.py reads step_result.json → returns to api.py
  │  api.py extracts metrics → persists to SQLite
  ▼
GitHub Pull Request
```

### Multi-Agent Routing

The OpenCode SDK is configured with multiple agents:

| Agent | Model | Role | Permissions |
|-------|-------|------|-------------|
| `plan` | `gemini-2.5-pro` | Read-only analysis and task decomposition | No file writes |
| `build` | `gemini-3-flash-preview` | Full code editing, bash, git | Read + write + bash |
| `explore` | `gemini-2.5-pro` | Codebase exploration and understanding | No file writes |

The engine orchestrates these sequentially: explore → plan → build.

### Pipeline Architecture

For multi-step workflows, the system supports DAG-based pipelines:

```
Pipeline Definition (steps with depends_on)
  │  POST /pipelines → stored in DB
  │  POST /pipelines/{id}/run → spawns orchestrator
  ▼
Pipeline Orchestrator (run_pipeline_task)
  │  Topological sort → layer-by-layer execution
  │  Shared workspace volume between steps
  ▼
Step 1 (run_pipeline_step) → clone repo → agent work → commit to volume
  ▼
Step 2 (run_pipeline_step) → reuse workspace → agent work → commit
  ▼ ...
Step N → final output
```

---

## 3. Completed Work — Phase-by-Phase

### Original Platform Build (Phases 1-6)

These phases established the core platform before the agent improvement pipeline began.

| Phase | What | Key Files |
|-------|------|-----------|
| 1. Local Engine | OpenCode SDK integration, agent with file/bash tools | `src/index.ts`, `opencode.json` |
| 2. Cloud Sandbox | Modal container with Node.js, Git, GitHub CLI | `shared.py` (sandbox_image) |
| 3. Git PR Loop | Autonomous branch → commit → push → PR workflow | `src/index.ts` (system prompts) |
| 4. HTTP API | Async job queue, WebSocket updates, retry logic | `api.py`, `models.py` |
| 5. Dashboard | React frontend with real-time WebSocket updates | `dashboard/` |
| 6. Workflow Engine | Multi-step pipelines with DAG scheduling | `api.py`, `scheduler.py` |

### Agent Improvement Pipeline (v0.4 – v0.7)

These phases enhanced the agent's intelligence and reliability:

#### Phase 1 (v0.4): Inner Loop — Verification Feedback

**Goal:** Agent should verify its own work by running tests/build and self-correcting.

**Changes:**
- `src/verify.ts` (NEW, 218 lines) — Auto-detects project type (Node.js, Python, Rust, Go, Makefile) and runs appropriate test/build commands. Extracts structured error summaries for the agent.
- `src/index.ts` — Verification loop (up to `MAX_ITERATIONS=5`). After build agent finishes, engine runs verification. If it fails, sends error output back to agent with fix instructions. Repeats until pass or max attempts.
- `models.py` — Migration: `iterations INTEGER`, `tests_passed INTEGER` columns on jobs table.

**Key design decisions:**
- Verification runs **outside** the agent (engine-driven), not inside the agent session. This prevents the agent from skipping or faking test runs.
- Error summary extraction filters output for lines matching error patterns, keeping context compact.
- `execSync` is used (blocks event loop) — acceptable for sandbox containers. See Known Issues #4 for async alternative.

#### Phase 2 (v0.5): Repo Map — Structural Context

**Goal:** Give the agent a map of the repository so it can navigate precisely instead of exploring with `ls`/`find`.

**Changes:**
- `src/repomap.ts` (NEW, 451 lines) — Walks the directory tree (max depth 5, max 300 entries), extracts one-line summaries from leading comments/docstrings, builds internal dependency graph from import statements, identifies key files (READMEs, configs, entry points, test directories).
- `src/index.ts` — Injects repo map via `session.prompt({ noReply: true })` before any task execution. The agent sees the full project structure in its context.

**Key design decisions:**
- Budget-aware: `maxChars` parameter controls repo map size. Truncates if it exceeds the budget.
- Summary extraction reads only first 2KB of each file — fast enough for large repos.
- Dependency graph shows `file → [local imports]` relationships (first 50 source files).
- `noReply: true` means the agent doesn't respond to the repo map injection — it just absorbs it as context.

#### Phase 3 (v0.6): Task Decomposition — Multi-Subtask Planning

**Goal:** Complex tasks should be broken into subtasks by a planning agent, then executed by the build agent.

**Changes:**
- `src/planner.ts` (NEW, 153 lines) — Planning prompt builder, JSON plan parser, text extraction, diff summary formatter. Exports `buildPlanningPrompt()`, `parsePlan()`, `extractTextFromParts()`, `formatDiffSummary()`.
- `src/index.ts` — Full SDK integration:
  - Per-prompt `agent` and `system` overrides (plan vs build)
  - `SubtaskPartInput` for dispatching multiple subtasks to build agent
  - `session.diff()` for structured diff retrieval
  - Graceful fallback if plan parsing fails (single-task mode)
- `models.py` — Migration: `subtasks_count INTEGER` column.

**Key design decisions:**
- Plan agent uses `gemini-2.5-pro` (stronger reasoning) with read-only system prompt.
- Build agent uses `gemini-3-flash-preview` (faster, cheaper) with full access.
- Plan parsing uses regex to find JSON in fenced code blocks. See Known Issues #5 for structured output alternative.
- `SubtaskPartInput` delegates orchestration to the SDK server. See Known Issues #6 about verifying orchestration behavior.

#### Phase 4 (v0.7): Smart Context + Workspace Persistence + Cost Tracking

**Goal:** Manage context window intelligently, persist workspaces between pipeline steps, and track costs.

**Changes across three sub-features:**

##### 4a. Cost & Token Tracking

- `src/index.ts` — Accumulators (`totalCost`, `totalTokensIn`, `totalTokensOut`, `totalCacheRead`) updated in the `step-finish` event handler. Written to `step_result.json`.
- `models.py` — Migration: `total_cost REAL`, `total_tokens_in INTEGER`, `total_tokens_out INTEGER` columns.
- `api.py` — Both `run_agent_task` and `run_pipeline_step` extract cost metrics from `step_output` and persist via `update_job()`.

**Data flow:** SDK `step-finish` event → accumulators in index.ts → `step_result.json` → `shared.py` reads it → `api.py` extracts and writes to DB.

##### 4b. Smart Context Management

- `src/context.ts` (NEW, 122 lines) — Token estimation (`char/4` heuristic), context budget calculation, verification output truncation (40% head + 50% tail), repo map budget (5% of context), compaction config builder.
- `src/index.ts` — Integrated:
  - `buildCompactionConfig()` → passed to `createOpencode()` config
  - `repoMapBudget()` → controls repo map character limit
  - `calculateBudget()` → logs context window utilization
  - `truncateVerificationOutput()` → keeps error feedback compact
  - `session.summarize()` → compresses context after long sessions (2+ iterations or 3+ subtasks)

##### 4c. Workspace Persistence for Pipelines

- `shared.py` — `workspace_volume` (Modal Volume `agent-workspaces`), `clone_and_install` accepts `skip_clone` param (reuses workspace, does `git fetch --all`), `run_agent` accepts `workspace` param (sets `WORKSPACE` env var).
- `api.py` — `run_pipeline_step` mounts workspace volume, accepts `workspace_path` and `skip_clone` params, calls `workspace_volume.reload()` before and `workspace_volume.commit()` after. `_execute_pipeline_steps` uses shared workspace path `/workspaces/{run_id}`, first step clones, subsequent steps reuse.
- `src/index.ts` — `WORKSPACE` is now configurable via `process.env.WORKSPACE`.

#### Phase 5 (v0.8): Debug Agent + Explore Agent + Session Persistence

**Goal:** Make the agent smarter with specialized behavior modes and crash recovery.

**Changes across three sub-features:**

##### 5a. Debug Agent Mode

- `src/index.ts` — Error normalization (`normalizeError()`), Jaccard similarity calculation (`calculateJaccardSimilarity()`), repeated error detection (`isRepeatedError()`). When verification fails with a similar error to previous attempts (≥0.7 similarity), switch to debug mode.
- `src/index.ts` — `DEBUG_SYSTEM_PROMPT` constant for debugging-focused system prompt. Uses `buildDebugPrompt()` to generate detailed feedback with error history context.
- `shared.py` — `DEBUG_SYSTEM_PROMPT` and `EXPLORE_SYSTEM_PROMPT` constants for Python-side reference.

**Logic flow:** After each verification failure, normalize the error and compare against history. If similarity threshold exceeded, activate debug mode. Subsequent prompts use debug system prompt emphasizing root cause analysis over superficial fixes.

##### 5b. Explore Agent Mode

- `src/index.ts` — `EXPLORE_SYSTEM_PROMPT` constant for exploration-focused system prompt. `buildExplorePrompt()` generates task-specific exploration prompts.
- `src/index.ts` — Explore phase runs between repo map injection and planning. Produces an exploration report that's passed to the plan agent for better context.
- Checkpoint tracks `completedPhases: ["explore", "plan", ...]` to avoid re-running on resume.

**Logic flow:** After injecting repo map, prompt the explore agent to analyze codebase structure, identify key components, understand data flow. Report is included in planning context for better task decomposition.

##### 5c. Session Persistence / Resume

- `src/index.ts` — `Checkpoint` interface tracks: sessionId, task, workspace, attempt, debugMode, errorHistory, completedPhases, costTracking, explorationReport, plan.
- `saveCheckpoint()`, `loadCheckpoint()`, `clearCheckpoint()` functions for checkpoint file management (`checkpoint.json` in workspace).
- Main loop checks for existing checkpoint on startup. If found, resumes from saved state (skips completed phases, restores error history, continues from last attempt).
- Checkpoint saved after: explore phase, plan phase, each verification iteration.
- Checkpoint cleared on successful task completion.

**Data flow:**

```
main() startup
  → loadCheckpoint(workspace)
  → if checkpoint exists:
      → restore debugMode, errorHistory, completedPhases, explorationReport, plan
      → startAttempt = checkpoint.attempt + 1
  → run phases, skip if already completed
  → saveCheckpoint() after each major phase
  → on success: clearCheckpoint(workspace)
```

---

## 4. Current System Capabilities (v0.8)

### Standalone Task Execution
- Accept task via HTTP → clone repo → generate repo map → **explore codebase** → plan subtasks → execute with build agent → verification loop → push + PR
- Automatic retry (3 attempts with exponential backoff)
- Real-time WebSocket updates
- Cost and token tracking per job

### Pipeline Execution
- Define multi-step pipelines with DAG dependencies
- Steps share a persistent workspace (no re-cloning)
- Upstream output templating: `{{steps.lint.output.error_count}}`
- Per-step failure handling: `stop` or `continue`

### Agent Intelligence
- **Three-agent architecture** (explore + plan + build) with different models
- Repo map for precise file navigation
- Task decomposition for complex tasks
- Verification inner loop (test/build, up to 5 iterations)
- **Debug mode** activated on repeated similar errors (root cause analysis)
- **Explore phase** for better codebase understanding before planning
- **Session persistence** with checkpoint/resume for crash recovery
- Smart context management (budget tracking, truncation, compaction, summarization)

### Observability
- Structured step results: iterations, verification status, cost, tokens, subtask count, **debug mode status**, **checkpoint resume status**
- Log accumulation across attempts
- WebSocket streaming for real-time monitoring
- Dashboard UI for visual management

---

## 5. File Reference

### TypeScript Agent Engine (`src/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | ~1000 | Main orchestrator — lifecycle management, event handling, agent coordination, debug mode, explore phase, checkpoint persistence |
| `src/verify.ts` | 218 | Project detection + test/build execution + error extraction |
| `src/repomap.ts` | 451 | Repository structure map generator with annotations and dependency graph |
| `src/planner.ts` | 153 | Task decomposition prompts, plan parsing, diff formatting |
| `src/context.ts` | 122 | Token estimation, context budgets, truncation, compaction config |

### Python Backend

| File | Lines | Purpose |
|------|-------|---------|
| `api.py` | 821 | FastAPI HTTP API, pipeline orchestrator, WebSocket |
| `shared.py` | 225 | Container image, GitHub auth, clone/install, agent runner |
| `models.py` | 358 | SQLite schema, migrations, CRUD for jobs/pipelines/runs |
| `scheduler.py` | 108 | DAG validation, topological sort (Kahn's), template resolution |

### Configuration

| File | Purpose |
|------|---------|
| `opencode.json` | OpenCode SDK provider config (Gemini, API key from env) |
| `package.json` | Node.js deps: `@opencode-ai/sdk ^1.2.9`, tsx, typescript |
| `tsconfig.json` | TypeScript config: ES2022, nodenext modules, strict mode |

---

## 6. Data Flow Walkthrough

### Standalone Task: End-to-End

```
1. User → POST /submit { repo_url, task }
2. api.py:ep_submit()
   → create_job(job_id, repo_url, task)
   → db_volume.commit()
   → run_agent_task.spawn(job_id, repo_url, task, github_token)

3. run_agent_task() [Modal container]
   → db_volume.reload()
   → update_job(status="running")
   → setup_github_auth(token)
   → clone_and_install(repo_url)     # git clone + npm install + opencode install
   → run_agent(task)                  # → npm run dev → tsx src/index.ts

4. src/index.ts [Agent Engine]
   → loadCheckpoint(WORKSPACE)  # Check for existing session to resume
   → createOpencode({ config: { model, compaction, agent: { plan, build, explore } } })
   → session.create({ directory: WORKSPACE })
   → generateRepoMap(WORKSPACE, repoMapBudget())
   → session.prompt({ noReply: true, parts: [repoMap] })
   → session.prompt({ agent: "plan", system: EXPLORE_SYSTEM_PROMPT, parts: [explorePrompt] })  # Explore phase
   → saveCheckpoint({ ..., completedPhases: ["explore"], explorationReport })
   → session.prompt({ agent: "plan", system: PLAN_SYSTEM_PROMPT, parts: [planningPrompt + explorationReport] })
   → parsePlan(response) → subtasks[]
   → saveCheckpoint({ ..., completedPhases: ["explore", "plan"], plan })
   → session.prompt({ agent: "build", system: BUILD_SYSTEM_PROMPT, parts: [subtaskParts] })
   → for (i = startAttempt..MAX_VERIFICATION_ATTEMPTS) {
       runVerification(WORKSPACE)
       if passed → break
       if isRepeatedError(error, errorHistory):
         debugMode = true  # Switch to debug mode
       errorHistory.push({ normalizedError, attempt })
       prompt = debugMode ? buildDebugPrompt(...) : buildVerificationFailedPrompt(...)
       session.prompt({ agent: "build", system: debugMode ? DEBUG_SYSTEM_PROMPT : undefined, parts: [prompt] })
       saveCheckpoint({ ..., attempt: i, debugMode, errorHistory })
     }
   → session.summarize() (if long session)
   → session.diff() → formatDiffSummary()
   → session.prompt({ agent: "build", parts: [finalReviewPrompt] })  # push + PR
   → session.messages() → extract PR URL
   → fs.writeFileSync("step_result.json", { pr_url, iterations, cost, tokens, debug_mode, ... })
   → clearCheckpoint(WORKSPACE)  # Clean up on success

5. shared.py:run_agent()
   → reads step_result.json → returns { stdout, stderr, exit_code, pr_url, log_lines, step_output }

6. api.py:run_agent_task()
   → extracts metrics from step_output
   → update_job(status="completed", total_cost=..., total_tokens_in=..., ...)
   → db_volume.commit()
```

### Pipeline: Step-to-Step

```
1. POST /pipelines/{id}/run → create_pipeline_run → run_pipeline_task.spawn()

2. run_pipeline_task() [Modal container]
   → _execute_pipeline_steps(run_id, pipeline_id, repo_url, steps, github_token)

3. _execute_pipeline_steps()
   → topological_sort(steps) → layers (e.g. [[lint], [test, docs], [pr]])
   → run_workspace = "/workspaces/{run_id}"
   → is_first_step = True
   → for layer in layers:
       for step_name in layer:
         → resolve_templates(step.task, step_outputs)
         → run_pipeline_step.remote(
             job_id, repo_url, task, step_context,
             workspace_path=run_workspace,
             skip_clone=not is_first_step,
           )
         → is_first_step = False
         → step_outputs[step_name] = result

4. run_pipeline_step() [separate Modal container]
   → workspace_volume.reload()              # see previous step's files
   → clone_and_install(workspace=..., skip_clone=True)  # reuse workspace, npm install
   → run_agent(task, step_context=..., workspace=...)
   → workspace_volume.commit()              # persist changes for next step
```

---

## 7. Known Issues & Technical Debt

> Tracked in `.context/improvements.md`

### Resolved (v0.7.1)

| # | Issue | File(s) | Resolution |
|---|-------|---------|------------|
| - | **Global state not reset on retry**: `totalCost`, `totalTokensIn`, `totalTokensOut`, `totalCacheRead` were module-level globals, causing incorrect accumulation across retries. | `src/index.ts` | Introduced `CostTracker` interface, initialized inside `main()` for each invocation. |
| - | **Logs lost on retry**: `all_logs` was re-initialized as empty on each retry attempt, losing previous logs. | `api.py` | Fetch existing logs from job record before starting new attempt. |
| - | **PR URL extraction might find wrong URL**: Regex matched any GitHub PR URL in conversation history. | `src/index.ts` | Only extract PR URL from the last assistant message. |
| - | **File descriptor leak**: `fs.openSync` without `try-finally` could leak FDs if `fs.readSync` threw. | `src/repomap.ts` | Added `finally` block to ensure `fs.closeSync` is always called. |
| - | **Python test detection incomplete**: Only checked for `tests/` directory, missed `test_*.py` files. | `src/verify.ts` | Added `hasPythonTestFiles()` to recursively detect Python test files. |
| - | **Template resolution for complex types**: Dicts/lists were converted to Python `str()` instead of JSON. | `scheduler.py` | Check `isinstance(value, (dict, list))` and use `json.dumps()`. |
| - | **Plan Agent failure without warning**: Silent fallback to single-task mode when plan parsing failed. | `src/index.ts` | Added `log("ENGINE:WARN", ...)` for visibility. |
| - | **SDK operations lack error handling**: Critical SDK calls could crash without writing `step_result.json`. | `src/index.ts` | Wrapped SDK calls in `try-catch`, added `fatalError` tracking. |
| - | **Empty fields causes SQL error**: `update_job()` with empty `fields` dict generated invalid SQL. | `models.py` | Early return if `fields` is empty. |
| - | **Pipeline workspace nonexistent**: `skip_clone=True` but workspace didn't exist caused unclear errors. | `api.py` | Added explicit check with clear `RuntimeError` message. |

### Open

| # | Issue | File(s) | Priority |
|---|-------|---------|----------|
| 1 | **Fallback verification for unknown projects**: `verify.ts` returns `null` for unrecognized projects, skipping the loop entirely. Should add git-diff-based self-review fallback. | `src/verify.ts`, `src/index.ts` | Medium |
| 2 | **Lint command detection**: verify.ts detects test/build but not lint (eslint, ruff, clippy). Many projects have lint but no tests. | `src/verify.ts` | Medium |
| 4 | **execSync blocks event loop**: verify.ts uses synchronous execution. Convert to async `execFile` when real-time streaming is needed. | `src/verify.ts` | Low |
| 5 | **Text-based JSON plan parsing**: planner.ts uses regex extraction. Switch to structured output (`format: { type: "json_schema" }`) when SDK supports it. | `src/planner.ts` | Low |
| 6 | **SubtaskPartInput behavior unverified**: SDK types define it but server-side behavior (sequential vs parallel, error handling) hasn't been verified in production. Fallback: manual per-subtask prompting. | `src/index.ts` | Medium |
| 7 | **session.diff() error handling**: Wrapped in try/catch with fallback. If SDK consistently returns diffs, remove the fallback path. | `src/index.ts` | Low |
| 8 | **Pipeline workspace cleanup**: After pipeline completion, `/workspaces/{run_id}` is not cleaned up from the workspace volume. Needs cleanup step or periodic garbage collection. | `api.py` | Medium |
| 9 | **Parallel pipeline step execution**: Same-layer steps run sequentially. True parallelism needs `run_pipeline_step.spawn()` + `await all` + workspace conflict handling. | `api.py` | Low |

---

## 8. Future Roadmap

### Phase 6 (v0.9): External Integration + Human-in-the-Loop

**Goal:** Connect the agent to external systems and allow human oversight at critical points.

#### 6a. GitHub Webhook Integration

Trigger agent tasks from GitHub events:
- New issue with label `agent` → auto-submit task
- PR review comment with `/agent fix` → run fix task on the PR branch
- Push to branch → run verification pipeline

**Implementation guide:**
1. Add a `/webhook/github` endpoint in `api.py` that validates GitHub webhook signatures.
2. Parse event types (`issues.labeled`, `pull_request_review_comment.created`, `push`).
3. Map events to task submissions with appropriate context.
4. Store webhook config (which repos, which labels, which branches) in a new `webhooks` DB table.

**Files to modify:** `api.py` (new webhook endpoint), `models.py` (webhook config table)

#### 6b. Approval Gates

Pipeline steps can require human approval before proceeding:
- Step definition: `{ "name": "deploy", "task": "...", "requires_approval": true }`
- When the orchestrator reaches an approval gate, pause execution and notify via webhook/WebSocket.
- Resume when the user approves via API: `POST /runs/{run_id}/approve/{step_name}`

**Implementation guide:**
1. In `_execute_pipeline_steps`, check `step_def.get("requires_approval")`.
2. If true, update job status to `"awaiting_approval"` and pause the loop.
3. Add a `/runs/{run_id}/approve/{step_name}` endpoint that sets a flag in the DB.
4. The orchestrator polls for approval (or use Modal's `Function.get()` with a completion signal).
5. Requires rethinking the sequential execution model — consider using Modal's `spawn()` + `get()` pattern.

**Files to modify:** `api.py` (approval endpoint + orchestrator changes), `models.py` (approval status fields)

#### 6c. Conditional Steps

Steps that execute based on conditions from upstream outputs:
- `{ "name": "fix-lint", "task": "...", "condition": "{{steps.lint.output.error_count}} > 0" }`
- Simple expression evaluator for numeric/string comparisons.

**Implementation guide:**
1. In `_execute_pipeline_steps`, evaluate `step_def.get("condition")` using `resolve_templates` first.
2. Implement a safe expression evaluator (no `eval`) — support `>`, `<`, `==`, `!=` for numbers and strings.
3. If condition is false, skip the step and set status to `"skipped"`.

**Files to modify:** `api.py` (condition evaluation), `scheduler.py` (condition in step schema validation)

---

### Phase 7 (v1.0): Production Hardening + Agent Memory

**Goal:** Make the system production-ready with proper authentication, scalability, and agent learning.

#### 7a. PostgreSQL Migration

SQLite on a Modal Volume works for development but has write concurrency limits. Migrate to PostgreSQL for production:
- Use Modal's `CloudSQLDatabase` or a managed Postgres (Neon, Supabase, etc.)
- Replace the `get_db()` context manager with a connection pool (asyncpg or psycopg3)
- Schema migration tool (Alembic)

**Implementation guide:**
1. Add `DATABASE_URL` environment variable support.
2. Create an `alembic/` directory with migration scripts.
3. Replace `sqlite3` calls with asyncpg (for async endpoints) or psycopg3 (for sync functions).
4. Keep SQLite as a fallback for local development.

**Files to modify:** `models.py` (full rewrite of DB layer), `api.py` (async DB calls)

#### 7b. API Authentication

Add JWT-based authentication:
- `POST /auth/login` → returns JWT token
- All other endpoints require `Authorization: Bearer <token>` header
- Role-based access: `admin` (manage pipelines, view all jobs), `user` (submit tasks, view own jobs)

**Implementation guide:**
1. Add `pyjwt` dependency to the API image.
2. Create a `users` table in the DB.
3. Add FastAPI middleware that validates JWT on all endpoints except `/health` and `/auth/*`.
4. Include `user_id` from JWT in all DB operations.

**Files to modify:** `api.py` (auth middleware + endpoints), `models.py` (users table)

#### 7c. Multi-Tenancy

Isolate resources by team/organization:
- Each tenant has their own pipelines, jobs, and secrets
- Tenant ID in all DB queries
- Rate limiting per tenant

**Implementation guide:**
1. Add `tenant_id` column to all tables.
2. Include tenant context in all CRUD functions.
3. Rate limiting via a token bucket stored in Redis or in-memory.

**Files to modify:** `models.py` (tenant_id everywhere), `api.py` (tenant extraction from JWT)

#### 7d. Vector Store Memory

Give the agent long-term memory across tasks on the same repository:
- After each successful task, extract key learnings (patterns, conventions, gotchas)
- Store as embeddings in a vector database (Pinecone, ChromaDB, or pgvector)
- Before each new task, retrieve relevant memories and inject into context

**Implementation guide:**
1. After successful PR creation, prompt the agent: "Summarize the key patterns and conventions you learned about this codebase."
2. Store the summary with metadata (repo_url, timestamp, task type) in a vector store.
3. Before planning phase in `src/index.ts`, query the vector store for memories related to the current repo.
4. Inject relevant memories alongside the repo map.

**Files to modify:** `src/index.ts` (memory retrieval + injection), new `src/memory.ts` (vector store client), `api.py` or `shared.py` (memory storage after task completion)

---

## 9. Development Setup

### Prerequisites

- Node.js >= 20
- Python 3.11+
- Modal CLI (`pip install modal`)
- Gemini API key
- GitHub personal access token (repo scope)

### Local Development

```bash
# Clone the repository
git clone <repo-url>
cd running-agent

# Install Node.js dependencies
npm install

# TypeScript compilation check
npx tsc --noEmit

# Run the agent engine locally (needs GEMINI_API_KEY, TASK_DESCRIPTION, WORKSPACE env vars)
GEMINI_API_KEY=... TASK_DESCRIPTION="..." WORKSPACE=/path/to/repo npm run dev
```

### Modal Secrets (One-Time)

```bash
modal secret create gemini-key GEMINI_API_KEY=your_key
modal secret create github-token GITHUB_TOKEN=your_token
```

### Testing Changes

1. **TypeScript changes** (`src/*.ts`): Run `npx tsc --noEmit` to verify compilation.
2. **Python changes** (`api.py`, `shared.py`, `models.py`, `scheduler.py`): Deploy with `modal serve api.py` for ephemeral testing.
3. **Full integration test**: Use `modal serve api.py`, then submit a task via curl to a test repository.

### Project Conventions

- TypeScript for the agent engine, Python for the API/infra layer.
- All code, comments, and documentation in English.
- Migrations in `models.py` are additive and idempotent (`_add_column` checks existence first).
- Modal Volumes are committed after writes and reloaded before reads to ensure consistency across containers.
- The agent engine communicates results via `step_result.json` (filesystem IPC between Node.js and Python).

---

## 10. Deployment

### Deploy to Modal

```bash
modal deploy api.py
```

This creates:
- A permanent ASGI endpoint: `https://<username>--agent-api-api.modal.run`
- Background functions: `run_agent_task`, `run_pipeline_step`, `run_pipeline_task`
- Two Modal Volumes: `agent-db` (SQLite), `agent-workspaces` (pipeline workspaces)

### Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `GEMINI_API_KEY` | Modal secret `gemini-key` | Gemini LLM access |
| `GITHUB_TOKEN` | Modal secret `github-token` | Git auth + PR creation |
| `TASK_DESCRIPTION` | Set by `shared.py` at runtime | Task for the agent |
| `WORKSPACE` | Set by `shared.py` at runtime | Path to cloned repo |
| `STEP_CONTEXT` | Set by `shared.py` for pipeline steps | Upstream step outputs |

### Container Image

Defined in `shared.py:sandbox_image`:
- Base: Debian slim
- Installed: Git, curl, Python3, Node.js 20, GitHub CLI, FastAPI
- Working directory: `/app` (agent code copied here)
- The agent engine + OpenCode SDK are installed at runtime via `npm install` in `clone_and_install()`.

### Monitoring

- **Job status**: `GET /status/{job_id}` or `GET /result/{job_id}`
- **WebSocket live updates**: `ws://.../ws/{job_id}`
- **Pipeline run status**: `GET /runs/{run_id}` (includes all step jobs)
- **Dashboard**: `cd dashboard && npm run dev` (or deploy as static site)
- **Cost tracking**: Available in job results (`total_cost`, `total_tokens_in`, `total_tokens_out`)

---

## Appendix: SDK Reference (Key APIs Used)

```typescript
// Create server with agent configs + compaction
const { client, server } = await createOpencode({
  hostname: "127.0.0.1",
  port: 0,
  config: {
    model: "google/gemini-3-flash-preview",
    compaction: { auto: true, prune: true, reserved: 150000 },
    agent: {
      plan: { model: "google/gemini-2.5-pro" },
      build: { model: "google/gemini-3-flash-preview" },
      explore: { model: "google/gemini-2.5-pro" },
    },
  },
});

// Create session in workspace directory
const { data: session } = await client.session.create({
  query: { directory: WORKSPACE },
});

// Inject context without agent response
await client.session.prompt({
  path: { id: session.id },
  body: { noReply: true, parts: [{ type: "text", text: "..." }] },
});

// Explore phase (v0.8) - read-only codebase exploration
await client.session.prompt({
  path: { id: session.id },
  body: {
    agent: "plan",
    system: EXPLORE_SYSTEM_PROMPT,
    parts: [{ type: "text", text: buildExplorePrompt(task) }],
  },
});

// Per-prompt agent and system override
await client.session.prompt({
  path: { id: session.id },
  body: {
    agent: "plan",
    system: PLAN_SYSTEM_PROMPT,
    parts: [{ type: "text", text: "..." }],
  },
});

// Dispatch subtasks via SubtaskPartInput
await client.session.prompt({
  path: { id: session.id },
  body: {
    agent: "build",
    system: BUILD_SYSTEM_PROMPT,
    parts: subtasks.map(st => ({
      type: "subtask",
      prompt: st.task,
      description: st.name,
      agent: "build",
    })),
  },
});

// Debug mode prompt (v0.8) - when repeated errors detected
await client.session.prompt({
  path: { id: session.id },
  body: {
    agent: "build",
    system: DEBUG_SYSTEM_PROMPT,
    parts: [{ type: "text", text: buildDebugPrompt(result, iteration, maxIter, errorHistory) }],
  },
});

// Context compression
await client.session.summarize({ sessionID: session.id, auto: true });

// Structured diff
const { data: diffs } = await client.session.diff({ path: { id: session.id } });

// Message history
const { data: messages } = await client.session.messages({ path: { id: session.id } });

// Event stream subscription
const { stream } = await client.event.subscribe();
for await (const event of stream) {
  // event.type: "message.part.updated" | "session.status" | "session.idle" | "session.error" | "file.edited"
  // event.properties.part.type: "text" | "reasoning" | "tool" | "step-start" | "step-finish"
}

// Checkpoint persistence (v0.8)
interface Checkpoint {
  sessionId: string;
  task: string;
  workspace: string;
  attempt: number;
  debugMode: boolean;
  errorHistory: ErrorSignature[];
  completedPhases: string[];
  costTracking: CostTracker;
  explorationReport: string | null;
  plan: TaskPlan | null;
}
// Save to workspace/checkpoint.json after each major phase
// Load on startup to resume from crash
// Clear on successful completion
```
