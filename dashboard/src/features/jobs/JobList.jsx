import JobItem from "./JobItem";

export default function JobList({
  jobs,
  loading,
  selectedId,
  onSelect,
}) {
  const activeJobs = jobs.filter((j) =>
    ["queued", "running", "retrying"].includes(j.status)
  );
  const doneJobs = jobs.filter((j) =>
    ["completed", "failed"].includes(j.status)
  );

  if (loading) {
    return <div className="no-jobs">Loading...</div>;
  }

  if (jobs.length === 0) {
    return <div className="no-jobs">No jobs yet. Submit your first task below.</div>;
  }

  return (
    <>
      {activeJobs.length > 0 && (
        <>
          <div className="job-group-label">Active</div>
          {activeJobs.map((job) => (
            <JobItem
              key={job.job_id}
              job={job}
              isActive={selectedId === job.job_id}
              onClick={() => onSelect(job.job_id)}
            />
          ))}
        </>
      )}
      {doneJobs.length > 0 && (
        <>
          <div className="job-group-label">History</div>
          {doneJobs.map((job) => (
            <JobItem
              key={job.job_id}
              job={job}
              isActive={selectedId === job.job_id}
              onClick={() => onSelect(job.job_id)}
            />
          ))}
        </>
      )}
    </>
  );
}
