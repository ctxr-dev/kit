/**
 * kit install <source> [<source>...] [options]
 *
 * Batch installer for every Claude Code artifact type. Accepts one or more
 * sources (npm package spec, `github:owner/repo`, or local path). Each source
 * is fetched into a throwaway tmpDir, its `package.json → ctxr` block is
 * read, and the appropriate installer (folder / file / team) is dispatched.
 *
 * Batch-continue semantics (per plan §7):
 *   - A failure on one source records the error and moves on to the next.
 *   - The batch never aborts on a single failure.
 *   - Exit code is non-zero if any source failed.
 *
 * Every per-source cleanup runs in a `finally`, so an interrupted install
 * leaves no junk in /tmp and nothing outside the package's `files` field
 * can reach `.claude/`.
 *
 * Examples:
 *   kit install @ctxr/skill-code-review
 *   kit install ./path/to/local-skill --dir .agents/skills
 *   kit install @ctxr/skill-a @ctxr/agent-b @ctxr/team-full-stack --user
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createTmpDir,
  fetchFromGitHub,
  fetchFromLocal,
  fetchFromNpm,
  resolveSource,
} from "../lib/fetch.js";
import { resolveTargetRoot, resolveType } from "../lib/types.js";
import { installFolder } from "../installers/folder.js";
import { installFile } from "../installers/file.js";
import { installTeam } from "../installers/team.js";

/**
 * Parse argv into { sources, flags, projectPath }.
 *
 * Positionals that look like sources come before the flags. `--dir` takes a
 * value; everything else is boolean. The trailing positional after a
 * standalone path arg (not preceded by --dir) is treated as projectPath for
 * compatibility with the legacy `kit install <src> <projectPath>` form.
 */
function usageError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

function parseArgs(args) {
  const flags = {
    dir: null,
    user: false,
    interactive: false,
    help: false,
  };
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      flags.help = true;
    } else if (a === "--user") {
      flags.user = true;
    } else if (a === "-i" || a === "--interactive") {
      flags.interactive = true;
    } else if (a === "--dir") {
      flags.dir = args[++i];
      if (!flags.dir) throw usageError("--dir requires a path argument");
    } else if (a.startsWith("--")) {
      throw usageError(`Unknown flag: ${a} (run 'kit install --help' for valid flags)`);
    } else {
      positionals.push(a);
    }
  }

  // Backwards compat: historically `kit install <source> [projectPath]` took
  // a final positional as the project root when only one path was a directory
  // on disk. The new batch form accepts N sources. To disambiguate: if the
  // LAST positional is an existing directory that is NOT prefixed with `.`,
  // `/`, or `~` and does NOT contain a `package.json`, treat it as projectPath.
  //
  // Pragmatically, tests and users overwhelmingly either pass a single source
  // with an explicit `projectDir` argument, or multiple npm specs with no
  // project arg. We prefer batch mode: any positional that doesn't exist as
  // a local path stays a source. If every positional is a local path and the
  // final one lacks a `package.json`, promote it to projectPath.
  let projectPath = resolve(".");
  if (positionals.length >= 2) {
    const last = positionals[positionals.length - 1];
    const isLocalPath =
      last.startsWith(".") || last.startsWith("/") || last.startsWith("~");
    if (isLocalPath) {
      const abs = resolve(last);
      if (existsSync(abs) && !existsSync(join(abs, "package.json"))) {
        projectPath = abs;
        positionals.pop();
      }
    }
  }

  return { sources: positionals, flags, projectPath };
}

function printUsage() {
  console.error("Usage: kit install <source> [<source>...] [options]");
  console.error("");
  console.error("Sources:");
  console.error("  @scope/name[@version]    npm package spec");
  console.error("  github:owner/repo        GitHub shorthand");
  console.error("  ./path/to/dir            local folder (requires leading ./, /, or ~/)");
  console.error("");
  console.error("Options:");
  console.error("  --dir <path>             Install to specific directory");
  console.error("  --user                   Install to ~/.claude/<type>/ (user-global)");
  console.error("  -i, --interactive        Prompt to choose install options");
  console.error("  --help, -h               Show this help");
  console.error("");
  console.error("Examples:");
  console.error("  kit install @ctxr/skill-code-review");
  console.error("  kit install @ctxr/skill-a @ctxr/agent-b @ctxr/rule-c");
  console.error("  kit install @ctxr/team-full-stack --user");
  console.error("  kit install ./my-local-skill --dir .claude/skills");
}

