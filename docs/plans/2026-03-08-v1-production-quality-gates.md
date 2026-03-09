# V1.0 Production Quality Gates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform running-agent into a production-ready V1.0 by adding multi-layer automated quality gates (Review Agent, extended verification, plan validation, PR quality metadata) to minimize errors and reduce need for human review.

**Architecture:** Inspired by the 三省六部 (Three Departments & Six Ministries) model — separation of concerns with independent review/gatekeeping layers. Each quality gate is an independent check that catches different types of errors, following the Swiss Cheese Model from reliability engineering. The Review Agent (门下省) uses a separate LLM session to avoid self-review bias.

**Tech Stack:** TypeScript (agent engine), Python/FastAPI (API), SQLite (data), OpenCode SDK (LLM orchestration), Vitest (TS tests), Pytest (Python tests)

---

## Phase 0: Test Infrastructure Setup

### Task 1: Set Up TypeScript Test Infrastructure (Vitest)

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add vitest devDependency + test script)
- Create: `src/__tests__/sample.test.ts`

**Step 1: Install vitest**

```bash
npm install --save-dev vitest
```

**Step 2: Create vitest config**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/opencode-sdk.d.ts"],
    },
  },
});
```

**Step 3: Add test script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Write a sample test to verify setup**

Create `src/__tests__/sample.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("test infrastructure", () => {
  it("should run tests successfully", () => {
    expect(1 + 1).toBe(2);
  });
});
```

**Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 1 test passed

**Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json src/__tests__/sample.test.ts
git commit -m "chore: add vitest test infrastructure"
```

---

### Task 2: Set Up Python Test Infrastructure (Pytest)

**Files:**
- Modify: `requirements.txt` (add pytest)
- Create: `tests/__init__.py`
- Create: `tests/test_sample.py`

**Step 1: Add pytest to requirements.txt**

Append to `requirements.txt`:
```
pytest>=8.0.0
```

**Step 2: Install pytest**

```bash
pip install -r requirements.txt
```

**Step 3: Write sample test**

Create `tests/__init__.py` (empty file).

Create `tests/test_sample.py`:
```python
def test_sample():
    assert 1 + 1 == 2
```

**Step 4: Run test to verify**

Run: `python -m pytest tests/ -v`
Expected: PASS — 1 test passed

**Step 5: Commit**

```bash
git add requirements.txt tests/
git commit -m "chore: add pytest test infrastructure"
```

---

## Phase 1: Review Agent (门下省) — P0 Priority

This is the highest-impact component. An independent LLM-based code review that runs after build completion, before push/PR.

### Task 3: Create Review Types & Interfaces

**Files:**
- Create: `src/review.ts`
- Create: `src/__tests__/review.test.ts`

**Step 1: Write failing tests for review types and parsing**

Create `src/__tests__/review.test.ts`:
```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `../review.js`

**Step 3: Implement review.ts**

Create `src/review.ts`:
```typescript
// Review Agent module — "门下省" quality gate
// Parses structured review verdicts from LLM output and makes auto-approve decisions.

export interface ReviewIssue {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  description: string;
}

export interface ReviewVerdict {
  verdict: "approve" | "request_changes" | "flag_for_human";
  confidence: number; // 0.0 - 1.0
  issues: ReviewIssue[];
  summary: string;
}

export interface PRMetrics {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  testsPassed: boolean;
  iterations: number;
  totalCost: number;
}

