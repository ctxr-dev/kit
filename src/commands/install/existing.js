/**
 * "What to do with an already-installed artifact" — the stay-or-move
 * decision logic extracted from `install.js`.
 *
 * The install orchestrator calls `handleExistingInstall()` whenever
 * `findArtifactAcrossTypes` returns matches for the source being
 * installed. This module owns:
 *
 *   - `handleExistingInstall` — decides stay / move / skip based on the
 *     current location, the user's chosen strategy, and whether we're
 *     running interactively
 *   - `buildPerItemMenuOptions` — constructs the clack menu with each
 *     candidate destination labeled `(current — update in place)` or
 *     `(what you picked)` as appropriate
 *   - `extractTargetRoot` — strips the `<installedName>` suffix from a
 *     resolved leaf path to recover the parent targetRoot (used by the
 *     orchestrator when the user picks a different location)
 *   - `removeExistingArtifact` — deletes old install paths + manifest
 *     rows so the subsequent copy step doesn't hit the installer's
 *     "already installed" guard
 *   - `isPathContained` — safety gate for `removeExistingArtifact`:
 *     a corrupted or hostile manifest pointing `installedPaths` at `/`
 *     or `/Users/me` shouldn't get silently honored. Only paths under
 *     the explicit `projectPath`, `~/.claude/`, or the manifest's own
 *     directory are eligible for deletion.
 *
 * The module accepts `prompt` as a parameter so tests can inject a mock
 * of `../lib/interactive.js`, matching the rest of the install flow.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readManifest, writeManifest } from "../../lib/discover.js";
import {
  STRATEGY_PROJECT_AGENTS,
  STRATEGY_PROJECT_CLAUDE,
  STRATEGY_USER_GLOBAL,
  strategyToTarget,
  validateCustomPath,
} from "./strategy.js";

/**
 * Recover the parent `targetRoot` directory from a resolved leaf path
 * built via `join(root, installedName)` or `join(root, installedName + ".md")`.
 *
 * Uses an `endsWith` guard so the fallback returns the input unchanged
 * if the leaf shape doesn't match the expected suffix. Centralizing the
 * slicing logic here means the install orchestrator + per-item menu
 * builder use exactly the same inverse-function.
 *
 * @param {string} leaf — absolute leaf path (wrapper dir for folder
 *                        target, single `.md` file for file target)
 * @param {string} installedName — derived from the package name
 * @param {"folder"|"file"} target — the artifact's ctxr.target
 * @returns {string} absolute targetRoot directory
 */
export function extractTargetRoot(leaf, installedName, target) {
  // folder target: leaf = <root>/<installedName>
  // file target:   leaf = <root>/<installedName>.md
  // Use `path.sep` instead of a hardcoded `/` so this helper stays
  // correct on Windows, matching the fix applied to sibling
  // `isPathContained` in the same round.
  const suffix =
    target === "folder"
      ? `${sep}${installedName}`
      : `${sep}${installedName}.md`;
  if (leaf.endsWith(suffix)) return leaf.slice(0, leaf.length - suffix.length);
  // Fallback: caller already gave us the root
  return leaf;
}

/**
 * True if `target` resolves to a path that is inside one of the trusted
 * roots (the explicit `projectPath` threaded through install, the user's
 * `~/.claude/`, or `match.dir` itself). Used to gate `rmSync` so a
 * corrupted or hostile manifest entry can't trick kit into deleting
 * arbitrary paths.
 *
 * Uses `path.sep` from `node:path` instead of a hardcoded `/` so the
 * containment check stays correct on Windows (where paths use `\\`).
 * kit is currently POSIX-only, but the one-character fix is free and
 * removes a quiet-wrong edge case for a future Windows port.
 */
export function isPathContained(target, match, projectPath) {
  try {
    const abs = resolve(target);
    const projectAbs = resolve(projectPath);
    const userClaudeBase = join(homedir(), ".claude");
    const matchDirAbs = resolve(match.dir);
    // Accept any path that is under the project root passed to install,
    // under the user's `~/.claude/`, or under the manifest's own
    // directory. The manifest dir is trusted because it was discovered
    // by findArtifactAcrossTypes, which only walks kit's known type
    // directories.
    return (
      abs === projectAbs ||
      abs.startsWith(projectAbs + sep) ||
      abs === userClaudeBase ||
      abs.startsWith(userClaudeBase + sep) ||
      abs === matchDirAbs ||
      abs.startsWith(matchDirAbs + sep)
    );
  } catch {
    return false;
  }
}

/**
 * Remove every existing on-disk install path + manifest row for an
 * artifact, defensively gated by `isPathContained` so a corrupted
 * manifest can't cause out-of-bounds `rmSync`s.
 *
 * Synchronous path only — no top-level await or deferred manifest
 * writes, so the caller's next `copyAndRecord` observes the cleared
 * manifest row.
 */
