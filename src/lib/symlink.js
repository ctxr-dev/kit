/**
 * Discovery-mirror symlink helper.
 *
 * The canonical install path is `.agents/<type>/<name>/` (project) or
 * `~/.agents/<type>/<name>/` (user). For harnesses that don't read `.agents/`
 * natively (Claude Code: `.claude/<type>/`; Codex CLI user-scope: `~/.codex/<type>/`)
 * kit creates a discovery mirror as a symlink so the harness still finds the
 * artefact. Project mirrors use relative targets so a repo can be checked in
 * and cloned; user mirrors use absolute targets because they cross parent
 * trees (`~/.agents/skills/foo` vs `~/.claude/skills/foo`).
 *
 * Windows fallback chain on EPERM (no developer-mode / no admin):
 *   - folder mirrors → directory junction (`fs.symlinkSync(target, path, 'junction')`)
 *   - file mirrors → hardlink (`fs.linkSync`)
 *   - last resort → copy + sentinel `<mirror>.ctxr-mirror` so removeMirror still
 *     knows kit owns the copy
 *
 * Symmetry rule: kit never destroys a mirror it does not own. removeMirror
 * checks ownership before unlinking — a hand-edited folder, a real install
 * accidentally placed at a mirror path, or a symlink pointing somewhere
 * unexpected is left alone with a warning.
 */

import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const SENTINEL_SUFFIX = ".ctxr-mirror";

/**
 * Decide whether to use relative or absolute symlink target.
 *
 * Project mirrors (mirror under `<projectPath>/.claude/...` pointing to
 * `<projectPath>/.agents/...`) use relative targets so cloning the repo
 * preserves the link. User mirrors (mirror under `~/.claude/...` pointing
 * to `~/.agents/...`) use absolute targets because crossing tree roots
 * with `..` segments hurts readability and the path has no portability
 * requirement.
 *
 * Heuristic: if mirror and canonical share a common ancestor that is NOT
 * the user's home directory and is at least two segments deep, prefer
 * relative. Otherwise absolute. The caller can override via opts.
 */
function defaultLinkStrategy({ canonicalPath, mirrorPath }) {
  const mirrorDir = dirname(mirrorPath);
  const rel = relative(mirrorDir, canonicalPath);
  // Cap the relative depth so we never produce
  // `../../../../../home/user/.agents/skills/foo` style targets.
  if (rel.startsWith("..") && rel.split("..").length > 4) {
    return { kind: "absolute", target: canonicalPath };
  }
  return { kind: "relative", target: rel };
}

/**
 * True iff `mirrorPath` is a kit-owned mirror that currently points at
 * `canonicalPath`. Used to short-circuit creation (idempotency) and to
 * authorise removal (don't delete what we don't own).
 */
export function mirrorIsCorrect(mirrorPath, canonicalPath) {
  if (!existsSync(mirrorPath) && !isLstatSymlink(mirrorPath)) {
    return false;
  }
  let st;
  try {
    st = lstatSync(mirrorPath);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    let resolved;
    try {
      resolved = realpathSync(mirrorPath);
    } catch {
      // Broken symlink. Not pointing at canonical, but we still own it
      // because only kit (or a previous version of kit) writes here.
      // Caller will replace it.
      return false;
    }
    let canonicalReal;
    try {
      canonicalReal = realpathSync(canonicalPath);
    } catch {
      canonicalReal = canonicalPath;
    }
    return resolved === canonicalReal;
  }
  // Copy fallback: only kit-owned if the sentinel is present.
  if (existsSync(mirrorPath + SENTINEL_SUFFIX)) {
    // Cannot easily verify the copy still matches the canonical; treat as
    // not-correct so re-install refreshes it.
    return false;
  }
  return false;
}

function isLstatSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function detectExistingKind(mirrorPath) {
  let st;
  try {
    st = lstatSync(mirrorPath);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) return "symlink";
  if (existsSync(mirrorPath + SENTINEL_SUFFIX)) return "copy";
  if (st.isDirectory()) return "real-dir";
  if (st.isFile()) return "real-file";
  return "other";
}

/**
 * Idempotently create a discovery-mirror symlink (or fallback) at
 * `mirrorPath` pointing at `canonicalPath`.
 *
 * Returns:
 *   { created: boolean, kind: "symlink"|"junction"|"hardlink"|"copy"|"noop", warning?: string }
 *
 * - created=false, kind="noop" — mirror already correct
 * - created=true, kind="symlink"|"junction"|"hardlink"|"copy" — fresh write
 * - created=false, warning set — mirror exists but kit does not own it; left alone
 *
 * @param {object} opts
 * @param {string} opts.canonicalPath — existing real file/folder kit just installed
 * @param {string} opts.mirrorPath — destination of the mirror (will be created)
 * @param {"folder"|"file"|"auto"} [opts.target] — payload kind; "auto" probes lstat(canonicalPath)
 */
