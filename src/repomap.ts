/**
 * Repository map generator — builds a compact structural overview of a project.
 *
 * Produces a token-budgeted map that includes:
 *   - Stats (file/dir counts)
 *   - Key file identification (README, configs, entry points)
 *   - Annotated directory tree (with one-line summaries from leading comments)
 *   - Internal dependency graph (local import/require relationships)
 *
 * Injected into the system prompt so the agent can precisely navigate
 * large codebases without blind exploration.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".eggs",
  "coverage",
  ".nyc_output",
  ".idea",
  ".vscode",
]);

const IGNORE_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".eslintcache",
]);

/** Files whose presence we always highlight. */
const KEY_FILE_NAMES = new Set([
  "README.md",
  "README.rst",
  "README.txt",
  "README",
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "CMakeLists.txt",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".env.example",
  "tsconfig.json",
]);

/** Patterns that signal an entry point. */
const ENTRY_POINT_PATTERNS = [
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "src/main.js",
  "src/app.ts",
  "src/app.js",
  "index.ts",
  "index.js",
  "main.py",
  "app.py",
  "manage.py",
  "cmd/main.go",
  "main.go",
  "src/main.rs",
  "src/lib.rs",
];

/** Source file extensions we inspect for summaries and imports. */
const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".vue",
  ".svelte",
]);

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

interface TreeLine {
  text: string;
  relPath: string;
  isDir: boolean;
}

const MAX_DEPTH = 5;
const MAX_ENTRIES = 300;
const MAX_FILES_PER_DIR = 15;
const SHOW_FILES_WHEN_TRUNCATED = 10;

/**
 * Walk a workspace and build an indented directory tree with annotations.
 * Directories are listed before files at each level.
 */
function buildTree(workspace: string): TreeLine[] {
  const lines: TreeLine[] = [];
  let entryCount = 0;

  function walk(dir: string, indent: string, depth: number): void {
    if (depth > MAX_DEPTH || entryCount >= MAX_ENTRIES) return;

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Separate dirs and files, sort alphabetically
    const dirs: fs.Dirent[] = [];
    const files: fs.Dirent[] = [];
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (!IGNORE_DIRS.has(d.name) && !d.name.startsWith(".")) {
          dirs.push(d);
        }
      } else {
        if (!IGNORE_FILES.has(d.name)) {
          files.push(d);
        }
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    // Directories first
    for (const d of dirs) {
      entryCount++;
      if (entryCount > MAX_ENTRIES) return;
      const full = path.join(dir, d.name);
      const rel = path.relative(workspace, full);
      lines.push({ text: `${indent}${d.name}/`, relPath: rel, isDir: true });
      walk(full, indent + "  ", depth + 1);
    }

    // Files (possibly truncated)
    const truncated = files.length > MAX_FILES_PER_DIR;
    const shown = truncated
      ? files.slice(0, SHOW_FILES_WHEN_TRUNCATED)
      : files;

    for (const f of shown) {
      entryCount++;
      if (entryCount > MAX_ENTRIES) return;
      const full = path.join(dir, f.name);
      const rel = path.relative(workspace, full);
      const summary = extractSummary(full);
      const annotation = summary ? `  — ${summary}` : "";
      lines.push({
        text: `${indent}${f.name}${annotation}`,
        relPath: rel,
        isDir: false,
      });
    }

    if (truncated) {
      const remaining = files.length - SHOW_FILES_WHEN_TRUNCATED;
      lines.push({
        text: `${indent}... and ${remaining} more files`,
        relPath: "",
        isDir: false,
      });
    }
  }

  walk(workspace, "", 0);
  return lines;
}

// ---------------------------------------------------------------------------
// File summary extraction (leading comment / docstring)
// ---------------------------------------------------------------------------

