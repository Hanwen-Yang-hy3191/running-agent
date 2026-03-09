import { describe, it, expect } from "vitest";
import {
  parseReviewVerdict,
  ReviewVerdict,
  shouldAutoApprove,
  shouldRequestChanges,
  formatReviewForPR,
} from "../review.js";

describe("parseReviewVerdict", () => {
  it("should parse a valid approve verdict from JSON", () => {
    const raw = JSON.stringify({
      verdict: "approve",
      confidence: 0.92,
      issues: [],
      summary: "Code looks clean and complete.",
    });
    const result = parseReviewVerdict(raw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("approve");
    expect(result!.confidence).toBe(0.92);
    expect(result!.issues).toHaveLength(0);
  });

  it("should parse verdict from markdown code block", () => {
    const raw = `Here is my review:\n\`\`\`json\n{"verdict":"request_changes","confidence":0.75,"issues":[{"severity":"high","file":"src/main.ts","line":42,"description":"Null pointer risk"}],"summary":"Found a critical issue."}\n\`\`\``;
    const result = parseReviewVerdict(raw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("request_changes");
    expect(result!.issues).toHaveLength(1);
    expect(result!.issues[0].severity).toBe("high");
  });

  it("should return null for unparseable text", () => {
    const result = parseReviewVerdict("I think the code is fine.");
    expect(result).toBeNull();
  });

  it("should reject invalid verdict values", () => {
    const raw = JSON.stringify({
      verdict: "maybe",
      confidence: 0.5,
      issues: [],
      summary: "Not sure.",
    });
    const result = parseReviewVerdict(raw);
    expect(result).toBeNull();
  });

  it("should clamp confidence to 0-1 range", () => {
    const raw = JSON.stringify({
      verdict: "approve",
      confidence: 1.5,
      issues: [],
      summary: "Good.",
    });
    const result = parseReviewVerdict(raw);
    expect(result!.confidence).toBe(1.0);
  });
});

describe("shouldAutoApprove", () => {
  it("returns true for approve with high confidence", () => {
    const v: ReviewVerdict = {
      verdict: "approve",
      confidence: 0.85,
      issues: [],
      summary: "All good.",
    };
    expect(shouldAutoApprove(v)).toBe(true);
  });

  it("returns false for approve with low confidence", () => {
    const v: ReviewVerdict = {
      verdict: "approve",
      confidence: 0.6,
      issues: [],
      summary: "Seems ok.",
    };
    expect(shouldAutoApprove(v)).toBe(false);
  });

  it("returns false for request_changes", () => {
    const v: ReviewVerdict = {
      verdict: "request_changes",
      confidence: 0.95,
      issues: [{ severity: "medium", file: "a.ts", line: 1, description: "x" }],
      summary: "Needs work.",
    };
    expect(shouldAutoApprove(v)).toBe(false);
  });
});

describe("shouldRequestChanges", () => {
  it("returns true for request_changes verdict", () => {
    const v: ReviewVerdict = {
      verdict: "request_changes",
      confidence: 0.9,
      issues: [{ severity: "high", file: "a.ts", line: 1, description: "Bug" }],
      summary: "Fix needed.",
    };
    expect(shouldRequestChanges(v)).toBe(true);
  });

  it("returns false for approve verdict", () => {
    const v: ReviewVerdict = {
      verdict: "approve",
      confidence: 0.9,
      issues: [],
      summary: "Good.",
    };
    expect(shouldRequestChanges(v)).toBe(false);
  });
});

describe("formatReviewForPR", () => {
  it("formats approved review as markdown", () => {
    const v: ReviewVerdict = {
      verdict: "approve",
      confidence: 0.92,
      issues: [],
      summary: "Code is clean and well-structured.",
    };
    const md = formatReviewForPR(v, {
      filesChanged: 3,
      linesAdded: 142,
      linesRemoved: 18,
      testsPassed: true,
      iterations: 2,
      totalCost: 0.034,
    });
    expect(md).toContain("Approved");
    expect(md).toContain("0.92");
    expect(md).toContain("3 files");
    expect(md).toContain("$0.034");
  });

  it("formats review with issues as markdown", () => {
    const v: ReviewVerdict = {
      verdict: "request_changes",
      confidence: 0.85,
      issues: [
        { severity: "high", file: "src/main.ts", line: 42, description: "Null check missing" },
        { severity: "low", file: "src/util.ts", line: 10, description: "Unused import" },
      ],
      summary: "Found critical issues.",
    };
    const md = formatReviewForPR(v, {
      filesChanged: 2,
      linesAdded: 50,
      linesRemoved: 5,
      testsPassed: true,
      iterations: 1,
      totalCost: 0.02,
    });
    expect(md).toContain("high");
    expect(md).toContain("src/main.ts");
    expect(md).toContain("Null check missing");
  });
});
