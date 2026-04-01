import { describe, it, expect } from "vitest";
import { validatePlan } from "../planner.js";

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
      reasoning: "Big refactor that needs detailed breakdown",
      subtasks: Array.from({ length: 8 }, (_, i) => ({
        name: `step-${i}`,
        task: `Do a very specific and detailed thing number ${i} in the codebase`,
      })),
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("too many subtasks");
  });

  it("warns about vague task descriptions", () => {
    const result = validatePlan({
      reasoning: "Fix stuff in the codebase to make it better",
      subtasks: [
        { name: "fix", task: "Fix the code" },
      ],
    });
    expect(result.valid).toBe(true); // Still valid, just warned
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects plan with empty subtasks", () => {
    const result = validatePlan({
      reasoning: "Something needs doing",
      subtasks: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Plan has no subtasks");
  });

  it("rejects plan with duplicate subtask names", () => {
    const result = validatePlan({
      reasoning: "Two things need to be done here",
      subtasks: [
        { name: "step-1", task: "Do the first thing in src/a.ts" },
        { name: "step-1", task: "Do the second thing in src/b.ts" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Plan has duplicate subtask names");
  });

  it("warns about short reasoning", () => {
    const result = validatePlan({
      reasoning: "Fix bug",
      subtasks: [
        { name: "fix-bug", task: "Fix the null pointer bug in auth module" },
      ],
    });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("reasoning is very short")]));
  });
});
