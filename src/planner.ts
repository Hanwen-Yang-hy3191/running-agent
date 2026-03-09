// ---------------------------------------------------------------------------
// Phase 3: Task Decomposition Planner
//
// Analyzes complex tasks and breaks them into subtasks.
// Subtasks are dispatched to the build agent via SubtaskPartInput,
// letting the OpenCode SDK handle orchestration natively.
// ---------------------------------------------------------------------------

export interface Subtask {
  name: string;
  task: string;
  files: string[];
}

export interface TaskPlan {
  reasoning: string;
  subtasks: Subtask[];
}

// SDK FileDiff type (mirrors types.gen.d.ts)
export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the planning prompt that asks the plan agent to analyze a task
 * and produce a structured subtask decomposition.
 */
export function buildPlanningPrompt(taskDescription: string): string {
  return `## Task Decomposition

Analyze the following task and determine whether it should be broken into subtasks.

### Task
${taskDescription}

### Instructions
1. Review the repository map already in context to understand the project structure.
2. Assess the task complexity:
   - If the task is **simple** (touches 1-2 files, single concern), return a plan with ONE subtask.
   - If the task is **complex** (multiple concerns, cross-module changes, needs sequencing), break it into 2-5 subtasks.
3. Each subtask should be a coherent unit of work that moves the project closer to completion.
4. Order subtasks so dependencies come first (e.g., data model before API, API before frontend).

### Output Format
Output ONLY a JSON block wrapped in triple backticks with the \`json\` language tag. No other text.

\`\`\`json
{
  "reasoning": "Brief explanation of why this decomposition makes sense",
  "subtasks": [
    {
      "name": "short-kebab-name",
      "task": "Detailed description of what to do. Be specific about files, functions, and acceptance criteria.",
      "files": ["src/path/to/relevant/file.ts"]
    }
  ]
}
\`\`\`

IMPORTANT: Output ONLY the JSON block above. No additional text, explanation, or markdown.`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Extract a TaskPlan from the agent's response text.
 * Looks for a fenced JSON code block first, then falls back to raw JSON parsing.
 */
export function parsePlan(responseText: string): TaskPlan | null {
  const codeBlockMatch = responseText.match(
    /```(?:json)?\s*\n?([\s\S]*?)\n?```/,
  );
  const jsonStr = codeBlockMatch
    ? codeBlockMatch[1].trim()
    : responseText.trim();

  try {
    const parsed = JSON.parse(jsonStr);

    if (
      !parsed.subtasks ||
      !Array.isArray(parsed.subtasks) ||
      parsed.subtasks.length === 0
    ) {
      return null;
    }

    for (const st of parsed.subtasks) {
      if (!st.name || !st.task) return null;
      if (!st.files) st.files = [];
    }

    return {
      reasoning: parsed.reasoning || "",
      subtasks: parsed.subtasks,
    };
  } catch {
    return null;
  }
}

/**
 * Extract all text content from the parts array returned by session.prompt().
 */
export function extractTextFromParts(parts: unknown[]): string {
  return parts
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" &&
        p !== null &&
        (p as Record<string, unknown>).type === "text" &&
        typeof (p as Record<string, unknown>).text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}

/**
 * Format an array of FileDiff objects (from session.diff()) into a
 * human-readable summary for the final review prompt.
 */
// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Diff formatting
// ---------------------------------------------------------------------------

export function formatDiffSummary(diffs: FileDiff[]): string {
  if (!diffs || diffs.length === 0) {
    return "No file changes detected.";
  }

  const totalAdded = diffs.reduce((sum, d) => sum + d.additions, 0);
  const totalDeleted = diffs.reduce((sum, d) => sum + d.deletions, 0);

  const lines = [
    `### Changes Summary`,
    `**${diffs.length} file(s)** modified — **+${totalAdded}** / **-${totalDeleted}** lines`,
    "",
  ];

  for (const d of diffs) {
    lines.push(`- \`${d.file}\` (+${d.additions}/-${d.deletions})`);
  }

  return lines.join("\n");
}
