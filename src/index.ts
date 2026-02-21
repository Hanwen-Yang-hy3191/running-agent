import { createOpencode } from "@opencode-ai/sdk";
import type { Event as SdkEvent } from "@opencode-ai/sdk";
import fs from "node:fs";
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
const MAX_ITERATIONS = 5;

const TASK_DESCRIPTION =
  process.env.TASK_DESCRIPTION ||
  "Improve the README with a better project description and usage instructions.";

// ---------------------------------------------------------------------------
// Cost & token tracking — accumulated across all agent steps
// ---------------------------------------------------------------------------

let totalCost = 0;
let totalTokensIn = 0;
let totalTokensOut = 0;
let totalCacheRead = 0;

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
): Promise<void> {
  log("ENGINE", "Subscribing to server event stream...");

  const { stream } = await client.event.subscribe();

  try {
    for await (const event of stream) {
      if (signal.aborted) break;
      handleEvent(event as AgentEvent);
    }
  } catch (err: unknown) {
    if (!signal.aborted) {
      log("EVENT:ERROR", `Event stream ended unexpectedly: ${err}`);
    }
  }
}

function handleEvent(event: AgentEvent): void {
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
          totalCost += cost;
          totalTokensIn += tokens.input;
          totalTokensOut += tokens.output;
          totalCacheRead += tokens.cache.read;

          log(
            "STEP",
            `--- Step finished (${reason}) — ` +
              `tokens: ${tokens.input}in/${tokens.output}out ` +
              `(${tokens.cache.read} cached) — ` +
              `cost: $${cost.toFixed(4)} (cumulative: $${totalCost.toFixed(4)}) ---`,
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
// Main — orchestrates the full agent lifecycle with SDK-native features:
//
//   1. Boot OpenCode server with agent configs + compaction
//   2. Subscribe to SSE events
//   3. Create a session
//   4. Inject repo map (token-budgeted) via noReply
//   5. Planning phase: plan agent decomposes task into subtasks
//   6. Execution phase: dispatch subtasks via SubtaskPartInput → build agent
//   7. Verification loop: engine-driven test/build verification
//   8. Context summarization (for long sessions)
//   9. Final review: session.diff() + push + PR
//  10. Shut down
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(64));
  console.log("  Running Agent — v0.7: Smart Context + Workspace Persistence");
  console.log("=".repeat(64));
  log("ENGINE", `Workspace       : ${WORKSPACE}`);
  log("ENGINE", `Task            : ${TASK_DESCRIPTION.slice(0, 120)}`);
  log("ENGINE", `Max iterations  : ${MAX_ITERATIONS}`);
  console.log();

  // -- 1. Start OpenCode server with agent configurations ---------------------
  log("ENGINE", "Starting OpenCode server with plan/build agent configs...");

  const compaction = buildCompactionConfig();

  const { client, server } = await createOpencode({
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
      },
    },
  });

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
  const eventLoop = listenToEvents(client, ac.signal);

  // -- 4. Create a fresh session ----------------------------------------------
  log("ENGINE", "Creating new session...");
  const { data: session } = await client.session.create({
    query: { directory: WORKSPACE },
  });

  if (!session) {
    log("ENGINE:ERROR", "Failed to create session — server returned no data.");
    shutdown();
    return;
  }

  log("ENGINE", `Session created: ${session.id}`);

  // -- 5. Generate repo map + inject via noReply ------------------------------
  log("ENGINE", "Generating repository map...");
  const mapCharBudget = repoMapBudget();
  const repoMap = generateRepoMap(WORKSPACE, mapCharBudget);
  log(
    "ENGINE",
    `Repo map generated (${repoMap.length} chars, ~${Math.round(repoMap.length / 4)} tokens, budget: ${mapCharBudget} chars)`,
  );

  log("ENGINE", "Injecting repo map into session context (noReply)...");
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

  // Calculate and log context budget
  const budget = calculateBudget(BUILD_SYSTEM_PROMPT, repoMap, TASK_PROMPT);
  log("ENGINE", `Context budget: ${budget.used} tokens used / ${budget.remaining} remaining (${budget.total} total)`);

  // -- 6. Planning phase: plan agent decomposes the task ----------------------
  log("ENGINE", "=== Planning Phase (plan agent) ===");

  const { data: planResponse } = await client.session.prompt({
    path: { id: session.id },
    body: {
      agent: "plan",
      system: PLAN_SYSTEM_PROMPT,
      parts: [
        {
          type: "text",
          text: buildPlanningPrompt(TASK_PROMPT),
        },
      ],
    },
  });

  // Extract text from response and parse the plan
  const planText = planResponse?.parts
    ? extractTextFromParts(planResponse.parts as unknown[])
    : "";

  let plan: TaskPlan | null = parsePlan(planText);

  if (plan) {
    log("ENGINE", `Plan parsed: ${plan.subtasks.length} subtask(s)`);
    log("ENGINE", `Reasoning: ${plan.reasoning}`);
    for (const st of plan.subtasks) {
      log("ENGINE", `  - [${st.name}] ${st.task.slice(0, 100)}`);
    }
  } else {
    // Fallback: treat the entire task as a single subtask
    log(
      "ENGINE",
      "Could not parse structured plan. Falling back to single-task mode.",
    );
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

  await client.session.prompt({
    path: { id: session.id },
    body: {
      agent: "build",
      system: BUILD_SYSTEM_PROMPT,
      parts: subtaskParts,
    },
  });

  log("ENGINE", "Build agent finished all subtasks.");

  // -- 8. Verification loop ---------------------------------------------------
  let totalIterations = 0;
  let allPassed = false;
  let lastVerification: VerificationResult | null = null;

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    log("ENGINE", `=== Verification ${i}/${MAX_ITERATIONS} ===`);

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

    log("ENGINE", `Sending failure feedback to build agent (iteration ${i})...`);

    await client.session.prompt({
      path: { id: session.id },
      body: {
        agent: "build",
        parts: [
          {
            type: "text",
            text: buildVerificationFailedPrompt(result, i, MAX_ITERATIONS),
          },
        ],
      },
    });

    log("ENGINE", `Build agent finished fix attempt ${i}.`);
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

  // -- 11. Extract PR URL from message history --------------------------------
  const { data: messages } = await client.session.messages({
    path: { id: session.id },
  });

  let prUrl: string | null = null;
  if (messages && Array.isArray(messages)) {
    console.log();
    log("ENGINE", `Total messages in session: ${messages.length}`);
    for (const msg of messages) {
      const role = (msg as Record<string, unknown>).role ?? "unknown";
      const msgStr = JSON.stringify(msg);
      log("HISTORY", `[${role}] ${msgStr.slice(0, 150)}`);

      const prMatch = msgStr.match(
        /https:\/\/github\.com\/[^\s"']+\/pull\/\d+/,
      );
      if (prMatch) {
        prUrl = prMatch[0];
      }
    }
  }

  // -- 12. Write structured step result ---------------------------------------
  const stepResult: Record<string, unknown> = {
    pr_url: prUrl,
    exit_code: 0,
    step_name: STEP_CONTEXT
      ? (STEP_CONTEXT as Record<string, unknown>).step_name
      : null,
    iterations: totalIterations,
    verification_passed: allPassed,
    verification_command: lastVerification?.command ?? null,
    project_type: lastVerification?.projectType ?? null,
    subtasks_count: plan.subtasks.length,
    plan_reasoning: plan.reasoning,
    total_cost: Math.round(totalCost * 1_000_000) / 1_000_000, // 6 decimal places
    total_tokens_in: totalTokensIn,
    total_tokens_out: totalTokensOut,
    total_cache_read: totalCacheRead,
  };

  try {
    fs.writeFileSync(STEP_RESULT_PATH, JSON.stringify(stepResult, null, 2));
    log("ENGINE", `Step result written to ${STEP_RESULT_PATH}`);
  } catch (err) {
    log("ENGINE:WARN", `Failed to write step result: ${err}`);
  }

  // -- Summary ----------------------------------------------------------------
  console.log();
  log("ENGINE", "=".repeat(50));
  log("ENGINE", `Task complete.`);
  log("ENGINE", `  Plan agent     : google/gemini-2.5-pro`);
  log("ENGINE", `  Build agent    : google/gemini-3-flash-preview`);
  log("ENGINE", `  Subtasks       : ${plan.subtasks.length}`);
  log("ENGINE", `  Iterations     : ${totalIterations}`);
  log("ENGINE", `  Verification   : ${allPassed ? "PASSED" : "FAILED/SKIPPED"}`);
  log("ENGINE", `  Total cost     : $${totalCost.toFixed(4)}`);
  log("ENGINE", `  Tokens in/out  : ${totalTokensIn}/${totalTokensOut} (${totalCacheRead} cached)`);
  log("ENGINE", `  PR URL         : ${prUrl ?? "(none)"}`);
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
