/**
 * kit install <source> [<source>...] [options]
 *
 * Interactive-by-default batch installer. In a TTY, kit shows a shared
 * destination menu once at the top of the batch and asks per-item
 * stay-or-move prompts for any artifact that's already installed at a
 * different location than the user's batch choice. In CI (`CI=true`), with
 * `--yes` / `-y`, when stdin isn't a TTY, or when `--dir` / `--user` is
 * explicit, kit falls through to the existing silent auto-detect and
 * `resolveTargetRoot` logic — so every pre-existing test and every
 * scripted automation continues to work unchanged.
 *
 * Destination strategies (one symbolic value per menu option):
 *   PROJECT_CLAUDE   → <projectPath>/.claude/<type>/        (project-local)
 *   PROJECT_AGENTS   → <projectPath>/.agents/<type>/        (project-local)
 *   USER_GLOBAL      → <homedir>/.claude/<type>/            (user-global)
 *   CUSTOM           → user-provided absolute or relative path
 *
 * Each batched source resolves its real target dir at install time by
 * substituting `<type>` per-item. Team members inherit the strategy their
 * parent team was installed under, so one top-level prompt decides the
 * location for the entire cascade.
 *
 * Two-phase flow:
 *   1. Metadata fetch — every source is fetched into its own tmpDir, its
 *      `package.json` is parsed, type is resolved, and the result is cached.
 *      Failures here are recorded in the batch report and the source is
 *      dropped from the install loop.
 *   2. Install — with the strategy decided (prompt or auto-detect), kit
 *      walks the resolved sources, runs per-item stay-or-move prompts for
 *      already-installed artifacts, and hands off to the folder/file/team
 *      installer. tmpDirs are cleaned up in the outer finally so even a
 *      Ctrl+C mid-menu leaves /tmp tidy.
 *
 * Examples:
 *   kit install @ctxr/skill-code-review
 *   kit install ./path/to/local-skill --dir .agents/skills
 *   kit install @ctxr/skill-a @ctxr/agent-b @ctxr/team-full-stack --user
 *   kit install @ctxr/skill-a @ctxr/skill-b --yes   # silent, auto-detect
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
import {
  installedName as deriveInstalledName,
  resolveTargetRoot,
  resolveType,
} from "../lib/types.js";
import { findArtifactAcrossTypes } from "../lib/discover.js";
import { installFolder } from "../installers/folder.js";
import { installFile } from "../installers/file.js";
import { installTeam } from "../installers/team.js";
import * as interactive from "../lib/interactive.js";
import { isFlagLike, unknownFlagError, usageError } from "../lib/cli-errors.js";
// Destination-strategy resolution lives in `install/strategy.js` so this
// file stays focused on orchestration (parseArgs + installDescriptor
// + default export). Strategy.js owns the STRATEGY_* symbols, the clack
// menu builder, the auto-detect fallback, the `--dir`/`--user` short-
// circuit, the `validateCustomPath` helper for the text prompt, and
// the `buildCascadeFlags` helper for team manifest placement.
import {
  buildCascadeFlags,
  pickSharedStrategy,
  strategyToTarget,
} from "./install/strategy.js";
// Existing-install decision logic (stay/move/skip + safety-gated
// removal) lives in `install/existing.js` so this file stays focused
// on orchestration. See that module's header for the full surface.
import {
  extractTargetRoot,
  handleExistingInstall,
  removeExistingArtifact,
} from "./install/existing.js";

// ─── Argument parsing ─────────────────────────────────────────────────────

/**
 * Parse argv into `{ sources, flags, projectPath }`.
 *
 * Positional ordering is backwards-compatible with the legacy form
 * `kit install <source> <projectPath>` — if the last positional is an
 * existing directory without a package.json, it's promoted to projectPath.
 *
 * Usage-error paths use the shared `usageError` / `isFlagLike` /
 * `unknownFlagError` helpers from `lib/cli-errors.js` so every
 * subcommand surfaces flag-parsing errors identically.
 */