function extractSummary(filePath: string): string | null {
  const ext = path.extname(filePath);
  if (!SOURCE_EXTS.has(ext)) return null;

  let content: string;
  let fd: number | undefined;
  try {
    // Read only the first 2KB — enough for a leading comment
    const buf = Buffer.alloc(2048);
    fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
    content = buf.toString("utf-8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }

  const lines = content.split("\n").slice(0, 15);

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    // Single-line // comment (JS/TS/Go/Rust/C)
    if (t.startsWith("//") && !t.startsWith("///") && !t.startsWith("//!")) {
      const c = t.slice(2).trim();
      if (c.length > 5) return c.slice(0, 80);
    }

    // Rust doc comment
    if (t.startsWith("///") || t.startsWith("//!")) {
      const c = t.replace(/^\/\/[/!]\s*/, "").trim();
      if (c.length > 5) return c.slice(0, 80);
    }

    // Block comment /** or /*
    if (t.startsWith("/**") || t.startsWith("/*")) {
      const c = t
        .replace(/^\/\*\*?\s*/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      if (c.length > 5) return c.slice(0, 80);
      // If just "/**" on its own line, the summary is on the next line
      continue;
    }

    // Block comment continuation: " * some text"
    if (t.startsWith("*") && !t.startsWith("*/")) {
      const c = t.slice(1).trim();
      if (c.length > 5) return c.slice(0, 80);
      continue;
    }

    // Python / Ruby / Shell # comment
    if (t.startsWith("#") && !t.startsWith("#!")) {
      const c = t.slice(1).trim();
      if (c.length > 5) return c.slice(0, 80);
    }

    // Python docstring
    if (t.startsWith('"""') || t.startsWith("'''")) {
      const c = t.slice(3).replace(/"""$|'''$/, "").trim();
      if (c.length > 5) return c.slice(0, 80);
    }

    // If we hit non-comment code, stop
    if (
      !t.startsWith("//") &&
      !t.startsWith("#") &&
      !t.startsWith("*") &&
      !t.startsWith("/*")
    ) {
      break;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Import / dependency extraction
// ---------------------------------------------------------------------------

function extractLocalImports(filePath: string): string[] {
  const ext = path.extname(filePath);
  if (!SOURCE_EXTS.has(ext)) return [];

  let content: string;
  let fd: number | undefined;
  try {
    const buf = Buffer.alloc(4096);
    fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    content = buf.toString("utf-8", 0, bytesRead);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }

  const imports: string[] = [];
  for (const line of content.split("\n").slice(0, 60)) {
    const t = line.trim();

    // ES import: import ... from './foo'
    const esm = t.match(/^import\s+.*?from\s+['"](\.[^'"]+)['"]/);
    if (esm) {
      imports.push(esm[1]);
      continue;
    }

    // CommonJS: require('./foo')
    const cjs = t.match(/require\(['"](\.[^'"]+)['"]\)/);
    if (cjs) {
      imports.push(cjs[1]);
      continue;
    }

    // Python relative import: from .foo import bar / from ..utils import x
    const pyRel = t.match(/^from\s+(\.\S+)\s+import/);
    if (pyRel) {
      imports.push(pyRel[1]);
      continue;
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Key file detection
// ---------------------------------------------------------------------------

function findKeyFiles(
  workspace: string,
  treeLines: TreeLine[],
): string[] {
  const allFiles = new Set(
    treeLines.filter((l) => !l.isDir && l.relPath).map((l) => l.relPath),
  );
  const result: string[] = [];

  // Config / documentation files
  for (const name of KEY_FILE_NAMES) {
    if (allFiles.has(name)) result.push(name);
  }

  // Entry points
  for (const ep of ENTRY_POINT_PATTERNS) {
    if (allFiles.has(ep)) result.push(`${ep} (entry point)`);
  }

  // Test directories
  for (const l of treeLines) {
    if (
      l.isDir &&
      /^(tests?|__tests__|spec)$/i.test(path.basename(l.relPath))
    ) {
      result.push(`${l.relPath}/ (test directory)`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dependency graph formatting
// ---------------------------------------------------------------------------

function formatDependencies(
  workspace: string,
  treeLines: TreeLine[],
): string {
  const sourceFiles = treeLines.filter(
    (l) => !l.isDir && l.relPath && SOURCE_EXTS.has(path.extname(l.relPath)),
  );

  const depLines: string[] = [];
  for (const f of sourceFiles.slice(0, 50)) {
    const imports = extractLocalImports(path.join(workspace, f.relPath));
    if (imports.length > 0) {
      depLines.push(`  ${f.relPath} -> ${imports.join(", ")}`);
    }
  }

  return depLines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a compact repository map suitable for injection into an LLM prompt.
 *
 * @param workspace - Absolute path to the cloned repository.
 * @param maxChars  - Character budget (default 10 000 ≈ 2 500 tokens).
 * @returns A Markdown-formatted string describing the repo structure.
 */
export function generateRepoMap(
  workspace: string,
  maxChars: number = 10_000,
): string {
  const treeLines = buildTree(workspace);

  const fileCount = treeLines.filter((l) => !l.isDir && l.relPath).length;
  const dirCount = treeLines.filter((l) => l.isDir).length;
  const keyFiles = findKeyFiles(workspace, treeLines);
  const tree = treeLines.map((l) => l.text).join("\n");
  const deps = formatDependencies(workspace, treeLines);

  // Assemble sections
  let map = `## Repository Structure

**${fileCount} files** in **${dirCount} directories**
`;

  if (keyFiles.length > 0) {
    map += `\n### Key Files\n${keyFiles.map((f) => `- ${f}`).join("\n")}\n`;
  }

  map += `\n### Directory Tree\n\`\`\`\n${tree}\n\`\`\`\n`;

  if (deps) {
    map += `\n### Internal Dependencies\n\`\`\`\n${deps}\n\`\`\`\n`;
  }

  // Enforce token budget
  if (map.length > maxChars) {
    map = map.slice(0, maxChars - 60) + "\n```\n... (truncated to fit token budget)\n";
  }

  return map;
}
