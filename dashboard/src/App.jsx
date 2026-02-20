import { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";

// ── Configuration ────────────────────────────────────────────────────────────
const API_BASE = "https://hanwen-yang-hy3191--agent-api-api.modal.run";
const WS_BASE = API_BASE.replace(/^http/, "ws");
const POLL_INTERVAL = 5000;

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  return res.json();
}

// ── Status badge ─────────────────────────────────────────────────────────────
const STATUS_MAP = {
  queued:    "Queued",
  running:   "Running",
  retrying:  "Retrying",
  completed: "Completed",
  failed:    "Failed",
};

function Badge({ status }) {
  const label = STATUS_MAP[status] || "Queued";
  return (
    <span className={`badge badge-${status || "queued"}`}>
      <span className="badge-dot" />
      {label}
    </span>
  );
}

// ── Time helpers ─────────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function duration(start, end) {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const rs = sec % 60;
  return `${m}m ${rs}s`;
}

function formatTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ── Log line colorizer ──────────────────────────────────────────────────────
function classifyLogLine(line) {
  if (/\[TOOL/.test(line)) return "log-line-tool";
  if (/\[THOUGHT|REASONING/.test(line)) return "log-line-thought";
  if (/\[STEP/.test(line)) return "log-line-step";
  if (/\[SESSION/.test(line)) return "log-line-session";
  if (/ERROR|WARN|error|fail/i.test(line)) return "log-line-error";
  if (/\[FILE/.test(line)) return "log-line-file";
  return "";
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [jobs, setJobs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [repoUrl, setRepoUrl] = useState("");
  const [task, setTask] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [wsLogs, setWsLogs] = useState([]);

  const wsRef = useRef(null);
  const selectJobRef = useRef(null);
  const fetchJobsRef = useRef(null);
  const logsEndRef = useRef(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [wsLogs]);

  // Fetch all jobs
  const fetchJobs = useCallback(async () => {
    try {
      const data = await api("/jobs");
      setJobs(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to fetch jobs:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  fetchJobsRef.current = fetchJobs;

  useEffect(() => {
    fetchJobs();
    const t = setInterval(fetchJobs, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [fetchJobs]);

  // WebSocket connection for selected job
  const connectWs = useCallback((jobId) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setWsLogs([]);
    const ws = new WebSocket(`${WS_BASE}/ws/${jobId}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "update") {
        setSelected(prev => prev ? {
          ...prev,
          status: data.status,
          started_at: data.started_at,
          completed_at: data.completed_at,
          result: data.result,
          error: data.error,
        } : prev);
        if (data.new_logs?.length > 0) {
          setWsLogs(prev => [...prev, ...data.new_logs]);
        }
      } else if (data.type === "done") {
        selectJobRef.current?.(jobId);
        fetchJobsRef.current?.();
      }
    };

    ws.onerror = () => {
      console.warn("WebSocket error, falling back to polling");
    };

    ws.onclose = () => {
      wsRef.current = null;
    };
  }, []);

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Fetch selected job detail
  const selectJob = async (jobId) => {
    try {
      const data = await api(`/result/${jobId}`);
      setSelected(data);
      setWsLogs(data.logs || []);

      // Connect WebSocket for live updates if job is active
      if (data.status === "queued" || data.status === "running" || data.status === "retrying") {
        connectWs(jobId);
      }
    } catch (e) {
      console.error(e);
    }
  };

  selectJobRef.current = selectJob;

  // Auto-refresh active job (fallback when WebSocket is not connected)
  useEffect(() => {
    if (!selected || selected.status === "completed" || selected.status === "failed") return;
    if (wsRef.current) return;
    const t = setInterval(() => selectJobRef.current?.(selected.job_id), POLL_INTERVAL);
    return () => clearInterval(t);
  }, [selected]);

  // Submit
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!repoUrl.trim() || !task.trim()) return;
    setSubmitting(true);
    try {
      const body = { repo_url: repoUrl.trim(), task: task.trim() };
      if (ghToken.trim()) body.github_token = ghToken.trim();
      const data = await api("/submit", { method: "POST", body: JSON.stringify(body) });
      setRepoUrl(""); setTask("");
      await fetchJobs();
      if (data.job_id) selectJob(data.job_id);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  // Group jobs into active (queued/running/retrying) and completed
  const activeJobs = jobs.filter(j => ["queued", "running", "retrying"].includes(j.status));
  const doneJobs = jobs.filter(j => ["completed", "failed"].includes(j.status));

  return (
    <div className="app-layout">
      {/* ── Sidebar ──────────────────────────────────────── */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h1><span className="logo-dot" /> Agent Console</h1>
          <div className="sidebar-subtitle">
            {jobs.length} job{jobs.length !== 1 ? "s" : ""}
            {activeJobs.length > 0 && ` · ${activeJobs.length} active`}
          </div>
        </div>

        <div className="job-list">
          {loading ? (
            <div className="no-jobs">Loading...</div>
          ) : jobs.length === 0 ? (
            <div className="no-jobs">No jobs yet. Submit your first task below.</div>
          ) : (
            <>
              {activeJobs.length > 0 && (
                <>
                  <div className="job-group-label">Active</div>
                  {activeJobs.map(job => (
                    <JobItem
                      key={job.job_id}
                      job={job}
                      isActive={selected?.job_id === job.job_id}
                      onClick={() => selectJob(job.job_id)}
                    />
                  ))}
                </>
              )}
              {doneJobs.length > 0 && (
                <>
                  <div className="job-group-label">History</div>
                  {doneJobs.map(job => (
                    <JobItem
                      key={job.job_id}
                      job={job}
                      isActive={selected?.job_id === job.job_id}
                      onClick={() => selectJob(job.job_id)}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* Submit form at bottom of sidebar */}
        <div className="submit-section">
          <form onSubmit={handleSubmit}>
            <input
              type="text"
              className="form-input"
              placeholder="Repository URL (https://github.com/...)"
              value={repoUrl}
              onChange={e => setRepoUrl(e.target.value)}
            />
            <textarea
              className="form-input form-textarea"
              placeholder="What should the agent do?"
              value={task}
              onChange={e => setTask(e.target.value)}
              rows={2}
            />
            {showToken ? (
              <input
                type="password"
                className="form-input"
                placeholder="GitHub Token (optional)"
                value={ghToken}
                onChange={e => setGhToken(e.target.value)}
              />
            ) : (
              <button type="button" className="token-toggle" onClick={() => setShowToken(true)}>
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
      </div>

      {/* ── Main Panel ───────────────────────────────────── */}
      <div className="main-panel">
        {!selected ? (
          <div className="empty-state">
            <div className="empty-state-icon">&#9672;</div>
            <p>Select a job to view details</p>
          </div>
        ) : (
          <>
            {/* Detail Header */}
            <div className="detail-header">
              <div className="detail-header-top">
                <Badge status={selected.status} />
                {(selected.status === "running" || selected.status === "retrying") && (
                  <span className="running-timer">
                    {duration(selected.started_at, null)}
                  </span>
                )}
                {wsRef.current && <span className="live-tag">LIVE</span>}
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

            {/* Error banner */}
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
                <div className="meta-card-value">{duration(selected.started_at, selected.completed_at)}</div>
              </div>
            </div>

            {/* Agent Logs */}
            {wsLogs.length > 0 && (
              <div className="logs-section">
                <div className="logs-header">
                  <h3>Agent Logs</h3>
                  <span className="log-count">{wsLogs.length} lines</span>
                </div>
                <div className="logs-container">
                  {wsLogs.map((line, i) => (
                    <div key={i} className={classifyLogLine(line)}>{line}</div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="detail-footer">
              Job ID: {selected.job_id}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Job list item component ──────────────────────────────────────────────────
function JobItem({ job, isActive, onClick }) {
  return (
    <div
      className={`job-item${isActive ? " active" : ""}`}
      onClick={onClick}
    >
      <div className="job-item-top">
        <Badge status={job.status} />
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {timeAgo(job.submitted_at)}
        </span>
      </div>
      <div className="job-item-task">{job.task}</div>
      <div className="job-item-meta">
        <span className="job-item-repo">
          {job.repo_url?.replace("https://github.com/", "")}
        </span>
        {job.pr_url && (
          <a
            href={job.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ color: "var(--green)", fontWeight: 600, marginLeft: 8 }}
          >
            PR &#8599;
          </a>
        )}
      </div>
    </div>
  );
}
