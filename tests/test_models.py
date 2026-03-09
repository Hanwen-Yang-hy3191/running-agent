import os
import json
import tempfile
import pytest

# Override DATA_DIR before importing models
_test_dir = tempfile.mkdtemp()
os.environ["DATA_DIR"] = _test_dir

from models import create_job, get_job, update_job, get_db


def test_job_has_review_columns():
    """Jobs table should have review_verdict, review_confidence, review_summary columns."""
    with get_db() as conn:
        cursor = conn.execute("PRAGMA table_info(jobs)")
        columns = {row[1] for row in cursor.fetchall()}
    assert "review_verdict" in columns
    assert "review_confidence" in columns
    assert "review_summary" in columns
    assert "review_issues_count" in columns
    assert "pr_is_draft" in columns


def test_update_job_with_review_data():
    """Should be able to store review data in a job record."""
    job_id = "test-review-" + os.urandom(4).hex()
    create_job(job_id, "https://github.com/test/repo", "Fix bug")
    update_job(job_id, **{
        "review_verdict": "approve",
        "review_confidence": 0.92,
        "review_summary": "Code looks clean.",
        "review_issues_count": 0,
        "pr_is_draft": False,
    })
    job = get_job(job_id)
    assert job["review_verdict"] == "approve"
    assert job["review_confidence"] == 0.92
    assert job["pr_is_draft"] == 0  # SQLite stores as int