export function parseArgs(args) {
  const flags = {
    dir: null,
    user: false,
    interactive: false,
    yes: false,
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
    } else if (a === "-y" || a === "--yes") {
      flags.yes = true;
    } else if (a === "--dir") {
      flags.dir = args[++i];
      if (!flags.dir) throw usageError("--dir requires a path argument");
    } else if (isFlagLike(a)) {
      throw unknownFlagError(a, "install");
    } else {
      positionals.push(a);
    }
  }

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
  console.error("Usage: npx @ctxr/kit install <source> [<source>...] [options]");
  console.error("");
  console.error("Sources:");
  console.error("  @scope/name[@version]    npm package spec");
  console.error("  github:owner/repo        GitHub shorthand");
  console.error("  ./path/to/dir            local folder (requires leading ./, /, or ~/)");
  console.error("");
  console.error("Options:");
  console.error("  --dir <path>             Install to specific directory (bypasses prompt)");
  console.error("  --user                   Install to ~/.claude/<type>/ (user-global)");
  console.error("  -y, --yes                Skip all prompts and use defaults");
  console.error("  -i, --interactive        Force interactive mode (overrides CI detection)");
  console.error("  --help, -h               Show this help");
  console.error("");
  console.error("Interactive mode (default in a TTY):");
  console.error("  kit shows a destination menu for every install, and asks");
  console.error("  stay-or-move for any already-installed artifact. Set CI=true or");
  console.error("  pass --yes to skip prompts and fall through to auto-detect.");
  console.error("");
  console.error("Examples:");
  console.error("  npx @ctxr/kit install @ctxr/skill-code-review");
  console.error("  npx @ctxr/kit install @ctxr/skill-a @ctxr/agent-b @ctxr/rule-c");
  console.error("  npx @ctxr/kit install @ctxr/team-full-stack --user");
  console.error("  npx @ctxr/kit install ./my-local-skill --yes");
}

// ─── Metadata fetch (phase 1) ────────────────────────────────────────────

/**
 * Fetch a source into a tmpDir and collect everything the install flow needs
 * to either copy the files or generate a menu label. Never throws — failures
 * are recorded on the returned object as `.error`.
 *
 * @param {string} source
 * @param {object} report — mutable batch report (only used for cleanup tracking)
 * @returns {Promise<object>} resolved descriptor
 */
