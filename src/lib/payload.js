/**
 * Resolves the file list a package would ship via `npm pack`.
 *
 * Uses the npm `files` field + `.npmignore` semantics — the same mechanism
 * that governs `npm publish`. Kit does NOT maintain a separate copy list.
 *
 * Implementation delegates to `npm pack --dry-run --json` which is
 * authoritative — it returns exactly what npm would include, honoring
 * `files`, `.npmignore`, `.gitignore` fallback, always-included files
 * (package.json, README, LICENSE, CHANGELOG, main, bin), and always-excluded
 * files (.git, node_modules, etc.).
 *
 * Kit requires npm at runtime anyway (for fetching npm sources), so there
 * is no separate fallback walker — npm is a hard requirement.
 *
 * See /Users/developer/.claude/plans/shiny-watching-moth.md §1.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXEC_TIMEOUT = 60_000;

// Sanitized env for npm child processes — prevents the user's .npmrc from
// influencing the dry-run output (registry override, auth tokens, custom
// pack options) and keeps tests deterministic across machines. We override
// user config only; overriding both user and global to the same sentinel
// makes npm refuse to load them ("double-loading config"), so we point
// user config at a nonexistent path and leave global alone.
function buildCleanNpmEnv() {
  const env = { ...process.env };
  env.npm_config_userconfig = "/nonexistent/.npmrc";
  return Object.freeze(env);
}
const CLEAN_NPM_ENV = buildCleanNpmEnv();

/**
 * Return the file list a package would ship if published.
 *
 * @param {string} packageDir — absolute path to a directory containing package.json
 * @returns {string[]} file paths relative to packageDir, POSIX-style separators, sorted, deduped
 * @throws if packageDir is missing/not a dir/has no package.json, or if npm fails
 */
export function packagePayload(packageDir) {
  if (typeof packageDir !== "string" || packageDir.length === 0) {
    throw new TypeError("packagePayload requires a non-empty directory path");
  }
  const abs = resolve(packageDir);
  if (!existsSync(abs)) {
    throw new Error(`Package directory not found: ${abs}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  if (!existsSync(join(abs, "package.json"))) {
    throw new Error(`No package.json in ${abs}`);
  }

  let raw;
  try {
    // --ignore-scripts: lifecycle hooks (prepack, prepare, postpack) must NOT
    // run during a dry-run inspection. A package shipping `"prepare": "husky"`
    // would otherwise let husky write to stdout/stderr and corrupt the JSON
    // output. Payload resolution is a pure metadata query, not an install.
    raw = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--silent", "--ignore-scripts"],
      {
        cwd: abs,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: EXEC_TIMEOUT,
        env: CLEAN_NPM_ENV,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    throw new Error(
      `npm pack --dry-run failed for ${abs}: ${stderr || err.message}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(extractPackJson(raw));
  } catch (err) {
    throw new Error(`Could not parse "npm pack --dry-run" output: ${err.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Unexpected 'npm pack --dry-run' output: not an array");
  }
  const entry = parsed[0];
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error("Unexpected 'npm pack --dry-run' output: missing files array");
  }

  const rawFiles = entry.files
    .map((f) => (typeof f === "string" ? f : f && f.path))
    .filter((p) => typeof p === "string" && p.length > 0);

  if (rawFiles.length === 0) {
    throw new Error(`Package at ${abs} has an empty payload — check "files" field`);
  }

  return sanitizePayload(rawFiles, abs);
}

/**
 * Strip non-JSON noise from `npm pack --json` stdout.
 *
 * Some environments (notably GitHub Actions Linux runners) emit a
 * git-detection warning on stdout despite `--silent --ignore-scripts`,
 * producing output like `.git can't be found... [{...}]`. Slice from
 * the first `[` to the last `]` so stray warnings don't break parsing.
 *
 * Exported for direct unit testing; no caller outside this module needs it.
 *
 * @param {string} raw — npm pack stdout
 * @returns {string} the JSON-array slice (or `raw` if no bracket pair found)
 */
export function extractPackJson(raw) {
  if (typeof raw !== "string") return raw;
  const first = raw.indexOf("[");
  const last = raw.lastIndexOf("]");
  if (first >= 0 && last > first) return raw.slice(first, last + 1);
  return raw;
}

/**
 * Scrub every path to ensure it stays inside `packageDir`.
 *
 * Rejects absolute paths (unix + Windows drive letters), path traversal
 * segments (`..`), paths resolving to the package root itself, and paths
 * that resolve outside the root after normalization. Returns sorted,
 * deduped, POSIX-style relative paths.
 *
 * Exported for direct unit testing — npm's real `pack --dry-run` output
 * never contains these shapes, so the guards would otherwise be dead code
 * under test. The security-critical path sanitizer deserves its own assertions.
 *
 * @param {string[]} files — candidate relative paths
 * @param {string} packageDir — absolute package root
 * @returns {string[]} sanitized, sorted, deduped payload
 */
export function sanitizePayload(files, packageDir) {
  const seen = new Set();
  const clean = [];
  for (const raw of files) {
    if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)) {
      throw new Error(`Payload contains absolute path: ${raw}`);
    }
    // Normalize separators for traversal check
    const parts = raw.split(/[\\/]/);
    if (parts.some((p) => p === "..")) {
      throw new Error(`Payload contains path traversal segment: ${raw}`);
    }
    const absPath = resolve(packageDir, raw);
    const rel = relative(packageDir, absPath);
    if (rel.length === 0) {
      throw new Error(`Payload path resolves to package root: ${raw}`);
    }
    if (rel.startsWith("..")) {
      throw new Error(`Payload path escapes package dir: ${raw}`);
    }
    const normalized = rel.split(/[\\/]/).join("/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    clean.push(normalized);
  }
  return clean.sort();
}
