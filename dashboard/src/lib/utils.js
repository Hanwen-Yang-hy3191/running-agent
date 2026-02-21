// ── Status helpers ────────────────────────────────────────────────────────────

export const STATUS_MAP = {
  queued:    "Queued",
  running:   "Running",
  retrying:  "Retrying",
  completed: "Completed",
  failed:    "Failed",
  pending:   "Pending",
};

// ── Time helpers ─────────────────────────────────────────────────────────────

export function timeAgo(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function duration(start, end) {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const rs = sec % 60;
  return `${m}m ${rs}s`;
}

export function formatTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ── Log line colorizer ──────────────────────────────────────────────────────

export function classifyLogLine(line) {
  if (/\[TOOL/.test(line)) return "log-line-tool";
  if (/\[THOUGHT|REASONING/.test(line)) return "log-line-thought";
  if (/\[STEP/.test(line)) return "log-line-step";
  if (/\[SESSION/.test(line)) return "log-line-session";
  if (/ERROR|WARN|error|fail/i.test(line)) return "log-line-error";
  if (/\[FILE/.test(line)) return "log-line-file";
  return "";
}
