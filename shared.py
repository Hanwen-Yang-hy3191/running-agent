"""
Shared infrastructure for the Background Coding Agent.

Centralises the container image definition, GitHub/Git authentication,
dependency installation, and agent execution logic so that both
sandbox.py (CLI) and api.py (HTTP API) stay thin wrappers.
"""

import modal
import os
import re
import subprocess

# ---------------------------------------------------------------------------
# 1. Container Image
# ---------------------------------------------------------------------------
# Debian-based image with Node.js 20, Git, GitHub CLI, and the local agent
# engine baked in.  Both sandbox.py and api.py reference this single object.

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
    .add_local_dir(
        local_path=".",
        remote_path="/app",
        ignore=["dummy-workspace/**", "node_modules/**", "dashboard/**"],
    )
)


# ---------------------------------------------------------------------------
# 2. GitHub + Git Authentication
# ---------------------------------------------------------------------------

def setup_github_auth(token: str) -> None:
    """Authenticate the GitHub CLI and configure Git credentials."""
    if not token:
        print("[Cloud] WARNING: GITHUB_TOKEN is empty — PR creation will fail.")

    # gh auth
    proc = subprocess.run(
        ["gh", "auth", "login", "--with-token"],
        input=token, text=True, capture_output=True,
    )
    if proc.returncode != 0:
        print(f"[Cloud] gh auth warning: {proc.stderr.strip()}")
    else:
        print("[Cloud] gh auth OK")

    subprocess.run(["gh", "auth", "status"], check=False)

    # Git identity
    subprocess.run(
        ["git", "config", "--global", "user.name", "Cloud Agent"], check=True
    )
    subprocess.run(
        ["git", "config", "--global", "user.email", "agent@cloud.bot"], check=True
    )

    # Credential store so git push / clone work with HTTPS
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

    # SDK symlink fix: tsx can't resolve the exports map correctly — the actual
    # JS lives at dist/src/index.js but Node looks for dist/index.js.
    os.makedirs("node_modules/@opencode-ai/sdk/dist", exist_ok=True)
    try:
        os.symlink("src/index.js", "node_modules/@opencode-ai/sdk/dist/index.js")
        print("[Cloud] SDK symlink fix applied.")
    except FileExistsError:
        pass


# ---------------------------------------------------------------------------
# 4. Run Agent Engine
# ---------------------------------------------------------------------------

def run_agent(task: str, timeout: int = 1500) -> dict:
    """
    Execute the Node.js agent engine and return structured results.

    Returns a dict with keys: stdout, stderr, exit_code, pr_url, log_lines.
    """
    env = os.environ.copy()
    env["TASK_DESCRIPTION"] = task

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

    # Extract PR URL
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

    return {
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": result.returncode,
        "pr_url": pr_url,
        "log_lines": log_lines,
    }
