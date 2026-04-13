/**
 * Shared manifest-entry construction for folder / file installers.
 *
 * Both layouts write the same entry shape (type, target, source, sourceType,
 * version, integrity, commit, installedPaths, installedAt, updatedAt) keyed
 * by the installedName. Centralizing it here keeps the two installers lean
 * and guarantees they can't drift in shape.
 */

import { readManifest, writeManifest } from "../lib/discover.js";

/**
 * Build the manifest entry and persist it to the target root's
 * `.ctxr-manifest.json`. Returns the composed entry for any caller that
 * wants to inspect it (currently unused but cheap to expose).
 *
 * @param {object} args
 * @param {string} args.targetRoot — directory that holds the manifest
 * @param {string} args.installedName — manifest key
 * @param {"folder"|"file"} args.target
 * @param {string} args.type — artifact type
 * @param {string} args.source
 * @param {string} args.sourceType
 * @param {string|null} args.version
 * @param {string|null} [args.integrity]
 * @param {string|null} [args.commit]
 * @param {string[]} args.installedPaths
 */
export function writeArtifactManifest(args) {
  const {
    targetRoot,
    installedName,
    target,
    type,
    source,
    sourceType,
    version,
    integrity,
    commit,
    installedPaths,
  } = args;

  const manifest = readManifest(targetRoot);
  const entry = {
    type,
    target,
    source,
    sourceType,
    version: version ?? null,
    installedPaths,
    installedAt: new Date().toISOString(),
    updatedAt: null,
  };
  if (integrity) entry.integrity = integrity;
  if (commit) entry.commit = commit;
  manifest[installedName] = entry;
  writeManifest(targetRoot, manifest);
  return entry;
}

/**
 * Shared "packaging metadata" recognizer used by both installers.
 *
 * folder.js drops only `package.json` (README/LICENSE are still useful
 * docs for a bundle artifact). file.js drops ALL metadata so that the
 * single-artifact-file invariant can be enforced on the npm payload.
 *
 * Exposed here as a single source of truth so the two installers can't
 * disagree on what "metadata" means.
 */
export const PACKAGE_METADATA = {
  /** Files that kit never copies into either target layout. */
  alwaysDrop: /^package\.json$/,

  /** Additional files that are dropped only for target:"file" installs. */
  fileTargetDrop: [
    /^README(\..*)?$/i,
    /^LICEN[SC]E(\..*)?$/i,
    /^CHANGELOG(\..*)?$/i,
    /^NOTICE(\..*)?$/i,
  ],
};

/**
 * True if `path` is a file kit should never copy under any target layout.
 */
export function isAlwaysDroppedMetadata(path) {
  return PACKAGE_METADATA.alwaysDrop.test(path);
}

/**
 * True if `path` is packaging metadata that a target:"file" install should
 * filter out before checking the "exactly one artifact" invariant.
 */
export function isFileTargetMetadata(path) {
  if (isAlwaysDroppedMetadata(path)) return true;
  return PACKAGE_METADATA.fileTargetDrop.some((re) => re.test(path));
}

/**
 * Resolve the single artifact file for a `target: "file"` package given an
 * already-computed `packagePayload()` output. Centralizes the "exactly one
 * .md file after metadata filter" invariant so the installer, the validator
 * dispatcher, and the per-type validator helper all share identical
 * semantics and error messages.
 *
 * Returns a discriminated union: callers throw or report as appropriate.
 * `artifacts` is always the filtered list (minus metadata) so callers can
 * build rich preview messages.
 *
 * @param {string[]} payload — raw output of `packagePayload(packageDir)`
 * @returns {{ ok: true, single: string, artifacts: string[] } |
 *           { ok: false, reason: string, artifacts: string[] }}
 */
export function resolveFileTargetArtifact(payload) {
  const artifacts = payload.filter((p) => !isFileTargetMetadata(p));

  if (artifacts.length !== 1) {
    const preview =
      artifacts.length > 0
        ? ` (${artifacts.slice(0, 3).join(", ")}${artifacts.length > 3 ? ", …" : ""})`
        : "";
    return {
      ok: false,
      reason: `target:"file" requires files to resolve to exactly one artifact file, got ${artifacts.length}${preview}`,
      artifacts,
    };
  }

  const single = artifacts[0];
  if (!single.toLowerCase().endsWith(".md")) {
    return {
      ok: false,
      reason: `target:"file" artifact must be a .md file, got "${single}"`,
      artifacts,
    };
  }

  return { ok: true, single, artifacts };
}