const VALID_VERDICTS = ["approve", "request_changes", "flag_for_human"] as const;
const VALID_SEVERITIES = ["critical", "high", "medium", "low"] as const;
const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Parse a ReviewVerdict from LLM text output.
 * Supports raw JSON or JSON inside a markdown code block.
 */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  // Try to extract JSON from markdown code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

  try {
    const parsed = JSON.parse(jsonStr);

    // Validate verdict
    if (!VALID_VERDICTS.includes(parsed.verdict)) {
      return null;
    }

    // Clamp confidence
    let confidence = Number(parsed.confidence);
    if (isNaN(confidence)) return null;
    confidence = Math.max(0, Math.min(1, confidence));

    // Validate issues array
    const issues: ReviewIssue[] = [];
    if (Array.isArray(parsed.issues)) {
      for (const issue of parsed.issues) {
        if (
          issue &&
          typeof issue.file === "string" &&
          typeof issue.description === "string"
        ) {
          issues.push({
            severity: VALID_SEVERITIES.includes(issue.severity)
              ? issue.severity
              : "medium",
            file: issue.file,
            line: typeof issue.line === "number" ? issue.line : 0,
            description: issue.description,
          });
        }
      }
    }

    return {
      verdict: parsed.verdict as ReviewVerdict["verdict"],
      confidence,
      issues,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch {
    return null;
  }
}

/**
 * Should the PR be auto-approved without human review?
 * Only if verdict is "approve" AND confidence >= threshold.
 */
export function shouldAutoApprove(
  verdict: ReviewVerdict,
  threshold: number = AUTO_APPROVE_CONFIDENCE_THRESHOLD
): boolean {
  return verdict.verdict === "approve" && verdict.confidence >= threshold;
}

/**
 * Should the build agent be asked to fix issues?
 */
export function shouldRequestChanges(verdict: ReviewVerdict): boolean {
  return verdict.verdict === "request_changes";
}

/**
 * Build the review prompt for the Review Agent.
 * This prompt instructs the LLM to produce a structured JSON review.
 */
export function buildReviewPrompt(
  taskDescription: string,
  diffSummary: string,
  verificationPassed: boolean,
  explorationReport: string
): string {
  return `You are a senior code reviewer. Your job is to review the following code changes and produce a structured verdict.

## Original Task
${taskDescription}

## Exploration Report (Codebase Context)
${explorationReport}

## Code Changes (git diff summary)
${diffSummary}

## Verification Status
Tests/Build: ${verificationPassed ? "PASSED" : "FAILED"}

## Review Instructions

Analyze the changes against the original task and produce a JSON verdict with EXACTLY this structure:

\`\`\`json
{
  "verdict": "approve" | "request_changes" | "flag_for_human",
  "confidence": 0.0-1.0,
  "issues": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "file": "path/to/file",
      "line": 42,
      "description": "Description of the issue"
    }
  ],
  "summary": "One paragraph summary of the review"
}
\`\`\`

## Verdict Guidelines
- **"approve"**: Changes correctly and completely implement the task. No critical or high-severity issues.
- **"request_changes"**: There are fixable issues (bugs, missing error handling, incomplete implementation). List them in issues[].
- **"flag_for_human"**: Changes are too risky or ambiguous for automated approval (large refactors, security-sensitive, unclear requirements).

## Confidence Guidelines
- **0.9-1.0**: Very clear-cut case, high certainty in verdict
- **0.7-0.9**: Reasonable certainty, minor ambiguities
- **0.5-0.7**: Significant uncertainty, recommend human review regardless
- **Below 0.5**: Should not happen — use "flag_for_human" instead

## Severity Guidelines
- **critical**: Will cause runtime errors, data loss, or security vulnerabilities
- **high**: Logic errors, missing error handling, incomplete implementation
- **medium**: Code quality issues, poor naming, missing edge cases
- **low**: Style issues, minor improvements, documentation

IMPORTANT: Respond ONLY with the JSON block. No other text.`;
}

/**
 * Build the fix prompt sent back to the build agent when review requests changes.
 */
export function buildReviewFixPrompt(
  verdict: ReviewVerdict,
  iteration: number,
  maxIterations: number
): string {
  const issueList = verdict.issues
    .map(
      (i, idx) =>
        `${idx + 1}. [${i.severity.toUpperCase()}] ${i.file}:${i.line} — ${i.description}`
    )
    .join("\n");

  return `## Code Review Feedback (Review iteration ${iteration}/${maxIterations})

The automated code review found the following issues:

**Summary:** ${verdict.summary}

**Issues to fix:**
${issueList}

Please fix ALL issues listed above. Focus on:
1. Critical and high-severity issues MUST be fixed
2. Medium-severity issues SHOULD be fixed
3. Low-severity issues are optional

After fixing, ensure all tests still pass.`;
}

/**
 * Format the review verdict as markdown for the PR body.
 */
export function formatReviewForPR(
  verdict: ReviewVerdict,
  metrics: PRMetrics
): string {
  const verdictEmoji =
    verdict.verdict === "approve"
      ? "✅ Approved"
      : verdict.verdict === "request_changes"
      ? "🔧 Changes Requested"
      : "👁️ Flagged for Human Review";

  const issuesSection =
    verdict.issues.length > 0
      ? `\n### Issues Found\n| Severity | File | Line | Description |\n|----------|------|------|-------------|\n${verdict.issues
          .map(
            (i) =>
              `| ${i.severity} | \`${i.file}\` | ${i.line} | ${i.description} |`
          )
          .join("\n")}\n`
      : "";

  return `## 🤖 Agent Report

| Metric | Value |
|--------|-------|
| **Review Verdict** | ${verdictEmoji} (confidence: ${verdict.confidence.toFixed(2)}) |
| **Files Changed** | ${metrics.filesChanged} files, +${metrics.linesAdded}/-${metrics.linesRemoved} lines |
| **Tests** | ${metrics.testsPassed ? "✅ Passed" : "❌ Failed"} |
| **Iterations** | ${metrics.iterations} |
| **Cost** | $${metrics.totalCost.toFixed(3)} |

**Summary:** ${verdict.summary}
${issuesSection}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/review.ts src/__tests__/review.test.ts
git commit -m "feat: add Review Agent (门下省) module with verdict parsing and PR formatting"
```

---

### Task 4: Integrate Review Agent into Agent Engine

**Files:**
- Modify: `src/index.ts` — add review phase between build completion and push/PR

**Step 1: Add imports at top of index.ts**

At the top of `src/index.ts`, add:
```typescript
import {
  parseReviewVerdict,
  shouldAutoApprove,
  shouldRequestChanges,
  buildReviewPrompt,
  buildReviewFixPrompt,
  formatReviewForPR,
  ReviewVerdict,
  PRMetrics,
} from "./review.js";
```

**Step 2: Add review constants**

After the existing constants (MAX_ITERATIONS, etc.), add:
```typescript
const MAX_REVIEW_ITERATIONS = 2;
const REQUIRE_HUMAN_REVIEW = process.env.REQUIRE_HUMAN_REVIEW === "true";
```

**Step 3: Add review phase after verification loop, before final review**

In the `main()` function, find the section between the verification loop (step 10) and the context summarization (step 11). Insert a new REVIEW PHASE section:

```typescript
// ============================================================
// STEP 10.5: REVIEW AGENT PHASE (门下省)
// ============================================================
let reviewVerdict: ReviewVerdict | null = null;
let reviewIteration = 0;

