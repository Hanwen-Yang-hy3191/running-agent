import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { fetchPipelines as apiFetchPipelines, createPipeline, deletePipeline } from "../lib/api";
import PipelineList from "../features/pipelines/PipelineList";
import PipelineForm from "../features/pipelines/PipelineForm";
import DAGRenderer from "../features/pipelines/DAGRenderer";
import { timeAgo } from "../lib/utils";

export default function PipelinesPage() {
  const navigate = useNavigate();
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const data = await apiFetchPipelines();
      setPipelines(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to fetch pipelines:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const selected = pipelines.find((p) => p.pipeline_id === selectedId);

  const handleCreate = async (data) => {
    const result = await createPipeline(data);
    await fetchAll();
    setSelectedId(result.pipeline_id);
    setShowCreate(false);
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this pipeline?")) return;
    await deletePipeline(id);
    setSelectedId(null);
    await fetchAll();
  };

  return (
    <div className="page-split">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-subtitle">
            {pipelines.length} pipeline{pipelines.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="job-list">
          <PipelineList
            pipelines={pipelines}
            loading={loading}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setShowCreate(false);
            }}
          />
        </div>
        <div className="submit-section">
          <button
            className="submit-btn"
            style={{ width: "100%" }}
            onClick={() => {
              setShowCreate(true);
              setSelectedId(null);
            }}
          >
            + Create Pipeline
          </button>
        </div>
      </div>

      {/* Main panel */}
      <div className="main-panel" style={{ overflowY: "auto", padding: 28 }}>
        {showCreate ? (
          <PipelineForm
            onSubmit={handleCreate}
            onCancel={() => setShowCreate(false)}
          />
        ) : selected ? (
          <PipelineDetailInline
            pipeline={selected}
            onDelete={() => handleDelete(selected.pipeline_id)}
            onViewDetail={() => navigate(`/pipelines/${selected.pipeline_id}`)}
          />
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">&#9670;</div>
            <p>Select a pipeline or create a new one</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline pipeline preview shown in the right panel of the list view.
 */
function PipelineDetailInline({ pipeline, onDelete, onViewDetail }) {
  return (
    <div>
      <div className="detail-header" style={{ border: "none", paddingBottom: 0 }}>
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
          <button className="submit-btn" onClick={onViewDetail}>
            View Detail & Run
          </button>
          <button
            className="btn-secondary"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>

      {pipeline.steps?.length > 0 && (
        <div style={{ padding: "20px 0" }}>
          <h4 className="form-section-subtitle" style={{ marginBottom: 12 }}>
            DAG Structure
          </h4>
          <DAGRenderer steps={pipeline.steps} />
        </div>
      )}

      {/* Steps list */}
      <div>
        <h4 className="form-section-subtitle" style={{ marginBottom: 12 }}>Steps</h4>
        {pipeline.steps?.map((step, i) => (
          <div key={i} className="step-row" style={{ marginBottom: 8 }}>
            <div className="step-row-header">
              <span className="step-row-index">{step.name}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: "4px 0" }}>
              {step.task}
            </div>
            {step.depends_on?.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                Depends on: {step.depends_on.join(", ")}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