export function removeExistingArtifact(existing, descriptor, projectPath) {
  for (const match of existing) {
    if (match.entry.installedName !== descriptor.installedName) continue;

    // Track whether at least one of the entry's paths passed the safety
    // gate AND was successfully removed. If every path failed the gate
    // (manifest corruption pointed outside the trusted roots) we refuse
    // to delete the manifest row too — otherwise we'd leave orphaned
    // files outside kit's tracking while the next `kit install` would
    // happily install a fresh copy as if nothing was there.
    const totalPaths = (match.entry.installedPaths || []).length;
    let gatedOut = 0;
    for (const p of match.entry.installedPaths || []) {
      if (!isPathContained(p, match, projectPath)) {
        console.warn(
          `  ⚠ skipping removal of out-of-bounds manifest path: ${p}`,
        );
        gatedOut++;
        continue;
      }
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // best-effort — don't block retry over a stray permission error
      }
    }

    // If EVERY installedPath was gated out, the manifest row still
    // points at untracked files on disk. Leaving the manifest intact is
    // the safer failure mode — a loud warning tells the user, and the
    // next install hits the installer's "already installed" guard
    // instead of silently double-installing.
    if (totalPaths > 0 && gatedOut === totalPaths) {
      console.warn(
        `  ⚠ manifest row for '${match.entry.installedName}' left intact — all recorded paths were out-of-bounds and could not be safely cleaned`,
      );
      continue;
    }

    try {
      const manifest = readManifest(match.dir);
      delete manifest[match.entry.installedName];
      writeManifest(match.dir, manifest);
    } catch {
      // best-effort — a corrupted manifest shouldn't fail the install
    }
  }
}

/**
 * Build the per-item menu when an artifact is already installed at a
 * location that differs from the user's shared-menu choice. Shows every
 * possible destination with `(current — update in place)` on the
 * existing one and `(what you picked)` on the target.
 *
 * @param {object} descriptor — the fetched-metadata descriptor
 * @param {string} currentLocation — the artifact's current leaf path
 * @param {string} chosenTarget — the leaf path the shared menu resolved to
 * @param {string} projectPath — absolute project root
 * @returns {Array<{value: object, label: string}>} clack-ready options
 */
export function buildPerItemMenuOptions(
  descriptor,
  currentLocation,
  chosenTarget,
  projectPath,
) {
  const addLabel = (strategy, suffix) => {
    try {
      const root = strategyToTarget(
        strategy,
        null,
        null,
        descriptor.typeCfg,
        projectPath,
      );
      const leaf =
        descriptor.target === "folder"
          ? join(root, descriptor.installedName)
          : join(root, `${descriptor.installedName}.md`);
      const isCurrent = leaf === currentLocation;
      const isChosen = leaf === chosenTarget;
      let annotation = "";
      if (isCurrent) annotation = " (current — update in place)";
      else if (isChosen) annotation = " (what you picked)";
      return {
        value: { kind: "move", strategy, target: leaf },
        label: leaf + annotation + (suffix ? ` ${suffix}` : ""),
      };
    } catch {
      return null;
    }
  };

  const options = [
    addLabel(STRATEGY_PROJECT_CLAUDE),
    addLabel(STRATEGY_PROJECT_AGENTS),
    addLabel(STRATEGY_USER_GLOBAL),
  ].filter((o) => o !== null);

  options.push({
    value: { kind: "custom" },
    label: "Custom path…",
  });
  options.push({
    value: { kind: "skip" },
    label: "Skip this item",
  });

  return options;
}

/**
 * When kit detects that an artifact is already installed at a
 * location that may or may not match the user's chosen target, ask
 * what to do. Returns one of:
 *
 *   { kind: "keep", target }             — update in place at existing location
 *   { kind: "move", target, targetRoot } — remove old, install at new
 *   { kind: "skip" }                     — skip this source entirely
 *   { kind: "install-at-chosen" }        — proceed with normal install flow
 *
 * Non-interactive mode: always `{ kind: "keep" }` (sticky in place,
 * never destructively moves). Matches the `--yes` rule: "if already
 * installed anywhere → update in place at the existing location".
 */
export async function handleExistingInstall(
  descriptor,
  chosenTarget,
  existing,
  projectPath,
  prompt,
  flags,
) {
  // Pick the first existing match's location as the canonical "current".
  // If the artifact happens to be installed in multiple locations, kit
  // updates the first one found (matches pre-existing behavior).
  const currentEntry = existing[0];
  const currentLocation =
    Array.isArray(currentEntry.entry.installedPaths) &&
    currentEntry.entry.installedPaths.length > 0
      ? currentEntry.entry.installedPaths[0]
      : null;

  if (!currentLocation) {
    // Couldn't identify a real path — fall through to normal install.
    return { kind: "install-at-chosen" };
  }

  if (currentLocation === chosenTarget) {
    // Already at the chosen location — just update in place.
    return { kind: "keep", target: currentLocation };
  }

  if (prompt.isNonInteractive(flags)) {
    // Sticky in place. Never moves destructively in automated mode.
    return { kind: "keep", target: currentLocation };
  }

  const options = buildPerItemMenuOptions(
    descriptor,
    currentLocation,
    chosenTarget,
    projectPath,
  );
  const choice = await prompt.select({
    message: `${descriptor.source} is already installed at ${currentLocation}`,
    options,
    defaultValue: options[0].value,
    flags,
  });

  if (choice.kind === "skip") return { kind: "skip" };

  if (choice.kind === "custom") {
    const raw = await prompt.text({
      message: "Custom path (absolute or relative to project root)",
      placeholder: ".claude/custom-location",
      validate: (v) => validateCustomPath(v, projectPath),
      flags,
    });
    const absBase = isAbsolute(raw.trim())
      ? raw.trim()
      : resolve(projectPath, raw.trim());
    const leaf =
      descriptor.target === "folder"
        ? join(absBase, descriptor.installedName)
        : join(absBase, `${descriptor.installedName}.md`);
    if (leaf === currentLocation) return { kind: "keep", target: currentLocation };
    return { kind: "move", target: leaf, targetRoot: absBase };
  }

  // Move to one of the standard strategies.
  if (choice.target === currentLocation) {
    return { kind: "keep", target: currentLocation };
  }
  const targetRoot = extractTargetRoot(
    choice.target,
    descriptor.installedName,
    descriptor.target,
  );
  return { kind: "move", target: choice.target, targetRoot };
}
