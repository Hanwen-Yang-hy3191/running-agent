import modal
import os
import subprocess
import sys

# ---------------------------------------------------------------------------
# 1. Image definition
# ---------------------------------------------------------------------------
# Build a cloud image with Node.js, Python, Git, and the GitHub CLI (gh).
# We also bake in our local Node.js agent engine so it's ready to run.
sandbox_image = (
    modal.Image.debian_slim()
    .apt_install("git", "curl", "python3")
    # Node.js 20
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
    )
    # GitHub CLI — needed for `gh pr create`
    .run_commands(
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
        "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
        'echo "deb [arch=$(dpkg --print-architecture) '
        "signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] "
        'https://cli.github.com/packages stable main" '
        "| tee /etc/apt/sources.list.d/github-cli.list > /dev/null",
        "apt-get update && apt-get install -y gh",
    )
    # Mount our local Node.js agent engine into /app
    .add_local_dir(
        local_path=".",
        remote_path="/app",
        ignore=["dummy-workspace/**", "node_modules/**"],
    )
)

app = modal.App("agent-in-the-cloud")

# ---------------------------------------------------------------------------
# 2. Cloud execution function
# ---------------------------------------------------------------------------
# Secrets now include both the LLM key and the GitHub token.
@app.function(
    image=sandbox_image,
    timeout=1800,
    secrets=[
        modal.Secret.from_dict({
            "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
            "GITHUB_TOKEN": os.environ.get("GITHUB_TOKEN", ""),
        })
    ],
)
def run_agent_in_cloud(repo_url: str, task: str = ""):
    """
    Runs entirely in the Modal cloud.
    1. Authenticates with GitHub via `gh`
    2. Clones the target repo
    3. Passes the task description to the Node.js agent engine
    4. The agent writes code, commits, and opens a PR — all in the cloud
    """
    import shutil

    github_token = os.environ.get("GITHUB_TOKEN", "")
    if not github_token:
        print("[Cloud] WARNING: GITHUB_TOKEN is empty — PR creation will fail.")

    # ── GitHub CLI authentication ──────────────────────────────────────────
    print("[Cloud] Authenticating GitHub CLI...")
    proc = subprocess.run(
        ["gh", "auth", "login", "--with-token"],
        input=github_token,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        print(f"[Cloud] gh auth warning: {proc.stderr.strip()}")
    else:
        print("[Cloud] gh auth OK")

    # Verify authentication
    subprocess.run(["gh", "auth", "status"], check=False)

    # ── Git identity (needed for commits) ──────────────────────────────────
    subprocess.run(
        ["git", "config", "--global", "user.name", "Cloud Agent"], check=True
    )
    subprocess.run(
        ["git", "config", "--global", "user.email", "agent@cloud.bot"], check=True
    )

    # ── Configure git to use GITHUB_TOKEN for HTTPS operations ───────────
    # This makes `git clone`, `git push`, etc. authenticate automatically.
    subprocess.run(
        ["git", "config", "--global", "credential.helper", "store"], check=True
    )
    # Write the token into the credential store so git can find it
    with open(os.path.expanduser("~/.git-credentials"), "w") as f:
        f.write(f"https://x-access-token:{github_token}@github.com\n")

    # ── Clone the target repository ────────────────────────────────────────
    print(f"[Cloud] Cloning {repo_url} ...")
    subprocess.run(["git", "clone", repo_url, "/app/workspace"], check=True)

    # ── Install agent dependencies ─────────────────────────────────────────
    os.chdir("/app")
    print("[Cloud] Installing Agent dependencies...")
    subprocess.run(["npm", "install"], check=True)
    subprocess.run(["npm", "install", "-g", "opencode-ai"], check=True)

    # SDK path fix: tsx can't resolve the exports map correctly — the actual
    # JS lives at dist/src/index.js but Node looks for dist/index.js.
    # A symlink bridges the gap reliably.
    os.makedirs("node_modules/@opencode-ai/sdk/dist", exist_ok=True)
    try:
        os.symlink("src/index.js", "node_modules/@opencode-ai/sdk/dist/index.js")
        print("[Cloud] SDK symlink fix applied.")
    except FileExistsError:
        pass

    # ── Pass the task description to the engine via env var ─────────────────
    env = os.environ.copy()
    env["TASK_DESCRIPTION"] = task or "Improve the README with a better project description."

    print("[Cloud] Starting the Agent Engine...")
    print("=" * 60)
    print("  LIVE CLOUD AGENT LOGS")
    print("=" * 60)

    subprocess.run(["npm", "run", "dev"], check=True, env=env)

    return "Agent task completed successfully in the cloud."


# ---------------------------------------------------------------------------
# 3. Local entrypoint
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def main():
    gemini_key = os.environ.get("GEMINI_API_KEY")
    github_token = os.environ.get("GITHUB_TOKEN")

    if not gemini_key:
        print("Error: GEMINI_API_KEY environment variable is missing.")
        print("Usage: GEMINI_API_KEY=... GITHUB_TOKEN=... modal run sandbox.py")
        return
    if not github_token:
        print("Warning: GITHUB_TOKEN is not set — the agent won't be able to push or create PRs.")

    # ── Configurable via env vars or sensible defaults ─────────────────────
    repo_url = os.environ.get(
        "REPO_URL",
        "https://github.com/octocat/Hello-World.git",
    )
    task = os.environ.get(
        "TASK_DESCRIPTION",
        "Improve the README with a better project description and usage instructions.",
    )

    print("=" * 60)
    print("  Launching Agent into Modal Sandbox")
    print("=" * 60)
    print(f"  Repo : {repo_url}")
    print(f"  Task : {task[:80]}{'...' if len(task) > 80 else ''}")
    print(f"  Token: {'set' if github_token else 'MISSING'}")
    print("=" * 60)

    status_message = run_agent_in_cloud.remote(repo_url, task)

    print("\n" + "=" * 60)
    print(f"  {status_message}")
    print("=" * 60)