if (!SKIP_PR) {
  log("ENGINE", "=== Review Agent Phase (门下省) ===");

  // Get the current diff for review
  const reviewDiffs = await client.session.diff({ path: { id: session.id } });
  const reviewDiffSummary = formatDiffSummary(reviewDiffs.data ?? []);

  for (
    reviewIteration = 1;
    reviewIteration <= MAX_REVIEW_ITERATIONS;
    reviewIteration++
  ) {
    log("REVIEW", `Review iteration ${reviewIteration}/${MAX_REVIEW_ITERATIONS}`);

    // Send review prompt to a FRESH explore agent (independent context)
    const reviewPromptText = buildReviewPrompt(
      task,
      reviewDiffSummary,
      allPassed,
      explorationReport
    );

    const reviewResponse = await client.session.prompt({
      path: { id: session.id },
      body: {
        agent: "explore", // Use explore agent (independent, read-only)
        system:
          "You are an independent code reviewer. Review the provided changes and return ONLY a JSON verdict. Do not modify any files.",
        parts: [{ type: "text" as const, text: reviewPromptText }],
      },
    });

    // Parse the response
    const reviewText = extractTextFromParts(
      (reviewResponse.data as any)?.parts ?? []
    );
    reviewVerdict = parseReviewVerdict(reviewText);

    if (!reviewVerdict) {
      log("REVIEW", "WARNING: Could not parse review verdict, defaulting to flag_for_human");
      reviewVerdict = {
        verdict: "flag_for_human",
        confidence: 0.0,
        issues: [],
        summary: "Review agent produced unparseable output.",
      };
      break;
    }

    log("REVIEW", `Verdict: ${reviewVerdict.verdict} (confidence: ${reviewVerdict.confidence})`);
    log("REVIEW", `Issues: ${reviewVerdict.issues.length} found`);
    log("REVIEW", `Summary: ${reviewVerdict.summary}`);

    if (shouldAutoApprove(reviewVerdict)) {
      log("REVIEW", "✅ Auto-approved by Review Agent");
      break;
    }

    if (
      shouldRequestChanges(reviewVerdict) &&
      reviewIteration < MAX_REVIEW_ITERATIONS
    ) {
      log("REVIEW", "🔧 Requesting changes from Build Agent...");
      // Send fix prompt back to build agent
      const fixPrompt = buildReviewFixPrompt(
        reviewVerdict,
        reviewIteration,
        MAX_REVIEW_ITERATIONS
      );
      await client.session.prompt({
        path: { id: session.id },
        body: {
          agent: "build",
          system: debugMode ? DEBUG_SYSTEM_PROMPT : BUILD_SYSTEM_PROMPT,
          parts: [{ type: "text" as const, text: fixPrompt }],
        },
      });

      // Re-verify after fixes
      log("REVIEW", "Re-running verification after review fixes...");
      const reVerify = runVerification(WORKSPACE);
      if (reVerify) {
        allPassed = reVerify.passed;
        log("REVIEW", `Re-verification: ${allPassed ? "PASSED" : "FAILED"}`);
      }

      // Re-fetch diff for next review iteration
      const newDiffs = await client.session.diff({ path: { id: session.id } });
      const newDiffSummary = formatDiffSummary(newDiffs.data ?? []);
      // Update for next iteration (the reviewPromptText will be rebuilt)
      continue;
    }

    // flag_for_human or low-confidence approve — stop reviewing
    break;
  }
}
```

**Step 4: Modify the final review/push section to use review verdict**

Replace the existing final review section (SKIP_PR guard) with:

```typescript
// ============================================================
// STEP 12: FINAL PUSH + PR
// ============================================================
if (SKIP_PR) {
  log("ENGINE", "=== Skipping Final Review (SKIP_PR=true) ===");
} else {
  const diffs = await client.session.diff({ path: { id: session.id } });
  const diffData = diffs.data ?? [];
  const diffSummary = formatDiffSummary(diffData);

  // Calculate PR metrics
  const prMetrics: PRMetrics = {
    filesChanged: diffData.length,
    linesAdded: diffData.reduce(
      (sum: number, d: any) => sum + (d.additions ?? 0),
      0
    ),
    linesRemoved: diffData.reduce(
      (sum: number, d: any) => sum + (d.deletions ?? 0),
      0
    ),
    testsPassed: allPassed,
    iterations: totalIterations,
    totalCost: costTracker.totalCost,
  };

  // Determine if PR should be draft
  const isDraft =
    REQUIRE_HUMAN_REVIEW ||
    (reviewVerdict && !shouldAutoApprove(reviewVerdict));

  // Build PR body with review metadata
  const reviewSection = reviewVerdict
    ? formatReviewForPR(reviewVerdict, prMetrics)
    : "";

  // Build the final review prompt with PR metadata instructions
  const prTypeNote = isDraft
    ? "Create a DRAFT pull request (use --draft flag) because this requires human review."
    : "Create a regular pull request.";

  const prBodyInstructions = reviewSection
    ? `Include the following at the END of the PR description body:\n\n${reviewSection}`
    : "";

  const finalPrompt = `${buildFinalReviewPrompt(diffSummary, allPassed)}

## Additional PR Instructions
${prTypeNote}
${prBodyInstructions}`;

  log("ENGINE", `=== Final Review & Push (${isDraft ? "DRAFT" : "REGULAR"} PR) ===`);
  await client.session.prompt({
    path: { id: session.id },
    body: {
      agent: "build",
      system: BUILD_SYSTEM_PROMPT,
      parts: [{ type: "text" as const, text: finalPrompt }],
    },
  });
}
```

**Step 5: Add review data to step_result.json**

In the `writeFileSync(STEP_RESULT_PATH, ...)` call, add review fields:

```typescript
const stepResult = {
  pr_url: prUrl,
  exit_code: 0,
  error: null,
  step_name: stepContext?.step_name ?? "standalone",
  iterations: totalIterations,
  verification_passed: allPassed,
  verification_command: verificationResult?.command ?? null,
  project_type: verificationResult?.projectType ?? null,
  subtasks_count: plan?.subtasks?.length ?? 0,
  plan_reasoning: plan?.reasoning ?? null,
  total_cost: costTracker.totalCost,
  total_tokens_in: costTracker.totalTokensIn,
  total_tokens_out: costTracker.totalTokensOut,
  total_cache_read: costTracker.totalCacheRead,
  debug_mode: debugMode,
  error_history_count: errorHistory.length,
  resumed_from_checkpoint: !!existingCheckpoint,
  exploration_report_generated: !!explorationReport,
  // NEW: Review Agent fields
  review_verdict: reviewVerdict?.verdict ?? null,
  review_confidence: reviewVerdict?.confidence ?? null,
  review_issues_count: reviewVerdict?.issues?.length ?? 0,
  review_iterations: reviewIteration,
  review_summary: reviewVerdict?.summary ?? null,
  require_human_review: REQUIRE_HUMAN_REVIEW,
  pr_is_draft: SKIP_PR ? null : (REQUIRE_HUMAN_REVIEW || (reviewVerdict && !shouldAutoApprove(reviewVerdict))),
};
```

**Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate Review Agent phase into agent engine flow"
```

