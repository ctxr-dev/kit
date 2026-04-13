/**
 * Destination-strategy resolution for `kit install`.
 *
 * Extracted from `install.js` to keep the orchestrator file under 800
 * lines. Everything here is concerned with ONE question:
 *
 *   "Where should the user's batch of sources end up on disk?"
 *
 * Strategies (symbolic values, intentionally strings so they survive
 * tests that log flags / options):
 *
 *   PROJECT_CLAUDE   → <projectPath>/.claude/<type>/
 *   PROJECT_AGENTS   → <projectPath>/.agents/<type>/
 *   USER_GLOBAL      → <homedir>/.claude/<type>/
 *   CUSTOM           → user-provided absolute or relative path
 *   EXPLICIT_DIR     → raw `--dir <path>` value (skips menu entirely)
 *
 * All rendering of the shared destination menu + the user's custom-path
 * text prompt lives here. The install orchestrator just calls
 * `pickSharedStrategy(...)` and gets a `{strategy, customPath,
 * explicitDir, explicitByFlag}` result back.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

// Strategy symbols — kept as plain string constants so they log cleanly
// in test outputs and debugger views.
export const STRATEGY_PROJECT_CLAUDE = "project-claude";
export const STRATEGY_PROJECT_AGENTS = "project-agents";
export const STRATEGY_USER_GLOBAL = "user-global";
export const STRATEGY_CUSTOM = "custom";
/** Explicit `--dir <path>` — bypasses the menu entirely. */
export const STRATEGY_EXPLICIT_DIR = "explicit-dir";

/**
 * Validate a user-entered custom path. Used by both the shared-menu
 * custom-path text prompt and the per-item stay/move custom-path
 * prompt in `install/existing.js`.
 *
 * Rejects:
 *   - empty or whitespace-only input
 *   - leading `-` (guards against accidental flag parsing)
 *   - literal `..` segments (traversal escape; kit refuses surprising
 *     values that climb out of the project dir from an interactive
 *     prompt)
 *   - absolute paths OUTSIDE the project root and the user's home
 *     (interactive prompts shouldn't quietly write to `/etc`; users
 *     who really want that can pass `--dir` explicitly)
 *
 * @param {string} raw — user input from the text prompt
 * @param {string} projectPath — absolute project root
 * @returns {string|undefined} — error string to reprompt, or undefined
 *                               to accept the value
 */
export function validateCustomPath(raw, projectPath) {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return "Path cannot be empty";
  if (trimmed.startsWith("-")) return "Path cannot start with '-'";
  // Reject `~`-prefixed paths explicitly. `src/lib/fetch.js`'s
  // `resolveSource` expands `~/foo` to `$HOME/foo` for source arguments,
  // but `validateCustomPath` is consumed downstream by `path.resolve`
  // which does NOT do tilde expansion. Accepting `~/foo` here would
  // silently create a literal `~` directory under the project root,
  // which contradicts the "under home directory" promise. The two
  // sources of truth (install source vs install target) stay aligned
  // if we refuse `~` at this layer and tell the user to type the
  // absolute path instead.
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return "Path must not start with '~' — type the absolute path under your home directory";
  }
  // Block `..` segments even in relative paths — normalizes-out to
  // escape, which is a surprise for a prompt value.
  const segs = trimmed.split(/[\\/]/);
  if (segs.some((s) => s === "..")) {
    return "Path must not contain '..' segments";
  }
  // If absolute, constrain to under the project root or the user's home
  // dir. An absolute path to `/etc` or `/usr/local` is almost certainly
  // a mistake from an interactive prompt; explicit `--dir` bypasses this.
  if (isAbsolute(trimmed)) {
    const abs = resolve(trimmed);
    const projectAbs = resolve(projectPath);
    const home = homedir();
    const underProject =
      abs === projectAbs || abs.startsWith(projectAbs + sep);
    const underHome = abs === home || abs.startsWith(home + sep);
    if (!underProject && !underHome) {
      return "Absolute paths must be under the project root or your home directory";
    }
  }
  return undefined;
}

