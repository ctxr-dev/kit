/**
 * kit remove <identifier>... [project-path] [options]
 *
 * Remove installed artifacts (by installed-name or original source) across
 * every known location. Type-aware: walks the full `(type, dir)` space so a
 * skill, agent, command, rule, output-style, or team can all be removed by
 * the same entry point.
 *
 * Behavior rules for this command:
 *
 *   1. **Missing identifiers are SOFT-SKIPPED.** If an identifier isn't
 *      installed anywhere, kit prints a one-line "not installed" note to
 *      stderr and continues. This matches the principle: `remove` means
 *      "make sure these artifacts aren't installed" — they weren't; job
 *      done. Exit code stays 0 unless something actually failed to remove.
 *
 *   2. **`--yes` / `-y` skips confirmation AND removes from every
 *      matching location.** When an identifier is installed in multiple
 *      places (project-local and user-global, say), `--yes` removes from
 *      all of them. Without `--yes`, the interactive multi-location
 *      picker asks which to remove.
 *
 *   3. **`--force` is kept as an alias for `--yes`** so earlier scripts
 *      that passed `--force` keep working.
 *
 *   4. **Team cascade** — removing a team also removes every member
 *      listed in its `members` manifest field, unless `--keep-members`
 *      is passed.
 *
 * Examples:
 *   kit remove ctxr-skill-code-review
 *   kit remove @ctxr/skill-code-review --yes
 *   kit remove ctxr-team-full-stack --keep-members
 *   kit remove skill-a skill-b skill-c --yes
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  findArtifactAcrossTypes,
  listAllInstalled,
  removeEntryFromManifest,
} from "../lib/discover.js";
import * as interactive from "../lib/interactive.js";
import { isFlagLike, unknownFlagError, usageError } from "../lib/cli-errors.js";

function formatPath(p) {
  const home = homedir();
  return p.startsWith(home) ? p.replace(home, "~") : p;
}

/**
 * Remove a single matched artifact, cascading to team members when
 * appropriate. Returns a short array of user-facing success lines.
 */
function removeMatchCascade(match, { keepMembers, projectPath }) {
  const { typeName, entry } = match;
  const lines = [];

  if (typeName === "team" && !keepMembers && Array.isArray(entry.members)) {
    for (const memberName of entry.members) {
      const memberMatches = findArtifactAcrossTypes(memberName, projectPath);
      for (const m of memberMatches) {
        removeEntryFromManifest(m);
        lines.push(
          `    ↳ removed member '${m.entry.installedName}' from ${formatPath(m.dir)}`,
        );
      }
    }
  }

  removeEntryFromManifest(match);
  lines.push(
    `  ✓ removed '${entry.installedName}' (${typeName}) from ${formatPath(match.dir)}`,
  );
  return lines;
}

