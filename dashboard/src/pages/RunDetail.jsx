import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchRun, fetchPipeline, POLL_INTERVAL } from "../lib/api";
import Badge from "../components/Badge";
import { duration, timeAgo } from "../lib/utils";
import DAGRenderer from "../features/pipelines/DAGRenderer";
import RunStepPanel from "../features/pipelines/RunStepPanel";

export default function RunDetail() {
  const { runId } = useParams();
  const navigate = useNavigate();

  const [run, setRun] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedStep, setSelectedStep] = useState(null);

  const pipelineRef = useRef(null);

  const loadRun = useCallback(async () => {
    try {
      const data = await fetchRun(runId);
      setRun(data);

      // Load pipeline definition once for DAG rendering
      if (data.pipeline_id && !pipelineRef.current) {
        const p = await fetchPipeline(data.pipeline_id);
        pipelineRef.current = p;
        setPipeline(p);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { loadRun(); }, [loadRun]);

  // Poll for updates if run is active
  useEffect(() => {
    if (!run) return;
    if (run.status === "completed" || run.status === "failed") return;
    const t = setInterval(loadRun, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [run, loadRun]);

  if (loading) {
    return (
      <div className="main-panel" style={{ padding: 28 }}>
        <div className="empty-state"><p>Loading run...</p></div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="main-panel" style={{ padding: 28 }}>
        <div className="empty-state"><p>Run not found</p></div>
      </div>
    );
  }

  // Build status map from jobs array for DAG coloring
  const statusMap = {};
  const jobByStep = {};
  for (const job of run.jobs || []) {
    if (job.step_name) {
      statusMap[job.step_name] = job.status;
      jobByStep[job.step_name] = job;
    }
  }

  const selectedJob = selectedStep ? jobByStep[selectedStep] : null;
  const steps = pipeline?.steps || [];

  return (
    <div className="run-detail-layout">
      {/* Header bar */}
      <div className="run-detail-header">
        <button
          className="back-link"
          onClick={() =>
            run.pipeline_id
              ? navigate(`/pipelines/${run.pipeline_id}`)
              : navigate("/pipelines")
          }
        >
          ← Pipeline
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Badge status={run.status} />
          <span className="detail-title" style={{ fontSize: 15 }}>
            Run {runId.slice(0, 8)}
          </span>
          {(run.status === "running" || run.status === "pending") && (
            <span className="running-timer">
              {duration(run.started_at, null)}
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {timeAgo(run.created_at)}
          </span>
        </div>
        {run.error && (
          <div className="error-banner" style={{ margin: "8px 0 0" }}>
            {run.error}
          </div>
        )}
      </div>

      {/* Body: DAG + Step Panel */}
      <div className="run-split">
        <div className="run-dag-panel">
          {steps.length > 0 ? (
            <DAGRenderer
              steps={steps}
              statusMap={statusMap}
              onSelect={setSelectedStep}
            />
          ) : (
            <div className="empty-state">
              <p>Pipeline steps not available</p>
            </div>
          )}

          {/* Step summary list below DAG */}
          <div className="run-steps-summary">
            {(run.jobs || []).map((job, i) => (
              <div
                key={job.job_id}
                className={`run-step-row${selectedStep === job.step_name ? " active" : ""}`}
                onClick={() => setSelectedStep(job.step_name)}
              >
                <Badge status={job.status} />
                <span className="run-step-name">{job.step_name || `Step ${i}`}</span>
                <span className="run-step-task">{job.task}</span>
                {job.started_at && (
                  <span className="run-step-duration">
                    {duration(job.started_at, job.completed_at)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <RunStepPanel job={selectedJob} stepName={selectedStep} />
      </div>
    </div>
  );
}