---

### Task 5: Add require_human_review API Parameter

**Files:**
- Modify: `shared.py` — add `require_human_review` param to `run_agent()`
- Modify: `api.py` — accept param from HTTP endpoint
- Create: `tests/test_api_params.py`

**Step 1: Write failing test**

Create `tests/test_api_params.py`:
```python
import os
import json
import pytest


def test_run_agent_sets_require_human_review_env(monkeypatch, tmp_path):
    """Test that run_agent passes REQUIRE_HUMAN_REVIEW env to subprocess."""
    # We can't easily test the full run_agent (it needs npm/opencode),
    # so we test the environment construction logic.
    from shared import run_agent

    # Mock subprocess.run to capture env
    captured_env = {}

    class MockProcess:
        returncode = 0
        stdout = ""
        stderr = ""

    def mock_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return MockProcess()

    monkeypatch.setattr("subprocess.run", mock_run)
    monkeypatch.setattr("shared.STEP_RESULT_PATH", str(tmp_path / "result.json"))

    # Write a fake step_result.json so it doesn't crash
    result_path = tmp_path / "result.json"
    result_path.write_text(json.dumps({"exit_code": 0}))

    try:
        run_agent("test task", require_human_review=True, timeout=5)
    except Exception:
        pass  # Expected — subprocess mock won't work perfectly

    assert captured_env.get("REQUIRE_HUMAN_REVIEW") == "true"


def test_run_agent_default_no_human_review(monkeypatch, tmp_path):
    """Test that REQUIRE_HUMAN_REVIEW is not set by default."""
    from shared import run_agent

    captured_env = {}

    class MockProcess:
        returncode = 0
        stdout = ""
        stderr = ""

    def mock_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return MockProcess()

    monkeypatch.setattr("subprocess.run", mock_run)
    monkeypatch.setattr("shared.STEP_RESULT_PATH", str(tmp_path / "result.json"))

    result_path = tmp_path / "result.json"
    result_path.write_text(json.dumps({"exit_code": 0}))

    try:
        run_agent("test task", timeout=5)
    except Exception:
        pass

    assert "REQUIRE_HUMAN_REVIEW" not in captured_env
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_api_params.py -v`
Expected: FAIL — `run_agent() got an unexpected keyword argument 'require_human_review'`

**Step 3: Add require_human_review to shared.py**

In `shared.py`, modify `run_agent()` signature:
```python
def run_agent(
    task: str,
    step_context: Optional[dict] = None,
    timeout: int = 3000,
    workspace: str = "",
    skip_pr: bool = False,
    require_human_review: bool = False,
) -> dict:
```

