"""
Integration test scaffolding — requires Docker environment.
Run with: docker compose exec agent python -m pytest tests/test_integration.py -v
Or set RUN_INTEGRATION_TESTS=1 to run locally.
"""
import os
import pytest

SKIP_INTEGRATION = not os.environ.get("RUN_INTEGRATION_TESTS")


@pytest.mark.skipif(SKIP_INTEGRATION, reason="Set RUN_INTEGRATION_TESTS=1 to run")
class TestIntegration:
    """Integration tests that require the full Docker environment."""

    def test_health_endpoint(self):
        """Health endpoint should return version and stats."""
        import requests
        api_url = os.environ.get("API_URL", "http://localhost:8000")
        resp = requests.get(f"{api_url}/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["version"] == "1.0.0"
        assert "stats" in data

    def test_submit_with_require_human_review(self):
        """Submit endpoint should accept require_human_review parameter."""
        import requests
        api_url = os.environ.get("API_URL", "http://localhost:8000")
        resp = requests.post(f"{api_url}/submit", json={
            "repo_url": "https://github.com/test/repo",
            "task": "Add a hello world function",
            "require_human_review": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "job_id" in data
