/**
 * target: "folder" installer.
 *
 * Creates `.claude/<typeDir>/<installedName>/` and copies every file in
 * `packagePayload()` into it verbatim, preserving relative paths. The
 * full npm payload is installed as-is — package.json, README, LICENSE,
 * CHANGELOG, and any other shipped files. Bundle runtime code can
 * therefore read its own package.json from the installed directory
 * (e.g. to resolve its own name/version), rather than depending on
 * hard-coded constants that drift from the manifest.
 *
 * Writes a type-aware manifest entry keyed by `installedName`.
 *
 * Failure safety: if any `cpSync` fails mid-loop, the half-populated wrapper
 * directory is removed so the install is atomic from the user's perspective —
 * a failed install never leaves a "zombie" directory that would block retry
 * with a misleading "already installed" error.
 *
 * Symlink safety: payload entries are `lstat`-checked before copy. A symlink
 * in the payload — even one pointing to a benign relative target — is
 * rejected. Otherwise a malicious package could ship `config -> /etc/passwd`
 * or `secret -> ~/.ssh/id_rsa`, and after install Claude Code would follow
 * the link when reading the artifact directory and pipe sensitive content
 * into the model context. `cpSync` defaults to `dereference: false`, so the
 * link would land verbatim in `.claude/<type>/<name>/` without this gate.
 *
 * In practice, `npm pack --dry-run --json` (which `packagePayload()` uses)
 * already filters symlinks out of the payload at every level — bare entry,
 * directory listing, glob expansion. Every observed source path (local,
 * github clone, npm tarball) goes through that filter. The lstat gate here
 * is therefore defense-in-depth: it covers a future change in npm's pack
 * semantics, a payload computed by a non-npm walker, or any caller that
 * bypasses `packagePayload()` and constructs its own file list. Cheap to
 * keep, expensive to rebuild after a symlink-smuggling incident.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { packagePayload } from "../lib/payload.js";
import { installedName } from "../lib/types.js";
import { writeArtifactManifest } from "./manifest-writer.js";

/**
 * Install a folder-target artifact.
 *
 * @param {object} opts
 * @param {string} opts.sourceDir — extracted package directory (contains package.json)
 * @param {string} opts.targetRoot — parent directory that will contain the wrapper
 * @param {string} opts.type — artifact type (skill | agent | command | rule | output-style)
 * @param {string} opts.packageName — npm package name (for installedName derivation)
 * @param {string} opts.source — original source string the user typed
 * @param {string} opts.sourceType — "npm" | "github" | "local"
 * @param {string|null} opts.version
 * @param {string|null} [opts.integrity]
 * @param {string|null} [opts.commit]
 * @returns {{ installedName: string, installedPaths: string[] }}
 */
export function installFolder(opts) {
  const {
    sourceDir,
    targetRoot,
    type,
    packageName,
    source,
    sourceType,
    version,
    integrity,
    commit,
  } = opts;

  const name = installedName(packageName);
  const destDir = join(targetRoot, name);

  if (existsSync(destDir)) {
    throw new Error(
      `already installed at ${destDir} — use 'npx @ctxr/kit update' or 'npx @ctxr/kit remove' first`,
    );
  }

  const payload = packagePayload(sourceDir);

  mkdirSync(targetRoot, { recursive: true });
  mkdirSync(destDir, { recursive: true });

  // Atomic copy semantics: if ANY file fails to copy, roll back the entire
  // wrapper directory so the user can retry without hitting a stale
  // "already installed" block.
  try {
    for (const rel of payload) {
      const srcFile = join(sourceDir, rel);
      // Reject symlink payload entries (see file-header "Symlink safety").
      // lstatSync — NOT statSync — so we inspect the link itself, not its
      // target. Defense in depth even though npm pack normally dereferences
      // links during pack; github: and local: sources never go through pack.
      const st = lstatSync(srcFile);
      if (st.isSymbolicLink()) {
        throw new Error(
          `Refusing to install symlink payload entry: "${rel}" (packages must ship regular files only)`,
        );
      }
      const destFile = join(destDir, rel);
      mkdirSync(dirname(destFile), { recursive: true });
      cpSync(srcFile, destFile);
    }
  } catch (err) {
    // Best-effort rollback; swallow cleanup errors so the original failure
    // surfaces clearly.
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to copy package files: ${err.message}`);
  }

  writeArtifactManifest({
    targetRoot,
    installedName: name,
    target: "folder",
    type,
    source,
    sourceType,
    version,
    integrity,
    commit,
    installedPaths: [destDir],
  });

  return { installedName: name, installedPaths: [destDir] };
}