In the env construction block within `run_agent()`, add after the `skip_pr` block:
```python
    if require_human_review:
        env["REQUIRE_HUMAN_REVIEW"] = "true"
```

**Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_api_params.py -v`
Expected: PASS

**Step 5: Update api.py to accept require_human_review**

In `api.py`, modify the `/submit` endpoint's request body and the `_run_agent_task_sync` function to accept and pass through `require_human_review`.

In `ep_submit()`, add to the request body parsing:
```python
require_human_review = body.get("require_human_review", False)
```

Pass it through to `_run_agent_task_sync` and then to `run_agent()`.

Also update `_run_pipeline_step_sync` and `_execute_pipeline_steps` to support per-step `require_human_review` from the pipeline step definition.

**Step 6: Commit**

```bash
git add shared.py api.py tests/test_api_params.py
git commit -m "feat: add require_human_review parameter to API and agent runner"
```

---

### Task 6: Store Review Results in SQLite

**Files:**
- Modify: `models.py` — add review columns to jobs table
- Create: `tests/test_models.py`

**Step 1: Write failing test**

Create `tests/test_models.py`:
```python
import os
import json
import tempfile
import pytest

# Override DATA_DIR before importing models
_test_dir = tempfile.mkdtemp()
os.environ["DATA_DIR"] = _test_dir

from models import create_job, get_job, update_job, _get_conn


def test_job_has_review_columns():
    """Jobs table should have review_verdict, review_confidence, review_summary columns."""
    conn = _get_conn()
    cursor = conn.execute("PRAGMA table_info(jobs)")
    columns = {row[1] for row in cursor.fetchall()}
    assert "review_verdict" in columns
    assert "review_confidence" in columns
    assert "review_summary" in columns
    assert "review_issues_count" in columns
    assert "pr_is_draft" in columns
    conn.close()


def test_update_job_with_review_data():
    """Should be able to store review data in a job record."""
    job_id = create_job("https://github.com/test/repo", "Fix bug")
    update_job(job_id, {
        "review_verdict": "approve",
        "review_confidence": 0.92,
        "review_summary": "Code looks clean.",
        "review_issues_count": 0,
        "pr_is_draft": False,
    })
    job = get_job(job_id)
    assert job["review_verdict"] == "approve"
    assert job["review_confidence"] == 0.92
    assert job["pr_is_draft"] == 0  # SQLite stores as int
```

**Step 2: Run to verify it fails**

Run: `python -m pytest tests/test_models.py -v`
Expected: FAIL — columns don't exist

**Step 3: Add review columns to models.py**

In `models.py`, in the `_migrate(conn)` function, add migration statements:
```python
    # v1.0: Review Agent columns
    _add_column(conn, "jobs", "review_verdict", "TEXT")
    _add_column(conn, "jobs", "review_confidence", "REAL")
    _add_column(conn, "jobs", "review_summary", "TEXT")
    _add_column(conn, "jobs", "review_issues_count", "INTEGER")
    _add_column(conn, "jobs", "pr_is_draft", "INTEGER")  # boolean
```

**Step 4: Run to verify it passes**

Run: `python -m pytest tests/test_models.py -v`
Expected: PASS

**Step 5: Update api.py to store review data**

In `_run_agent_task_sync`, where `step_output` is parsed and stored, add:
```python
    # Store review data
    review_data = {}
    if step_output:
        for field in ["review_verdict", "review_confidence", "review_summary",
                       "review_issues_count", "pr_is_draft"]:
            if field in step_output:
                review_data[field] = step_output[field]
    if review_data:
        update_job(job_id, review_data)
```

**Step 6: Commit**

```bash
git add models.py api.py tests/test_models.py
git commit -m "feat: store review agent results in SQLite jobs table"
```

---

## Phase 2: Extended Verification — P0 Priority

### Task 7: Add Lint & Type Check to Verification Pipeline

**Files:**
- Modify: `src/verify.ts` — add lint and type check commands
- Create: `src/__tests__/verify.test.ts`

**Step 1: Write failing tests**

Create `src/__tests__/verify.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { detectExtendedChecks, ExtendedCheck } from "../verify.js";

