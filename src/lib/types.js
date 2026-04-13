/**
 * Artifact type registry and identity derivation utilities.
 *
 * Every installable package declares its type and on-disk layout via a
 * nested `ctxr: { type, target, includes }` object in its package.json.
 * Kit reads that object, looks up the type in this registry, and dispatches
 * to the appropriate installer. The registry itself only maps types to
 * their Claude-Code-native directories — layout is driven by ctxr.target
 * per the package's own declaration.
 *
 * See /Users/developer/.claude/plans/shiny-watching-moth.md §3.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ARTIFACT_TYPES = Object.freeze({
  skill: Object.freeze({
    projectDirs: Object.freeze([".claude/skills", ".agents/skills"]),
    userDir: "skills",
  }),
  agent: Object.freeze({
    projectDirs: Object.freeze([".claude/agents", ".agents/agents"]),
    userDir: "agents",
  }),
  command: Object.freeze({
    projectDirs: Object.freeze([".claude/commands", ".agents/commands"]),
    userDir: "commands",
  }),
  "output-style": Object.freeze({
    projectDirs: Object.freeze([".claude/output-styles", ".agents/output-styles"]),
    userDir: "output-styles",
  }),
  rule: Object.freeze({
    projectDirs: Object.freeze([".claude/rules", ".agents/rules"]),
    userDir: "rules",
  }),
  team: Object.freeze({
    projectDirs: Object.freeze([]),
    userDir: null,
  }),
});

export const ARTIFACT_TYPE_NAMES = Object.freeze(Object.keys(ARTIFACT_TYPES));
export const INSTALLABLE_TYPE_NAMES = Object.freeze(
  ARTIFACT_TYPE_NAMES.filter((t) => t !== "team"),
);
export const VALID_TARGETS = Object.freeze(["folder", "file"]);

// Conservative npm package name grammar. Rejects path-like inputs, empty,
// leading symbols, unicode, and multi-slash patterns. Scope is optional.
const PKG_NAME_RE =
  /^(?:@[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\/)?[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/;

/**
 * Derive the on-disk name from a package name.
 *
 * Rule: strip leading `@` and replace every `/` with `-`. So:
 *   @ctxr/skill-foo       → ctxr-skill-foo
 *   @acme/agent-bar       → acme-agent-bar
 *   skill-local           → skill-local
 *
 * Rejects empty/invalid/path-like inputs with an Error.
 *
 * @param {string} pkgName — npm package name
 * @returns {string} installed-name for filesystem + manifest key use
 */
export function installedName(pkgName) {
  if (typeof pkgName !== "string" || pkgName.length === 0) {
    throw new TypeError(`installedName requires a non-empty string, got: ${String(pkgName)}`);
  }
  // npm's hard limit on package-name length (including scope).
  if (pkgName.length > 214) {
    throw new Error(`Package name exceeds npm's 214-char limit: "${pkgName}"`);
  }
  if (!PKG_NAME_RE.test(pkgName)) {
    throw new Error(
      `Invalid package name: "${pkgName}" — must match npm grammar (no paths, no leading dot/slash, ASCII only)`,
    );
  }
  // replaceAll is defense-in-depth: PKG_NAME_RE currently allows at most one
  // slash (the scope delimiter), but if that grammar is ever loosened we
  // still want every slash flattened to a hyphen.
  return pkgName.replace(/^@/, "").replaceAll("/", "-");
}

/**
 * Validate and resolve the artifact type from a package's parsed package.json.
 *
 * For team packages, `target` is null and `ctxr.includes` must be present and non-empty.
 * For non-team packages, `target` must be "folder" or "file".
 *
 * @param {object} pkgJson — parsed package.json contents
 * @returns {{ type: string, target: string|null, config: object }}
 * @throws if ctxr block missing, type unknown, or target invalid
 */
