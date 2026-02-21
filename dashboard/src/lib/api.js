// ── API Client ───────────────────────────────────────────────────────────────

export const API_BASE = "https://hanwen-yang-hy3191--agent-api-api.modal.run";
export const WS_BASE = API_BASE.replace(/^http/, "ws");
export const POLL_INTERVAL = 5000;

/**
 * Generic fetch wrapper. Returns parsed JSON.
 */
export async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Job endpoints ────────────────────────────────────────────────────────────

export function fetchJobs() {
  return api("/jobs");
}

export function fetchJobResult(jobId) {
  return api(`/result/${jobId}`);
}

export function submitJob(data) {
  return api("/submit", { method: "POST", body: JSON.stringify(data) });
}

// ── Pipeline endpoints ───────────────────────────────────────────────────────

export function fetchPipelines() {
  return api("/pipelines");
}

export function fetchPipeline(id) {
  return api(`/pipelines/${id}`);
}

export function createPipeline(data) {
  return api("/pipelines", { method: "POST", body: JSON.stringify(data) });
}

export function deletePipeline(id) {
  return api(`/pipelines/${id}`, { method: "DELETE" });
}

// ── Pipeline run endpoints ───────────────────────────────────────────────────

export function triggerRun(pipelineId, data = {}) {
  return api(`/pipelines/${pipelineId}/run`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function fetchPipelineRuns(pipelineId) {
  return api(`/pipelines/${pipelineId}/runs`);
}

export function fetchRun(runId) {
  return api(`/runs/${runId}`);
}