async function fetchMetadata(source) {
  const descriptor = {
    source,
    tmpDir: null,
    sourceDir: null,
    pkgJson: null,
    type: null,
    target: null,
    typeCfg: null,
    installedName: null,
    version: null,
    integrity: null,
    commit: null,
    sourceType: null,
    isLocal: false,
    error: null,
  };

  try {
    const resolved = resolveSource(source);
    descriptor.sourceType = resolved.type;
    if (resolved.type === "local") {
      const r = fetchFromLocal(resolved.path);
      descriptor.sourceDir = r.dir;
      descriptor.version = r.version;
      descriptor.isLocal = true;
    } else {
      descriptor.tmpDir = createTmpDir("ctxr-install-");
      if (resolved.type === "npm") {
        console.log(`  Fetching ${resolved.package} from npm...`);
        const r = fetchFromNpm(resolved.package, descriptor.tmpDir);
        descriptor.sourceDir = r.dir;
        descriptor.version = r.version;
        descriptor.integrity = r.integrity;
      } else {
        console.log(`  Cloning ${resolved.repo} from GitHub...`);
        const r = fetchFromGitHub(resolved.repo, descriptor.tmpDir);
        descriptor.sourceDir = r.dir;
        descriptor.commit = r.commit;
      }
    }

    const pkgJsonPath = join(descriptor.sourceDir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      throw new Error("Package is missing package.json");
    }
    try {
      descriptor.pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch (err) {
      throw new Error(`Could not parse package.json: ${err.message}`);
    }
    if (
      typeof descriptor.pkgJson.name !== "string" ||
      descriptor.pkgJson.name.length === 0
    ) {
      throw new Error("package.json is missing a `name` field");
    }

    const resolvedType = resolveType(descriptor.pkgJson);
    descriptor.type = resolvedType.type;
    descriptor.target = resolvedType.target;
    descriptor.typeCfg = resolvedType.config;
    descriptor.installedName = deriveInstalledName(descriptor.pkgJson.name);
  } catch (err) {
    descriptor.error = err;
  }

  return descriptor;
}

function cleanupDescriptor(descriptor) {
  if (descriptor.tmpDir && !descriptor.isLocal && existsSync(descriptor.tmpDir)) {
    try {
      rmSync(descriptor.tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort; don't mask the real error
    }
  }
}

// ─── Install execution (phase 3/4) ───────────────────────────────────────

/**
 * Team cascade — teams have no physical install location; their members
 * inherit the chosen strategy via a synthetic flags object built from
 * `buildCascadeFlags`. Recursion runs through `installOne`, which still
 * applies the per-item stay/move prompt for each member.
 *
 * Split out of `installDescriptor` so the top-level dispatcher reads as
 * a ~20-line switch instead of a ~160-line monster.
 */
async function installTeamDescriptor(
  descriptor,
  chosen,
  projectPath,
  report,
  prompt,
  flags,
  visited,
) {
  const { source } = descriptor;
  try {
    const memberFlags = buildCascadeFlags(chosen, projectPath);
    const result = await installTeam({
      pkgJson: descriptor.pkgJson,
      source,
      sourceType: descriptor.sourceType,
      version: descriptor.version,
      integrity: descriptor.integrity,
      commit: descriptor.commit,
      flags: { ...flags, ...memberFlags },
      visited,
      projectPath,
      report,
      dispatcher: async (memberSource, memberFlagsArg, memberCtx) => {
        // Team members bypass the shared menu (strategy already decided
        // at the top level). They do still get per-item stay/move prompts
        // via the normal installOne path below.
        await installOne(
          memberSource,
          memberFlagsArg,
          memberCtx,
          chosen,
          prompt,
        );
      },
    });
    report.installed.push({
      type: "team",
      source,
      installedName: result.installedName,
      installedPaths: result.installedPaths,
    });
  } catch (err) {
    // Ctrl+C during a team member's stay/move prompt (or anywhere in
    // the cascade) must propagate — swallowing it here would drop the
    // user into the next top-level source and exit with the batch
    // summary instead of exit 130. Matches `installSingleDescriptor`.
    if (err instanceof interactive.UserAbortError) throw err;
    console.error(`  ✗ ${source} — ${err.message}`);
    report.failed.push({ source, error: err.message });
  }
}

/**
 * Resolve the absolute target root for a non-team descriptor given the
 * chosen strategy. Falls back to the legacy `resolveTargetRoot` auto-
 * detect if the strategy can't apply (e.g. team typeCfg with no project
 * dirs makes it through a malformed chosen object).
 */
function resolveDescriptorTargetRoot(descriptor, chosen, projectPath, flags) {
  try {
    return strategyToTarget(
      chosen.strategy,
      chosen.customPath,
      chosen.explicitDir,
      descriptor.typeCfg,
      projectPath,
    );
  } catch {
    return resolveTargetRoot(projectPath, {
      dir: flags.dir,
      user: flags.user,
      typeCfg: descriptor.typeCfg,
    });
  }
}

/**
 * Collect every existing-install match for a descriptor, deduplicated
 * across the `source`-keyed and `installedName`-keyed lookups. The two
 * lookups can return different rows when the package's recorded source
 * differs from the argument the user typed (e.g. a GitHub URL vs the
 * installed name).
 */
function findAllExisting(descriptor, projectPath) {
  const existing = findArtifactAcrossTypes(descriptor.source, projectPath);
  const existingByName = findArtifactAcrossTypes(
    descriptor.installedName,
    projectPath,
  );
  const allExisting = [...existing];
  for (const e of existingByName) {
    const seen = allExisting.some(
      (x) => x.dir === e.dir && x.entry.installedName === e.entry.installedName,
    );
    if (!seen) allExisting.push(e);
  }
  return allExisting;
}

/**
 * Non-team install path. Resolves the target, checks for existing
 * installs, runs the stay/move prompt if needed, then hands off to
 * `copyAndRecord`. Split out of `installDescriptor` for readability —
 * the dispatcher is now ~20 lines.
 */
async function installSingleDescriptor(
  descriptor,
  chosen,
  projectPath,
  report,
  prompt,
  flags,
) {
  const { source } = descriptor;
  try {
    const targetRoot = resolveDescriptorTargetRoot(
      descriptor,
      chosen,
      projectPath,
      flags,
    );

    const chosenLeaf =
      descriptor.target === "folder"
        ? join(targetRoot, descriptor.installedName)
        : join(targetRoot, `${descriptor.installedName}.md`);

    const allExisting = findAllExisting(descriptor, projectPath);

    if (allExisting.length > 0) {
      // `chosen.explicitByFlag` means the user used --dir or --user to
      // directly specify the destination. That's an explicit directive:
      // wherever the artifact is currently installed, respect the flag
      // and move it. For the auto-detect + interactive paths, fall
      // through to the stay/move decision helper.
      // When the artifact is installed in multiple locations, every
      // code path below only acts on ONE of them (the "current" one
      // `handleExistingInstall` showed the user). Warn so the user isn't
      // surprised that the *other* location is still there after the
      // command finishes — it's intentional ("first one found wins" is
      // pre-existing behavior), but silent multi-location drift is bad.
      if (allExisting.length > 1 && !chosen.explicitByFlag) {
        const others = allExisting
          .slice(1)
          .map((m) => m.entry.installedPaths?.[0] ?? m.dir)
          .join(", ");
        console.warn(
          `  ⚠ ${source} is also installed at: ${others} — this command only affects the first match`,
        );
      }

      if (chosen.explicitByFlag) {
        // Remove existing installs (anywhere), then install at the
        // flag-directed location. `--dir`/`--user` is a "converge to this
        // one location" directive, so sweeping every match is the
        // intended behavior. If the existing install happens to already
        // be at chosenLeaf, removeExistingArtifact + copyAndRecord is
        // idempotent — the end state is identical.
        removeExistingArtifact(allExisting, descriptor, projectPath);
        await copyAndRecord(descriptor, targetRoot, report);
        return;
      }

      const decision = await handleExistingInstall(
        descriptor,
        chosenLeaf,
        allExisting,
        projectPath,
        prompt,
        flags,
      );

      if (decision.kind === "skip") {
        console.log(`  ⊘ ${source} — skipped`);
        report.skipped.push({ source });
        return;
      }

      // For keep/move/custom the user saw a prompt showing the *first*
      // match as "current". Only touch that one — a second unrelated
      // install at a different location stays untouched (and was flagged
      // in the multi-match warning above).
      const firstMatch = [allExisting[0]];

      if (decision.kind === "keep") {
        // Update in place at the existing location. Remove the current
        // entry first (so installer doesn't hit its "already installed"
        // guard), then re-install at the same spot.
        const existingTargetRoot = extractTargetRoot(
          decision.target,
          descriptor.installedName,
          descriptor.target,
        );
        removeExistingArtifact(firstMatch, descriptor, projectPath);
        await copyAndRecord(descriptor, existingTargetRoot, report);
        return;
      }

      if (decision.kind === "move") {
        removeExistingArtifact(firstMatch, descriptor, projectPath);
        await copyAndRecord(descriptor, decision.targetRoot, report);
        return;
      }
      // decision.kind === "install-at-chosen" — fall through
    }

    await copyAndRecord(descriptor, targetRoot, report);
  } catch (err) {
    if (err instanceof interactive.UserAbortError) throw err;
    console.error(`  ✗ ${source} — ${err.message}`);
    report.failed.push({ source, error: err.message });
  }
}

/**
 * Thin dispatcher: routes each descriptor to the team cascade path or
 * the non-team install path. Also short-circuits descriptors that
 * already failed during metadata fetch.
 */
async function installDescriptor(
  descriptor,
  chosen,
  projectPath,
  report,
  prompt,
  flags,
  visited,
) {
  const { source } = descriptor;

  if (descriptor.error) {
    console.error(`  ✗ ${source} — ${descriptor.error.message}`);
    report.failed.push({ source, error: descriptor.error.message });
    return;
  }

  if (descriptor.type === "team") {
    await installTeamDescriptor(
      descriptor,
      chosen,
      projectPath,
      report,
      prompt,
      flags,
      visited,
    );
    return;
  }

  await installSingleDescriptor(
    descriptor,
    chosen,
    projectPath,
    report,
    prompt,
    flags,
  );
}

async function copyAndRecord(descriptor, targetRoot, report) {
  const installerArgs = {
    sourceDir: descriptor.sourceDir,
    targetRoot,
    type: descriptor.type,
    packageName: descriptor.pkgJson.name,
    source: descriptor.source,
    sourceType: descriptor.sourceType,
    version: descriptor.version,
    integrity: descriptor.integrity,
    commit: descriptor.commit,
  };
  const result =
    descriptor.target === "folder"
      ? installFolder(installerArgs)
      : installFile(installerArgs);
  console.log(
    `  ✓ installed ${descriptor.type} ${descriptor.source} → ${result.installedPaths[0]}`,
  );
  report.installed.push({
    type: descriptor.type,
    source: descriptor.source,
    installedName: result.installedName,
    installedPaths: result.installedPaths,
  });
}

/**
 * Team-member install helper. Kept for recursion from the team installer,
 * which still uses the older `dispatcher` callback contract.
 *
 * Member installs bypass the shared menu (strategy already decided) but
 * still run per-item stay/move prompts on already-installed members.
 */
async function installOne(source, memberFlags, ctx, chosen, prompt) {
  const descriptor = await fetchMetadata(source);
  try {
    await installDescriptor(
      descriptor,
      chosen,
      ctx.projectPath,
      ctx.report,
      prompt,
      memberFlags,
      ctx.visited,
    );
  } finally {
    cleanupDescriptor(descriptor);
  }
}

// ─── Default export: orchestrator ────────────────────────────────────────

export default async function install(args, opts = {}) {
  const prompt = opts.prompt ?? interactive;

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

  const report = { installed: [], failed: [], skipped: [] };

  // PHASE 1: fetch metadata for every source in parallel-safe serial.
  // Serial is fine for kit's typical batch sizes (1-10) and keeps tmpDir
  // accounting simple; clack stdout output also serializes naturally.
  const descriptors = [];
  try {
    for (const source of sources) {
      const d = await fetchMetadata(source);
      descriptors.push(d);
    }

    // PHASE 2: shared destination strategy.
    let chosen;
    try {
      chosen = await pickSharedStrategy(descriptors, flags, projectPath, prompt);
    } catch (err) {
      if (err instanceof interactive.UserAbortError) {
        console.error("\n  Cancelled.");
        // Re-throw so the CLI top-level catch handler maps err.exitCode
        // (130) to process.exit. Library-style callers (e.g. tests) can
        // catch it themselves instead of seeing the whole process die.
        throw err;
      }
      throw err;
    }

    // PHASE 3: install each descriptor.
    for (const descriptor of descriptors) {
      // FRESH visited set per top-level source so `install teamA teamA`
      // isn't flagged as cyclic.
      const visited = new Set();
      try {
        await installDescriptor(
          descriptor,
          chosen,
          projectPath,
          report,
          prompt,
          flags,
          visited,
        );
      } catch (err) {
        if (err instanceof interactive.UserAbortError) {
          // Re-throw so the outer finally still runs and every tmpDir
          // from phase 1 gets cleaned up. cli.js's top-level catch maps
          // UserAbortError → exit 130. Never call process.exit here —
          // process.exit terminates synchronously without unwinding
          // suspended async finally blocks.
          throw err;
        }
        console.error(`  ✗ ${descriptor.source} — ${err.message}`);
        report.failed.push({ source: descriptor.source, error: err.message });
      }
    }
  } finally {
    // PHASE 4: cleanup every tmpDir, even if we aborted mid-batch.
    // Runs on success, on throw, and on Ctrl+C (because the UserAbortError
    // path above re-throws instead of calling process.exit).
    for (const d of descriptors) {
      cleanupDescriptor(d);
    }
  }

  // Summary
  const installedCount = report.installed.length;
  const failedCount = report.failed.length;
  const skippedCount = report.skipped.length;
  if (installedCount > 0 || failedCount > 0 || skippedCount > 0) {
    const skippedPart = skippedCount > 0 ? `, ${skippedCount} skipped` : "";
    console.log(
      `\n  Summary: ${installedCount} installed, ${failedCount} failed${skippedPart}`,
    );
  }

  if (failedCount > 0) {
    const err = new Error(`install failed: ${failedCount} error(s)`);
    err.batchFailures = failedCount;
    throw err;
  }
}
