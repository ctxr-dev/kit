/**
 * Discovery-mirror path resolution for installers.
 *
 * Given the canonical install destination (a real directory or file kit just
 * wrote), compute the list of mirror paths kit should symlink-or-copy so
 * harnesses that don't read `.agents/` natively still discover the artefact.
 *
 * Mirrors are created only for canonical destinations under `.agents/<type>/`
 * or `~/.agents/<type>/`. Custom `--dir` installs are intentional and skip
 * mirror emission so users who target an arbitrary location aren't surprised
 * by sidecar paths appearing under `.claude/` or `~/.codex/`.
 */

import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";

/**
 * Decide whether `targetRoot` is a canonical project, canonical user, or
 * custom destination. Returns `null` for custom (mirror emission skipped).
 *
 * Cross-platform: uses `path.sep` rather than a hardcoded `/` so the
 * `startsWith` ancestry check fires on Windows (`\\`-separated paths) too.
 *
 * @param {string} targetRoot — absolute directory the installer wrote to
 * @param {string} projectPath — absolute project root
 * @returns {{ scope: "project"|"user", typeRel: string }|null}
 */
function classifyTargetRoot(targetRoot, projectPath) {
  const tr = normalize(targetRoot);
  const projectAgents = normalize(join(projectPath, ".agents"));
  const userAgents = normalize(join(homedir(), ".agents"));
  if (tr === projectAgents || tr.startsWith(projectAgents + sep)) {
    return { scope: "project", typeRel: tr.slice(projectAgents.length + 1) };
  }
  if (tr === userAgents || tr.startsWith(userAgents + sep)) {
    return { scope: "user", typeRel: tr.slice(userAgents.length + 1) };
  }
  return null;
}

/**
 * Resolve the absolute mirror paths for a freshly-installed artefact.
 *
 * For a `target: "folder"` install the basename of each mirror is the
 * `installedName`. For a `target: "file"` install the basename is the
 * payload's resolved file basename (e.g. `my-agent.md`).
 *
 * @param {object} args
 * @param {string} args.targetRoot — absolute install root (e.g. `<project>/.agents/skills`)
 * @param {string} args.projectPath — absolute project root
 * @param {object} args.discoveryMirrors — typeCfg.discoveryMirrors object
 * @param {string} args.basenameToMirror — what to append to each mirror dir
 * @returns {string[]} absolute paths where mirrors should be created
 */
export function resolveMirrorPaths({
  targetRoot,
  projectPath,
  discoveryMirrors,
  basenameToMirror,
}) {
  if (!discoveryMirrors) return [];
  const cls = classifyTargetRoot(targetRoot, projectPath);
  if (!cls) return [];
  const mirrors = [];
  if (cls.scope === "project") {
    for (const rel of discoveryMirrors.project ?? []) {
      mirrors.push(join(projectPath, rel, basenameToMirror));
    }
  } else {
    for (const rel of discoveryMirrors.user ?? []) {
      mirrors.push(join(homedir(), rel, basenameToMirror));
    }
  }
  return mirrors;
}
