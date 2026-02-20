import { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";

// ── Configuration ────────────────────────────────────────────────────────────
const API_BASE = "https://hanwen-yang-hy3191--agent-api-api.modal.run";
const WS_BASE = API_BASE.replace(/^http/, "ws");
const POLL_INTERVAL = 5000;

// ── API helpers ──────────────────────────────────────────────────────────────
function getApiKey() {
  return localStorage.getItem("agent_api_key") || "";
}

async function api(path, options = {}) {
  const apiKey = getApiKey();
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  return res.json();
}

// ── Status badge ─────────────────────────────────────────────────────────────
const STATUS_STYLES = {
  queued:    { bg: "#fef3c7", color: "#92400e", label: "Queued" },
  running:   { bg: "#dbeafe", color: "#1e40af", label: "Running" },
  retrying:  { bg: "#fef3c7", color: "#d97706", label: "Retrying" },
  completed: { bg: "#d1fae5", color: "#065f46", label: "Completed" },
  failed:    { bg: "#fee2e2", color: "#991b1b", label: "Failed" },
};

function Badge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.queued;
  return (
    <span style={{
      padding: "3px 10px", borderRadius: 12, fontSize: 12,
      fontWeight: 600, background: s.bg, color: s.color, whiteSpace: "nowrap",
    }}>
      {s.label}
    </span>
  );
}

// ── Time helpers ─────────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

