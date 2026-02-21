import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  fetchPipeline,
  fetchPipelineRuns,
  triggerRun,
  deletePipeline,
} from "../lib/api";
import { timeAgo } from "../lib/utils";
import Badge from "../components/Badge";
import DAGRenderer from "../features/pipelines/DAGRenderer";
import RunHistory from "../features/pipelines/RunHistory";

export default function PipelineDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [pipeline, setPipeline] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        fetchPipeline(id),
        fetchPipelineRuns(id),
      ]);
      setPipeline(p);
      setRuns(Array.isArray(r) ? r : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleRun = async () => {
    setTriggering(true);
    try {
      const result = await triggerRun(id, {});
      navigate(`/runs/${result.run_id}`);
    } catch (e) {
      console.error(e);
      alert("Failed to trigger run: " + e.message);
    } finally {
      setTriggering(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this pipeline and all its data?")) return;
    try {
      await deletePipeline(id);
      navigate("/pipelines");
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) {
    return (
      <div className="main-panel" style={{ padding: 28 }}>
        <div className="empty-state"><p>Loading...</p></div>
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div className="main-panel" style={{ padding: 28 }}>
        <div className="empty-state"><p>Pipeline not found</p></div>
      </div>
    );
  }

  return (
    <div className="pipeline-detail-layout">
      {/* Header */}
      <div className="pipeline-detail-header">
        <button
          className="back-link"
          onClick={() => navigate("/pipelines")}
        >
          ← Pipelines
        </button>
        <h2 className="detail-title">{pipeline.name}</h2>
        <div className="detail-subtitle">
          <span>
            {pipeline.steps?.length || 0} step
            {(pipeline.steps?.length || 0) !== 1 ? "s" : ""}
          </span>
          {pipeline.repo_url && (
            <>
              <span>·</span>
              <span>{pipeline.repo_url.replace("https://github.com/", "")}</span>
            </>
          )}
          <span>·</span>
          <span>Created {timeAgo(pipeline.created_at)}</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            className="submit-btn"
            onClick={handleRun}
            disabled={triggering}
          >
            {triggering ? "Starting..." : "▶ Run Pipeline"}
          </button>
          <button className="btn-secondary" onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      {/* Body: DAG + Run History */}
      <div className="pipeline-detail-body">
        <div className="pipeline-detail-dag">
          <h4 className="form-section-subtitle">DAG Structure</h4>
          <DAGRenderer steps={pipeline.steps} />
        </div>
        <div className="pipeline-detail-runs">
          <RunHistory
            runs={runs}
            onSelect={(runId) => navigate(`/runs/${runId}`)}
          />
        </div>
      </div>
    </div>
  );
}
