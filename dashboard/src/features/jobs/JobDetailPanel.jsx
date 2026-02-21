import { useEffect, useRef } from "react";
import Badge from "../../components/Badge";
import { duration, formatTime, classifyLogLine } from "../../lib/utils";

export default function JobDetailPanel({ selected, wsLogs, wsConnected }) {
  const logsEndRef = useRef(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [wsLogs]);

  if (!selected) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">&#9672;</div>
        <p>Select a job to view details</p>
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="detail-header">
        <div className="detail-header-top">
          <Badge status={selected.status} />
          {(selected.status === "running" || selected.status === "retrying") && (
            <span className="running-timer">
              {duration(selected.started_at, null)}
            </span>
          )}
          {wsConnected && <span className="live-tag">LIVE</span>}
        </div>
        <h2 className="detail-title">{selected.task}</h2>
        <div className="detail-subtitle">
          <span>{selected.repo_url?.replace("https://github.com/", "")}</span>
          <span>·</span>
          <span>{selected.submitted_by || "anonymous"}</span>
        </div>

        {selected.result?.pr_url && (
          <a
            href={selected.result.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="pr-link"
          >
            &#8599; View Pull Request
          </a>
        )}
      </div>

      {/* Error */}
      {selected.error && (
        <div className="error-banner">
          <strong>Error:</strong> {selected.error}
        </div>
      )}

      {/* Meta grid */}
      <div className="meta-grid">
        <div className="meta-card">
          <div className="meta-card-label">Submitted</div>
          <div className="meta-card-value">{formatTime(selected.submitted_at)}</div>
        </div>
        <div className="meta-card">
          <div className="meta-card-label">Started</div>
          <div className="meta-card-value">{formatTime(selected.started_at)}</div>
        </div>
        <div className="meta-card">
          <div className="meta-card-label">Completed</div>
          <div className="meta-card-value">{formatTime(selected.completed_at)}</div>
        </div>
        <div className="meta-card">
          <div className="meta-card-label">Duration</div>
          <div className="meta-card-value">
            {duration(selected.started_at, selected.completed_at)}
          </div>
        </div>
      </div>

      {/* Logs */}
      {wsLogs.length > 0 && (
        <div className="logs-section">
          <div className="logs-header">
            <h3>Agent Logs</h3>
            <span className="log-count">{wsLogs.length} lines</span>
          </div>
          <div className="logs-container">
            {wsLogs.map((line, i) => (
              <div key={i} className={classifyLogLine(line)}>
                {line}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="detail-footer">Job ID: {selected.job_id}</div>
    </>
  );
}
