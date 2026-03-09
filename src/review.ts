// Review Agent module — "門下省" quality gate
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
 * Parse a ReviewVerdict from raw LLM text output.
 * Handles both raw JSON strings and JSON embedded in markdown code blocks.
 * Returns null if the text cannot be parsed into a valid verdict.
 */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!VALID_VERDICTS.includes(parsed.verdict)) return null;

    let confidence = Number(parsed.confidence);
    if (isNaN(confidence)) return null;
    confidence = Math.max(0, Math.min(1, confidence));

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
 * Determine whether a review verdict qualifies for automatic approval.
 * Requires "approve" verdict with confidence at or above the threshold.
 */
export function shouldAutoApprove(
  verdict: ReviewVerdict,
  threshold: number = AUTO_APPROVE_CONFIDENCE_THRESHOLD,
): boolean {
  return verdict.verdict === "approve" && verdict.confidence >= threshold;
}

/**
 * Determine whether a review verdict indicates changes should be requested.
 */
export function shouldRequestChanges(verdict: ReviewVerdict): boolean {
  return verdict.verdict === "request_changes";
}

/**
 * Build the system/user prompt for the review agent to evaluate code changes.
 */
export function buildReviewPrompt(
  taskDescription: string,
  diffSummary: string,
  verificationPassed: boolean,
  explorationReport: string,
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

IMPORTANT: Respond ONLY with the JSON block. No other text.`;
}

/**
 * Build a prompt instructing the coding agent to fix issues found during review.
 */
export function buildReviewFixPrompt(
  verdict: ReviewVerdict,
  iteration: number,
  maxIterations: number,
): string {
  const issueList = verdict.issues
    .map(
      (i, idx) =>
        `${idx + 1}. [${i.severity.toUpperCase()}] ${i.file}:${i.line} — ${i.description}`,
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
 * Format a review verdict and PR metrics into a markdown body suitable for a PR comment.
 */
export function formatReviewForPR(
  verdict: ReviewVerdict,
  metrics: PRMetrics,
): string {
  const verdictEmoji =
    verdict.verdict === "approve"
      ? "Approved"
      : verdict.verdict === "request_changes"
        ? "Changes Requested"
        : "Flagged for Human Review";

  const issuesSection =
    verdict.issues.length > 0
      ? `\n### Issues Found\n| Severity | File | Line | Description |\n|----------|------|------|-------------|\n${verdict.issues
          .map(
            (i) =>
              `| ${i.severity} | \`${i.file}\` | ${i.line} | ${i.description} |`,
          )
          .join("\n")}\n`
      : "";

  return `## Agent Report

| Metric | Value |
|--------|-------|
| **Review Verdict** | ${verdictEmoji} (confidence: ${verdict.confidence.toFixed(2)}) |
| **Files Changed** | ${metrics.filesChanged} files, +${metrics.linesAdded}/-${metrics.linesRemoved} lines |
| **Tests** | ${metrics.testsPassed ? "Passed" : "Failed"} |
| **Iterations** | ${metrics.iterations} |
| **Cost** | $${metrics.totalCost.toFixed(3)} |

**Summary:** ${verdict.summary}
${issuesSection}`;
}
