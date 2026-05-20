/**
 * AGENTS.md emitter.
 *
 * Codex CLI and other Agent Skills harnesses look for an `AGENTS.md` at the
 * project root and treat it as a top-level pointer to skill resources. After
 * every project-scope install, kit upserts a managed section into AGENTS.md
 * listing each installed artefact with a one-line description and a relative
 * path to its `SKILL.md` (or single artefact file). On remove, kit deletes
 * the row.
 *
 * Markers delimit kit's section so user-authored prose outside the markers
 * is preserved verbatim:
 *
 *   <!-- ctxr:skills:start -->
 *   ... kit-managed rows ...
 *   <!-- ctxr:skills:end -->
 *
 * Atomic writes use the same temp+fsync+rename pattern as `writeManifest`
 * in `./discover.js` so a crash mid-write either leaves the previous file
 * intact or completes the swap.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const MARKER_START = "<!-- ctxr:skills:start -->";
export const MARKER_END = "<!-- ctxr:skills:end -->";

/**
 * Opt-out gate. Set `CTXR_NO_AGENTS_MD=1` to disable kit's AGENTS.md
 * emitter entirely (no creates, no upserts, no removes). Useful for users
 * who keep `AGENTS.md` under their own authorship and don't want kit
 * managing a section inside it, OR who keep `AGENTS.md` in `.gitignore`
 * and don't want it materialised on every install.
 */
function isOptedOut() {
  const v = process.env.CTXR_NO_AGENTS_MD;
  return typeof v === "string" && v.length > 0 && v !== "0" && v.toLowerCase() !== "false";
}

const PREAMBLE =
  "# Agents\n\n" +
  "Managed by @ctxr/kit. Hand-edit OUTSIDE the marked section below;\n" +
  "rows inside `ctxr:skills:start`/`end` markers are rewritten on every\n" +
  "`kit install` / `kit remove`.\n\n";

/**
 * Sanitize a row value before serialising into the kit-managed section.
 *
 * Untrusted package metadata (description, installedName, type, path) is
 * inlined into a markdown row. A malicious description containing the end
 * marker would close the section early; a description with newlines would
 * spill into a sibling row and break upsert idempotency; a backtick would
 * break the row regex on parse-back. Strip every dangerous code unit before
 * write so kit's parse-and-rewrite cycle stays robust under hostile input.
 *
 * - Newlines, carriage returns, and tabs collapse to a single space.
 * - Backticks are removed (they would break the row regex on parse-back).
 * - HTML/XML comment delimiters `<!--` / `-->` lose their dashes so a row
 *   value cannot mimic the section markers.
 * - Length is capped at 200 chars (matches the npm package.json description
 *   convention) so a megabyte of garbage cannot bloat AGENTS.md.
 */
function sanitizeRowValue(s, fallback = "") {
  if (typeof s !== "string") return fallback;
  let v = s.replace(/[\r\n\t]+/g, " ");
  v = v.replace(/`/g, "");
  v = v.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
  v = v.trim();
  if (v.length > 200) v = v.slice(0, 197) + "...";
  return v.length > 0 ? v : fallback;
}

function buildSection(rows) {
  // Rows is an ordered list of {installedName, type, description, skillRelPath}.
  if (rows.length === 0) {
    return `${MARKER_START}\n${MARKER_END}\n`;
  }
  const lines = rows.map((row) => {
    const name = sanitizeRowValue(row.installedName, "unknown");
    const type = sanitizeRowValue(row.type, "unknown");
    const desc = sanitizeRowValue(row.description, "(no description)");
    const path = sanitizeRowValue(row.skillRelPath, "");
    return `- **\`${name}\`** (${type}) — ${desc}\n  Path: \`${path}\``;
  });
  return `${MARKER_START}\n${lines.join("\n")}\n${MARKER_END}\n`;
}

function atomicWrite(path, content) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // `flag: "wx"` opens with O_EXCL so a pre-existing file at `tmp` (e.g.
    // an attacker-planted symlink pointing at a sensitive path) causes
    // EEXIST instead of being followed-and-written-through. Combined with
    // the per-pid + 48-bit random suffix this makes targeted symlink
    // attacks on the tmp slot effectively impossible.
    writeFileSync(tmp, content, { flag: "wx" });
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Parse the kit-managed section out of an AGENTS.md body. Returns
 *   { kind: "ok", before, rows, after }
 *   { kind: "noMarkers", body }
 *   { kind: "malformed" }
 *
 * `rows` is parsed back to {installedName, type, description, skillRelPath}
 * structured records so callers can mutate and re-serialise without losing
 * unrelated rows.
 */
