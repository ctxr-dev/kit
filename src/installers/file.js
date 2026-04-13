/**
 * target: "file" installer.
 *
 * Copies a single artifact file from the package payload directly into
 * `.claude/<typeDir>/` with no wrapper folder, preserving its original
 * basename. The package must ship a payload that resolves to **exactly one
 * artifact file** once npm's always-include metadata (package.json, README*,
 * LICENSE*, CHANGELOG*, NOTICE*) is filtered out — otherwise the install is
 * rejected and the caller records the error without aborting the batch.
 *
 * The single file must be `.md` because Claude Code's file-discovery scans
 * for markdown artifacts. A non-`.md` single file is rejected.
 *
 * Writes a type-aware manifest entry keyed by `installedName`.
 *
 * Failure safety: if `cpSync` fails mid-write (e.g. disk full), the partial
 * destination file is removed so the install is atomic from the user's
 * perspective — a failed install never leaves a "zombie" file that would
 * block retry with a misleading "already installed" error.
 *
 * Symlink safety: the resolved single artifact file is `lstat`-checked
 * before copy. A symlink — even one pointing to a benign target — is
 * rejected. Same defense-in-depth rationale as installers/folder.js: npm
 * pack already filters symlinks out of the payload, but the lstat gate
 * covers any future change in pack semantics or any caller that bypasses
 * `packagePayload()` with a hand-built file list.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { packagePayload } from "../lib/payload.js";
import { installedName } from "../lib/types.js";
import {
  resolveFileTargetArtifact,
  writeArtifactManifest,
} from "./manifest-writer.js";

/**
 * Install a file-target artifact.
 *
 * @param {object} opts — same shape as installFolder
 * @returns {{ installedName: string, installedPaths: string[] }}
 */
export function installFile(opts) {
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

  const payload = packagePayload(sourceDir);
  const resolution = resolveFileTargetArtifact(payload);
  if (!resolution.ok) {
    throw new Error(resolution.reason);
  }
  const single = resolution.single;

  // Flatten to basename on install — Claude Code scans the flat
  // `.claude/<type>/` directory, not nested subdirs of file-target artifacts.
  const destBasename = basename(single);
  const destFile = join(targetRoot, destBasename);

  if (existsSync(destFile)) {
    throw new Error(
      `already installed at ${destFile} — use 'npx @ctxr/kit update' or 'npx @ctxr/kit remove' first`,
    );
  }

  // Reject symlink payload — see file-header "Symlink safety". Done before
  // mkdirSync so a failed install leaves the target directory untouched.
  const srcAbs = join(sourceDir, single);
  const st = lstatSync(srcAbs);
  if (st.isSymbolicLink()) {
    throw new Error(
      `Refusing to install symlink payload entry: "${single}" (packages must ship regular files only)`,
    );
  }

  mkdirSync(targetRoot, { recursive: true });

  // Atomic copy: on any cpSync failure, clean the partial file so retry
  // is possible without a stale "already installed" block.
  try {
    cpSync(srcAbs, destFile);
  } catch (err) {
    try {
      rmSync(destFile, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`Failed to copy artifact file: ${err.message}`);
  }

  const name = installedName(packageName);
  writeArtifactManifest({
    targetRoot,
    installedName: name,
    target: "file",
    type,
    source,
    sourceType,
    version,
    integrity,
    commit,
    installedPaths: [destFile],
  });

  return { installedName: name, installedPaths: [destFile] };
}
