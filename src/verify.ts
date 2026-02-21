/**
 * Verification module — auto-detect project type and run tests/build/lint.
 *
 * Used by the inner loop in index.ts to automatically verify the agent's
 * code changes after each iteration. Runs the appropriate commands based
 * on the project's tech stack and returns structured results.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  passed: boolean;
  command: string;
  output: string;
  exitCode: number;
  errorSummary: string;
  projectType: string;
}

interface ProjectDetection {
  type: string;
  testCommand: string | null;
  buildCommand: string | null;
}

// ---------------------------------------------------------------------------
// Project type detection
// ---------------------------------------------------------------------------

function detectProject(workspace: string): ProjectDetection | null {
  // Node.js — check package.json scripts
  const packageJsonPath = path.join(workspace, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const scripts = pkg.scripts ?? {};

      const hasTest =
        scripts.test &&
        scripts.test !== 'echo "Error: no test specified" && exit 1';

      return {
        type: "node",
        testCommand: hasTest ? "npm test" : null,
        buildCommand: scripts.build ? "npm run build" : null,
      };
    } catch {
      // Ignore parse errors, fall through
    }
  }

  // Python — pyproject.toml / setup.py / setup.cfg
  const hasPyProject =
    fs.existsSync(path.join(workspace, "pyproject.toml")) ||
    fs.existsSync(path.join(workspace, "setup.py")) ||
    fs.existsSync(path.join(workspace, "setup.cfg"));

  if (hasPyProject) {
    const hasTestDir =
      fs.existsSync(path.join(workspace, "tests")) ||
      fs.existsSync(path.join(workspace, "test"));

    return {
      type: "python",
      testCommand: hasTestDir ? "python -m pytest --tb=short -q" : null,
      buildCommand: null,
    };
  }

  // Rust — Cargo.toml
  if (fs.existsSync(path.join(workspace, "Cargo.toml"))) {
    return {
      type: "rust",
      testCommand: "cargo test",
      buildCommand: "cargo build",
    };
  }

  // Go — go.mod
  if (fs.existsSync(path.join(workspace, "go.mod"))) {
    return {
      type: "go",
      testCommand: "go test ./...",
      buildCommand: "go build ./...",
    };
  }

  // Makefile — check for test target
  const makefilePath = path.join(workspace, "Makefile");
  if (fs.existsSync(makefilePath)) {
    try {
      const content = fs.readFileSync(makefilePath, "utf-8");
      return {
        type: "make",
        testCommand: /^test\s*:/m.test(content) ? "make test" : null,
        buildCommand: "make",
      };
    } catch {
      // Ignore read errors
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Error summary extraction
// ---------------------------------------------------------------------------

function extractErrorSummary(output: string, maxLines: number = 50): string {
  const lines = output.split("\n");

  const errorPatterns = [
    /error[\s:[]/i,
    /\bfail(ed|ure|ing)?\b/i,
    /\bFAIL\b/,
    /\bERROR\b/,
    /assert(ion)?[\s:]/i,
    /\bpanic\b/i,
    /traceback/i,
    /exception/i,
    /\b(SyntaxError|TypeError|ReferenceError|NameError|ImportError|ValueError)\b/,
  ];

  const errorLines: string[] = [];
  for (const line of lines) {
    if (errorPatterns.some((pat) => pat.test(line))) {
      errorLines.push(line.trim());
    }
  }

  if (errorLines.length > 0) {
    return errorLines.slice(0, maxLines).join("\n");
  }

  // Fallback: return last N lines of output
  return lines
    .filter((l) => l.trim())
    .slice(-maxLines)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Execute a single command and return result
// ---------------------------------------------------------------------------

function runCommand(
  command: string,
  workspace: string,
  projectType: string,
): VerificationResult {
  try {
    const output = execSync(command, {
      cwd: workspace,
      encoding: "utf-8",
      timeout: 120_000, // 2 minutes per command
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    });

    return {
      passed: true,
      command,
      output: output.slice(-5000),
      exitCode: 0,
      errorSummary: "",
      projectType,
    };
  } catch (err: unknown) {
    const execError = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    const stdout = execError.stdout ?? "";
    const stderr = execError.stderr ?? "";
    const combined = stdout + "\n" + stderr;

    return {
      passed: false,
      command,
      output: combined.slice(-5000),
      exitCode: execError.status ?? 1,
      errorSummary: extractErrorSummary(combined),
      projectType,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run verification on the workspace. Tries test command first, falls back
 * to build command. Returns null if no verification is possible.
 */
export function runVerification(workspace: string): VerificationResult | null {
  const detection = detectProject(workspace);
  if (!detection) {
    return null;
  }

  // Prefer test command over build command
  const command = detection.testCommand ?? detection.buildCommand;
  if (!command) {
    return null;
  }

  return runCommand(command, workspace, detection.type);
}
