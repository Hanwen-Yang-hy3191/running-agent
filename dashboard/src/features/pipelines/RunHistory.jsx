import Badge from "../../components/Badge";
import { timeAgo, duration } from "../../lib/utils";

export default function RunHistory({ runs, onSelect }) {
  if (!runs || runs.length === 0) {
    return (
      <div className="no-jobs" style={{ padding: 20 }}>
        No runs yet. Click "Run Pipeline" to start one.
      </div>
    );
  }

  return (
    <div>
      <div className="job-group-label">Run History</div>
      {runs.map((run) => (
        <div
          key={run.run_id}
          className="job-item"
          onClick={() => onSelect(run.run_id)}
        >
          <div className="job-item-top">
            <Badge status={run.status} />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {timeAgo(run.created_at)}
            </span>
          </div>
          <div className="job-item-meta">
            <span className="job-item-repo">
              {run.repo_url?.replace("https://github.com/", "")}
            </span>
            {run.started_at && (
              <span>{duration(run.started_at, run.completed_at)}</span>
            )}
          </div>
          {run.error && (
            <div
              style={{
                fontSize: 11,
                color: "var(--red)",
                marginTop: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {run.error}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