function duration(start, end) {
  if (!start) return "";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function MetaCard({ label, value }) {
  return (
    <div style={{ padding: 12, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{value || "—"}</div>
    </div>
  );
}

const inputStyle = {
  padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 8,
  fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box",
  color: "#1a1a2e", background: "#fff",
};

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [jobs, setJobs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [repoUrl, setRepoUrl] = useState("");
  const [task, setTask] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [apiKey, setApiKey] = useState(getApiKey());
  const [authError, setAuthError] = useState(false);
  const [wsLogs, setWsLogs] = useState([]);

  const wsRef = useRef(null);

  // Save API key
  const saveApiKey = (key) => {
    setApiKey(key);
    localStorage.setItem("agent_api_key", key);
    setAuthError(false);
  };

  // Fetch all jobs
  const fetchJobs = useCallback(async () => {
    try {
      const data = await api("/jobs");
      setJobs(Array.isArray(data) ? data : []);
      setAuthError(false);
    } catch (e) {
      if (e.message === "AUTH_REQUIRED") {
        setAuthError(true);
      } else {
        console.error("Failed to fetch jobs:", e);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    const t = setInterval(fetchJobs, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [fetchJobs]);

  // WebSocket connection for selected job
  const connectWs = useCallback((jobId) => {
    // Close existing connection
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
        // Refresh full job details on completion
        selectJob(jobId);
        fetchJobs();
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
      if (e.message === "AUTH_REQUIRED") setAuthError(true);
      else console.error(e);
    }
  };

  // Auto-refresh active job (fallback when WebSocket is not connected)
  useEffect(() => {
    if (!selected || selected.status === "completed" || selected.status === "failed") return;
    if (wsRef.current) return; // WebSocket is handling updates
    const t = setInterval(() => selectJob(selected.job_id), POLL_INTERVAL);
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
      if (e.message === "AUTH_REQUIRED") setAuthError(true);
      else console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh", color: "#1a1a2e" }}>
      {/* ── Left Panel ─────────────────────────────────────── */}
      <div style={{
        width: 420, minWidth: 420, borderRight: "1px solid #e2e8f0",
        display: "flex", flexDirection: "column", background: "#f8fafc",
      }}>
        <div style={{ padding: "20px 20px 12px", borderBottom: "1px solid #e2e8f0" }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Agent Dashboard</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748b" }}>
            Background Coding Agent · {jobs.length} job{jobs.length !== 1 ? "s" : ""}
          </p>
        </div>

        {/* API Key input */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #e2e8f0", background: authError ? "#fef2f2" : "#f8fafc" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              placeholder="API Key"
              value={apiKey}
              onChange={e => saveApiKey(e.target.value)}
              style={{ ...inputStyle, flex: 1, fontSize: 12 }}
            />
            <div style={{
              fontSize: 11, display: "flex", alignItems: "center",
              color: authError ? "#991b1b" : apiKey ? "#065f46" : "#94a3b8",
              whiteSpace: "nowrap",
            }}>
              {authError ? "Invalid key" : apiKey ? "Connected" : "No key"}
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{
          padding: 16, borderBottom: "1px solid #e2e8f0",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          <input type="text" placeholder="Repository URL (https://github.com/...)"
            value={repoUrl} onChange={e => setRepoUrl(e.target.value)} style={inputStyle} />
          <textarea placeholder="Task description — what should the agent do?"
            value={task} onChange={e => setTask(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
          <input type="password" placeholder="GitHub Token (optional — uses server default)"
            value={ghToken} onChange={e => setGhToken(e.target.value)} style={inputStyle} />
          <button type="submit" disabled={submitting || !repoUrl.trim() || !task.trim()} style={{
            padding: "10px 16px", background: submitting ? "#94a3b8" : "#2563eb",
            color: "#fff", border: "none", borderRadius: 8, fontSize: 14,
            fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer",
          }}>
            {submitting ? "Submitting..." : "Submit Task"}
          </button>
        </form>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading ? (
            <p style={{ padding: 20, color: "#94a3b8", textAlign: "center" }}>Loading...</p>
          ) : jobs.length === 0 ? (
            <p style={{ padding: 20, color: "#94a3b8", textAlign: "center" }}>No jobs yet. Submit your first task above.</p>
          ) : jobs.map(job => (
            <div key={job.job_id} onClick={() => selectJob(job.job_id)} style={{
              padding: "12px 16px", borderBottom: "1px solid #e2e8f0", cursor: "pointer",
              background: selected?.job_id === job.job_id ? "#e0e7ff" : "transparent",
              transition: "background 0.15s",
            }}
              onMouseEnter={e => { if (selected?.job_id !== job.job_id) e.currentTarget.style.background = "#f1f5f9"; }}
              onMouseLeave={e => { if (selected?.job_id !== job.job_id) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <Badge status={job.status} />
                <span style={{ fontSize: 11, color: "#94a3b8" }}>{timeAgo(job.submitted_at)}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {job.task}
              </div>
              <div style={{ fontSize: 11, color: "#64748b", display: "flex", justifyContent: "space-between" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {job.repo_url?.replace("https://github.com/", "")}
                </span>
                {job.pr_url && (
                  <a href={job.pr_url} target="_blank" rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()} style={{ color: "#059669", fontWeight: 600, marginLeft: 8 }}>
                    PR
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right Panel: Detail ────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto", padding: 28, background: "#fff" }}>
        {!selected ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 48, opacity: 0.5 }}>&#129302;</div>
            <p>Select a job from the list to view details</p>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <Badge status={selected.status} />
                {(selected.status === "running" || selected.status === "retrying") && (
                  <span style={{ fontSize: 12, color: "#2563eb", fontWeight: 500 }}>
                    {selected.status === "retrying" ? "Retrying" : "Running"} for {duration(selected.started_at, null)}...
                  </span>
                )}
                {wsRef.current && (
                  <span style={{ fontSize: 11, color: "#059669", fontWeight: 500 }}>
                    LIVE
                  </span>
                )}
              </div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{selected.task}</h2>
              <p style={{ margin: "6px 0 0", fontSize: 13, color: "#64748b" }}>
                {selected.repo_url?.replace("https://github.com/", "")} · by {selected.submitted_by || "anonymous"}
              </p>
            </div>

            {selected.result?.pr_url && (
              <a href={selected.result.pr_url} target="_blank" rel="noopener noreferrer" style={{
                display: "inline-block", padding: "10px 20px", background: "#059669",
                color: "#fff", borderRadius: 8, textDecoration: "none", fontWeight: 600,
                fontSize: 14, marginBottom: 20,
              }}>
                View Pull Request
              </a>
            )}

            {selected.error && (
              <div style={{
                padding: 12, background: "#fef2f2", border: "1px solid #fecaca",
                borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#991b1b",
              }}>
                <strong>Error:</strong> {selected.error}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
              <MetaCard label="Submitted" value={selected.submitted_at && new Date(selected.submitted_at).toLocaleString()} />
              <MetaCard label="Started" value={selected.started_at && new Date(selected.started_at).toLocaleString()} />
              <MetaCard label="Completed" value={selected.completed_at && new Date(selected.completed_at).toLocaleString()} />
              <MetaCard label="Duration" value={duration(selected.started_at, selected.completed_at)} />
            </div>

            {wsLogs.length > 0 && (
              <>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Agent Logs</h3>
                <pre style={{
                  background: "#1e293b", color: "#e2e8f0", padding: 16, borderRadius: 8,
                  fontSize: 11, lineHeight: 1.6, overflowX: "auto", maxHeight: 400,
                  whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}>
                  {wsLogs.join("\n")}
                </pre>
              </>
            )}

            <p style={{ marginTop: 20, fontSize: 11, color: "#94a3b8" }}>
              Job ID: <code>{selected.job_id}</code>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