/**
 * Map a strategy symbol to the absolute target-root directory for a
 * given artifact type. Used at two call sites: when the shared-menu
 * pre-expands labels (so the user sees the actual destination per
 * source before picking) and when the real install step resolves the
 * final target. The single source of truth guarantees preview and
 * execution match.
 *
 * @param {string} strategy — one of the STRATEGY_* constants
 * @param {string|null} customPath — absolute path set by CUSTOM strategy
 * @param {string|null} explicitDir — raw `--dir` value for EXPLICIT_DIR
 * @param {object} typeCfg — ARTIFACT_TYPES[type] (from `lib/types.js`)
 * @param {string} projectPath — absolute project root
 * @returns {string} absolute target-root directory
 */
export function strategyToTarget(
  strategy,
  customPath,
  explicitDir,
  typeCfg,
  projectPath,
) {
  switch (strategy) {
    case STRATEGY_PROJECT_CLAUDE: {
      const rel = typeCfg.projectDirs[0];
      if (!rel) {
        throw new Error("type has no project directory (team meta-type)");
      }
      return join(projectPath, rel);
    }
    case STRATEGY_PROJECT_AGENTS: {
      const rel = typeCfg.projectDirs[1] ?? typeCfg.projectDirs[0];
      if (!rel) {
        throw new Error("type has no project directory (team meta-type)");
      }
      return join(projectPath, rel);
    }
    case STRATEGY_USER_GLOBAL: {
      if (!typeCfg.userDir) {
        throw new Error("type has no user directory (team meta-type)");
      }
      return join(homedir(), ".claude", typeCfg.userDir);
    }
    case STRATEGY_CUSTOM: {
      if (!customPath) {
        throw new Error("CUSTOM strategy requires a customPath");
      }
      return isAbsolute(customPath)
        ? customPath
        : resolve(projectPath, customPath);
    }
    case STRATEGY_EXPLICIT_DIR: {
      if (!explicitDir) {
        throw new Error("EXPLICIT_DIR strategy requires an explicitDir");
      }
      return isAbsolute(explicitDir)
        ? explicitDir
        : resolve(projectPath, explicitDir);
    }
    default:
      throw new Error(`Unknown destination strategy: ${strategy}`);
  }
}

/**
 * Translate the chosen strategy into explicit `--dir` / `--user` flags.
 *
 * Load-bearing for team manifest placement: `src/installers/team.js`
 * reads `flags.user` to decide whether the team manifest entry lives
 * at `.claude/teams/` (project) or `~/.claude/teams/` (user-global).
 *
 * For INDIVIDUAL members (the recursive `installOne` calls), these
 * synthetic flags are mostly inert — the install orchestrator resolves
 * member paths via `chosen.strategy` + `strategyToTarget`, not via
 * `flags.dir` / `flags.user`. This helper exists specifically to keep
 * the team manifest placement correct.
 */
export function buildCascadeFlags(chosen, projectPath) {
  switch (chosen.strategy) {
    case STRATEGY_USER_GLOBAL:
      return { user: true, dir: null };
    case STRATEGY_PROJECT_CLAUDE:
      return { user: false, dir: join(projectPath, ".claude") };
    case STRATEGY_PROJECT_AGENTS:
      return { user: false, dir: join(projectPath, ".agents") };
    case STRATEGY_CUSTOM:
      return { user: false, dir: chosen.customPath };
    case STRATEGY_EXPLICIT_DIR:
      return { user: false, dir: chosen.explicitDir };
    default:
      return {};
  }
}

/**
 * Compute the auto-detect default strategy for a batch. Walks each
 * descriptor's type candidates in order (`.claude/<type>/`,
 * `.agents/<type>/`, `~/.claude/<type>/`) and picks the first one that
 * has an existing directory. Falls back to PROJECT_CLAUDE (Claude
 * Code's native discovery location) for a fresh project.
 */
export function autoDefaultStrategy(descriptors, projectPath) {
  const installable = descriptors.filter(
    (d) => !d.error && d.type && d.type !== "team",
  );
  if (installable.length === 0) return STRATEGY_PROJECT_CLAUDE;

  const anyClaude = installable.some((d) =>
    existsSync(join(projectPath, d.typeCfg.projectDirs[0] ?? "")),
  );
  if (anyClaude) return STRATEGY_PROJECT_CLAUDE;

  const anyAgents = installable.some((d) => {
    const rel = d.typeCfg.projectDirs[1];
    return rel && existsSync(join(projectPath, rel));
  });
  if (anyAgents) return STRATEGY_PROJECT_AGENTS;

  return STRATEGY_PROJECT_CLAUDE;
}

