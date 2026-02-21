// ---------------------------------------------------------------------------
// Phase 4: Smart Context Management
//
// Provides token estimation, context budget calculation, and intelligent
// truncation for verification outputs and diffs. Works with the OpenCode
// SDK's built-in compaction system for automatic context compression.
// ---------------------------------------------------------------------------

// Rough char-to-token ratio (conservative for English + code)
const TOKEN_CHAR_RATIO = 4;

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the number of tokens in a text string.
 * Uses a simple char/4 heuristic — accurate enough for budget decisions.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHAR_RATIO);
}

// ---------------------------------------------------------------------------
// Context budget
// ---------------------------------------------------------------------------

export interface ContextBudget {
  total: number;
  system: number;
  repoMap: number;
  task: number;
  used: number;
  remaining: number;
}

/**
 * Calculate how much of the context window is consumed by static content
 * (system prompt, repo map, task description) and how much remains for
 * the agent's conversation turns.
 */
export function calculateBudget(
  systemPrompt: string,
  repoMap: string,
  taskPrompt: string,
  maxContextTokens: number = 1_000_000,
): ContextBudget {
  const system = estimateTokens(systemPrompt);
  const repo = estimateTokens(repoMap);
  const task = estimateTokens(taskPrompt);
  const used = system + repo + task;

  return {
    total: maxContextTokens,
    system,
    repoMap: repo,
    task,
    used,
    remaining: maxContextTokens - used,
  };
}

// ---------------------------------------------------------------------------
// Smart truncation for verification output
// ---------------------------------------------------------------------------

/**
 * Truncate verification output to fit within a token budget while
 * preserving the most useful parts: error lines at the top and
 * the tail of the output.
 */
export function truncateVerificationOutput(
  output: string,
  maxTokens: number = 2000,
): string {
  const maxChars = maxTokens * TOKEN_CHAR_RATIO;
  if (output.length <= maxChars) return output;

  // Keep first portion (usually has error header) and last portion (summary/stack)
  const headChars = Math.floor(maxChars * 0.4);
  const tailChars = Math.floor(maxChars * 0.5);
  const head = output.slice(0, headChars);
  const tail = output.slice(-tailChars);
  const omitted = output.length - headChars - tailChars;

  return `${head}\n\n... (${omitted} chars / ~${Math.round(omitted / TOKEN_CHAR_RATIO)} tokens omitted) ...\n\n${tail}`;
}

// ---------------------------------------------------------------------------
// Repo map sizing
// ---------------------------------------------------------------------------

/**
 * Calculate the maximum character budget for the repo map based on
 * what percentage of the context window we want to dedicate to it.
 *
 * Default: 5% of context window for the repo map.
 */
export function repoMapBudget(
  maxContextTokens: number = 1_000_000,
  percentage: number = 0.05,
): number {
  return Math.floor(maxContextTokens * percentage * TOKEN_CHAR_RATIO);
}

// ---------------------------------------------------------------------------
// Compaction configuration builder
// ---------------------------------------------------------------------------

/**
 * Build the compaction configuration for createOpencode().
 * Enables automatic context compression when the context window fills up.
 */
export function buildCompactionConfig(maxContextTokens: number = 1_000_000) {
  return {
    auto: true,
    prune: true,
    // Reserve 15% of context for compaction buffer
    reserved: Math.floor(maxContextTokens * 0.15),
  };
}
