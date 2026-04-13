/**
 * kit update [identifier] [project-path] [options]
 *
 * Re-install an artifact (or every artifact) from its recorded `source`
 * package spec. Type-aware — walks every `(type, dir)` pair. Without an
 * identifier, every artifact that has a recorded source is updated; with
 * one, only matching entries (by installed-name or source) are updated.
 *
 * Pre-flight check: before touching any existing install, update splits
 * the requested identifiers into `installed` (found) and `missing` (not
 * found via findArtifactAcrossTypes). If any identifier is missing:
 *
 *   - Without `--install`: print the missing list to stderr, don't touch
 *     any installed artifact, exit with usage error (code 2).
 *   - With `--install`: delegate to the install command, passing the
 *     original argv MINUS `--install`. install() runs with its full
 *     interactive/--yes/CI flow, so the user's experience matches
 *     running `kit install <missing>` directly with the same flags.
 *     After install completes, update continues with the `installed`
 *     subset via the snapshot + reinstall flow.
 *
 * Backup/restore semantics: folder- and file-target artifacts are copied
 * to a tmpDir before the uninstall so a failed re-install can be rolled
 * back to the previous version. Team entries cascade-remove every member
 * first so the re-install runs from a clean slate; a team update that
 * fails part-way leaves members in whatever state the reinstall reached.
 *
 * Examples:
 *   kit update                                     # update all installed
 *   kit update ctxr-skill-code-review              # update one by name
 *   kit update @ctxr/skill-foo --install           # install if missing
 *   kit update @ctxr/skill-foo @ctxr/skill-bar --yes  # silent batch
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  findArtifactAcrossTypes,
  listAllInstalled,
  readManifest,
  removeEntryFromManifest,
  writeManifest,
} from "../lib/discover.js";
import { isFlagLike, unknownFlagError, usageError } from "../lib/cli-errors.js";

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
 *
 * "User scope" for a team is defined as living under `~/.claude/teams/`
 * specifically — NOT just "any path under $HOME". A project whose root
 * happens to live under `$HOME` (e.g. `~/projects/myrepo`) would otherwise
 * be misclassified and its project-scope team entry would get re-installed
 * as user-global on update.
 */
function scopeFlagsForEntry(dir, { isTeam } = {}) {
  if (isTeam) {
    const userTeamsBase = join(homedir(), ".claude", "teams");
    const isUserTeam = dir === userTeamsBase || dir.startsWith(userTeamsBase + sep);
    return isUserTeam ? ["--user"] : [];
  }
  return ["--dir", dir];
}

/**
 * Parse update's argv into identifiers (positional) + flags. Separates the
 * trailing `project-path` positional via filesystem probing — a positional
 * whose resolved path is an existing dir with `.claude/` or `.agents/` is
 * the project root, anything else is an identifier.
 */
function parseArgs(args) {
  const flags = {
    help: false,
    install: false,
    yes: false,
    interactive: false,
    user: false,
    dir: null,
  };
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--install") flags.install = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--interactive" || a === "-i") flags.interactive = true;
    else if (a === "--user") flags.user = true;
    else if (a === "--dir") {
      flags.dir = args[++i];
      if (!flags.dir) throw usageError("--dir requires a path argument");
    } else if (isFlagLike(a)) {
      throw unknownFlagError(a, "update");
    } else {
      positionals.push(a);
    }
  }

  // Positional disambiguation:
  //   0 positionals → update everything in cwd
  //   1 positional  → identifier OR project-path, resolved by filesystem probe
  //   2+ positionals → [identifiers..., maybe-path]; the last positional is
  //                    promoted to path if it resolves to an existing
  //                    directory (a brand-new user-global install target
  //                    doesn't yet have .claude/ or .agents/, so we do NOT
  //                    require those markers — matches the old update.js
  //                    semantics that tests rely on).
  let identifiers = [];
  let pathArg = null;
  if (positionals.length === 0) {
    // update everything in cwd
  } else if (positionals.length === 1) {
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
    if (isProjectRoot) pathArg = only;
    else identifiers = [only];
  } else {
    const last = positionals[positionals.length - 1];
    let lastLooksLikePath = false;
    try {
      const abs = resolve(last);
      // Any existing directory qualifies as a project-path positional —
      // user-global installs don't require `.claude/` or `.agents/` in the
      // project root for the caller to still want the project scope to
      // resolve there.
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        lastLooksLikePath = true;
      }
    } catch {
      lastLooksLikePath = false;
    }
    if (lastLooksLikePath) {
      pathArg = last;
      identifiers = positionals.slice(0, -1);
    } else {
      identifiers = [...positionals];
    }
  }
  const projectPath = resolve(pathArg || ".");
  return { identifiers, projectPath, flags };
}

/**
 * Reconstruct the install argv to pass to the install command for missing
 * items. We forward every flag the user gave update EXCEPT `--install`
 * (which is update-specific). Positional identifiers become the install
 * sources. If update was run with no identifier (updating everything),
 * there's no "missing" set to pass — the delegation is skipped.
 */
function buildInstallArgv(missing, flags) {
  const argv = [...missing];
  if (flags.yes) argv.push("--yes");
  if (flags.interactive) argv.push("--interactive");
  if (flags.user) argv.push("--user");
  if (flags.dir) argv.push("--dir", flags.dir);
  return argv;
}

/**
 * Run a reinstall for one already-installed entry via the `install`
 * command. Preserves the entry's scope via `--dir` (or `--user` for
 * teams). `forwardedOpts` is the same DI bag the top-level command
 * accepts — when present it's passed through to every recursive install
 * call so in-process tests can see the mock prompt.
 */
