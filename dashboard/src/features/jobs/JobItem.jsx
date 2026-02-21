import Badge from "../../components/Badge";
import { timeAgo } from "../../lib/utils";

export default function JobItem({ job, isActive, onClick }) {
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
            onClick={(e) => e.stopPropagation()}
            style={{ color: "var(--green)", fontWeight: 600, marginLeft: 8 }}
          >
            PR &#8599;
          </a>
        )}
      </div>
    </div>
  );
}
