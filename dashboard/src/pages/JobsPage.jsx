import { useState, useEffect, useRef, useCallback } from "react";
import { fetchJobs as apiFetchJobs, fetchJobResult, submitJob, WS_BASE, POLL_INTERVAL } from "../lib/api";
import JobList from "../features/jobs/JobList";
import JobSubmitForm from "../features/jobs/JobSubmitForm";
import JobDetailPanel from "../features/jobs/JobDetailPanel";

export default function JobsPage() {
  const [jobs, setJobs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [wsLogs, setWsLogs] = useState([]);

  const wsRef = useRef(null);
  const selectJobRef = useRef(null);
  const fetchJobsRef = useRef(null);

  // ── Fetch jobs ───────────────────────────────────────────────────────────
  const fetchJobs = useCallback(async () => {
    try {
      const data = await apiFetchJobs();
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

  // ── WebSocket ────────────────────────────────────────────────────────────
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
        setSelected((prev) =>
          prev
            ? {
                ...prev,
                status: data.status,
                started_at: data.started_at,
                completed_at: data.completed_at,
                result: data.result,
                error: data.error,
              }
            : prev
        );
        if (data.new_logs?.length > 0) {
          setWsLogs((prev) => [...prev, ...data.new_logs]);
        }
      } else if (data.type === "done") {
        selectJobRef.current?.(jobId);
        fetchJobsRef.current?.();
      }
    };

    ws.onerror = () => console.warn("WebSocket error, falling back to polling");
    ws.onclose = () => { wsRef.current = null; };
  }, []);

  useEffect(() => {
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, []);

  // ── Select job ───────────────────────────────────────────────────────────
  const selectJob = async (jobId) => {
    try {
      const data = await fetchJobResult(jobId);
      setSelected(data);
      setWsLogs(data.logs || []);
      if (["queued", "running", "retrying"].includes(data.status)) {
        connectWs(jobId);
      }
    } catch (e) {
      console.error(e);
    }
  };

  selectJobRef.current = selectJob;

  // ── Auto-refresh fallback ────────────────────────────────────────────────
  useEffect(() => {
    if (!selected || selected.status === "completed" || selected.status === "failed") return;
    if (wsRef.current) return;
    const t = setInterval(() => selectJobRef.current?.(selected.job_id), POLL_INTERVAL);
    return () => clearInterval(t);
  }, [selected]);

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = async (body) => {
    setSubmitting(true);
    try {
      const data = await submitJob(body);
      await fetchJobs();
      if (data.job_id) selectJob(data.job_id);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="page-split">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-subtitle">
            {jobs.length} job{jobs.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="job-list">
          <JobList
            jobs={jobs}
            loading={loading}
            selectedId={selected?.job_id}
            onSelect={selectJob}
          />
        </div>
        <JobSubmitForm onSubmit={handleSubmit} submitting={submitting} />
      </div>

      {/* Main panel */}
      <div className="main-panel">
        <JobDetailPanel
          selected={selected}
          wsLogs={wsLogs}
          wsConnected={!!wsRef.current}
        />
      </div>
    </div>
  );
}
