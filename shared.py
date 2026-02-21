"""
Shared infrastructure for the Background Coding Agent.

Centralises the container image definition, GitHub/Git authentication,
dependency installation, and agent execution logic so that both
sandbox.py (CLI) and api.py (HTTP API) stay thin wrappers.
"""

import json
import modal
import os
import re
import subprocess
from typing import Optional

# ---------------------------------------------------------------------------
# 1. Container Image
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
    .env({"PYTHONPATH": "/app"})
    .add_local_dir(
        local_path=".",
        remote_path="/app",
        ignore=["dummy-workspace/**", "node_modules/**", "dashboard/**"],
    )
)

STEP_RESULT_PATH = "/app/step_result.json"

# ---------------------------------------------------------------------------
# 1b. Workspace Volume — shared between pipeline steps
# ---------------------------------------------------------------------------

workspace_volume = modal.Volume.from_name("agent-workspaces", create_if_missing=True)
WORKSPACE_VOLUME_DIR = "/workspaces"


# ---------------------------------------------------------------------------
# 2. GitHub + Git Authentication
# ---------------------------------------------------------------------------

def setup_github_auth(token: str) -> None:
    """Authenticate the GitHub CLI and configure Git credentials."""
    if not token:
        print("[Cloud] WARNING: GITHUB_TOKEN is empty — PR creation will fail.")

    proc = subprocess.run(
        ["gh", "auth", "login", "--with-token"],
        input=token, text=True, capture_output=True,
    )
    if proc.returncode != 0:
        print(f"[Cloud] gh auth warning: {proc.stderr.strip()}")
    else:
        print("[Cloud] gh auth OK")

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
    workspace: str = "/app/workspace",
    skip_clone: bool = False,
) -> None:
    """Clone the target repository and install agent engine dependencies.

    When skip_clone=True (pipeline workspace persistence), the workspace
    already exists from a previous step — skip cloning and reuse it.
    """
    if skip_clone and os.path.isdir(workspace):
        print(f"[Cloud] Reusing existing workspace at {workspace} (skip_clone=True)")
        # Fetch latest from remote so the agent sees any upstream changes
        subprocess.run(
            ["git", "fetch", "--all"],
            cwd=workspace,
            check=False,
            capture_output=True,
        )
    else:
        print(f"[Cloud] Cloning {repo_url} ...")
        os.makedirs(os.path.dirname(workspace), exist_ok=True)
        subprocess.run(["git", "clone", repo_url, workspace], check=True)

    os.chdir("/app")
    print("[Cloud] Installing Agent dependencies...")
    subprocess.run(["npm", "install"], check=True)
    subprocess.run(["npm", "install", "-g", "opencode-ai"], check=True)

    os.makedirs("node_modules/@opencode-ai/sdk/dist", exist_ok=True)
    try:
        os.symlink("src/index.js", "node_modules/@opencode-ai/sdk/dist/index.js")
        print("[Cloud] SDK symlink fix applied.")
    except FileExistsError:
        pass


# ---------------------------------------------------------------------------
# 4. Run Agent Engine
# ---------------------------------------------------------------------------

def run_agent(
    task: str,
    step_context: Optional[dict] = None,
    timeout: int = 3000,
    workspace: str = "/app/workspace",
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
    env = os.environ.copy()
    env["TASK_DESCRIPTION"] = task
    env["WORKSPACE"] = workspace

    if step_context:
        env["STEP_CONTEXT"] = json.dumps(step_context)

    # Clean up any previous step result
    if os.path.exists(STEP_RESULT_PATH):
        os.remove(STEP_RESULT_PATH)

    print("[Cloud] Starting the Agent Engine...")
    result = subprocess.run(
        ["npm", "run", "dev"],
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
            print(f"[Cloud] Step result read from {STEP_RESULT_PATH}")
        except (json.JSONDecodeError, OSError) as e:
            print(f"[Cloud] Warning: could not read step result: {e}")

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