export function resolveType(pkgJson) {
  if (!pkgJson || typeof pkgJson !== "object" || Array.isArray(pkgJson)) {
    throw new TypeError("resolveType requires a parsed package.json object");
  }
  const ctxr = pkgJson.ctxr;
  if (!ctxr || typeof ctxr !== "object" || Array.isArray(ctxr)) {
    throw new Error(
      `Missing "ctxr" block in package.json. Every @ctxr/kit package must declare { "ctxr": { "type": "...", "target": "..." } }.`,
    );
  }
  const { type, target } = ctxr;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(
      `Missing "ctxr.type" in package.json. Must be one of: ${ARTIFACT_TYPE_NAMES.join(", ")}.`,
    );
  }
  if (!(type in ARTIFACT_TYPES)) {
    throw new Error(
      `Unknown "ctxr.type" = "${type}". Must be one of: ${ARTIFACT_TYPE_NAMES.join(", ")}.`,
    );
  }
  const config = ARTIFACT_TYPES[type];

  if (type === "team") {
    if (!Array.isArray(ctxr.includes) || ctxr.includes.length === 0) {
      throw new Error(
        `Team packages must declare a non-empty "ctxr.includes" array of member package specs.`,
      );
    }
    return { type, target: null, config };
  }

  // Non-team types require ctxr.target
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(
      `Missing "ctxr.target" in package.json. Must be one of: ${VALID_TARGETS.join(", ")}.`,
    );
  }
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(
      `Invalid "ctxr.target" = "${target}". Must be one of: ${VALID_TARGETS.join(", ")}.`,
    );
  }
  return { type, target, config };
}

/**
 * Resolve the install target root directory for a given type and scope.
 *
 * Precedence:
 *   1. Explicit `dir` (absolute or relative to projectPath)
 *   2. `user: true` → ~/.claude/<typeCfg.userDir>
 *   3. First existing entry in `typeCfg.projectDirs` (if any exist on disk)
 *   4. Primary default: first entry in `typeCfg.projectDirs` (will be created)
 *
 * For team types (empty projectDirs, null userDir) this function errors out.
 *
 * @param {string} projectPath — absolute project root
 * @param {object} opts
 * @param {string} [opts.dir] — explicit target path (takes precedence over --user)
 * @param {boolean} [opts.user] — install to ~/.claude/<typeCfg.userDir>
 * @param {object} opts.typeCfg — entry from ARTIFACT_TYPES
 * @param {(p: string) => boolean} [opts.existsCheck] — override for filesystem probe (defaults to node:fs existsSync; tests may inject a fake)
 * @returns {string} absolute directory path
 */
export function resolveTargetRoot(projectPath, opts) {
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    throw new TypeError("resolveTargetRoot requires an absolute projectPath");
  }
  if (!opts || typeof opts !== "object") {
    throw new TypeError("resolveTargetRoot requires an options object");
  }
  const { dir, user, typeCfg } = opts;
  // Default to real existsSync so production callers who forget to pass one
  // still get correct behavior. Tests can override for determinism.
  const existsCheck = typeof opts.existsCheck === "function" ? opts.existsCheck : existsSync;
  if (!typeCfg || typeof typeCfg !== "object") {
    throw new TypeError("resolveTargetRoot requires opts.typeCfg from ARTIFACT_TYPES");
  }

  // 1. Explicit --dir
  if (typeof dir === "string" && dir.length > 0) {
    return dir.startsWith("/") ? dir : join(projectPath, dir);
  }

  // 2. --user
  if (user) {
    if (!typeCfg.userDir) {
      throw new Error(
        `This type has no user-scope directory (team/meta types cannot be installed to --user).`,
      );
    }
    return join(homedir(), ".claude", typeCfg.userDir);
  }

  // Non-team types only from here on
  if (!Array.isArray(typeCfg.projectDirs) || typeCfg.projectDirs.length === 0) {
    throw new Error(
      `This type has no project-scope directories (team/meta types cannot be installed locally).`,
    );
  }

  // 3. First existing project-level candidate
  for (const relPath of typeCfg.projectDirs) {
    const abs = join(projectPath, relPath);
    if (existsCheck(abs)) return abs;
  }

  // 4. Primary default (first listed — will be created by the installer)
  return join(projectPath, typeCfg.projectDirs[0]);
}