/**
 * Install a single source. Records success/failure into `report` and never
 * throws past the outer `finally` — batch-continue is the contract.
 *
 * @param {string} source
 * @param {object} flags
 * @param {object} ctx
 * @param {Set<string>} ctx.visited — installedNames already being installed in this recursion
 * @param {string} ctx.projectPath
 * @param {object} ctx.report — { installed: [], failed: [] }
 */
async function installOne(source, flags, ctx) {
  const { visited, projectPath, report } = ctx;
  let tmpDir = null;

  try {
    const resolved = resolveSource(source);
    let sourceDir;
    let version = null;
    let integrity = null;
    let commit = null;
    const sourceType = resolved.type;

    if (resolved.type === "local") {
      const r = fetchFromLocal(resolved.path);
      sourceDir = r.dir;
      version = r.version;
    } else {
      tmpDir = createTmpDir("ctxr-install-");
      if (resolved.type === "npm") {
        console.log(`  Fetching ${resolved.package} from npm...`);
        const r = fetchFromNpm(resolved.package, tmpDir);
        sourceDir = r.dir;
        version = r.version;
        integrity = r.integrity;
      } else {
        console.log(`  Cloning ${resolved.repo} from GitHub...`);
        const r = fetchFromGitHub(resolved.repo, tmpDir);
        sourceDir = r.dir;
        commit = r.commit;
      }
    }

    const pkgJsonPath = join(sourceDir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      throw new Error("Package is missing package.json");
    }
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch (err) {
      throw new Error(`Could not parse package.json: ${err.message}`);
    }

    if (typeof pkgJson.name !== "string" || pkgJson.name.length === 0) {
      throw new Error("package.json is missing a `name` field");
    }

    const { type, target, config: typeCfg } = resolveType(pkgJson);

    if (type === "team") {
      const result = await installTeam({
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
        dispatcher: (memberSource, memberFlags, memberCtx) =>
          installOne(memberSource, memberFlags, memberCtx),
      });
      report.installed.push({
        type: "team",
        source,
        installedName: result.installedName,
        installedPaths: result.installedPaths,
      });
      return;
    }

    const targetRoot = resolveTargetRoot(projectPath, {
      dir: flags.dir,
      user: flags.user,
      typeCfg,
    });

    const installerArgs = {
      sourceDir,
      targetRoot,
      type,
      packageName: pkgJson.name,
      source,
      sourceType,
      version,
      integrity,
      commit,
    };

    const result =
      target === "folder" ? installFolder(installerArgs) : installFile(installerArgs);

    console.log(
      `  ✓ installed ${type} ${source} → ${result.installedPaths[0]}`,
    );
    report.installed.push({
      type,
      source,
      installedName: result.installedName,
      installedPaths: result.installedPaths,
    });
  } catch (err) {
    console.error(`  ✗ ${source} — ${err.message}`);
    report.failed.push({ source, error: err.message });
  } finally {
    if (tmpDir && existsSync(tmpDir)) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        console.warn(`  ⚠ Could not clean up temp directory: ${tmpDir}`);
      }
    }
  }
}

export default async function install(args) {
  if (args.length === 0) {
    printUsage();
    throw usageError("Missing required argument: <source>");
  }

  const { sources, flags, projectPath } = parseArgs(args);

  if (flags.help) {
    printUsage();
    return;
  }

  if (sources.length === 0) {
    printUsage();
    throw usageError("Missing required argument: <source>");
  }

  const report = { installed: [], failed: [] };

  // `visited` tracks installedNames that are currently in an active
  // recursion (used for team cycle detection). Each top-level source gets
  // a FRESH visited set so that `kit install teamA teamA` doesn't
  // incorrectly surface a "cyclic" error for what is really a duplicate.
  for (const source of sources) {
    await installOne(source, flags, {
      visited: new Set(),
      projectPath,
      report,
    });
  }

  // Summary
  const installedCount = report.installed.length;
  const failedCount = report.failed.length;
  if (installedCount > 0 || failedCount > 0) {
    console.log(
      `\n  Summary: ${installedCount} installed, ${failedCount} failed`,
    );
  }

  if (failedCount > 0) {
    // Signal failure to the CLI error handler without printing a second
    // error line — individual failures were already logged inline.
    const err = new Error(`install failed: ${failedCount} error(s)`);
    err.batchFailures = failedCount;
    throw err;
  }
}
