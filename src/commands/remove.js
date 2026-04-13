/**
 * kit remove <identifier> [project-path] [options]
 *
 * Remove an installed artifact (by installed-name or original source) across
 * every known location. Type-aware: walks the full `(type, dir)` space so a
 * skill, agent, command, rule, output-style, or team can all be removed by
 * the same entry point.
 *
 * For team entries, cascade-remove every member unless `--keep-members` is
 * passed. The team's own manifest entry is always removed.
 *
 * Examples:
 *   kit remove ctxr-skill-code-review
 *   kit remove @ctxr/skill-code-review --force
 *   kit remove ctxr-team-full-stack --keep-members
 *   kit remove shared --all --force
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import {
  findArtifactAcrossTypes,
  listAllInstalled,
  removeEntryFromManifest,
} from "../lib/discover.js";

function prompt(question) {
  if (!process.stdin.isTTY) {
    throw new Error("Confirmation requires a TTY. Use --force to skip prompts.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) =>
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    }),
  );
}

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
    all: false,
    keepMembers: false,
    help: false,
  };
  const positionals = [];
  for (const a of args) {
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--force" || a === "-f") flags.force = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--keep-members") flags.keepMembers = true;
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else positionals.push(a);
  }
  return { positionals, flags };
}

function printUsage() {
  console.error("Usage: kit remove <identifier> [project-path] [options]");
  console.error("");
  console.error("Options:");
  console.error("  --force, -f       Skip confirmation prompt");
  console.error("  --all             Remove from every location (non-TTY needs --force)");
  console.error("  --keep-members    For team entries, remove only the team manifest row");
  console.error("  --help, -h        Show this help");
  console.error("");
  console.error("Examples:");
  console.error("  kit remove ctxr-skill-code-review");
  console.error("  kit remove @ctxr/skill-code-review --force");
  console.error("  kit remove ctxr-team-full-stack --keep-members");
}

export default async function remove(args) {
  const { positionals, flags } = parseArgs(args);
  if (flags.help) {
    printUsage();
    return;
  }
  if (positionals.length === 0) {
    printUsage();
    throw new Error("Missing required argument: <identifier>");
  }

  const identifier = positionals[0];
  const projectPath = resolve(positionals[1] || ".");

  const matches = findArtifactAcrossTypes(identifier, projectPath);

  if (matches.length === 0) {
    // Help the user by listing what IS installed.
    const groups = listAllInstalled(projectPath);
    const names = [];
    for (const g of groups) {
      for (const e of g.entries) names.push(e.installedName);
    }
    const tail = names.length > 0 ? `Installed: ${names.join(", ")}` : "No artifacts installed.";
    throw new Error(`Artifact '${identifier}' not found. ${tail}`);
  }

  // Single match
  if (matches.length === 1) {
    const match = matches[0];
    console.log(
      `\n  Found: ${match.entry.installedName} (${match.typeName}) at ${formatPath(match.dir)}\n`,
    );

    if (!flags.force) {
      const answer = await prompt("  Remove this artifact? [y/N]: ");
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log("  Cancelled.\n");
        return;
      }
    }
    const lines = removeMatchCascade(match, {
      keepMembers: flags.keepMembers,
      projectPath,
    });
    for (const l of lines) console.log(l);
    console.log();
    return;
  }

  // Multiple matches
  console.log(
    `\n  '${identifier}' found in ${matches.length} location(s):\n`,
  );
  for (let i = 0; i < matches.length; i++) {
    console.log(
      `    ${i + 1}) ${matches[i].entry.installedName} (${matches[i].typeName}) — ${formatPath(matches[i].dir)}`,
    );
  }
  console.log("");

  if (flags.all) {
    if (!flags.force) {
      const answer = await prompt(
        `  Remove from all ${matches.length} location(s)? [y/N]: `,
      );
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log("  Cancelled.\n");
        return;
      }
    }
    for (const match of matches) {
      const lines = removeMatchCascade(match, {
        keepMembers: flags.keepMembers,
        projectPath,
      });
      for (const l of lines) console.log(l);
    }
    console.log();
    return;
  }

  // Multiple matches, non-interactive without --all: refuse with guidance.
  if (!process.stdin.isTTY) {
    throw new Error(
      `'${identifier}' matches ${matches.length} locations. ` +
        "Use --all --force to remove from every location in non-TTY mode.",
    );
  }

  const answer = await prompt(
    `  Which to remove? (1-${matches.length}, 'all', or 'none') [none]: `,
  );
  if (answer.toLowerCase() === "all") {
    for (const match of matches) {
      const lines = removeMatchCascade(match, {
        keepMembers: flags.keepMembers,
        projectPath,
      });
      for (const l of lines) console.log(l);
    }
    console.log();
    return;
  }
  if (!answer || answer.toLowerCase() === "none") {
    console.log("  Cancelled.\n");
    return;
  }
  const indices = answer
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1);
  const invalid = indices.find(
    (i) => Number.isNaN(i) || i < 0 || i >= matches.length,
  );
  if (invalid !== undefined) {
    throw new Error(`Invalid choice: ${answer}`);
  }
  for (const idx of indices) {
    const lines = removeMatchCascade(matches[idx], {
      keepMembers: flags.keepMembers,
      projectPath,
    });
    for (const l of lines) console.log(l);
  }
  console.log();
}