export function ensureMirror({ canonicalPath, mirrorPath, target = "auto" }) {
  if (typeof canonicalPath !== "string" || canonicalPath.length === 0) {
    throw new TypeError("ensureMirror requires canonicalPath");
  }
  if (typeof mirrorPath !== "string" || mirrorPath.length === 0) {
    throw new TypeError("ensureMirror requires mirrorPath");
  }
  if (!existsSync(canonicalPath)) {
    throw new Error(
      `ensureMirror: canonicalPath does not exist: ${canonicalPath}`,
    );
  }
  // Idempotency check.
  if (mirrorIsCorrect(mirrorPath, canonicalPath)) {
    return { created: false, kind: "noop" };
  }

  const existingKind = detectExistingKind(mirrorPath);
  if (existingKind === "real-dir" || existingKind === "real-file") {
    return {
      created: false,
      kind: "noop",
      warning: `Mirror path ${mirrorPath} is a real ${existingKind === "real-dir" ? "directory" : "file"} not owned by kit; leaving alone`,
    };
  }
  // Symlink pointing at the wrong target (or broken) → kit owned it
  // previously, safe to replace. Same for stale copy-sentinel pairs.
  if (existingKind === "symlink") {
    rmSync(mirrorPath, { force: true });
  } else if (existingKind === "copy") {
    rmSync(mirrorPath, { recursive: true, force: true });
    rmSync(mirrorPath + SENTINEL_SUFFIX, { force: true });
  } else if (existingKind === "other") {
    return {
      created: false,
      kind: "noop",
      warning: `Mirror path ${mirrorPath} exists but is neither file/dir/symlink; leaving alone`,
    };
  }

  // Resolve the payload kind.
  let kind = target;
  if (kind === "auto") {
    const st = lstatSync(canonicalPath);
    kind = st.isDirectory() ? "folder" : "file";
  }

  mkdirSync(dirname(mirrorPath), { recursive: true });
  const { target: linkTarget, kind: linkStrategy } = defaultLinkStrategy({
    canonicalPath,
    mirrorPath,
  });

  // Try POSIX symlink first.
  try {
    if (kind === "folder") {
      symlinkSync(linkTarget, mirrorPath, "dir");
    } else {
      symlinkSync(linkTarget, mirrorPath, "file");
    }
    return { created: true, kind: "symlink", linkTarget, linkStrategy };
  } catch (err) {
    if (err.code !== "EPERM" && err.code !== "EACCES") {
      // Real failure (ENOENT etc) — surface to caller.
      throw err;
    }
    // Windows-style permission denial. Fall through to platform-specific
    // fallback chain.
  }

  if (kind === "folder") {
    try {
      symlinkSync(canonicalPath, mirrorPath, "junction");
      return { created: true, kind: "junction" };
    } catch {
      // Junction failed too; fall back to recursive copy + sentinel.
      try {
        cpSync(canonicalPath, mirrorPath, { recursive: true });
        writeFileSync(mirrorPath + SENTINEL_SUFFIX, "ctxr-kit\n");
        return {
          created: true,
          kind: "copy",
          warning:
            "Discovery mirror created as a copy because symlink and junction both failed (likely Windows without developer mode). Re-run install after content changes to refresh the mirror.",
        };
      } catch (copyErr) {
        return {
          created: false,
          kind: "noop",
          warning: `Failed to create discovery mirror at ${mirrorPath}: ${copyErr.message}`,
        };
      }
    }
  }
  // File: try hardlink, then copy.
  try {
    linkSync(canonicalPath, mirrorPath);
    return { created: true, kind: "hardlink" };
  } catch {
    try {
      cpSync(canonicalPath, mirrorPath);
      writeFileSync(mirrorPath + SENTINEL_SUFFIX, "ctxr-kit\n");
      return {
        created: true,
        kind: "copy",
        warning:
          "Discovery mirror created as a copy because symlink and hardlink both failed. Re-run install after content changes to refresh the mirror.",
      };
    } catch (copyErr) {
      return {
        created: false,
        kind: "noop",
        warning: `Failed to create discovery mirror at ${mirrorPath}: ${copyErr.message}`,
      };
    }
  }
}

/**
 * Remove a previously-created discovery mirror. Refuses to delete anything
 * kit does not own: real directories, real files without the sentinel, and
 * symlinks pointing somewhere other than the canonical (which the caller
 * passes via opts.expectedTarget when available).
 *
 * Returns { removed: boolean, kind: string, warning?: string }.
 *
 * @param {string} mirrorPath
 * @param {{ expectedTarget?: string }} [opts]
 */
export function removeMirror(mirrorPath, opts = {}) {
  const existingKind = detectExistingKind(mirrorPath);
  if (existingKind === "absent") {
    return { removed: false, kind: "noop" };
  }
  if (existingKind === "symlink") {
    if (opts.expectedTarget) {
      let resolved;
      try {
        resolved = realpathSync(mirrorPath);
      } catch {
        // Broken symlink; we own it (only kit writes mirror-shaped paths).
        rmSync(mirrorPath, { force: true });
        return { removed: true, kind: "symlink-broken" };
      }
      let expected;
      try {
        expected = realpathSync(opts.expectedTarget);
      } catch {
        expected = opts.expectedTarget;
      }
      if (resolved !== expected) {
        return {
          removed: false,
          kind: "symlink",
          warning: `Mirror at ${mirrorPath} points at ${resolved}, not ${expected}; leaving alone`,
        };
      }
    }
    rmSync(mirrorPath, { force: true });
    return { removed: true, kind: "symlink" };
  }
  if (existingKind === "copy") {
    rmSync(mirrorPath, { recursive: true, force: true });
    rmSync(mirrorPath + SENTINEL_SUFFIX, { force: true });
    return { removed: true, kind: "copy" };
  }
  return {
    removed: false,
    kind: existingKind,
    warning: `Mirror path ${mirrorPath} is a real ${existingKind} not owned by kit; leaving alone`,
  };
}

// Re-export the sentinel suffix for tests and migration helpers.
export { SENTINEL_SUFFIX };
