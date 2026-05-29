/**
 * target: "bundle" installer: meta package that cascades to other packages.
 *
 * Reads `ctxr.includes` and recursively invokes the main install dispatcher
 * for every member spec. Members follow the same batch-continue semantics as
 * top-level install: a broken member records an error and the siblings still
 * install. Cycle detection prevents `bundle A -> bundle B -> bundle A` from
 * looping.
 *
 * Records the successfully-installed members into a bundle manifest entry at
 * `<targetBase>/.agents/bundles/.ctxr-manifest.json` (or
 * `~/.agents/bundles/...` when `--user`). Bundles have no project/user
 * "type directory" the way artifacts do, so this dedicated `bundles/`
 * location keeps uniformity with the per-type manifest layout without
 * polluting the registry.
 *
 * Interactive mode is handled upstream in `src/commands/install.js`, which
 * runs the shared destination prompt once at the batch level and passes
 * the resolved strategy down to every bundle member via synthetic flags.
 * This installer itself contains no prompt code.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readManifest, writeManifest } from "../lib/discover.js";
import { installedName } from "../lib/types.js";

/**
 * Resolve the manifest directory for bundle entries.
 *
 * Preference order:
 *   1. `--user` -> `~/.agents/bundles/`
 *   2. `dir` override (synthesized by the install orchestrator's
 *      `buildCascadeFlags`) -> `<dir>/bundles/`. This is the knob that
 *      routes CUSTOM / EXPLICIT_DIR / PROJECT_AGENTS strategies so the
 *      bundle manifest lands next to its members instead of getting stuck
 *      at the project default location.
 *   3. fallback -> `<projectPath>/.agents/bundles/`
 *
 * @param {object} opts
 * @param {string} opts.projectPath: absolute project root
 * @param {boolean} [opts.user]: write to user-scope location
 * @param {string|null} [opts.dir]: strategy-derived base dir (optional)
 */
export function resolveBundleManifestDir({ projectPath, user, dir }) {
  if (user) {
    return join(homedir(), ".agents", "bundles");
  }
  if (dir) {
    return join(dir, "bundles");
  }
  return join(projectPath, ".agents", "bundles");
}

/**
 * Install a bundle package. Cascades to every member in `ctxr.includes`.
 *
 * @param {object} args
 * @param {object} args.pkgJson: parsed package.json of the bundle package
 * @param {string} args.source: original source string for the bundle
 * @param {string} args.sourceType: "npm" | "github" | "local"
 * @param {string|null} args.version
 * @param {string|null} [args.integrity]
 * @param {string|null} [args.commit]
 * @param {object} args.flags: install flags (dir, user, interactive, ...)
 * @param {Set<string>} args.visited: installedNames already being installed in this recursion
 * @param {string} args.projectPath: absolute project root
 * @param {object} args.report: shared batch report (installed[], failed[])
 * @param {(source: string, flags: object, ctx: object) => Promise<void>} args.dispatcher
 * @returns {Promise<{ installedName: string, installedPaths: string[], members: string[] }>}
 */
export async function installBundle(args) {
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
    throw new Error("Bundle package.json missing `name` field");
  }
  const name = installedName(packageName);

  // Cycle detection: a bundle that includes itself (directly or
  // transitively) is rejected cleanly instead of recursing forever. The
  // visited set is scoped to the current root recursion and cleaned up in
  // a `finally` below so the same bundle can legitimately appear under
  // two separate branches of a larger install graph.
  if (visited.has(name)) {
    throw new Error(
      `Cyclic bundle dependency detected: "${name}" is already being installed in the current recursion`,
    );
  }
  visited.add(name);

  const includes = pkgJson.ctxr?.includes;
  if (!Array.isArray(includes) || includes.length === 0) {
    visited.delete(name);
    throw new Error(`Bundle "${packageName}" has empty or missing "ctxr.includes"`);
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
        console.error(`  ✗ ${memberSpec}: Invalid member spec in ctxr.includes`);
        continue;
      }
      await dispatcher(memberSpec, flags, { visited, projectPath, report });
    }
  } finally {
    // Always release the visited entry so this bundle can appear again
    // under a different branch of the batch (e.g. same bundle referenced
    // by two separate top-level sources). Cycle detection still works
    // because a recursion that re-enters `name` while it's on the active
    // stack would still see `visited.has(name)`.
    visited.delete(name);
  }

  // Members actually installed by this bundle = delta in report.installed
  // that are new since we entered. Each installed record carries its
  // `installedName`. We intentionally flatten nested-bundle members into
  // the outer bundle's `members` list so that `kit remove <outer-bundle>`
  // can cascade-delete every leaf artifact without walking a tree of
  // nested bundle entries (nested bundles have their own manifest records
  // with their own `members` list if callers want the hierarchy).
  for (let i = beforeInstalledLen; i < report.installed.length; i++) {
    const rec = report.installed[i];
    if (rec && rec.installedName && rec.type !== "bundle") {
      installedMembers.push(rec.installedName);
    }
  }
  const memberFailures = report.failed.length - beforeFailedLen;

  // Write bundle manifest entry. `flags.dir` here is the strategy-derived
  // base dir from `buildCascadeFlags`, NOT a user-supplied `--dir` path;
  // see the helper's docstring for how each strategy maps.
  const manifestDir = resolveBundleManifestDir({
    projectPath,
    user: flags.user,
    dir: flags.dir,
  });
  mkdirSync(manifestDir, { recursive: true });
  const manifest = readManifest(manifestDir);
  const entry = {
    type: "bundle",
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
    `  ✓ installed bundle ${source} (${installedMembers.length}/${includes.length} members` +
      (memberFailures > 0 ? `, ${memberFailures} failed` : "") +
      `)`,
  );

  return {
    installedName: name,
    installedPaths: [join(manifestDir, name)],
    members: installedMembers,
  };
}
