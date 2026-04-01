import os
import json
import pytest


def test_run_agent_sets_require_human_review_env(monkeypatch, tmp_path):
    """Test that run_agent passes REQUIRE_HUMAN_REVIEW env to subprocess."""
    from shared import run_agent

    captured_env = {}

    class MockProcess:
        returncode = 0
        stdout = ""
        stderr = ""

    def mock_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return MockProcess()

    monkeypatch.setattr("subprocess.run", mock_run)
    monkeypatch.setattr("shared.STEP_RESULT_PATH", str(tmp_path / "result.json"))

    result_path = tmp_path / "result.json"
    result_path.write_text(json.dumps({"exit_code": 0}))

    try:
        run_agent("test task", require_human_review=True, timeout=5)
    except Exception:
        pass

    assert captured_env.get("REQUIRE_HUMAN_REVIEW") == "true"


def test_run_agent_default_no_human_review(monkeypatch, tmp_path):
    """Test that REQUIRE_HUMAN_REVIEW is not set by default."""
    from shared import run_agent

    captured_env = {}

    class MockProcess:
        returncode = 0
        stdout = ""
        stderr = ""

    def mock_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return MockProcess()

    monkeypatch.setattr("subprocess.run", mock_run)
    monkeypatch.setattr("shared.STEP_RESULT_PATH", str(tmp_path / "result.json"))

    result_path = tmp_path / "result.json"
    result_path.write_text(json.dumps({"exit_code": 0}))

    try:
        run_agent("test task", timeout=5)
    except Exception:
        pass

    assert "REQUIRE_HUMAN_REVIEW" not in captured_env
