import { createOpencode } from "@opencode-ai/sdk";
import type { Event as SdkEvent } from "@opencode-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { runVerification, type VerificationResult } from "./verify.js";
import { generateRepoMap } from "./repomap.js";
import {
  buildPlanningPrompt,
  parsePlan,
  extractTextFromParts,
  formatDiffSummary,
  type TaskPlan,
  type FileDiff,
} from "./planner.js";
import {
  calculateBudget,
  truncateVerificationOutput,
  repoMapBudget,
  buildCompactionConfig,
} from "./context.js";

// Re-alias the SDK's Event union so we can reference it concisely.
type AgentEvent = SdkEvent;

// Type alias for the SDK client returned by createOpencode
type Client = Awaited<ReturnType<typeof createOpencode>>["client"];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKSPACE = process.env.WORKSPACE || "/app/workspace";
const STEP_RESULT_PATH = "/app/step_result.json";
const CHECKPOINT_FILE = "checkpoint.json";
const MAX_ITERATIONS = 5;
const MAX_VERIFICATION_ATTEMPTS = 5;

const TASK_DESCRIPTION =
  process.env.TASK_DESCRIPTION ||
  "Improve the README with a better project description and usage instructions.";

// ---------------------------------------------------------------------------
// Cost & token tracking — reset on each main() invocation for accurate per-session metrics
// ---------------------------------------------------------------------------

// These are initialized inside main() and passed to handleEvent via closure.
// Using a mutable container object so nested functions can update values.
interface CostTracker {
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheRead: number;
}

// ---------------------------------------------------------------------------
// Error similarity detection for Debug Agent Mode (Phase 5)
// ---------------------------------------------------------------------------

interface ErrorSignature {
  normalizedError: string;  // Normalized error text
  attempt: number;
}

/**
 * Normalize error text by removing paths, line numbers, and variable values
 * to enable similarity comparison across different attempts.
 */
function normalizeError(errorText: string): string {
  return errorText
    .replace(/\/[^\s:]+:\d+/g, "<path>")      // Remove file paths with line numbers
    .replace(/\/[^\s:]+/g, "<path>")          // Remove standalone file paths
    .replace(/\b\d+\b/g, "<num>")              // Remove numbers
    .replace(/'[^']*'/g, "'<str>'")            // Normalize single-quoted strings
    .replace(/"[^"]*"/g, '"<str>"')            // Normalize double-quoted strings
    .toLowerCase()
    .slice(0, 500);
}

/**
 * Calculate Jaccard similarity between two strings (word-level).
 * Returns a value between 0 (no similarity) and 1 (identical).
 */
function calculateJaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 0));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 0));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

/**
 * Check if the current error is similar to any previous errors.
 * Uses Jaccard similarity with a configurable threshold (default 0.7).
 */
