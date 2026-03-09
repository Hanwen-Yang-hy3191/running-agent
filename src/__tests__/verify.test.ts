import { describe, it, expect } from "vitest";
import { type ExtendedCheck } from "../verify.js";

describe("ExtendedCheck type", () => {
  it("should have correct structure", () => {
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
