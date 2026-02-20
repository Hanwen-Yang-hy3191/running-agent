"""
CLI-triggered cloud execution for the Background Coding Agent.

Usage:
    GEMINI_API_KEY=... GITHUB_TOKEN=... modal run sandbox.py
"""

import modal
import os

from shared import sandbox_image, setup_github_auth, clone_and_install, run_agent

app = modal.App("agent-in-the-cloud")

# ---------------------------------------------------------------------------
# Cloud execution function
# ---------------------------------------------------------------------------

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
    token = os.environ.get("GITHUB_TOKEN", "")
    setup_github_auth(token)
    clone_and_install(repo_url)

    task = task or "Improve the README with a better project description."

    print("=" * 60)
    print("  LIVE CLOUD AGENT LOGS")
    print("=" * 60)

    result = run_agent(task)

    if result["pr_url"]:
        print(f"\n[Cloud] PR created: {result['pr_url']}")

    return "Agent task completed successfully in the cloud."


# ---------------------------------------------------------------------------
# Local entrypoint
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