/**
 * Build the four strategy menu options with pre-expanded per-source
 * destinations as the clack "hint" lines (per the Q13-option-2 UX
 * decision). Each label shows where every non-team descriptor will
 * actually land under that strategy, so the user sees full impact
 * before picking.
 */
export function buildSharedMenuOptions(descriptors, projectPath) {
  const installable = descriptors.filter(
    (d) => !d.error && d.type && d.type !== "team",
  );

  const labelFor = (strategy) => {
    const rows = installable
      .map((d) => {
        try {
          const root = strategyToTarget(
            strategy,
            null,
            null,
            d.typeCfg,
            projectPath,
          );
          const leaf =
            d.target === "folder"
              ? join(root, d.installedName)
              : join(root, `${d.installedName}.md`);
          return `    → ${leaf}`;
        } catch {
          return `    → (unavailable for ${d.installedName})`;
        }
      })
      .join("\n");
    return rows || "    (no installable items)";
  };

  return [
    {
      value: STRATEGY_PROJECT_CLAUDE,
      label: "project-local (Claude Code native)",
      hint: labelFor(STRATEGY_PROJECT_CLAUDE),
    },
    {
      value: STRATEGY_PROJECT_AGENTS,
      label: "project-local (cross-tool standard)",
      hint: labelFor(STRATEGY_PROJECT_AGENTS),
    },
    {
      value: STRATEGY_USER_GLOBAL,
      label: "user-global",
      hint: labelFor(STRATEGY_USER_GLOBAL),
    },
    {
      value: STRATEGY_CUSTOM,
      label: "Custom path…",
    },
  ];
}

/**
 * Show the shared destination menu and resolve to a concrete strategy
 * + (for CUSTOM) a custom path. Non-interactive mode falls through to
 * the auto-detect default without prompting.
 *
 * Returns `{strategy, explicitDir, customPath, explicitByFlag}` where
 * `explicitByFlag === true` iff the user directed the destination via
 * `--dir` or `--user` rather than the menu or auto-detect. The install
 * orchestrator uses that flag to decide whether to apply the sticky-
 * in-place rule for already-installed artifacts (auto-detect → sticky,
 * explicit flag → honor the directive).
 *
 * @param {Array<object>} descriptors — resolved metadata from fetchMetadata
 * @param {object} flags — command flags (dir, user, yes, interactive, …)
 * @param {string} projectPath — absolute project root
 * @param {object} prompt — the interactive module (or a test mock)
 * @returns {Promise<{strategy: string, explicitDir: string|null, customPath: string|null, explicitByFlag: boolean}>}
 */
export async function pickSharedStrategy(
  descriptors,
  flags,
  projectPath,
  prompt,
) {
  if (flags.dir) {
    return {
      strategy: STRATEGY_EXPLICIT_DIR,
      explicitDir: flags.dir,
      customPath: null,
      explicitByFlag: true,
    };
  }
  if (flags.user) {
    return {
      strategy: STRATEGY_USER_GLOBAL,
      explicitDir: null,
      customPath: null,
      explicitByFlag: true,
    };
  }

  const autoDefault = autoDefaultStrategy(descriptors, projectPath);

  if (prompt.isNonInteractive(flags)) {
    return {
      strategy: autoDefault,
      explicitDir: null,
      customPath: null,
      explicitByFlag: false,
    };
  }

  const options = buildSharedMenuOptions(descriptors, projectPath);
  const installable = descriptors.filter(
    (d) => !d.error && d.type && d.type !== "team",
  );
  const totalCount = installable.length;
  const label =
    totalCount === 1 ? "this artifact" : `these ${totalCount} artifacts`;

  const strategy = await prompt.select({
    message: `Where to install ${label}?`,
    options,
    defaultValue: autoDefault,
    flags,
  });

  if (strategy === STRATEGY_CUSTOM) {
    const raw = await prompt.text({
      message: "Custom path (absolute or relative to project root)",
      placeholder: ".claude/custom-location",
      validate: (v) => validateCustomPath(v, projectPath),
      flags,
    });
    return {
      strategy: STRATEGY_CUSTOM,
      explicitDir: null,
      customPath: raw.trim(),
      explicitByFlag: false,
    };
  }

  return {
    strategy,
    explicitDir: null,
    customPath: null,
    explicitByFlag: false,
  };
}
