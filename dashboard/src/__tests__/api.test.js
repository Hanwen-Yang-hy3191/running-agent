import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  api,
  API_BASE,
  fetchJobs,
  fetchJobResult,
  submitJob,
  fetchPipelines,
  fetchPipeline,
  createPipeline,
  deletePipeline,
  triggerRun,
  fetchPipelineRuns,
  fetchRun,
} from "../lib/api";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockOk(data) {
  return { ok: true, json: () => Promise.resolve(data) };
}

function mockError(status, data = {}) {
  return { ok: false, status, json: () => Promise.resolve(data) };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("api() wrapper", () => {
  it("calls fetch with correct URL and headers", async () => {
    mockFetch.mockResolvedValue(mockOk({ status: "ok" }));
    await api("/health");
    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/health`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("returns parsed JSON on success", async () => {
    mockFetch.mockResolvedValue(mockOk({ data: 42 }));
    const result = await api("/test");
    expect(result).toEqual({ data: 42 });
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValue(mockError(404, { error: "not found" }));
    await expect(api("/missing")).rejects.toThrow("not found");
  });

  it("throws with status code when no error message", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(),
    });
    await expect(api("/broken")).rejects.toThrow("HTTP 500");
  });
});

describe("Job endpoint functions", () => {
  it("fetchJobs calls GET /jobs", async () => {
    mockFetch.mockResolvedValue(mockOk([{ job_id: "1" }]));
    const result = await fetchJobs();
    expect(result).toEqual([{ job_id: "1" }]);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/jobs"),
      expect.any(Object)
    );
  });

  it("fetchJobResult calls GET /result/:id", async () => {
    mockFetch.mockResolvedValue(mockOk({ job_id: "abc", logs: [] }));
    await fetchJobResult("abc");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/result/abc"),
      expect.any(Object)
    );
  });

  it("submitJob calls POST /submit with body", async () => {
    mockFetch.mockResolvedValue(mockOk({ job_id: "new" }));
    await submitJob({ repo_url: "https://github.com/test/repo", task: "fix bugs" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/submit"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("fix bugs"),
      })
    );
  });
});

describe("Pipeline endpoint functions", () => {
  it("fetchPipelines calls GET /pipelines", async () => {
    mockFetch.mockResolvedValue(mockOk([]));
    await fetchPipelines();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/pipelines"),
      expect.any(Object)
    );
  });

  it("fetchPipeline calls GET /pipelines/:id", async () => {
    mockFetch.mockResolvedValue(mockOk({ pipeline_id: "p1" }));
    await fetchPipeline("p1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/pipelines/p1"),
      expect.any(Object)
    );
  });

  it("createPipeline calls POST /pipelines", async () => {
    mockFetch.mockResolvedValue(mockOk({ pipeline_id: "p2" }));
    await createPipeline({ name: "CI", steps: [] });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/pipelines"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("deletePipeline calls DELETE /pipelines/:id", async () => {
    mockFetch.mockResolvedValue(mockOk({ deleted: true }));
    await deletePipeline("p1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/pipelines/p1"),
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("triggerRun calls POST /pipelines/:id/run", async () => {
    mockFetch.mockResolvedValue(mockOk({ run_id: "r1" }));
    await triggerRun("p1", { repo_url: "https://github.com/test/repo" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/pipelines/p1/run"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("fetchPipelineRuns calls GET /pipelines/:id/runs", async () => {
    mockFetch.mockResolvedValue(mockOk([]));
    await fetchPipelineRuns("p1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/pipelines/p1/runs"),
      expect.any(Object)
    );
  });

  it("fetchRun calls GET /runs/:id", async () => {
    mockFetch.mockResolvedValue(mockOk({ run_id: "r1", jobs: [] }));
    await fetchRun("r1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/runs/r1"),
      expect.any(Object)
    );
  });
});
