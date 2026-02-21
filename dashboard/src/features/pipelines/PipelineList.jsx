import PipelineItem from "./PipelineItem";

export default function PipelineList({ pipelines, loading, selectedId, onSelect }) {
  if (loading) {
    return <div className="no-jobs">Loading...</div>;
  }

  if (pipelines.length === 0) {
    return (
      <div className="no-jobs">No pipelines yet. Create one to get started.</div>
    );
  }

  return (
    <>
      <div className="job-group-label">Pipelines</div>
      {pipelines.map((p) => (
        <PipelineItem
          key={p.pipeline_id}
          pipeline={p}
          isActive={selectedId === p.pipeline_id}
          onClick={() => onSelect(p.pipeline_id)}
        />
      ))}
    </>
  );
}
