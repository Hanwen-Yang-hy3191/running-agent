import { createOpencode } from "@opencode-ai/sdk";
import type { Event as SdkEvent } from "@opencode-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Re-alias the SDK's Event union so we can reference it concisely.
type AgentEvent = SdkEvent;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKSPACE = "/app/workspace";

// Task description comes from the environment (set by sandbox.py).
// Falls back to a safe default so local development still works.
const TASK_DESCRIPTION =
  process.env.TASK_DESCRIPTION ||
  "Improve the README with a better project description and usage instructions.";

// ---------------------------------------------------------------------------
// System prompt — teaches the agent the full Git → PR workflow
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an autonomous coding agent running inside a cloud sandbox.
Your job is to complete a task on a codebase and submit the result as a GitHub Pull Request.

## Environment
- The repository has already been cloned to: ${WORKSPACE}
- You are working inside that directory.
- Git is configured with a valid identity (user.name / user.email).
- The GitHub CLI (\`gh\`) is authenticated and ready to use.
- You have full shell access via bash.

## Workflow — follow these steps IN ORDER:

1. **Understand the repo**: Read key files (README, package.json, directory structure, etc.) to understand the project.
2. **Create a branch**: Run \`git checkout -b agent/<short-descriptive-name>\` from the default branch.
3. **Do the work**: Write code, fix bugs, add features, write tests — whatever the task requires. Make sure your changes are correct and complete.
4. **Verify**: If the project has tests or a build step, run them to make sure nothing is broken.
5. **Commit**: Stage your changes with \`git add -A\` and commit with a clear, conventional commit message.
6. **Push**: Run \`git push -u origin HEAD\` to push your branch to the remote.
7. **Open a PR**: Run:
   \`\`\`bash
   gh pr create --title "<concise title>" --body "<description of what you did and why>"
   \`\`\`
   The PR should have a clear title and a body that explains the changes.

## Rules
- NEVER push directly to main / master.
- Always create a new branch for your work.
- Write clean, idiomatic code that matches the project's existing style.
- If tests exist, make sure they pass before committing.
- If you encounter an error, debug it and retry — do not give up easily.
- When you are done and the PR is created, output the PR URL as your final message.
`;

// Build the user-facing task prompt
const TASK_PROMPT = `Here is your task:\n\n${TASK_DESCRIPTION}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pretty-print a timestamped log line with a category tag. */
function log(tag: string, message: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`[${ts}] [${tag}] ${message}`);
}

// ---------------------------------------------------------------------------
// Event listener — runs in the background and logs every SSE event emitted
// by the OpenCode server.
//
// The SDK exposes a Server-Sent Events stream via `client.event.subscribe()`.
// It returns an object with a `.stream` property — an AsyncGenerator that
// yields `Event` values. Each Event is a discriminated union with a `.type`
// field (e.g. "session.status", "message.part.updated") and a `.properties`
// payload whose shape depends on the type.
//
// We map events into five logical categories so console output is easy to
// scan at a glance:
//
//   THOUGHT  — model-generated text / reasoning fragments
//   TOOL     — tool invocation lifecycle (pending → running → completed/error)
//   STEP     — agentic step boundaries (start / finish with token counts)
//   SESSION  — session-level state transitions (busy, idle, error)
//   EVENT    — catch-all for everything else (file edits, permissions, etc.)
// ---------------------------------------------------------------------------

async function listenToEvents(
  client: Awaited<ReturnType<typeof createOpencode>>["client"],
  signal: AbortSignal,
): Promise<void> {
  log("ENGINE", "Subscribing to server event stream...");

  // Subscribe to the global SSE channel. The server pushes every event that
  // occurs across all sessions through this single stream.
  const { stream } = await client.event.subscribe();

  try {
    for await (const event of stream) {
      if (signal.aborted) break;

      // `event` is typed as the SDK's `Event` discriminated union. We switch
      // on `event.type` to handle each variant with full type narrowing.
      handleEvent(event as AgentEvent);
    }
  } catch (err: unknown) {
    // The stream throws when the server shuts down or the abort signal fires.
    // That is expected — only surface truly unexpected failures.
    if (!signal.aborted) {
      log("EVENT:ERROR", `Event stream ended unexpectedly: ${err}`);
    }
  }
}

/**
 * Route a single SSE event to the appropriate log handler.
 *
 * The OpenCode server emits a rich set of event types. We focus on the ones
 * most relevant to observing an agent's execution lifecycle:
 *
 *  - message.part.updated  — streamed text, reasoning, and tool call updates
 *  - session.status        — busy / idle / retry transitions
 *  - session.idle          — the agent finished all pending work
 *  - session.error         — unrecoverable session-level failure
 *  - file.edited           — a file was created or modified by the agent
 *  - command.executed      — a slash-command was invoked
 */
function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    // ----- THOUGHT / TOOL / STEP events ----------------------------------
    // All streamed through `message.part.updated`. The `part` property is
    // itself a discriminated union — its `.type` tells us whether this is
    // assistant text, a tool call, reasoning, or a step boundary.
    case "message.part.updated": {
      const { part, delta } = event.properties;

      switch (part.type) {
        // --- Text fragments (assistant prose) ---
        // Fired each time the model streams a new chunk of text. The `delta`
        // field contains just the incremental addition; `part.text` has the
        // full accumulated text so far.
        case "text": {
          if (delta) {
            const preview =
              delta.length > 120
                ? delta.slice(0, 120) + "..."
                : delta;
            log("THOUGHT", preview.replaceAll("\n", "\\n"));
          }
          break;
        }

        // --- Reasoning fragments (chain-of-thought) ---
        // Some models emit structured reasoning before answering. We surface
        // these so you can trace the agent's internal deliberation.
        case "reasoning": {
          if (delta) {
            const preview =
              delta.length > 120
                ? delta.slice(0, 120) + "..."
                : delta;
            log("REASONING", preview.replaceAll("\n", "\\n"));
          }
          break;
        }

        // --- Tool call lifecycle ---
        // A single ToolPart transitions through states:
        //   pending → running → completed | error
        // We log each transition so you can trace every side-effect the
        // agent performs (file writes, bash commands, reads, etc.).
        case "tool": {
          const { tool, state } = part;
          switch (state.status) {
            case "pending":
              log("TOOL:QUEUED", `${tool} — input: ${JSON.stringify(state.input).slice(0, 100)}`);
              break;
            case "running":
              log("TOOL:RUNNING", `${tool}${state.title ? ` — ${state.title}` : ""}`);
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

        // --- Step boundaries ---
        // OpenCode wraps each agentic "turn" (model call + tool execution)
        // in a step-start / step-finish pair. step-finish includes token
        // usage and cost, which is valuable for monitoring.
        case "step-start": {
          log("STEP", "--- New agentic step started ---");
          break;
        }
        case "step-finish": {
          const { tokens, cost, reason } = part;
          log(
            "STEP",
            `--- Step finished (${reason}) — ` +
            `tokens: ${tokens.input}in/${tokens.output}out ` +
            `(${tokens.cache.read} cached) — ` +
            `cost: $${cost.toFixed(4)} ---`,
          );
          break;
        }

        default:
          // Other part types (file, snapshot, patch, agent, compaction, etc.)
          log("PART", `${part.type} update`);
          break;
      }
      break;
    }

    // ----- SESSION lifecycle events --------------------------------------

    // Fired when the session transitions between busy / idle / retry states.
    case "session.status": {
      const { status, sessionID } = event.properties;
      log("SESSION", `[${sessionID.slice(0, 8)}] Status → ${status.type}`);
      break;
    }

    // The primary "completion" signal — the agent has finished all pending
    // work and is waiting for the next prompt.
    case "session.idle": {
      log("SESSION", `[${event.properties.sessionID.slice(0, 8)}] Agent reached idle state (task complete).`);
      break;
    }

    // Unrecoverable session-level errors (auth failures, API errors, etc.).
    case "session.error": {
      const { error, sessionID } = event.properties;
      log("SESSION:ERROR", `[${sessionID?.slice(0, 8) ?? "?"}] ${JSON.stringify(error).slice(0, 200)}`);
      break;
    }

    // ----- FILE events ---------------------------------------------------

    // Fired after the agent writes or modifies a file on disk.
    case "file.edited": {
      log("FILE", `Edited: ${event.properties.file}`);
      break;
    }

    // ----- Catch-all for every other event type --------------------------
    // The server emits many additional events (permission prompts, LSP
    // diagnostics, VCS updates, etc.). We log them tersely so nothing
    // is silently swallowed during development.
    default: {
      log("EVENT", `${event.type} — ${JSON.stringify("properties" in event ? event.properties : {}).slice(0, 120)}`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main — orchestrates the full agent lifecycle:
//   1. Boot the OpenCode server
//   2. Subscribe to SSE events
//   3. Create a session
//   4. Send the task prompt
//   5. Wait for completion
//   6. Retrieve message history
//   7. Shut down
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(64));
  console.log("  Running Agent — Phase 3: Git PR Workflow");
  console.log("=".repeat(64));
  log("ENGINE", `Workspace : ${WORKSPACE}`);
  log("ENGINE", `Task      : ${TASK_DESCRIPTION.slice(0, 120)}`);
  console.log();

  // 1. Start the OpenCode server + client.
  //    `createOpencode` spawns a local HTTP server and returns both a typed
  //    SDK client and a server handle. It reads `opencode.json` from the
  //    project root for provider/model configuration.
  log("ENGINE", "Starting OpenCode server...");

  const { client, server } = await createOpencode({
    hostname: "127.0.0.1",
    port: 0, // let the OS assign a free port to avoid collisions
    config: {
      model: "google/gemini-3-flash-preview",
    },
  });

  log("ENGINE", `Server listening at ${server.url}`);

  // 2. Wire up a global AbortController so we can tear everything down
  //    cleanly on SIGINT / SIGTERM or when the task finishes.
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

  // 3. Start the event listener in the background.
  //    It runs for the lifetime of the process and logs every event the
  //    server emits — thoughts, tool calls, session transitions, etc.
  const eventLoop = listenToEvents(client, ac.signal);

  // 4. Create a fresh session scoped to the dummy workspace.
  //    A session is an isolated conversation context. The agent remembers
  //    all messages and tool results within a single session.
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

  // 5. Send the task prompt.
  //    `session.prompt()` blocks until the agent has finished processing.
  //    Meanwhile, the SSE event stream we subscribed to in step 3 will emit
  //    real-time updates for every thought, tool call, and state change.
  log("ENGINE", "Sending task prompt to agent...");

  const { data: response } = await client.session.prompt({
    path: { id: session.id },
    body: {
      parts: [
        {
          type: "text",
          text: [
            SYSTEM_PROMPT,
            "",
            "---",
            "",
            TASK_PROMPT,
          ].join("\n"),
        },
      ],
    },
  });

  // 6. Log the final assistant response.
  log("ENGINE", "Agent finished processing the prompt.");

  if (response) {
    log("RESULT", JSON.stringify(response, null, 2).slice(0, 500));
  }

  // 7. Retrieve the full message history so we can inspect every step the
  //    agent took — useful for debugging and auditing.
  const { data: messages } = await client.session.messages({
    path: { id: session.id },
  });

  if (messages && Array.isArray(messages)) {
    console.log();
    log("ENGINE", `Total messages in session: ${messages.length}`);
    for (const msg of messages) {
      const role = (msg as Record<string, unknown>).role ?? "unknown";
      log("HISTORY", `[${role}] ${JSON.stringify(msg).slice(0, 150)}`);
    }
  }

  // 8. Give the event stream a moment to flush any remaining events, then
  //    shut down the server gracefully.
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  log("ENGINE", "Task complete. Tearing down.");
  shutdown();

  // Await the event loop so we don't leave dangling promises.
  await eventLoop;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
