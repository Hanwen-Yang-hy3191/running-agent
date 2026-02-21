import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  STATUS_MAP,
  timeAgo,
  duration,
  formatTime,
  classifyLogLine,
} from "../lib/utils";

describe("STATUS_MAP", () => {
  it("contains all expected statuses", () => {
    expect(STATUS_MAP.queued).toBe("Queued");
    expect(STATUS_MAP.running).toBe("Running");
    expect(STATUS_MAP.retrying).toBe("Retrying");
    expect(STATUS_MAP.completed).toBe("Completed");
    expect(STATUS_MAP.failed).toBe("Failed");
    expect(STATUS_MAP.pending).toBe("Pending");
  });
});

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for falsy input", () => {
    expect(timeAgo(null)).toBe("");
    expect(timeAgo("")).toBe("");
    expect(timeAgo(undefined)).toBe("");
  });

  it("returns seconds for < 60s", () => {
    expect(timeAgo("2025-01-15T11:59:30Z")).toBe("30s ago");
  });

  it("returns minutes for < 60m", () => {
    expect(timeAgo("2025-01-15T11:30:00Z")).toBe("30m ago");
  });

  it("returns hours for < 24h", () => {
    expect(timeAgo("2025-01-15T06:00:00Z")).toBe("6h ago");
  });

  it("returns days for >= 24h", () => {
    expect(timeAgo("2025-01-13T12:00:00Z")).toBe("2d ago");
  });
});

describe("duration", () => {
  it("returns em dash for missing start", () => {
    expect(duration(null, null)).toBe("—");
    expect(duration("", null)).toBe("—");
  });

  it("returns seconds for short durations", () => {
    expect(duration("2025-01-15T12:00:00Z", "2025-01-15T12:00:45Z")).toBe("45s");
  });

  it("returns minutes and seconds", () => {
    expect(duration("2025-01-15T12:00:00Z", "2025-01-15T12:02:30Z")).toBe("2m 30s");
  });
});

describe("formatTime", () => {
  it("returns em dash for missing value", () => {
    expect(formatTime(null)).toBe("—");
    expect(formatTime("")).toBe("—");
  });

  it("formats ISO string to readable time", () => {
    const result = formatTime("2025-01-15T12:30:00Z");
    // Result is locale-dependent, but should be a non-empty string
    expect(result).toBeTruthy();
    expect(result).not.toBe("—");
  });
});

describe("classifyLogLine", () => {
  it("returns tool class for TOOL lines", () => {
    expect(classifyLogLine("[TOOL] execute bash")).toBe("log-line-tool");
  });

  it("returns thought class for THOUGHT lines", () => {
    expect(classifyLogLine("[THOUGHT] thinking about...")).toBe("log-line-thought");
  });

  it("returns step class for STEP lines", () => {
    expect(classifyLogLine("[STEP] step 1 of 3")).toBe("log-line-step");
  });

  it("returns session class for SESSION lines", () => {
    expect(classifyLogLine("[SESSION] connected")).toBe("log-line-session");
  });

  it("returns error class for ERROR lines", () => {
    expect(classifyLogLine("ERROR: something went wrong")).toBe("log-line-error");
    expect(classifyLogLine("Build failed")).toBe("log-line-error");
  });

  it("returns file class for FILE lines", () => {
    expect(classifyLogLine("[FILE] modified src/index.ts")).toBe("log-line-file");
  });

  it("returns empty string for plain log lines", () => {
    expect(classifyLogLine("npm install completed")).toBe("");
  });
});
