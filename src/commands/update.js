/**
 * kit update [identifier] [project-path]
 *
 * Re-install an artifact (or every artifact) from its recorded `source`
 * package spec. Type-aware — walks every `(type, dir)` pair. Without an
 * identifier, every artifact that has a recorded source is updated; with
 * one, only matching entries (by installed-name or source) are updated.
 *
 * Backup/restore semantics: folder- and file-target artifacts are copied to
 * a tmpDir before the uninstall so a failed re-install can be rolled back to
 * the previous version. Team entries cascade-remove every member first so
 * the re-install runs from a clean slate; a team update that fails part-way
 * leaves members in whatever state the reinstall reached.
 *
 * Examples:
 *   kit update                                     # update all
 *   kit update ctxr-skill-code-review              # update one by installed-name
 *   kit update @ctxr/skill-code-review             # update one by package source
 *   kit update ctxr-team-full-stack                # cascade-update team members
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  findArtifactAcrossTypes,
  listAllInstalled,
  readManifest,
  removeEntryFromManifest,
  writeManifest,
} from "../lib/discover.js";

/**
 * Snapshot every path in `installedPaths` into a throwaway tmpDir so the
 * update can roll back on failure. Returns `null` for team entries (their
 * paths are synthetic — nothing lives there to snapshot).
 */
function snapshotEntry(entry) {
  if (entry.type === "team") return null;
  const paths = (entry.installedPaths || []).filter((p) => existsSync(p));
  if (paths.length === 0) return null;
  const backupDir = mkdtempSync(join(tmpdir(), "ctxr-update-backup-"));
  const snapshots = [];
  for (const p of paths) {
    const name = basename(p);
    const dest = join(backupDir, name);
    cpSync(p, dest, { recursive: true });
    snapshots.push({ original: p, backup: dest });
  }
  return { backupDir, snapshots };
}

/**
 * Restore a previously-taken snapshot over the current on-disk state.
 */
function restoreSnapshot(snapshot) {
  if (!snapshot) return;
  for (const { original, backup } of snapshot.snapshots) {
    try {
      rmSync(original, { recursive: true, force: true });
      const stat = lstatSync(backup);
      cpSync(backup, original, { recursive: stat.isDirectory() });
    } catch {
      // Best effort — a restore failure is already a degraded state and
      // surfaces to the caller via the outer error path.
    }
  }
}

