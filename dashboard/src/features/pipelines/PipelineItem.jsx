import { timeAgo } from "../../lib/utils";

export default function PipelineItem({ pipeline, isActive, onClick }) {
  const stepCount = pipeline.steps?.length || 0;
  return (
    <div
      className={`job-item${isActive ? " active" : ""}`}
      onClick={onClick}
    >
      <div className="job-item-task">{pipeline.name}</div>
      <div className="job-item-meta">
        <span className="job-item-repo">
          {stepCount} step{stepCount !== 1 ? "s" : ""}
          {pipeline.repo_url &&
            ` · ${pipeline.repo_url.replace("https://github.com/", "")}`}
        </span>
        <span>{timeAgo(pipeline.created_at)}</span>
      </div>
    </div>
  );
}