async function updateOne(match, projectPath, flags, forwardedOpts) {
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

  // Forward --yes / --interactive so the reinstall honors the user's
  // update-time choice. --dir/--user come from scope detection below.
  const passthroughFlags = [];
  if (flags.yes) passthroughFlags.push("--yes");
  if (flags.interactive) passthroughFlags.push("--interactive");

  // Team cascade — remove every member first, then reinstall.
  if (typeName === "team") {
    const memberNames = Array.isArray(entry.members) ? entry.members : [];
    for (const memberName of memberNames) {
      const memberMatches = findArtifactAcrossTypes(memberName, projectPath);
      for (const mm of memberMatches) removeEntryFromManifest(mm);
    }
    removeEntryFromManifest(match);
    try {
      const teamScopeFlags = scopeFlagsForEntry(dir, { isTeam: true });
      const installArgs = teamScopeFlags.includes("--user")
        ? [entry.source, ...teamScopeFlags, ...passthroughFlags]
        : [entry.source, ...teamScopeFlags, ...passthroughFlags, projectPath];
      await installCmd(installArgs, forwardedOpts);
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

  // Single artifact — snapshot + reinstall with rollback.
  const snapshot = snapshotEntry(entry);
  removeEntryFromManifest(match);
  try {
    await installCmd(
      [entry.source, ...scopeFlagsForEntry(dir), ...passthroughFlags],
      forwardedOpts,
    );
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
  console.error("Usage: npx @ctxr/kit update [identifier]... [project-path] [options]");
  console.error("");
  console.error("Re-install one or every artifact from its recorded `source`.");
  console.error("");
  console.error("Arguments:");
  console.error("  identifier     installed-name, package spec, or recorded source");
  console.error("                 (omit to update every artifact in the project)");
  console.error("  project-path   project root (defaults to cwd)");
  console.error("");
  console.error("Options:");
  console.error("  --install          For missing identifiers, run 'kit install' with");
  console.error("                     the same flags instead of erroring out");
  console.error("  -y, --yes          Skip prompts (forwarded to install for missing items)");
  console.error("  -i, --interactive  Force interactive mode (forwarded to install)");
  console.error("  --dir <path>       Override destination for installs of missing items");
  console.error("  --user             Install missing items user-global (~/.claude/<type>/)");
  console.error("  -h, --help         Show this help");
  console.error("");
  console.error("Examples:");
  console.error("  npx @ctxr/kit update");
  console.error("  npx @ctxr/kit update ctxr-skill-code-review");
  console.error("  npx @ctxr/kit update @ctxr/skill-foo --install");
  console.error("  npx @ctxr/kit update @ctxr/a @ctxr/b --install --yes");
}

export default async function update(args, opts = {}) {
  const { identifiers, projectPath, flags } = parseArgs(args);

  if (flags.help) {
    printUsage();
    return;
  }

  // Dependency injection: tests can pass `opts.prompt` to supply a mocked
  // prompt module that the delegated install receives when this update
  // turns into "install missing items". Production callers (CLI entry
  // point) leave it undefined and install's default module-level import
  // of interactive.js takes over.
  const forwardedOpts = opts.prompt ? { prompt: opts.prompt } : undefined;

  // Determine what we're updating.
  let matches;
  let missing = [];
  if (identifiers.length > 0) {
    matches = [];
    for (const identifier of identifiers) {
      const found = findArtifactAcrossTypes(identifier, projectPath);
      if (found.length === 0) {
        missing.push(identifier);
      } else {
        matches.push(...found);
      }
    }

    if (missing.length > 0) {
      // PRE-FLIGHT: some identifiers aren't installed. Two branches:
      //   (1) --install → delegate to install, then continue with the rest.
      //   (2) no --install → print list, exit without touching anything.
      if (!flags.install) {
        console.error(
          `\n  The following artifact${missing.length === 1 ? " is" : "s are"} not installed:`,
        );
        for (const id of missing) console.error(`    - ${id}`);
        console.error(
          `\n  Run with --install to install them, or omit them from the update.`,
        );
        throw usageError(
          `update: ${missing.length} identifier${missing.length === 1 ? "" : "s"} not installed`,
        );
      }

      // Delegate missing items to the install command. We pass the exact
      // argv shape that a user would type themselves — install's own
      // interactive/--yes/CI flow applies. install throws if the batch
      // has any failures; we treat that as a hard stop.
      const installArgv = buildInstallArgv(missing, flags);
      console.log(
        `\n  Installing ${missing.length} missing item${missing.length === 1 ? "" : "s"} via 'kit install':`,
      );
      const { default: installCmd } = await import("./install.js");
      // Forward the test-provided prompt module so in-process tests of
      // update's --install delegation see the same mock the installer
      // would have received if they'd called install directly.
      await installCmd(installArgv, forwardedOpts);

      // Re-resolve matches — the freshly-installed items now have manifest
      // entries and can be updated in the same pass. (Usually they're
      // already fresh and don't need a second update, but the flow is
      // uniform: update = "make sure these are up-to-date".)
      for (const identifier of missing) {
        const found = findArtifactAcrossTypes(identifier, projectPath);
        matches.push(...found);
      }
      missing = [];
    }
  } else {
    const groups = listAllInstalled(projectPath);
    if (groups.length === 0) {
      throw new Error(
        "No artifacts installed. Use 'npx @ctxr/kit install' first.",
      );
    }
    matches = [];
    for (const { typeName, dir, entries } of groups) {
      for (const entry of entries) {
        matches.push({ typeName, dir, entry });
      }
    }
  }

  if (matches.length === 0) return; // everything was newly-installed via --install, nothing to update again

  console.log("\nUpdating artifacts:\n");

  let failures = 0;
  for (const match of matches) {
    const { ok, skipped } = await updateOne(
      match,
      projectPath,
      flags,
      forwardedOpts,
    );
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