function cleanupSnapshot(snapshot) {
  if (!snapshot) return;
  try {
    rmSync(snapshot.backupDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Build the install flags that pin a reinstall to the same scope the entry
 * currently lives in. Non-team artifacts use `--dir <dir>` to land in the
 * exact original location. Teams can't use `--dir` because the flag would
 * cascade to every member and stuff them into the team manifest directory
 * — instead we translate user-scope teams to `--user` and let project-scope
 * teams fall back to the default `.claude/teams/` location.
 */
function scopeFlagsForEntry(dir, { isTeam } = {}) {
  if (isTeam) {
    return dir.startsWith(homedir()) ? ["--user"] : [];
  }
  return ["--dir", dir];
}

/**
 * Run a reinstall, passing the projectPath explicitly so members of a team
 * reinstall land in the same project the original team was installed in
 * (not in the CLI caller's cwd). For non-team entries we use `--dir <abs>`
 * and don't need the trailing positional, but it's harmless when passed.
 */
async function updateOne(match, projectPath) {
  const { typeName, dir, entry } = match;
  if (!entry.source) {
    console.log(
      `  ⚠ ${entry.installedName}: no recorded source — reinstall via 'npx @ctxr/kit install'`,
    );
    return { ok: false, skipped: true };
  }

  console.log(`  Updating ${entry.installedName} from ${entry.source}...`);
  console.log(`    location: ${dir}`);

  const { default: installCmd } = await import("./install.js");

  // Team cascade: remove every member first so the team reinstall runs from
  // a clean slate. If the cascade reinstall fails mid-way, callers are left
  // with a partially-updated team — we record that as a failure rather than
  // attempting a best-effort restore (the member artifacts themselves are
  // small and cheap to reinstall).
  if (typeName === "team") {
    const memberNames = Array.isArray(entry.members) ? entry.members : [];
    for (const memberName of memberNames) {
      const memberMatches = findArtifactAcrossTypes(memberName, projectPath);
      for (const mm of memberMatches) removeEntryFromManifest(mm);
    }
    removeEntryFromManifest(match);
    try {
      // For team updates we pass projectPath as a trailing positional so
      // the dispatcher roots both the team manifest AND every cascaded
      // member install at the correct project, regardless of cwd.
      const teamScopeFlags = scopeFlagsForEntry(dir, { isTeam: true });
      const installArgs = teamScopeFlags.includes("--user")
        ? [entry.source, ...teamScopeFlags]
        : [entry.source, ...teamScopeFlags, projectPath];
      await installCmd(installArgs);
      const manifest = readManifest(dir);
      if (manifest[entry.installedName]) {
        manifest[entry.installedName].updatedAt = new Date().toISOString();
        writeManifest(dir, manifest);
      }
      console.log(`  ✓ ${entry.installedName}: team cascade complete`);
      return { ok: true, skipped: false };
    } catch (err) {
      console.error(
        `  ✗ ${entry.installedName}: team update failed — ${err.message}`,
      );
      console.error(
        `    Team and its members were partially removed — reinstall manually.`,
      );
      return { ok: false, skipped: false };
    }
  }

  // Single artifact: snapshot, remove, reinstall, restore on failure.
  const snapshot = snapshotEntry(entry);
  removeEntryFromManifest(match);
  try {
    await installCmd([entry.source, ...scopeFlagsForEntry(dir)]);
    // Stamp `updatedAt` on the fresh manifest row so list/info can show
    // the last-update time. The installer writes `updatedAt: null` by
    // default because it doesn't know it was called in an update flow.
    const manifest = readManifest(dir);
    if (manifest[entry.installedName]) {
      manifest[entry.installedName].updatedAt = new Date().toISOString();
      writeManifest(dir, manifest);
    }
    console.log(`  ✓ ${entry.installedName}: updated`);
    return { ok: true, skipped: false };
  } catch (err) {
    console.error(`  ✗ ${entry.installedName}: update failed — ${err.message}`);
    if (snapshot) {
      restoreSnapshot(snapshot);
      // Restore the manifest row too.
      const manifest = readManifest(dir);
      manifest[entry.installedName] = {
        type: entry.type,
        target: entry.target,
        source: entry.source,
        sourceType: entry.sourceType,
        version: entry.version,
        installedPaths: entry.installedPaths,
        installedAt: entry.installedAt,
        updatedAt: entry.updatedAt,
        ...(entry.integrity ? { integrity: entry.integrity } : {}),
      };
      writeManifest(dir, manifest);
      console.log(`  ↺ ${entry.installedName}: restored previous version`);
    }
    return { ok: false, skipped: false };
  } finally {
    cleanupSnapshot(snapshot);
  }
}

function printUsage() {
  console.error("Usage: npx @ctxr/kit update [identifier] [project-path]");
  console.error("");
  console.error("Re-install one or every artifact from its recorded `source`.");
  console.error("");
  console.error("Arguments:");
  console.error("  identifier     installed-name, package spec, or recorded source");
  console.error("                 (omit to update every artifact in the project)");
  console.error("  project-path   project root (defaults to cwd)");
  console.error("");
  console.error("Examples:");
  console.error("  npx @ctxr/kit update");
  console.error("  npx @ctxr/kit update ctxr-skill-code-review");
  console.error("  npx @ctxr/kit update @ctxr/skill-code-review");
  console.error("  npx @ctxr/kit update ctxr-team-full-stack");
}

export default async function update(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  // Positional parse:
  //   0 args                        → update everything in cwd
  //   1 arg (identifier)            → update that identifier in cwd
  //   2 args (identifier, path)     → update identifier inside path
  //
  // The identifier may be an installed-name, a package spec (e.g.
  // `@ctxr/skill-foo`), OR the original source string the user typed on
  // install (which can be an absolute path). We do NOT try to guess whether
  // a leading `./` means "path arg" vs "source" — the user disambiguates by
  // position. `kit update .` is the only path-shorthand we honor (project
  // path resolves to cwd, no identifier).
  const positionals = args.filter((a) => !a.startsWith("-"));
  let identifier;
  let pathArg;
  if (positionals.length === 0) {
    // update everything in cwd
  } else if (positionals.length === 1) {
    // Ambiguous: `kit update <thing>` could mean "update this identifier in
    // cwd" OR "update everything in this project". Disambiguate by probing
    // the filesystem — a path that resolves to an existing directory
    // containing `.claude/` or `.agents/` is a project root; anything else
    // is an identifier (installed-name or recorded source).
    const only = positionals[0];
    let isProjectRoot = false;
    try {
      const abs = resolve(only);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        isProjectRoot =
          existsSync(join(abs, ".claude")) || existsSync(join(abs, ".agents"));
      }
    } catch {
      isProjectRoot = false;
    }
    if (isProjectRoot) {
      pathArg = only;
    } else {
      identifier = only;
    }
  } else {
    identifier = positionals[0];
    pathArg = positionals[1];
  }
  const projectPath = resolve(pathArg || ".");

  let matches;
  if (identifier) {
    matches = findArtifactAcrossTypes(identifier, projectPath);
    if (matches.length === 0) {
      // List what IS installed for a helpful error.
      const groups = listAllInstalled(projectPath);
      const names = [];
      for (const g of groups) {
        for (const e of g.entries) names.push(e.installedName);
      }
      const tail = names.length > 0 ? `Installed: ${names.join(", ")}` : "No artifacts installed.";
      throw new Error(`Artifact '${identifier}' not found. ${tail}`);
    }
  } else {
    const groups = listAllInstalled(projectPath);
    if (groups.length === 0) {
      throw new Error("No artifacts installed. Use 'npx @ctxr/kit install' first.");
    }
    matches = [];
    for (const { typeName, dir, entries } of groups) {
      for (const entry of entries) {
        matches.push({ typeName, dir, entry });
      }
    }
  }

  console.log("\nUpdating artifacts:\n");

  let failures = 0;
  for (const match of matches) {
    const { ok, skipped } = await updateOne(match, projectPath);
    if (!ok && !skipped) failures++;
  }

  if (failures > 0) {
    console.log(`\n⚠ Update completed with ${failures} failure(s)\n`);
    const err = new Error(`update failed: ${failures} error(s)`);
    err.batchFailures = failures;
    throw err;
  }
  console.log("\n✓ Update complete\n");
}
