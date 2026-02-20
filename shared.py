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

def clone_and_install(repo_url: str, workspace: str = "/app/workspace") -> None:
    """Clone the target repository and install agent engine dependencies."""
    print(f"[Cloud] Cloning {repo_url} ...")
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
    timeout: int = 1500,
) -> dict:
    """
    Execute the Node.js agent engine and return structured results.

    Args:
        task: The task description for the agent.
        step_context: Optional dict with upstream step outputs (pipeline mode).
        timeout: Max seconds to wait for the agent process.

    Returns a dict with keys:
        stdout, stderr, exit_code, pr_url, log_lines, step_output.
    """
    env = os.environ.copy()
    env["TASK_DESCRIPTION"] = task

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

    # Last ~50 meaningful log lines
    log_lines = [
        l for l in combined.splitlines()
        if l.strip() and not l.startswith(">")
    ][-50:]

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
