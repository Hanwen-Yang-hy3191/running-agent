import { useState } from "react";

export default function JobSubmitForm({ onSubmit, submitting }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [task, setTask] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!repoUrl.trim() || !task.trim()) return;
    const body = { repo_url: repoUrl.trim(), task: task.trim() };
    if (ghToken.trim()) body.github_token = ghToken.trim();
    onSubmit(body);
    setRepoUrl("");
    setTask("");
  };

  return (
    <div className="submit-section">
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          className="form-input"
          placeholder="Repository URL (https://github.com/...)"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
        />
        <textarea
          className="form-input form-textarea"
          placeholder="What should the agent do?"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={2}
        />
        {showToken ? (
          <input
            type="password"
            className="form-input"
            placeholder="GitHub Token (optional)"
            value={ghToken}
            onChange={(e) => setGhToken(e.target.value)}
          />
        ) : (
          <button
            type="button"
            className="token-toggle"
            onClick={() => setShowToken(true)}
          >
            + Add GitHub token (optional)
          </button>
        )}
        <button
          type="submit"
          className="submit-btn"
          disabled={submitting || !repoUrl.trim() || !task.trim()}
        >
          {submitting ? "Submitting..." : "Submit Task"}
        </button>
      </form>
    </div>
  );
}