function isRepeatedError(
  currentError: string,
  previousErrors: ErrorSignature[],
  threshold: number = 0.7
): boolean {
  if (previousErrors.length === 0) return false;

  const normalized = normalizeError(currentError);
  for (const prev of previousErrors) {
    const similarity = calculateJaccardSimilarity(normalized, prev.normalizedError);
    if (similarity >= threshold) {
      log("DEBUG", `Similar error detected (similarity: ${similarity.toFixed(2)})`);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Checkpoint utilities for Session Persistence (Phase 5)
// ---------------------------------------------------------------------------

interface Checkpoint {
  sessionId: string;
  task: string;
  workspace: string;
  gitUrl: string | null;
  branch: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  attempt: number;
  debugMode: boolean;
  errorHistory: ErrorSignature[];
  completedPhases: string[];  // ["explore", "plan", ...]
  messages: Array<{role: string, content: string}>;
  costTracking: CostTracker;
  explorationReport: string | null;
  plan: TaskPlan | null;
}

/**
 * Save checkpoint to the workspace directory.
 * This enables crash recovery and session resumption.
 */
function saveCheckpoint(checkpoint: Checkpoint): void {
  const checkpointPath = path.join(checkpoint.workspace, CHECKPOINT_FILE);
  try {
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
    log("ENGINE", `Checkpoint saved at attempt ${checkpoint.attempt} (debugMode: ${checkpoint.debugMode})`);
  } catch (err) {
    log("ENGINE:WARN", `Failed to save checkpoint: ${err}`);
  }
}

/**
 * Load an existing checkpoint from the workspace directory.
 * Returns null if no checkpoint exists or it's corrupted.
 */
function loadCheckpoint(workspace: string): Checkpoint | null {
  const checkpointPath = path.join(workspace, CHECKPOINT_FILE);
  try {
    if (fs.existsSync(checkpointPath)) {
      const data = fs.readFileSync(checkpointPath, "utf-8");
      const checkpoint = JSON.parse(data) as Checkpoint;
      log("ENGINE", `Checkpoint loaded from ${checkpointPath}`);
      return checkpoint;
    }
  } catch (err) {
    log("ENGINE:WARN", `Failed to load checkpoint: ${err}`);
  }
  return null;
}

/**
 * Clear the checkpoint file after successful completion.
 */
function clearCheckpoint(workspace: string): void {
  const checkpointPath = path.join(workspace, CHECKPOINT_FILE);
  try {
    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath);
      log("ENGINE", "Checkpoint cleared after successful completion.");
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Step context from pipeline execution (set by shared.py's run_agent).
const STEP_CONTEXT: Record<string, unknown> | null = (() => {
  const raw = process.env.STEP_CONTEXT;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("[ENGINE] Failed to parse STEP_CONTEXT:", raw.slice(0, 200));
    return null;
  }
})();

// ---------------------------------------------------------------------------
// System prompts — separate prompts for plan and build agents
// ---------------------------------------------------------------------------

/** System prompt for the plan agent (read-only analysis). */
const PLAN_SYSTEM_PROMPT = `You are a planning agent analyzing a codebase.
Your job is to understand a task and decompose it into executable subtasks.

## Environment
- The repository is at: ${WORKSPACE}
- A repository map is already in context — use it to understand the project structure.
- You have read-only access. Do NOT modify any files.

## Rules
- Focus on analysis and planning only.
- Output structured JSON when asked for a task plan.
- Be precise about which files need to be modified and why.
`;

/** System prompt for the build agent (full read/write/bash access). */
const BUILD_SYSTEM_PROMPT = `You are an autonomous coding agent running inside a cloud sandbox.
Your job is to complete tasks on a codebase. An automated verification system will check your work after each round.

## Environment
- The repository has already been cloned to: ${WORKSPACE}
- You are working inside that directory.
- Git is configured with a valid identity (user.name / user.email).
- The GitHub CLI (\`gh\`) is authenticated and ready to use.
- You have full shell access via bash.
- A **repository map** is already in context — use it to locate files precisely instead of exploring with ls/find.

## Workflow — follow these steps IN ORDER:

1. **Understand the repo**: Review the repository map in context, then read the specific files relevant to your task.
2. **Create a branch** (first subtask only): Run \`git checkout -b agent/<short-descriptive-name>\` from the default branch.
3. **Do the work**: Write code, fix bugs, add features, write tests — whatever the task requires.
4. **Self-verify**: If the project has tests or a build step, run them yourself first.
5. **Commit**: Stage with \`git add -A\` and commit with a clear, conventional commit message.
6. **STOP HERE** — do NOT push or open a PR. The engine handles that.

## Rules
- NEVER push directly to main / master.
- Work on the agent branch (create it on the first subtask, reuse it for subsequent ones).
- Write clean, idiomatic code matching the project's existing style.
- If tests exist, make sure they pass before committing.
- Debug errors and retry — do not give up easily.
- Do NOT push to remote or open a PR until explicitly told to do so.
`;

/** System prompt for the explore agent (Phase 5: codebase exploration). */
const EXPLORE_SYSTEM_PROMPT = `You are a code exploration agent. Your job is to thoroughly understand a codebase.

## Environment
- The repository is at: ${WORKSPACE}
- A repository map is already in context — use it to understand the project structure.
- You have read-only access. Do NOT modify any files.

## Your exploration should cover:
1. **Architecture** - What are the main components and how do they interact?
2. **Entry Points** - Where does execution start? What are the public APIs?
3. **Key Abstractions** - What are the core types/classes/modules?
4. **Dependencies** - What external libraries are used? How?
5. **Patterns** - What coding patterns/conventions are used?

## Output Format
Provide a structured exploration report with:
- Component diagram (text-based)
- Key files and their purposes
- Data flow description
- Any areas of concern or complexity

Be thorough but focused on information relevant to the task.`;

/** System prompt for debug mode (Phase 5: when repeated errors detected). */
const DEBUG_SYSTEM_PROMPT = `You are a debugging specialist. The previous attempts have not resolved the issue.

## Environment
- The repository is at: ${WORKSPACE}
- An automated verification system has detected repeated similar errors.
- Previous fixes have NOT worked — you need to find the ROOT CAUSE.

## Your Goal
Deeply analyze the error and identify the ROOT CAUSE.

## Debugging Methodology
1. **Reproduce** - Understand exactly how the error occurs
2. **Isolate** - Narrow down where the problem is
3. **Hypothesize** - Form a theory about the root cause
4. **Verify** - Check your hypothesis before making changes

## When You Find the Root Cause
- Explain WHY previous fixes didn't work
- Describe the correct fix in detail
- Implement the fix carefully
- Add tests or assertions to prevent regression

## Important
- Do NOT make superficial changes
- Find and fix the ACTUAL problem
- Think deeply about why the error persists`;

// Pipeline context section (appended to task when running as a pipeline step)
const STEP_CONTEXT_SECTION = STEP_CONTEXT
  ? `\n## Pipeline Context\nYou are running as step "${(STEP_CONTEXT as Record<string, unknown>).step_name ?? "unknown"}" in a pipeline.\n\nUpstream step outputs:\n\`\`\`json\n${JSON.stringify((STEP_CONTEXT as Record<string, unknown>).upstream_outputs ?? {}, null, 2)}\n\`\`\`\n`
  : "";

const TASK_PROMPT = `${TASK_DESCRIPTION}${STEP_CONTEXT_SECTION}`;

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

function buildVerificationFailedPrompt(
  result: VerificationResult,
  iteration: number,
  maxIter: number,
): string {
  const errorOutput = result.errorSummary || result.output;
  const truncated = truncateVerificationOutput(errorOutput, 2000);

  return `## Automated Verification Failed (iteration ${iteration}/${maxIter})

The engine ran \`${result.command}\` and it **FAILED** (exit code ${result.exitCode}).

### Error Output
\`\`\`
${truncated}
\`\`\`

Please fix these issues:
1. Read the error output carefully
2. Identify and fix the root cause
3. Run the tests/build yourself to verify your fix
4. Commit your fix with \`git add -A && git commit -m "fix: ..."\`
5. Do NOT push or open a PR yet
`;
}

function buildFinalReviewPrompt(diffSummary: string, allPassed: boolean): string {
  const status = allPassed
    ? "All automated checks passed."
    : `Automated verification did not fully pass after ${MAX_ITERATIONS} attempts. Proceed with known issues noted.`;

  return `## Final Review — Push & PR

${status}

${diffSummary}

### Instructions
1. Review the change summary above
2. If you see any critical issues, fix and commit them now
3. Push your branch: \`git push -u origin HEAD\`
4. Open a PR: \`gh pr create --title "<concise title>" --body "<description of what you did and why${allPassed ? "" : ", including known remaining issues"}>"\`
5. Output the PR URL as your final message
`;
}

/**
 * Build a debug-mode prompt with error history context.
 * Used when repeated similar errors are detected.
 */
function buildDebugPrompt(
  result: VerificationResult,
  iteration: number,
  maxIter: number,
  errorHistory: ErrorSignature[],
): string {
  const errorOutput = result.errorSummary || result.output;
  const truncated = truncateVerificationOutput(errorOutput, 2000);

  // Build a summary of previous error patterns
  const previousPatterns = errorHistory
    .slice(0, -1) // Exclude current error
    .map((e, i) => `Attempt ${e.attempt}: ${e.normalizedError.slice(0, 100)}...`)
    .join("\n");

  return `## Debug Mode Activated (iteration ${iteration}/${maxIter})

The verification system has detected **REPEATED SIMILAR ERRORS**.
Previous fixes have NOT resolved the issue. You must find the ROOT CAUSE.

### Current Error
\`\`\`
${truncated}
\`\`\`

### Previous Error Patterns
${previousPatterns || "(first occurrence)"}

### Your Task
1. **STOP and THINK** - Do not rush to make changes
2. **Analyze** - Why did previous fixes fail?
3. **Isolate** - Where is the actual bug?
4. **Hypothesize** - What is the root cause?
5. **Verify** - Test your hypothesis before making changes
6. **Fix** - Implement the correct fix
7. **Commit**: \`git add -A && git commit -m "fix: ..."\`

Do NOT make superficial changes. Find and fix the ACTUAL problem.`;
}

/**
 * Build an exploration prompt for the explore phase.
 */
function buildExplorePrompt(task: string): string {
  return `Explore this codebase to understand its structure and prepare for the following task:

## Task
${task}

## Instructions
1. Review the repository map provided in context
2. Identify key components and their relationships
3. Understand the architecture and data flow
4. Note any areas of complexity or concern
5. Provide a structured exploration report

Focus on information relevant to the task above. This exploration will help with planning and execution.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(tag: string, message: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${message}`);
}

// ---------------------------------------------------------------------------
// Event listener
// ---------------------------------------------------------------------------

async function listenToEvents(
  client: Client,
  signal: AbortSignal,
  costTracker: CostTracker,
): Promise<void> {
  log("ENGINE", "Subscribing to server event stream...");

  const { stream } = await client.event.subscribe();

  try {
    for await (const event of stream) {
      if (signal.aborted) break;
      handleEvent(event as AgentEvent, costTracker);
    }
  } catch (err: unknown) {
    if (!signal.aborted) {
      log("EVENT:ERROR", `Event stream ended unexpectedly: ${err}`);
    }
  }
}

function handleEvent(event: AgentEvent, costTracker: CostTracker): void {
  switch (event.type) {
    case "message.part.updated": {
      const { part, delta } = event.properties;

      switch (part.type) {
        case "text": {
          if (delta) {
            const preview =
              delta.length > 120 ? delta.slice(0, 120) + "..." : delta;
            log("THOUGHT", preview.replaceAll("\n", "\\n"));
          }
          break;
        }

        case "reasoning": {
          if (delta) {
            const preview =
              delta.length > 120 ? delta.slice(0, 120) + "..." : delta;
            log("REASONING", preview.replaceAll("\n", "\\n"));
          }
          break;
        }

        case "tool": {
          const { tool, state } = part;
          switch (state.status) {
            case "pending":
              log(
                "TOOL:QUEUED",
                `${tool} — input: ${JSON.stringify(state.input).slice(0, 100)}`,
              );
              break;
            case "running":
              log(
                "TOOL:RUNNING",
                `${tool}${state.title ? ` — ${state.title}` : ""}`,
              );
              break;
            case "completed":
              log(
                "TOOL:DONE",
                `${tool} — output: ${state.output.slice(0, 100)}${state.output.length > 100 ? "..." : ""}`,
              );
              break;
            case "error":
              log("TOOL:ERROR", `${tool} — ${state.error}`);
              break;
          }
          break;
        }

        case "step-start": {
          log("STEP", "--- New agentic step started ---");
          break;
        }
        case "step-finish": {
          const { tokens, cost, reason } = part;

          // Accumulate cost and token metrics
          costTracker.totalCost += cost;
          costTracker.totalTokensIn += tokens.input;
          costTracker.totalTokensOut += tokens.output;
          costTracker.totalCacheRead += tokens.cache.read;

          log(
            "STEP",
            `--- Step finished (${reason}) — ` +
              `tokens: ${tokens.input}in/${tokens.output}out ` +
              `(${tokens.cache.read} cached) — ` +
              `cost: $${cost.toFixed(4)} (cumulative: $${costTracker.totalCost.toFixed(4)}) ---`,
          );
          break;
        }

        default:
          log("PART", `${part.type} update`);
          break;
      }
      break;
    }

    case "session.status": {
      const { status, sessionID } = event.properties;
      log("SESSION", `[${sessionID.slice(0, 8)}] Status → ${status.type}`);
      break;
    }

    case "session.idle": {
      log(
        "SESSION",
        `[${event.properties.sessionID.slice(0, 8)}] Agent reached idle state.`,
      );
      break;
    }

    case "session.error": {
      const { error, sessionID } = event.properties;
      log(
        "SESSION:ERROR",
        `[${sessionID?.slice(0, 8) ?? "?"}] ${JSON.stringify(error).slice(0, 200)}`,
      );
      break;
    }

    case "file.edited": {
      log("FILE", `Edited: ${event.properties.file}`);
      break;
    }

    default: {
      log(
        "EVENT",
        `${event.type} — ${JSON.stringify("properties" in event ? event.properties : {}).slice(0, 120)}`,
      );
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: Write step result file (ensures result is written even on error)
// ---------------------------------------------------------------------------

function writeStepResult(result: Record<string, unknown>): void {
  try {
    fs.writeFileSync(STEP_RESULT_PATH, JSON.stringify(result, null, 2));
    log("ENGINE", `Step result written to ${STEP_RESULT_PATH}`);
  } catch (err) {
    log("ENGINE:WARN", `Failed to write step result: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Main — orchestrates the full agent lifecycle with SDK-native features:
//
//   1. Check for existing checkpoint (resume support)
//   2. Boot OpenCode server with agent configs + compaction
//   3. Subscribe to SSE events
//   4. Create a session
//   5. Inject repo map (token-budgeted) via noReply
//   6. Explore phase: understand codebase structure (Phase 5)
//   7. Planning phase: plan agent decomposes task into subtasks
//   8. Execution phase: dispatch subtasks via SubtaskPartInput → build agent
//   9. Verification loop: engine-driven test/build verification (with debug mode)
//  10. Context summarization (for long sessions)
//  11. Final review: session.diff() + push + PR
//  12. Clear checkpoint and shut down
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(64));
  console.log("  Running Agent — v0.8: Debug Agent + Explore + Persistence");
  console.log("=".repeat(64));
  log("ENGINE", `Workspace       : ${WORKSPACE}`);
  log("ENGINE", `Task            : ${TASK_DESCRIPTION.slice(0, 120)}`);
  log("ENGINE", `Max iterations  : ${MAX_ITERATIONS}`);
  console.log();

  // ---------------------------------------------------------------------------
  // Phase 5: Checkpoint Resume - Check for existing checkpoint
  // ---------------------------------------------------------------------------
  const existingCheckpoint = loadCheckpoint(WORKSPACE);

  // Initialize cost tracker for this session (resets on each main() call)
  const costTracker: CostTracker = existingCheckpoint
    ? existingCheckpoint.costTracking
    : {
        totalCost: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCacheRead: 0,
      };

  // Initialize state variables - either from checkpoint or fresh
  let startAttempt: number;
  let debugMode: boolean;
  let errorHistory: ErrorSignature[];
  let completedPhases: string[];
  let explorationReport: string | null;
  let savedPlan: TaskPlan | null;

  if (existingCheckpoint) {
    log("ENGINE", `=== RESUMING from checkpoint at attempt ${existingCheckpoint.attempt} ===`);
    log("ENGINE", `Previous debug mode: ${existingCheckpoint.debugMode}`);
    log("ENGINE", `Completed phases: ${existingCheckpoint.completedPhases.join(", ") || "(none)"}`);

    startAttempt = existingCheckpoint.attempt + 1;
    debugMode = existingCheckpoint.debugMode;
    errorHistory = existingCheckpoint.errorHistory;
    completedPhases = existingCheckpoint.completedPhases;
    explorationReport = existingCheckpoint.explorationReport;
    savedPlan = existingCheckpoint.plan;
  } else {
    startAttempt = 1;
    debugMode = false;
    errorHistory = [];
    completedPhases = [];
    explorationReport = null;
    savedPlan = null;
  }

  // Track error for result file
  let fatalError: string | null = null;

  // -- 1. Start OpenCode server with agent configurations ---------------------
  log("ENGINE", "Starting OpenCode server with plan/build agent configs...");

  const compaction = buildCompactionConfig();

  let client: Client;
  let server: { url: string; close: () => void };

  try {
    const opencode = await createOpencode({
      hostname: "127.0.0.1",
      port: 0,
      config: {
        model: "google/gemini-3-flash-preview",
        compaction,
        agent: {
          plan: {
            model: "google/gemini-2.5-pro",
            // plan agent: read-only analysis, no file modification
          },
          build: {
            model: "google/gemini-3-flash-preview",
            // build agent: full read/write/bash access (default permissions)
          },
          explore: {
            model: "google/gemini-2.5-pro",
            // explore agent: read-only codebase exploration (Phase 5)
          },
        },
      },
    });
    client = opencode.client;
    server = opencode.server;
  } catch (err) {
    fatalError = `Failed to start OpenCode server: ${err}`;
    log("ENGINE:ERROR", fatalError);
    writeStepResult({
      pr_url: null,
      exit_code: 1,
      error: fatalError,
      step_name: STEP_CONTEXT?.step_name ?? null,
    });
    process.exit(1);
    return;
  }

  log("ENGINE", `Server listening at ${server.url}`);

  // -- 2. AbortController for clean shutdown ----------------------------------
  const ac = new AbortController();
  let exiting = false;

  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    log("ENGINE", "Shutting down...");
    ac.abort();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // -- 3. Start the event listener in the background --------------------------
  const eventLoop = listenToEvents(client, ac.signal, costTracker);

  // -- 4. Create a fresh session ----------------------------------------------
  log("ENGINE", "Creating new session...");
  let session: { id: string } | null = null;
  try {
    const { data: sessionData } = await client.session.create({
      query: { directory: WORKSPACE },
    });
    session = sessionData;

    if (!session) {
      throw new Error("Server returned no session data");
    }
  } catch (err) {
    fatalError = `Failed to create session: ${err}`;
    log("ENGINE:ERROR", fatalError);
    writeStepResult({
      pr_url: null,
      exit_code: 1,
      error: fatalError,
      step_name: STEP_CONTEXT?.step_name ?? null,
    });
    shutdown();
    return;
  }

  log("ENGINE", `Session created: ${session.id}`);

  // ---------------------------------------------------------------------------
  // Initialize checkpoint object for persistence
  // ---------------------------------------------------------------------------
  const checkpoint: Checkpoint = {
    sessionId: session.id,
    task: TASK_DESCRIPTION,
    workspace: WORKSPACE,
    gitUrl: null,
    branch: null,
    createdAt: existingCheckpoint?.createdAt || new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    attempt: existingCheckpoint?.attempt || 0,
    debugMode,
    errorHistory,
    completedPhases,
    messages: [],
    costTracking: costTracker,
    explorationReport,
    plan: savedPlan,
  };

  // -- 5. Generate repo map + inject via noReply ------------------------------
  log("ENGINE", "Generating repository map...");
  const mapCharBudget = repoMapBudget();
  const repoMap = generateRepoMap(WORKSPACE, mapCharBudget);
  log(
    "ENGINE",
    `Repo map generated (${repoMap.length} chars, ~${Math.round(repoMap.length / 4)} tokens, budget: ${mapCharBudget} chars)`,
  );

  log("ENGINE", "Injecting repo map into session context (noReply)...");
  try {
    await client.session.prompt({
      path: { id: session.id },
      body: {
        noReply: true,
        parts: [
          {
            type: "text",
            text: `## Repository Map\n\n${repoMap}`,
          },
        ],
      },
    });
    log("ENGINE", "Repo map injected.");
  } catch (err) {
    log("ENGINE:WARN", `Failed to inject repo map: ${err}. Continuing without it.`);
  }

  // Calculate and log context budget
  const budget = calculateBudget(BUILD_SYSTEM_PROMPT, repoMap, TASK_PROMPT);
  log("ENGINE", `Context budget: ${budget.used} tokens used / ${budget.remaining} remaining (${budget.total} total)`);

  // ---------------------------------------------------------------------------
  // Phase 5: Explore Phase - Run before planning if not already completed
  // ---------------------------------------------------------------------------
  if (!completedPhases.includes("explore")) {
    log("ENGINE", "=== Explore Phase (explore agent) ===");
    try {
      const { data: exploreResponse } = await client.session.prompt({
        path: { id: session.id },
        body: {
          agent: "plan", // Use plan agent config for exploration (read-only)
          system: EXPLORE_SYSTEM_PROMPT,
          parts: [
            {
              type: "text",
              text: buildExplorePrompt(TASK_PROMPT),
            },
          ],
        },
      });

      const exploreText = exploreResponse?.parts
        ? extractTextFromParts(exploreResponse.parts as unknown[])
        : "";

      if (exploreText) {
        explorationReport = exploreText;
        log("ENGINE", `Exploration report generated (${explorationReport.length} chars)`);
        log("ENGINE", `Report preview: ${explorationReport.slice(0, 200)}...`);
      }
    } catch (err) {
      log("ENGINE:WARN", `Explore phase failed: ${err}. Continuing without exploration report.`);
    }

    // Mark explore phase as completed and save checkpoint
    completedPhases.push("explore");
    checkpoint.completedPhases = completedPhases;
    checkpoint.explorationReport = explorationReport;
    checkpoint.lastUpdatedAt = new Date().toISOString();
    saveCheckpoint(checkpoint);
  } else {
    log("ENGINE", "Skipping Explore Phase (already completed in checkpoint)");
  }

  // -- 6. Planning phase: plan agent decomposes the task ----------------------
  let plan: TaskPlan | null;

  if (!completedPhases.includes("plan") || !savedPlan) {
    log("ENGINE", "=== Planning Phase (plan agent) ===");

    // Include exploration report in planning context if available
    const planningContext = explorationReport
      ? `\n\n## Exploration Report\n\n${explorationReport}`
      : "";

    let planText = "";
    try {
      const { data: planResponse } = await client.session.prompt({
        path: { id: session.id },
        body: {
          agent: "plan",
          system: PLAN_SYSTEM_PROMPT,
          parts: [
            {
              type: "text",
              text: buildPlanningPrompt(TASK_PROMPT) + planningContext,
            },
          ],
        },
      });

      planText = planResponse?.parts
        ? extractTextFromParts(planResponse.parts as unknown[])
        : "";
    } catch (err) {
      log("ENGINE:WARN", `Plan agent prompt failed: ${err}. Falling back to single-task mode.`);
    }

    // Extract text from response and parse the plan
    plan = parsePlan(planText);

    if (plan) {
      log("ENGINE", `Plan parsed: ${plan.subtasks.length} subtask(s)`);
      log("ENGINE", `Reasoning: ${plan.reasoning}`);
      for (const st of plan.subtasks) {
        log("ENGINE", `  - [${st.name}] ${st.task.slice(0, 100)}`);
      }
    } else {
      // Fallback: treat the entire task as a single subtask
      log(
        "ENGINE:WARN",
        "Plan agent returned empty response or invalid JSON. Falling back to single-task mode.",
      );
      if (planText) {
        log("ENGINE:WARN", `Plan response preview: ${planText.slice(0, 200)}`);
      } else {
        log("ENGINE:WARN", "Plan response was empty.");
      }
      plan = {
        reasoning: "Single-task fallback",
        subtasks: [
          {
            name: "complete-task",
            task: TASK_DESCRIPTION,
            files: [],
          },
        ],
      };
    }

    // Mark plan phase as completed and save checkpoint
    completedPhases.push("plan");
    savedPlan = plan;
    checkpoint.completedPhases = completedPhases;
    checkpoint.plan = plan;
    checkpoint.lastUpdatedAt = new Date().toISOString();
    saveCheckpoint(checkpoint);
  } else {
    plan = savedPlan;
    log("ENGINE", `Skipping Planning Phase (already completed in checkpoint: ${plan.subtasks.length} subtasks)`);
  }

  // -- 7. Execution phase: dispatch subtasks via SubtaskPartInput -------------
  log("ENGINE", `=== Execution Phase (build agent, ${plan.subtasks.length} subtask(s)) ===`);

  // Build SubtaskPartInput array from the plan
  const subtaskParts = plan.subtasks.map((st) => ({
    type: "subtask" as const,
    prompt: st.task + (st.files.length > 0
      ? `\n\nRelevant files: ${st.files.map((f) => `\`${f}\``).join(", ")}`
      : ""),
    description: st.name,
    agent: "build",
  }));

  // Use appropriate system prompt based on debug mode
  const executionSystemPrompt = debugMode ? DEBUG_SYSTEM_PROMPT : BUILD_SYSTEM_PROMPT;
  if (debugMode) {
    log("ENGINE", "Using DEBUG_SYSTEM_PROMPT for execution");
  }

  try {
    await client.session.prompt({
      path: { id: session.id },
      body: {
        agent: "build",
        system: executionSystemPrompt,
        parts: subtaskParts,
      },
    });
    log("ENGINE", "Build agent finished all subtasks.");
  } catch (err) {
    fatalError = `Build agent execution failed: ${err}`;
    log("ENGINE:ERROR", fatalError);
    writeStepResult({
      pr_url: null,
      exit_code: 1,
      error: fatalError,
      step_name: STEP_CONTEXT?.step_name ?? null,
      iterations: 0,
      verification_passed: false,
      subtasks_count: plan.subtasks.length,
      total_cost: Math.round(costTracker.totalCost * 1_000_000) / 1_000_000,
      total_tokens_in: costTracker.totalTokensIn,
      total_tokens_out: costTracker.totalTokensOut,
      total_cache_read: costTracker.totalCacheRead,
      debug_mode: debugMode,
    });
    shutdown();
    return;
  }

  // -- 8. Verification loop with Debug Mode detection (Phase 5) ---------------
  let totalIterations = 0;
  let allPassed = false;
  let lastVerification: VerificationResult | null = null;

  // Resume from the correct attempt number
  for (let i = startAttempt; i <= MAX_VERIFICATION_ATTEMPTS; i++) {
    log("ENGINE", `=== Verification ${i}/${MAX_VERIFICATION_ATTEMPTS} ===`);

    const result = runVerification(WORKSPACE);

    if (!result) {
      log("ENGINE", "No verification command detected. Skipping loop.");
      allPassed = true;
      break;
    }

    lastVerification = result;
    totalIterations = i;

    log("ENGINE", `Command: ${result.command}`);
    log("ENGINE", `Result: ${result.passed ? "PASSED" : "FAILED"} (exit ${result.exitCode})`);

    if (result.passed) {
      log("ENGINE", "Verification passed!");
      allPassed = true;
      break;
    }

    // ---------------------------------------------------------------------------
    // Phase 5: Debug Mode Detection - Check for repeated similar errors
    // ---------------------------------------------------------------------------
    const errorOutput = result.errorSummary || result.output;

    if (!debugMode && isRepeatedError(errorOutput, errorHistory)) {
      debugMode = true;
      log("ENGINE", "=== SWITCHING TO DEBUG MODE - Similar errors detected ===");
    }

    // Record this error in history
    errorHistory.push({
      normalizedError: normalizeError(errorOutput),
      attempt: i,
    });

    // Update checkpoint after each verification attempt
    checkpoint.attempt = i;
    checkpoint.debugMode = debugMode;
    checkpoint.errorHistory = errorHistory;
    checkpoint.lastUpdatedAt = new Date().toISOString();
    checkpoint.costTracking = costTracker;
    saveCheckpoint(checkpoint);

    // Use debug prompt if in debug mode
    const feedbackPrompt = debugMode
      ? buildDebugPrompt(result, i, MAX_VERIFICATION_ATTEMPTS, errorHistory)
      : buildVerificationFailedPrompt(result, i, MAX_VERIFICATION_ATTEMPTS);

    if (debugMode) {
      log("ENGINE", `Sending DEBUG feedback to build agent (iteration ${i})...`);
    } else {
      log("ENGINE", `Sending failure feedback to build agent (iteration ${i})...`);
    }

    try {
      await client.session.prompt({
        path: { id: session.id },
        body: {
          agent: "build",
          system: debugMode ? DEBUG_SYSTEM_PROMPT : undefined,
          parts: [
            {
              type: "text",
              text: feedbackPrompt,
            },
          ],
        },
      });
      log("ENGINE", `Build agent finished fix attempt ${i}.`);
    } catch (err) {
      log("ENGINE:WARN", `Verification feedback prompt failed: ${err}. Continuing with current state.`);
    }
  }

  // -- 9. Summarize session if it's been long (context compression) ----------
  if (totalIterations >= 2 || plan.subtasks.length >= 3) {
    log("ENGINE", "Session has been long — triggering context summarization...");
    try {
      await client.session.summarize({
        sessionID: session.id,
        auto: true,
      });
      log("ENGINE", "Session summarized for context compression.");
    } catch (err) {
      log("ENGINE:WARN", `session.summarize() not available or failed: ${err}`);
    }
  }

  // -- 10. Final review: session.diff() + push + PR ---------------------------
  log("ENGINE", "=== Final Review (session.diff + push + PR) ===");

  // Use session.diff() to get structured diff data from the SDK
  let diffSummary = "";
  try {
    const { data: diffs } = await client.session.diff({
      path: { id: session.id },
    });
    if (diffs) {
      diffSummary = formatDiffSummary(diffs as FileDiff[]);
      log("ENGINE", `session.diff(): ${(diffs as FileDiff[]).length} file(s) changed`);
    }
  } catch (err) {
    log("ENGINE:WARN", `session.diff() failed, falling back to prompt-based review: ${err}`);
    diffSummary = "Could not retrieve diff summary. Run `git diff main..HEAD` to review your changes.";
  }

  try {
    await client.session.prompt({
      path: { id: session.id },
      body: {
        agent: "build",
        parts: [
          {
            type: "text",
            text: buildFinalReviewPrompt(diffSummary, allPassed),
          },
        ],
      },
    });
    log("ENGINE", "Agent finished final review.");
  } catch (err) {
    log("ENGINE:WARN", `Final review prompt failed: ${err}. Continuing to extract results.`);
  }

  // -- 11. Extract PR URL from the most recent assistant message ---------------
  // We only look at the LAST assistant message to avoid picking up example URLs
  // or URLs mentioned in earlier conversation context.
  let prUrl: string | null = null;
  try {
    const { data: messages } = await client.session.messages({
      path: { id: session.id },
    });

    if (messages && Array.isArray(messages)) {
      console.log();
      log("ENGINE", `Total messages in session: ${messages.length}`);

      // Find the last assistant message (where the PR URL would be)
      let lastAssistantMsg: string | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const role = (msg as Record<string, unknown>).role ?? "unknown";
        const msgStr = JSON.stringify(msg);
        log("HISTORY", `[${role}] ${msgStr.slice(0, 150)}`);

        if (role === "assistant") {
          lastAssistantMsg = msgStr;
          break;
        }
      }

      // Extract PR URL only from the last assistant message
      if (lastAssistantMsg) {
        // Match GitHub PR URLs, preferring those created via 'gh pr create'
        // Pattern: https://github.com/owner/repo/pull/number
        const prMatch = lastAssistantMsg.match(
          /https:\/\/github\.com\/[^\s"']+\/pull\/\d+/,
        );
        if (prMatch) {
          prUrl = prMatch[0];
          log("ENGINE", `Extracted PR URL from last assistant message: ${prUrl}`);
        }
      }
    }
  } catch (err) {
    log("ENGINE:WARN", `Failed to extract PR URL: ${err}`);
  }

  // -- 12. Write structured step result ---------------------------------------
  const stepResult: Record<string, unknown> = {
    pr_url: prUrl,
    exit_code: fatalError ? 1 : 0,
    error: fatalError,
    step_name: STEP_CONTEXT?.step_name ?? null,
    iterations: totalIterations,
    verification_passed: allPassed,
    verification_command: lastVerification?.command ?? null,
    project_type: lastVerification?.projectType ?? null,
    subtasks_count: plan.subtasks.length,
    plan_reasoning: plan.reasoning,
    total_cost: Math.round(costTracker.totalCost * 1_000_000) / 1_000_000, // 6 decimal places
    total_tokens_in: costTracker.totalTokensIn,
    total_tokens_out: costTracker.totalTokensOut,
    total_cache_read: costTracker.totalCacheRead,
    // Phase 5 additions
    debug_mode: debugMode,
    error_history_count: errorHistory.length,
    resumed_from_checkpoint: existingCheckpoint !== null,
    exploration_report_generated: explorationReport !== null,
  };

  writeStepResult(stepResult);

  // ---------------------------------------------------------------------------
  // Phase 5: Clear checkpoint on successful completion
  // ---------------------------------------------------------------------------
  clearCheckpoint(WORKSPACE);

  // -- Summary ----------------------------------------------------------------
  console.log();
  log("ENGINE", "=".repeat(50));
  log("ENGINE", `Task complete.`);
  log("ENGINE", `  Plan agent     : google/gemini-2.5-pro`);
  log("ENGINE", `  Build agent    : google/gemini-3-flash-preview`);
  log("ENGINE", `  Subtasks       : ${plan.subtasks.length}`);
  log("ENGINE", `  Iterations     : ${totalIterations}`);
  log("ENGINE", `  Verification   : ${allPassed ? "PASSED" : "FAILED/SKIPPED"}`);
  log("ENGINE", `  Debug mode     : ${debugMode ? "ACTIVATED" : "No"}`);
  log("ENGINE", `  Total cost     : $${costTracker.totalCost.toFixed(4)}`);
  log("ENGINE", `  Tokens in/out  : ${costTracker.totalTokensIn}/${costTracker.totalTokensOut} (${costTracker.totalCacheRead} cached)`);
  log("ENGINE", `  PR URL         : ${prUrl ?? "(none)"}`);
  if (existingCheckpoint) {
    log("ENGINE", `  Resumed from   : checkpoint at attempt ${existingCheckpoint.attempt}`);
  }
  log("ENGINE", "=".repeat(50));

  // -- Teardown ---------------------------------------------------------------
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  log("ENGINE", "Tearing down.");
  shutdown();
  await eventLoop;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
