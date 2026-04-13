#!/usr/bin/env node

/**
 * @ctxr/kit — universal CLI for Claude Code artifacts.
 *
 * `kit` installs, validates, updates, and scaffolds every artifact type
 * Claude Code understands: skills, agents, commands, output-styles, rules,
 * plus ctxr "team" meta-packages that bundle several artifacts together.
 *
 * Usage:
 *   npx @ctxr/kit <command> [options]
 *
 * The CLI itself is just a router. It decodes `--help` / `--version` and
 * dispatches everything else to a per-command module under `commands/`.
 * Each subcommand owns its own argv parsing, validation, and help text —
 * the router never inspects subcommand flags. This keeps the entry point
 * boring and the per-command help authoritative.
 */

const [, , command, ...args] = process.argv;

const COMMANDS = {
  validate: () => import("./commands/validate.js"),
  install: () => import("./commands/install.js"),
  update: () => import("./commands/update.js"),
  remove: () => import("./commands/remove.js"),
  uninstall: () => import("./commands/remove.js"),
  list: () => import("./commands/list.js"),
  init: () => import("./commands/init.js"),
  info: () => import("./commands/info.js"),
};

function printUsage() {
  console.log(`
@ctxr/kit — universal CLI for Claude Code artifacts

Usage:
  npx @ctxr/kit <command> [options]

Commands:
  install <source>...       Install one or more artifacts (npm, github:, local)
  update [name]             Update installed artifact(s) in place
  remove <name>             Remove an installed artifact
  list [path]               List installed artifacts grouped by type
  info <identifier>         Show info about an artifact
  validate [path]           Validate an artifact package's structure
  init [--type <t>] [name]  Scaffold a new artifact package

Artifact types:
  skill, agent, command, rule, output-style, team

Global options:
  --help, -h                Show this help message
  --version, -v             Show version
  -y, --yes                 Skip all prompts and use defaults
  -i, --interactive         Force interactive mode (overrides CI detection)

Interactive mode (default):
  In a TTY, kit prompts for destination selection, wizard fields, and
  destructive confirmations. Non-interactive mode is triggered automatically
  when CI=true is set (GitHub Actions, GitLab, CircleCI, etc.) or when
  stdin is not a terminal — so scripts and pipelines keep working without
  any flag. Pass --yes to force non-interactive mode from within a TTY.
  Pass --interactive to force prompts even in CI.

Install-time options (for 'install'; forwarded by 'update --install'):
  --dir <path>              Install into a specific directory (skips menu)
  --user                    Install to ~/.claude/<type>/ (skips menu)

Exit codes:
  0  success
  1  runtime failure
  2  usage error (unknown command, unknown flag, missing argument)

Examples:
  npx @ctxr/kit install @ctxr/skill-code-review
  npx @ctxr/kit install @ctxr/skill-a @ctxr/agent-b @ctxr/rule-c
  npx @ctxr/kit install @ctxr/team-full-stack --user
  npx @ctxr/kit init --type agent my-agent
  npx @ctxr/kit list
  npx @ctxr/kit validate ./my-skill

Run 'npx @ctxr/kit <command> --help' for command-specific options.
`);
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    } catch {
      console.log("unknown");
      process.exit(0);
    }
    console.log(pkg.version);
    process.exit(0);
  }

  const loader = COMMANDS[command];
  if (!loader) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'npx @ctxr/kit --help' for usage information.`);
    // POSIX-ish convention: 2 = usage error, 1 = runtime failure.
    process.exit(2);
  }

  const mod = await loader();
  await mod.default(args);
}

main().catch((err) => {
  // Suppress the error message for UserAbortError — the command already
  // printed "Cancelled." to stderr. Double-printing produces confusing
  // output. Every other thrown error surfaces its message here.
  if (err?.name !== "UserAbortError") {
    console.error(err.message);
  }
  // Subcommands tag usage errors with `err.exitCode = 2` so scripts can
  // distinguish "you typed it wrong" from "the install actually failed".
  // Any other thrown error exits 1 (runtime failure). Validate the tag
  // value before passing it to process.exit — `process.exit(NaN)` and
  // `process.exit(-1)` both throw ERR_OUT_OF_RANGE at runtime, which
  // would mask the original error with a confusing stack trace.
  const tag = err?.exitCode;
  const exitCode =
    Number.isInteger(tag) && tag >= 0 && tag <= 255 ? tag : 1;
  process.exit(exitCode);
});