describe("detectExtendedChecks", () => {
  it("detects eslint in node project with eslint config", () => {
    const checks = detectExtendedChecks("/fake/workspace", "node");
    // This will be tested with mock fs, for now test the structure
    expect(Array.isArray(checks)).toBe(true);
  });

  it("returns ExtendedCheck structure", () => {
    const check: ExtendedCheck = {
      name: "lint",
      command: "npx eslint src/",
      required: false,
    };
    expect(check.name).toBe("lint");
    expect(check.command).toBe("npx eslint src/");
    expect(check.required).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `detectExtendedChecks` not exported

**Step 3: Add extended checks to verify.ts**

Add to `src/verify.ts`:
```typescript
export interface ExtendedCheck {
  name: string;
  command: string;
  required: boolean; // if false, failure is warning only
}

/**
 * Detect additional quality checks beyond test/build.
 */
export function detectExtendedChecks(
  workspace: string,
  projectType: string
): ExtendedCheck[] {
  const checks: ExtendedCheck[] = [];

  if (projectType === "node") {
    // Check for ESLint config
    const eslintConfigs = [
      ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml",
      ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs",
    ];
    const hasEslint = eslintConfigs.some((f) =>
      existsSync(join(workspace, f))
    );
    if (hasEslint) {
      checks.push({
        name: "lint",
        command: "npx eslint . --max-warnings 0",
        required: false,
      });
    }

    // Check for TypeScript
    if (existsSync(join(workspace, "tsconfig.json"))) {
      checks.push({
        name: "typecheck",
        command: "npx tsc --noEmit",
        required: false,
      });
    }
  }

  if (projectType === "python") {
    // Check for ruff or flake8
    if (
      existsSync(join(workspace, "ruff.toml")) ||
      existsSync(join(workspace, "pyproject.toml"))
    ) {
      checks.push({
        name: "lint",
        command: "python -m ruff check .",
        required: false,
      });
    }

    // Check for mypy
    if (existsSync(join(workspace, "mypy.ini")) ||
        existsSync(join(workspace, "pyproject.toml"))) {
      checks.push({
        name: "typecheck",
        command: "python -m mypy . --ignore-missing-imports",
        required: false,
      });
    }
  }

  return checks;
}

/**
 * Run all extended checks, return results.
 */
export function runExtendedChecks(
  workspace: string,
  projectType: string
): { name: string; passed: boolean; output: string }[] {
  const checks = detectExtendedChecks(workspace, projectType);
  const results: { name: string; passed: boolean; output: string }[] = [];

  for (const check of checks) {
    try {
      const output = execSync(check.command, {
        cwd: workspace,
        timeout: 60_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      results.push({ name: check.name, passed: true, output });
    } catch (err: any) {
      const output = (err.stdout ?? "") + "\n" + (err.stderr ?? "");
      results.push({ name: check.name, passed: false, output: output.trim() });
    }
  }

  return results;
}
```

**Step 4: Run tests**

Run: `npm test`
Expected: PASS

**Step 5: Integrate into index.ts verification loop**

After the main verification in `src/index.ts`, add:
```typescript
// Run extended checks (lint, typecheck) — informational
if (verificationResult) {
  const extResults = runExtendedChecks(WORKSPACE, verificationResult.projectType);
  for (const ext of extResults) {
    log("VERIFY", `Extended check [${ext.name}]: ${ext.passed ? "PASS" : "WARN"}`);
  }
}
```

**Step 6: Commit**

```bash
git add src/verify.ts src/__tests__/verify.test.ts src/index.ts
git commit -m "feat: add lint and typecheck to verification pipeline"
```

---

## Phase 3: Plan Validation — P1 Priority

### Task 8: Add Plan Validator

**Files:**
- Modify: `src/planner.ts` — add `validatePlan()` function
- Create: `src/__tests__/planner.test.ts`

**Step 1: Write failing tests**

Create `src/__tests__/planner.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { validatePlan, PlanValidationResult } from "../planner.js";

describe("validatePlan", () => {
  it("accepts a valid plan with reasonable subtasks", () => {
    const result = validatePlan({
      reasoning: "Need to add auth endpoint and tests",
      subtasks: [
        { name: "add-auth-endpoint", task: "Create POST /auth/login endpoint in src/routes/auth.ts" },
        { name: "add-auth-tests", task: "Write tests for auth endpoint in tests/auth.test.ts" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects plan with too many subtasks", () => {
    const result = validatePlan({
      reasoning: "Big refactor",
      subtasks: Array.from({ length: 8 }, (_, i) => ({
        name: `step-${i}`,
        task: `Do thing ${i}`,
      })),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(expect.stringContaining("too many subtasks"));
  });

  it("warns about vague task descriptions", () => {
    const result = validatePlan({
      reasoning: "Fix stuff",
      subtasks: [
        { name: "fix", task: "Fix the code" },
      ],
    });
    expect(result.valid).toBe(true); // Still valid, just warned
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects plan with empty subtasks", () => {
    const result = validatePlan({
      reasoning: "Something",
      subtasks: [],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects plan with duplicate subtask names", () => {
    const result = validatePlan({
      reasoning: "Two things",
      subtasks: [
        { name: "step-1", task: "Do A" },
        { name: "step-1", task: "Do B" },
      ],
    });
    expect(result.valid).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `validatePlan` not exported

**Step 3: Implement validatePlan in planner.ts**

Add to `src/planner.ts`:
```typescript
export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const MAX_SUBTASKS = 6;
const MIN_TASK_DESCRIPTION_LENGTH = 15;
const VAGUE_PATTERNS = /^(fix|update|change|modify|do|handle|add|improve)\s+(the\s+)?(code|stuff|things?|it)$/i;

export function validatePlan(plan: {
  reasoning: string;
  subtasks: { name: string; task: string }[];
}): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check empty subtasks
  if (!plan.subtasks || plan.subtasks.length === 0) {
    errors.push("Plan has no subtasks");
    return { valid: false, errors, warnings };
  }

  // Check too many subtasks
  if (plan.subtasks.length > MAX_SUBTASKS) {
    errors.push(
      `Plan has too many subtasks (${plan.subtasks.length} > ${MAX_SUBTASKS}). Break into a pipeline instead.`
    );
  }

  // Check duplicate names
  const names = plan.subtasks.map((s) => s.name);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) {
    errors.push("Plan has duplicate subtask names");
  }

  // Check each subtask
  for (const subtask of plan.subtasks) {
    if (!subtask.task || subtask.task.length < MIN_TASK_DESCRIPTION_LENGTH) {
      warnings.push(
        `Subtask "${subtask.name}" has a very short description (${subtask.task?.length ?? 0} chars). May be too vague.`
      );
    }

    if (VAGUE_PATTERNS.test(subtask.task?.trim() ?? "")) {
      warnings.push(
        `Subtask "${subtask.name}" has a vague description: "${subtask.task}". Consider being more specific.`
      );
    }
  }

  // Check reasoning
  if (!plan.reasoning || plan.reasoning.length < 10) {
    warnings.push("Plan reasoning is very short. Consider explaining the approach.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
```

**Step 4: Run tests**

Run: `npm test`
Expected: ALL PASS

**Step 5: Integrate into index.ts planning phase**

In the planning phase of `src/index.ts`, after `parsePlan()`, add:
```typescript
if (plan) {
  const validation = validatePlan(plan);
  for (const w of validation.warnings) log("PLAN", `⚠ ${w}`);
  if (!validation.valid) {
    log("PLAN", `❌ Plan validation failed: ${validation.errors.join("; ")}`);
    log("PLAN", "Requesting re-plan...");
    // Re-plan once (simplified — just log for now, can add retry later)
  }
}
```

**Step 6: Commit**

```bash
git add src/planner.ts src/__tests__/planner.test.ts src/index.ts
git commit -m "feat: add plan validation with subtask count, duplication, and vagueness checks"
```

---

## Phase 4: Dashboard & Observability — P1 Priority

### Task 9: Update Dashboard to Show Review Verdicts

**Files:**
- Modify: `dashboard/src/App.jsx`

**Step 1: Add review badge component**

In `App.jsx`, add a new `ReviewBadge` component:
```jsx
function ReviewBadge({ verdict, confidence }) {
  if (!verdict) return null;
  const styles = {
    approve: { bg: "#dcfce7", color: "#166534", label: "✅ Approved" },
    request_changes: { bg: "#fef3c7", color: "#92400e", label: "🔧 Changes" },
    flag_for_human: { bg: "#fce7f3", color: "#9d174d", label: "👁️ Needs Review" },
  };
  const style = styles[verdict] || styles.flag_for_human;
  return (
    <span style={{
      padding: "2px 8px",
      borderRadius: "4px",
      fontSize: "0.8em",
      backgroundColor: style.bg,
      color: style.color,
    }}>
      {style.label} ({(confidence * 100).toFixed(0)}%)
    </span>
  );
}
```

**Step 2: Add review section to job detail view**

In the job detail section of `App.jsx`, add after the existing metrics:
```jsx
{job.review_verdict && (
  <div style={{ marginTop: "12px", padding: "12px", border: "1px solid #e5e7eb", borderRadius: "8px" }}>
    <h4 style={{ margin: "0 0 8px 0" }}>🤖 Review Agent</h4>
    <ReviewBadge verdict={job.review_verdict} confidence={job.review_confidence} />
    {job.review_summary && <p style={{ margin: "8px 0 0 0", fontSize: "0.9em" }}>{job.review_summary}</p>}
    {job.review_issues_count > 0 && (
      <p style={{ margin: "4px 0 0 0", fontSize: "0.85em", color: "#6b7280" }}>
        {job.review_issues_count} issue(s) found
      </p>
    )}
    {job.pr_is_draft && (
      <p style={{ margin: "4px 0 0 0", fontSize: "0.85em", color: "#92400e" }}>
        ⚠ PR created as Draft — human review required
      </p>
    )}
  </div>
)}
```

**Step 3: Add review column to jobs list table**

In the jobs list table, add a new column:
```jsx
<th>Review</th>
// ... in rows:
<td><ReviewBadge verdict={job.review_verdict} confidence={job.review_confidence} /></td>
```

**Step 4: Commit**

```bash
git add dashboard/src/App.jsx
git commit -m "feat: add review verdict display to dashboard"
```

---

### Task 10: Add /health Extended Endpoint with System Info

**Files:**
- Modify: `api.py` — enhance /health endpoint

**Step 1: Add system metrics to health check**

Update the `/health` endpoint:
```python
@app.get("/health")
def ep_health():
    job_stats = get_job_stats()  # New function
    return {
        "status": "ok",
        "version": "1.0.0",
        "timestamp": datetime.utcnow().isoformat(),
        "stats": {
            "total_jobs": job_stats["total"],
            "completed_jobs": job_stats["completed"],
            "failed_jobs": job_stats["failed"],
            "running_jobs": job_stats["running"],
            "auto_approved_prs": job_stats["auto_approved"],
            "human_review_prs": job_stats["human_review"],
        },
    }
```

**Step 2: Add get_job_stats() to models.py**

```python
def get_job_stats() -> dict:
    conn = _get_conn()
    try:
        row = conn.execute("""
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
                SUM(CASE WHEN review_verdict='approve' AND pr_is_draft=0 THEN 1 ELSE 0 END) as auto_approved,
                SUM(CASE WHEN pr_is_draft=1 THEN 1 ELSE 0 END) as human_review
            FROM jobs
        """).fetchone()
        return {
            "total": row[0] or 0,
            "completed": row[1] or 0,
            "failed": row[2] or 0,
            "running": row[3] or 0,
            "auto_approved": row[4] or 0,
            "human_review": row[5] or 0,
        }
    finally:
        conn.close()
```

**Step 3: Commit**

```bash
git add api.py models.py
git commit -m "feat: add job statistics and version to health endpoint"
```

---

## Phase 5: Update Dockerfile, README, and API Docs

### Task 11: Update Dockerfile for V1.0

**Files:**
- Modify: `Dockerfile` — add pytest to the image

**Step 1: Add pytest to pip install**

In the Dockerfile, the `pip install` line should ensure `requirements.txt` includes pytest (it does after Task 2).

No additional changes needed if requirements.txt is already updated.

**Step 2: Commit (if changes made)**

```bash
git add Dockerfile
git commit -m "chore: update Dockerfile for V1.0"
```

---

### Task 12: Update README for V1.0

**Files:**
- Modify: `README.md`

**Step 1: Update README with V1.0 features**

Add a V1.0 section documenting:
- Review Agent (门下省) — automated code review before PR
- Extended verification (lint + typecheck)
- Plan validation
- `require_human_review` API parameter
- PR quality metadata
- Dashboard review verdicts
- New API response fields

Update the architecture diagram to show the review phase.

Update the version number to 1.0.0.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for V1.0 with quality gates documentation"
```

---

### Task 13: Integration Test — Full Pipeline with Review Agent

**Files:**
- Create: `tests/test_integration.py`

**Step 1: Write integration test**

Create a test that verifies the full flow works end-to-end by submitting a simple task and checking:
1. Job is created
2. Review fields are populated after completion
3. PR metadata is present in result

```python
"""
Integration test — requires Docker environment.
Run with: docker compose exec agent python -m pytest tests/test_integration.py -v
"""
import os
import time
import json
import pytest
import requests

API_URL = os.environ.get("API_URL", "http://localhost:8000")
SKIP_INTEGRATION = not os.environ.get("RUN_INTEGRATION_TESTS")


@pytest.mark.skipif(SKIP_INTEGRATION, reason="Set RUN_INTEGRATION_TESTS=1 to run")
class TestIntegration:
    def test_health_has_version(self):
        resp = requests.get(f"{API_URL}/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["version"] == "1.0.0"
        assert "stats" in data

    def test_submit_with_require_human_review(self):
        """Submit a task with require_human_review=true and verify it's accepted."""
        resp = requests.post(f"{API_URL}/submit", json={
            "repo_url": "https://github.com/test/repo",
            "task": "Add a hello world function",
            "require_human_review": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "job_id" in data
```

**Step 2: Commit**

```bash
git add tests/test_integration.py
git commit -m "test: add integration test scaffolding for V1.0 quality gates"
```

---

### Task 14: Final Verification & Tag

**Step 1: Run all unit tests**

```bash
npm test
python -m pytest tests/ -v
```
Expected: ALL PASS

**Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: No errors

**Step 3: Build Docker image**

```bash
docker compose build agent
```
Expected: Success

**Step 4: Tag V1.0**

```bash
git tag -a v1.0.0 -m "V1.0: Production quality gates with Review Agent"
```

---

## Summary of Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `package.json` | Modify | Add vitest devDep + test scripts |
| `vitest.config.ts` | Create | Vitest configuration |
| `requirements.txt` | Modify | Add pytest |
| `src/review.ts` | Create | Review Agent module (门下省) — verdict parsing, prompts, PR formatting |
| `src/index.ts` | Modify | Integrate review phase, REQUIRE_HUMAN_REVIEW, draft PR logic |
| `src/verify.ts` | Modify | Add lint + typecheck extended checks |
| `src/planner.ts` | Modify | Add plan validation |
| `shared.py` | Modify | Add require_human_review parameter |
| `api.py` | Modify | Accept require_human_review, store review data |
| `models.py` | Modify | Add review columns, job stats query |
| `dashboard/src/App.jsx` | Modify | Review verdict display |
| `README.md` | Modify | V1.0 documentation |
| `src/__tests__/review.test.ts` | Create | Review module tests |
| `src/__tests__/verify.test.ts` | Create | Verify module tests |
| `src/__tests__/planner.test.ts` | Create | Planner validation tests |
| `tests/test_api_params.py` | Create | Python API parameter tests |
| `tests/test_models.py` | Create | SQLite model tests |
| `tests/test_integration.py` | Create | Integration test scaffolding |

## Execution Order

```
Phase 0: Test Infrastructure (Tasks 1-2) — foundation
    ↓
Phase 1: Review Agent (Tasks 3-6) — highest impact
    ↓
Phase 2: Extended Verification (Task 7) — quick win
    ↓
Phase 3: Plan Validation (Task 8) — moderate impact
    ↓
Phase 4: Dashboard & Observability (Tasks 9-10) — user-facing
    ↓
Phase 5: Finalization (Tasks 11-14) — docs, build, tag
```

Total: 14 tasks, estimated 2-3 hours of implementation time.