function parseAgentsMd(body) {
  const startIdx = body.indexOf(MARKER_START);
  const endIdx = body.indexOf(MARKER_END);
  if (startIdx === -1 && endIdx === -1) {
    return { kind: "noMarkers", body };
  }
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { kind: "malformed" };
  }
  // Reject duplicate markers — they indicate a hand-edit gone wrong.
  if (
    body.indexOf(MARKER_START, startIdx + 1) !== -1 ||
    body.indexOf(MARKER_END, endIdx + 1) !== -1
  ) {
    return { kind: "malformed" };
  }
  const before = body.slice(0, startIdx);
  const after = body.slice(endIdx + MARKER_END.length);
  const inner = body.slice(startIdx + MARKER_START.length, endIdx);
  // Parse each row pair (name+desc, then path line).
  const rows = [];
  const lines = inner.split("\n").map((l) => l.trimEnd());
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \*\*`([^`]+)`\*\* \(([^)]+)\) — (.*)$/);
    if (!m) continue;
    const next = lines[i + 1] ?? "";
    const pm = next.match(/^\s*Path: `([^`]+)`/);
    rows.push({
      installedName: m[1],
      type: m[2],
      description: m[3],
      skillRelPath: pm ? pm[1] : "",
    });
    if (pm) i++;
  }
  return { kind: "ok", before, rows, after };
}

function readAgentsMd(projectPath) {
  const path = join(projectPath, "AGENTS.md");
  if (!existsSync(path)) {
    return { path, exists: false, body: "" };
  }
  return { path, exists: true, body: readFileSync(path, "utf8") };
}

function applySection(parsed, beforeFallback, rows) {
  const section = buildSection(rows);
  if (parsed.kind === "ok") {
    return parsed.before + section + parsed.after;
  }
  // No markers in the file (or never existed): append our section to the end.
  const trailing = beforeFallback.endsWith("\n") ? "" : "\n";
  return beforeFallback + trailing + (beforeFallback.length > 0 ? "\n" : "") + section;
}

/**
 * Insert or update a single skill row in the project's AGENTS.md.
 *
 * If the file is missing it is created with a one-line preamble and a
 * marker section. If markers are present they are reused. If markers are
 * malformed the function emits a one-line stderr warning and returns
 * without touching the file.
 *
 * @param {object} args
 * @param {string} args.projectPath — absolute project root
 * @param {string} args.installedName
 * @param {string} args.type
 * @param {string} [args.description]
 * @param {string} args.skillRelPath — relative path to the artefact's primary file
 * @returns {{ written: boolean, reason?: string }}
 */
export function upsertSkillRow({
  projectPath,
  installedName,
  type,
  description,
  skillRelPath,
}) {
  if (isOptedOut()) return { written: false, reason: "opted-out" };
  const { path, exists, body } = readAgentsMd(projectPath);
  if (!exists) {
    const section = buildSection([
      { installedName, type, description, skillRelPath },
    ]);
    atomicWrite(path, PREAMBLE + section);
    return { written: true };
  }
  const parsed = parseAgentsMd(body);
  if (parsed.kind === "malformed") {
    process.stderr.write(
      `warning: AGENTS.md at ${path} has malformed ctxr:skills markers; leaving untouched\n`,
    );
    return { written: false, reason: "malformed-markers" };
  }
  let rows;
  let beforeBody;
  if (parsed.kind === "ok") {
    rows = parsed.rows.filter((r) => r.installedName !== installedName);
    rows.push({ installedName, type, description, skillRelPath });
    rows.sort((a, b) => a.installedName.localeCompare(b.installedName));
    beforeBody = parsed.before;
  } else {
    // noMarkers: append a fresh section.
    rows = [{ installedName, type, description, skillRelPath }];
    beforeBody = body;
  }
  const next = applySection(parsed, beforeBody, rows);
  atomicWrite(path, next);
  return { written: true };
}

/**
 * Remove the row keyed by `installedName` from AGENTS.md. Preserves the
 * marker section even when it becomes empty so the file is still
 * obviously kit-managed.
 *
 * @param {object} args
 * @param {string} args.projectPath
 * @param {string} args.installedName
 * @returns {{ written: boolean, reason?: string }}
 */
export function removeSkillRow({ projectPath, installedName }) {
  if (isOptedOut()) return { written: false, reason: "opted-out" };
  const { path, exists, body } = readAgentsMd(projectPath);
  if (!exists) return { written: false, reason: "no-file" };
  const parsed = parseAgentsMd(body);
  if (parsed.kind === "malformed") {
    process.stderr.write(
      `warning: AGENTS.md at ${path} has malformed ctxr:skills markers; leaving untouched\n`,
    );
    return { written: false, reason: "malformed-markers" };
  }
  if (parsed.kind === "noMarkers") {
    return { written: false, reason: "no-section" };
  }
  const before = parsed.rows.length;
  const rows = parsed.rows.filter((r) => r.installedName !== installedName);
  if (rows.length === before) return { written: false, reason: "row-not-found" };
  const next = parsed.before + buildSection(rows) + parsed.after;
  atomicWrite(path, next);
  return { written: true };
}

// Re-export the sanitiser so tests can assert on the exact stripping rules.
export { sanitizeRowValue };
