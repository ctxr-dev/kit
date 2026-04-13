/**
 * target: "team" installer — meta package that cascades to other packages.
 *
 * Reads `ctxr.includes` and recursively invokes the main install dispatcher
 * for every member spec. Members follow the same batch-continue semantics as
 * top-level install: a broken member records an error and the siblings still
 * install. Cycle detection prevents `team A → team B → team A` from looping.
 *
 * Records the successfully-installed members into a team manifest entry at
 * `<targetBase>/.claude/teams/.ctxr-manifest.json` (or `~/.claude/teams/…`
 * when `--user`). Teams have no project/user "type directory" the way
 * artifacts do, so this dedicated `teams/` location keeps uniformity with
 * the per-type manifest layout without polluting the registry.
 *
 * Interactive mode is handled upstream in `src/commands/install.js`, which
 * runs the shared destination prompt once at the batch level and passes
 * the resolved strategy down to every team member via synthetic flags.
 * This installer itself contains no prompt code.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readManifest, writeManifest } from "../lib/discover.js";
import { installedName } from "../lib/types.js";

/**
 * Resolve the manifest directory for team entries.
 *
 * Preference order:
 *   1. `--user` → `~/.claude/teams/`
 *   2. `dir` override (synthesized by the install orchestrator's
 *      `buildCascadeFlags`) → `<dir>/teams/`. This is the knob that
 *      routes CUSTOM / EXPLICIT_DIR / PROJECT_AGENTS strategies so the
 *      team manifest lands next to its members instead of getting stuck
 *      at the project default `.claude/` tree.
 *   3. fallback → `<projectPath>/.claude/teams/`
 *
 * @param {object} opts
 * @param {string} opts.projectPath — absolute project root
 * @param {boolean} [opts.user] — write to user-scope location
 * @param {string|null} [opts.dir] — strategy-derived base dir (optional)
 */
function resolveTeamManifestDir({ projectPath, user, dir }) {
  if (user) {
    return join(homedir(), ".claude", "teams");
  }
  if (dir) {
    return join(dir, "teams");
  }
  return join(projectPath, ".claude", "teams");
}

/**
 * Install a team package. Cascades to every member in `ctxr.includes`.
 *
 * @param {object} args
 * @param {object} args.pkgJson — parsed package.json of the team package
 * @param {string} args.source — original source string for the team
 * @param {string} args.sourceType — "npm" | "github" | "local"
 * @param {string|null} args.version
 * @param {string|null} [args.integrity]
 * @param {string|null} [args.commit]
 * @param {object} args.flags — install flags (dir, user, interactive, …)
 * @param {Set<string>} args.visited — installedNames already being installed in this recursion
 * @param {string} args.projectPath — absolute project root
 * @param {object} args.report — shared batch report (installed[], failed[])
 * @param {(source: string, flags: object, ctx: object) => Promise<void>} args.dispatcher
 * @returns {Promise<{ installedName: string, installedPaths: string[], members: string[] }>}
 */
export async function installTeam(args) {
  const {
    pkgJson,
    source,
    sourceType,
    version,
    integrity,
    commit,
    flags,
    visited,
    projectPath,
    report,
    dispatcher,
  } = args;

  const packageName = pkgJson.name;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error("Team package.json missing `name` field");
  }
  const name = installedName(packageName);

  // Cycle detection — a team that includes itself (directly or transitively)
  // is rejected cleanly instead of recursing forever. The visited set is
  // scoped to the current root recursion and cleaned up in a `finally`
  // below so the same team can legitimately appear under two separate
  // branches of a larger install graph.
  if (visited.has(name)) {
    throw new Error(
      `Cyclic team dependency detected: "${name}" is already being installed in the current recursion`,
    );
  }
  visited.add(name);

  const includes = pkgJson.ctxr?.includes;
  if (!Array.isArray(includes) || includes.length === 0) {
    visited.delete(name);
    throw new Error(`Team "${packageName}" has empty or missing "ctxr.includes"`);
  }

  const installedMembers = [];
  const beforeInstalledLen = report.installed.length;
  const beforeFailedLen = report.failed.length;

  try {
    for (const memberSpec of includes) {
      if (typeof memberSpec !== "string" || memberSpec.length === 0) {
        report.failed.push({
          source: String(memberSpec),
          error: "Invalid member spec in ctxr.includes",
        });
        console.error(`  ✗ ${memberSpec} — Invalid member spec in ctxr.includes`);
        continue;
      }
      await dispatcher(memberSpec, flags, { visited, projectPath, report });
    }
  } finally {
    // Always release the visited entry so this team can appear again under
    // a different branch of the batch (e.g. same team referenced by two
    // separate top-level sources). Cycle detection still works because a
    // recursion that re-enters `name` while it's on the active stack would
    // still see `visited.has(name)`.
    visited.delete(name);
  }

  // Members actually installed by this team = delta in report.installed that
  // are new since we entered. Each installed record carries its
  // `installedName`. We intentionally flatten nested-team members into the
  // outer team's `members` list so that `kit remove <outer-team>` can
  // cascade-delete every leaf artifact without walking a tree of nested
  // team entries (nested teams have their own manifest records with their
  // own `members` list if callers want the hierarchy).
  for (let i = beforeInstalledLen; i < report.installed.length; i++) {
    const rec = report.installed[i];
    if (rec && rec.installedName && rec.type !== "team") {
      installedMembers.push(rec.installedName);
    }
  }
  const memberFailures = report.failed.length - beforeFailedLen;

  // Write team manifest entry. `flags.dir` here is the strategy-derived
  // base dir from `buildCascadeFlags`, NOT a user-supplied `--dir` path;
  // see the helper's docstring for how each strategy maps.
  const manifestDir = resolveTeamManifestDir({
    projectPath,
    user: flags.user,
    dir: flags.dir,
  });
  mkdirSync(manifestDir, { recursive: true });
  const manifest = readManifest(manifestDir);
  const entry = {
    type: "team",
    source,
    sourceType,
    version: version ?? null,
    members: installedMembers,
    installedAt: new Date().toISOString(),
    updatedAt: null,
  };
  if (integrity) entry.integrity = integrity;
  if (commit) entry.commit = commit;
  manifest[name] = entry;
  writeManifest(manifestDir, manifest);

  console.log(
    `  ✓ installed team ${source} (${installedMembers.length}/${includes.length} members` +
      (memberFailures > 0 ? `, ${memberFailures} failed` : "") +
      `)`,
  );

  return {
    installedName: name,
    installedPaths: [join(manifestDir, name)],
    members: installedMembers,
  };
}
