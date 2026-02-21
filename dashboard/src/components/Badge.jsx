import { STATUS_MAP } from "../lib/utils";

export default function Badge({ status }) {
  const label = STATUS_MAP[status] || STATUS_MAP.queued || "Unknown";
  return (
    <span className={`badge badge-${status || "queued"}`}>
      <span className="badge-dot" />
      {label}
    </span>
  );
}
