"""
Shared infrastructure for the Background Coding Agent.

Centralises GitHub/Git authentication, dependency installation,
and agent execution logic so that both sandbox.py (CLI) and
api.py (HTTP API) stay thin wrappers.
"""

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# 1. Configurable Paths
# ---------------------------------------------------------------------------

APP_DIR = os.environ.get("APP_DIR", str(Path(__file__).parent.resolve()))
STEP_RESULT_PATH = os.path.join(APP_DIR, "step_result.json")
WORKSPACES_DIR = os.environ.get("WORKSPACES_DIR", "/workspaces")
DEFAULT_WORKSPACE = os.path.join(APP_DIR, "workspace")


# ---------------------------------------------------------------------------
# 1c. System Prompts for Specialized Agent Modes (Phase 5)
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
# 2. GitHub + Git Authentication
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
# 3. Clone + Install Dependencies
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
        # Fetch latest from remote so the agent sees any upstream changes
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
    subprocess.run(["npm", "install"], cwd=APP_DIR, check=True)
    subprocess.run(["npm", "install", "-g", "opencode-ai"], cwd=APP_DIR, check=True)

    sdk_dist = os.path.join(APP_DIR, "node_modules/@opencode-ai/sdk/dist")
    os.makedirs(sdk_dist, exist_ok=True)
    try:
        os.symlink("src/index.js", os.path.join(sdk_dist, "index.js"))
        print("[Agent] SDK symlink fix applied.")
    except FileExistsError:
        pass


# ---------------------------------------------------------------------------
# 4. Run Agent Engine
# ---------------------------------------------------------------------------

def run_agent(
    task: str,
    step_context: Optional[dict] = None,
    timeout: int = 3000,
    workspace: str = "",
) -> dict:
    """
    Execute the Node.js agent engine and return structured results.

    The agent runs a multi-phase pipeline:
      Phase 1: Repo map generation + context injection
      Phase 2: Task decomposition into subtasks (planner)
      Phase 3: Execute each subtask through the verification inner loop
      Final: Push + open PR

    Args:
        task: The task description for the agent.
        step_context: Optional dict with upstream step outputs (pipeline mode).
        timeout: Max seconds to wait (increased for multi-subtask execution).
        workspace: Path to the repo workspace directory.

    Returns a dict with keys:
        stdout, stderr, exit_code, pr_url, log_lines, step_output.
        step_output includes: iterations, verification_passed,
        verification_command, project_type, subtasks_count, plan_reasoning,
        total_cost, total_tokens_in, total_tokens_out.
    """
    workspace = workspace or DEFAULT_WORKSPACE

    env = os.environ.copy()
    env["TASK_DESCRIPTION"] = task
    env["WORKSPACE"] = workspace

    if step_context:
        env["STEP_CONTEXT"] = json.dumps(step_context)

    # Clean up any previous step result
    if os.path.exists(STEP_RESULT_PATH):
        os.remove(STEP_RESULT_PATH)

    print("[Agent] Starting the Agent Engine...")
    result = subprocess.run(
        ["npm", "run", "dev"],
        cwd=APP_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )

    stdout = result.stdout or ""
    stderr = result.stderr or ""
    combined = stdout + "\n" + stderr

    # Extract PR URL from output
    pr_url = None
    for line in combined.splitlines():
        if "github.com" in line and "/pull/" in line:
            match = re.search(r"https://github\.com/[^\s\"']+/pull/\d+", line)
            if match:
                pr_url = match.group(0)
                break

    # Last ~150 meaningful log lines (increased for multi-subtask runs)
    log_lines = [
        l for l in combined.splitlines()
        if l.strip() and not l.startswith(">")
    ][-150:]

    # Read structured step output if the agent wrote one
    step_output = None
    if os.path.exists(STEP_RESULT_PATH):
        try:
            with open(STEP_RESULT_PATH) as f:
                step_output = json.load(f)
            print(f"[Agent] Step result read from {STEP_RESULT_PATH}")
        except (json.JSONDecodeError, OSError) as e:
            print(f"[Agent] Warning: could not read step result: {e}")

    # If no explicit step_output, build one from extracted data
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
