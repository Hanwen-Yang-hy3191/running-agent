import { useState, useEffect, useRef } from "react";
import { fetchJobResult } from "../../lib/api";
import Badge from "../../components/Badge";
import { duration, formatTime, classifyLogLine } from "../../lib/utils";

/**
 * Right panel showing a selected step's job details.
 *
 * Props:
 *   job      — job summary from run detail { job_id, step_name, status, ... }
 *   stepName — currently selected step name
 */
export default function RunStepPanel({ job, stepName }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const logsEndRef = useRef(null);

  useEffect(() => {
    if (!job?.job_id) {
      setDetail(null);
      return;
    }
    setLoading(true);
    fetchJobResult(job.job_id)
      .then((data) => setDetail(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [job?.job_id, job?.status]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.logs]);

  if (!stepName) {
    return (
      <div className="run-step-panel">
        <div className="empty-state">
          <p>Click a step in the DAG to view details</p>
        </div>
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="run-step-panel">
        <div className="empty-state"><p>Loading...</p></div>
      </div>
    );
  }

  const logs = detail?.logs || [];

  return (
    <div className="run-step-panel">
      {/* Step header */}
      <div className="step-panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Badge status={job?.status || detail?.status} />
          {(job?.status === "running" || job?.status === "retrying") && (
            <span className="running-timer">
              {duration(job?.started_at || detail?.started_at, null)}
            </span>
          )}
        </div>
        <h3 className="detail-title" style={{ fontSize: 15 }}>
          Step: {stepName}
        </h3>
        {detail?.task && (
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            {detail.task}
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="step-panel-meta">
        <div className="meta-card">
          <div className="meta-card-label">Started</div>
          <div className="meta-card-value">{formatTime(job?.started_at)}</div>
        </div>
        <div className="meta-card">
          <div className="meta-card-label">Duration</div>
          <div className="meta-card-value">
            {duration(job?.started_at, job?.completed_at)}
          </div>
        </div>
      </div>

      {/* Error */}
      {(job?.error || detail?.error) && (
        <div className="error-banner" style={{ margin: "12px 16px" }}>
          <strong>Error:</strong> {job?.error || detail?.error}
        </div>
      )}

      {/* PR link */}
      {(job?.pr_url || detail?.result?.pr_url) && (
        <div style={{ padding: "0 16px" }}>
          <a
            href={job?.pr_url || detail?.result?.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="pr-link"
          >
            &#8599; View Pull Request
          </a>
        </div>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <div className="step-panel-logs">
          <div className="logs-header">
            <h4 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              Agent Logs
            </h4>
            <span className="log-count">{logs.length} lines</span>
          </div>
          <div className="logs-container" style={{ maxHeight: 300 }}>
            {logs.map((line, i) => (
              <div key={i} className={classifyLogLine(line)}>{line}</div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}

      {/* Step output */}
      {job?.step_output && (
        <div className="step-panel-output">
          <h4 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
            Step Output
          </h4>
          <pre className="logs-container" style={{ maxHeight: 200 }}>
            {JSON.stringify(job.step_output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