function parseArgs(args) {
  const flags = {
    force: false,
    yes: false,
    interactive: false,
    keepMembers: false,
    help: false,
  };
  const positionals = [];
  for (const a of args) {
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--force" || a === "-f") flags.force = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--interactive" || a === "-i") flags.interactive = true;
    else if (a === "--keep-members") flags.keepMembers = true;
    // --all is a legacy alias for --yes. In the old remove command, --all
    // meant "apply to every matching location even in non-TTY mode"; with
    // the new --yes rule (which also removes from every match on multi-
    // hit), --all becomes a redundant no-op. We accept it silently so
    // scripts that still pass it keep working.
    else if (a === "--all") flags.yes = true;
    else if (isFlagLike(a)) {
      throw unknownFlagError(a, "remove");
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function printUsage() {
  console.error("Usage: npx @ctxr/kit remove <identifier>... [project-path] [options]");
  console.error("");
  console.error("Options:");
  console.error("  -y, --yes          Skip confirmation AND remove from every matching location");
  console.error("  -f, --force        Alias for --yes (kept for script compatibility)");
  console.error("  -i, --interactive  Force interactive picker (overrides CI detection)");
  console.error("  --keep-members     For team entries, remove only the team manifest row");
  console.error("  -h, --help         Show this help");
  console.error("");
  console.error("Examples:");
  console.error("  npx @ctxr/kit remove ctxr-skill-code-review");
  console.error("  npx @ctxr/kit remove @ctxr/skill-code-review --yes");
  console.error("  npx @ctxr/kit remove ctxr-team-full-stack --keep-members");
  console.error("  npx @ctxr/kit remove a b c --yes");
}

/**
 * Partition positionals into identifiers + optional project-path. Same
 * heuristic as update.js: if the LAST positional resolves to an existing
 * directory containing `.claude/` or `.agents/`, it's the project root.
 */
function splitPositionals(positionals) {
  if (positionals.length === 0) return { identifiers: [], projectPath: resolve(".") };
  if (positionals.length === 1)
    return { identifiers: [positionals[0]], projectPath: resolve(".") };

  const last = positionals[positionals.length - 1];
  let lastLooksLikePath = false;
  try {
    const abs = resolve(last);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      lastLooksLikePath =
        existsSync(join(abs, ".claude")) || existsSync(join(abs, ".agents"));
    }
  } catch {
    lastLooksLikePath = false;
  }
  if (lastLooksLikePath) {
    return {
      identifiers: positionals.slice(0, -1),
      projectPath: resolve(last),
    };
  }
  return { identifiers: [...positionals], projectPath: resolve(".") };
}

/**
 * Interactive multi-location picker. Uses the shared interactive module so
 * CI / !isTTY / --yes auto-fall-through to "remove from all locations".
 */
async function pickLocations(matches, flags, prompt) {
  const options = matches.map((m, idx) => ({
    value: idx,
    label: `${m.entry.installedName} (${m.typeName}) — ${formatPath(m.dir)}`,
  }));
  options.push({ value: "all", label: "Remove from ALL locations" });
  options.push({ value: "none", label: "Cancel" });

  // Initial selection = "all" if --yes/CI (silent fallback already handled
  // earlier, but pick something safe as the default).
  const pick = await prompt.select({
    message: `'${matches[0].entry.installedName}' is installed in ${matches.length} locations. Which to remove?`,
    options,
    defaultValue: "all",
    flags,
  });

  if (pick === "none") return [];
  if (pick === "all") return matches;
  return [matches[pick]];
}

async function removeOne(identifier, projectPath, flags, prompt) {
  const matches = findArtifactAcrossTypes(identifier, projectPath);

  if (matches.length === 0) {
    // SOFT-SKIP: print a helpful note, don't throw, don't exit non-zero.
    console.log(`  ℹ '${identifier}' is not installed (nothing to remove)`);
    return { removed: 0, skipped: true };
  }

  // Single match — remove without prompting for location (there's only one),
  // but still honor the confirmation-before-destructive rule via prompt.confirm.
  if (matches.length === 1) {
    const match = matches[0];
    console.log(
      `\n  Found: ${match.entry.installedName} (${match.typeName}) at ${formatPath(match.dir)}`,
    );
    // Safety: in non-TTY / CI mode, a destructive op without explicit
    // --yes/--force is a hard error. Silently returning "did nothing" is
    // worse than erroring — a CI pipeline that meant to remove something
    // should fail loudly, not succeed-without-effect.
    const explicitlyAuthorized = flags.force || flags.yes;
    if (!explicitlyAuthorized && prompt.isNonInteractive(flags)) {
      throw new Error(
        "Confirmation requires a TTY. Use --force (or --yes) to skip prompts.",
      );
    }
    const shouldProceed = explicitlyAuthorized
      ? true
      : await prompt.confirm({
          message: "Remove this artifact?",
          defaultValue: false,
          flags,
        });
    if (!shouldProceed) {
      console.log("  Cancelled.");
      return { removed: 0, skipped: false };
    }
    const lines = removeMatchCascade(match, {
      keepMembers: flags.keepMembers,
      projectPath,
    });
    for (const l of lines) console.log(l);
    console.log();
    return { removed: 1, skipped: false };
  }

  // Multi-match — two paths:
  //   --yes / --force → remove from ALL without prompting (new rule from Q18)
  //   interactive     → run the location picker, let user choose
  console.log(`\n  '${identifier}' found in ${matches.length} locations:`);
  for (let i = 0; i < matches.length; i++) {
    console.log(
      `    ${i + 1}) ${matches[i].entry.installedName} (${matches[i].typeName}) — ${formatPath(matches[i].dir)}`,
    );
  }
  console.log();

  if (flags.yes || flags.force) {
    // Non-interactive: remove from every match.
    let removed = 0;
    for (const match of matches) {
      const lines = removeMatchCascade(match, {
        keepMembers: flags.keepMembers,
        projectPath,
      });
      for (const l of lines) console.log(l);
      removed++;
    }
    console.log();
    return { removed, skipped: false };
  }

  // Interactive multi-location picker.
  const picked = await pickLocations(matches, flags, prompt);
  if (picked.length === 0) {
    console.log("  Cancelled.");
    return { removed: 0, skipped: false };
  }
  let removed = 0;
  for (const match of picked) {
    const lines = removeMatchCascade(match, {
      keepMembers: flags.keepMembers,
      projectPath,
    });
    for (const l of lines) console.log(l);
    removed++;
  }
  console.log();
  return { removed, skipped: false };
}

export default async function remove(args, opts = {}) {
  const prompt = opts.prompt ?? interactive;

  const { positionals, flags } = parseArgs(args);
  if (flags.help) {
    printUsage();
    return;
  }
  if (positionals.length === 0) {
    printUsage();
    throw usageError("Missing required argument: <identifier>");
  }

  const { identifiers, projectPath } = splitPositionals(positionals);
  if (identifiers.length === 0) {
    printUsage();
    throw usageError("Missing required argument: <identifier>");
  }

  // If the user provided a single missing identifier AND no other identifier,
  // print a hint showing what IS installed so they can recover quickly.
  const showInstalledOnFirstMiss = identifiers.length === 1;

  let totalRemoved = 0;
  let anyMissing = false;

  for (const identifier of identifiers) {
    try {
      const { removed, skipped } = await removeOne(
        identifier,
        projectPath,
        flags,
        prompt,
      );
      totalRemoved += removed;
      if (skipped) anyMissing = true;
    } catch (err) {
      if (err instanceof interactive.UserAbortError) {
        console.error("\n  Cancelled.");
      }
      throw err;
    }
  }

  if (anyMissing && showInstalledOnFirstMiss && totalRemoved === 0) {
    // Print the "installed names" hint block AFTER the soft-skip note so
    // the user sees what's actually in the project.
    const groups = listAllInstalled(projectPath);
    const names = [];
    for (const g of groups) for (const e of g.entries) names.push(e.installedName);
    if (names.length > 0) {
      console.log(`\n  Installed: ${names.join(", ")}\n`);
    } else {
      console.log(`\n  No artifacts installed.\n`);
    }
  }
}
