/**
 * Type-aware artifact discovery and manifest I/O.
 *
 * Every install location holds one `.ctxr-manifest.json` per artifact-type
 * directory (e.g. `.agents/skills/.ctxr-manifest.json`,
 * `.agents/agents/.ctxr-manifest.json`,
 * `~/.agents/bundles/.ctxr-manifest.json`).
 * Discovery also walks legacy `.claude/<type>/` and `~/.claude/<type>/` paths
 * plus per-client mirrors (`~/.codex/<type>/`) so `list`, `remove`, and the
 * migration helper can find pre-flip and pre-migration installs.
 *
 * Manifest writes are atomic (temp + fsync + rename) so a SIGINT or concurrent
 * `kit install` can never leave a half-written JSON that silently loses every
 * previously-recorded artifact.
 *
 * Reads tolerate a malformed manifest by warning to stderr and returning an
 * empty object — silent `{}` would orphan every entry without notifying the
 * user, which is the failure mode this whole module exists to prevent.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { ARTIFACT_TYPES, INSTALLABLE_TYPE_NAMES, LEGACY_PROJECT_DIRS } from "./types.js";
import { removeMirror } from "./symlink.js";

export const MANIFEST_FILE = ".ctxr-manifest.json";

/**
 * Read the `.ctxr-manifest.json` from an artifact-type directory.
 *
 * Returns `{}` if the file is absent or malformed. Malformed reads write a
 * one-line warning to stderr so the user knows their manifest needs repair —
 * silently swallowing the parse error would orphan every recorded artifact.
 */
// Pollution keys filtered out of every manifest read. JSON.parse will set
// `__proto__` as an own property (not the prototype chain), but downstream
// spreads (`{ ...legacyEntry }` in migrate.js) copy own enumerables only,
// and any key called `constructor` or `prototype` survives unfiltered. Strip
// the trio at parse time as defence-in-depth so a malicious manifest can
// never seed pollution keys into kit's data flow.
const MANIFEST_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function manifestReviver(key, value) {
  if (MANIFEST_POLLUTION_KEYS.has(key)) return undefined;
  return value;
}

export function readManifest(dir) {
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return {};
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"), manifestReviver);
  } catch (err) {
    process.stderr.write(
      `warning: manifest at ${manifestPath} is malformed, ignoring (${err.message})\n`,
    );
    return {};
  }
}

/**
 * Atomically write the `.ctxr-manifest.json` to an artifact-type directory.
 *
 * Strategy: write to a per-writer sibling `.tmp` file (uniquified by pid +
 * random bytes so two concurrent `kit` processes cannot stomp each other's
 * tmp content), `fsync` to flush page cache to disk, then `rename` over
 * the existing manifest. POSIX `rename` is atomic on the same filesystem,
 * so a crash mid-write either leaves the previous manifest intact or
 * completes the swap — never a truncated file. Without the explicit
 * `fsync` between write and rename, a power failure can leave an empty
 * file in place even though `writeFileSync` returned successfully (page
 * cache was never flushed).
 *
 * Concurrency caveat: even with unique tmp names, two parallel writers
 * still race the read-modify-write step (callers `readManifest`, mutate,
 * `writeManifest`). The rename is per-tmp-file atomic, so neither file is
 * corrupted, but the second writer's manifest replaces the first writer's
 * in-memory copy — the first writer's row is lost. A real lock requires
 * an advisory file lock and is deferred; in practice `kit` is invoked
 * one-at-a-time by humans and CI scripts. If parallel kit invocations
 * become routine, add an `flock`-style helper here.
 *
 * On orphan-tmp failure: if `writeFileSync` succeeds and the subsequent
 * `openSync`/`fsyncSync`/`renameSync` throws, the orphan tmp is removed
 * in a `catch` so a transient EMFILE doesn't leave breadcrumbs.
 */
export function writeManifest(dir, manifest) {
  const manifestPath = join(dir, MANIFEST_FILE);
  const tmpPath = `${manifestPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // `flag: "wx"` (O_EXCL) refuses to follow a pre-planted symlink at the
    // tmp path. Combined with the per-pid + random suffix this makes
    // targeted symlink attacks on the tmp slot effectively impossible.
    writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, manifestPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * List candidate install directories for a given artifact type that actually
 * exist on disk. Iterates the canonical `.agents/<type>/` project dir plus
 * `~/.agents/<type>/` user-scope dir, plus every legacy/mirror path declared
 * in `typeCfg.discoveryMirrors` and `LEGACY_PROJECT_DIRS` so a fresh `list` /
 * `remove` finds installs that pre-date the canonical-path flip.
 *
 * Mirror paths only matter to discovery while a legacy install or symlink
 * still exists at one of them; idempotent re-installs/removes are safe even
 * when the mirror points at the canonical dir.
 *
 * @param {string} typeName — key into ARTIFACT_TYPES
 * @param {string} projectPath — absolute project root
 * @returns {string[]} absolute directory paths that exist
 */
export function discoverArtifactDirs(typeName, projectPath) {
  const typeCfg = ARTIFACT_TYPES[typeName];
  if (!typeCfg) {
    throw new Error(`Unknown artifact type: "${typeName}"`);
  }
  const candidates = [];
  for (const rel of typeCfg.projectDirs) {
    candidates.push(join(projectPath, rel));
  }
  // Legacy project-scope dir (pre-flip installs).
  const legacyProjectRel = LEGACY_PROJECT_DIRS[typeName];
  if (legacyProjectRel) {
    candidates.push(join(projectPath, legacyProjectRel));
  }
  // Project-scope discovery mirrors (today: same as legacy).
  for (const rel of typeCfg.discoveryMirrors?.project ?? []) {
    candidates.push(join(projectPath, rel));
  }
  if (typeCfg.userDir) {
    candidates.push(join(homedir(), ".agents", typeCfg.userDir));
    // Legacy + per-client user-scope mirrors.
    for (const rel of typeCfg.discoveryMirrors?.user ?? []) {
      candidates.push(join(homedir(), rel));
    }
  }
  // De-dup while preserving order (canonical first, mirrors after).
  const seen = new Set();
  return candidates.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return existsSync(p);
  });
}

/**
 * Return all artifacts installed in `dir` according to the manifest file.
 * Each entry carries `type`, `target`, `source`, and the `installedPaths`
 * array exactly as written by the type-aware installers. `installedName`
 * (the manifest key) is attached for convenience so callers can render or
 * match without re-deriving it.
 *
 * @param {string} dir — absolute install directory (contains the manifest)
 * @returns {Array<object>} manifest entries with `installedName` attached
 */
export function getInstalledArtifacts(dir) {
  if (!existsSync(dir)) return [];
  const manifest = readManifest(dir);
  const out = [];
  for (const [key, raw] of Object.entries(manifest)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = {
      installedName: key,
      type: typeof raw.type === "string" ? raw.type : null,
      target: typeof raw.target === "string" ? raw.target : null,
      source: raw.source ?? null,
      sourceType: raw.sourceType ?? null,
      version: raw.version ?? null,
      integrity: raw.integrity ?? null,
      installedPaths: Array.isArray(raw.installedPaths)
        ? raw.installedPaths
        : [join(dir, key)],
      discoveryMirrors: Array.isArray(raw.discoveryMirrors)
        ? raw.discoveryMirrors
        : [],
      migratedFrom: typeof raw.migratedFrom === "string" ? raw.migratedFrom : null,
      installedAt: raw.installedAt ?? null,
      updatedAt: raw.updatedAt ?? null,
    };
    if (raw.type === "bundle" && Array.isArray(raw.members)) {
      entry.members = raw.members;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Bundle manifests live canonically at `.agents/bundles/` (project) and
 * `~/.agents/bundles/` (user). Bundle is a meta type and does not appear
 * in `ARTIFACT_TYPES` with project/user dirs, so the list/remove/update
 * commands call this helper directly to enumerate bundle manifest
 * locations. There is no legacy `.claude/bundles/` path to consider:
 * the rename from `team` to `bundle` was a clean break in
 * `@ctxr/kit@2.0.0`. Note that when the install flow runs with a
 * non-canonical `dir` (CUSTOM / EXPLICIT_DIR), `resolveBundleManifestDir`
 * can additionally write a manifest under `<dir>/bundles`; callers that
 * may have installed with a custom dir should enumerate that location
 * themselves rather than relying on this helper.
 *
 * @param {string} projectPath: absolute project root
 * @returns {string[]} absolute directory paths that exist
 */
export function discoverBundleManifestDirs(projectPath) {
  const candidates = [
    join(projectPath, ".agents", "bundles"),
    join(homedir(), ".agents", "bundles"),
  ];
  const seen = new Set();
  return candidates.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return existsSync(p);
  });
}

/**
 * Walk every `(type, dir)` pair that could contain a `.ctxr-manifest.json`
 * and return one group per non-empty manifest. Used by `list` to render the
 * full installation inventory and by `update` to iterate every artifact with
 * a recorded source.
 *
 * @param {string} projectPath — absolute project root
 * @returns {Array<{ typeName: string, dir: string, entries: Array }>}
 */
export function listAllInstalled(projectPath) {
  const out = [];
  for (const typeName of INSTALLABLE_TYPE_NAMES) {
    for (const dir of discoverArtifactDirs(typeName, projectPath)) {
      const entries = getInstalledArtifacts(dir).filter(
        (e) => e.type === typeName,
      );
      if (entries.length > 0) out.push({ typeName, dir, entries });
    }
  }
  for (const dir of discoverBundleManifestDirs(projectPath)) {
    const entries = getInstalledArtifacts(dir).filter((e) => e.type === "bundle");
    if (entries.length > 0) out.push({ typeName: "bundle", dir, entries });
  }
  return out;
}

/**
 * Delete an entry's on-disk install paths, every kit-owned discovery mirror
 * recorded on the entry, and the manifest row. Used by `remove` (leaf
 * delete) and `update` (remove-then-reinstall). No bundle cascade, no
 * confirmation: callers layer their own policy on top.
 *
 * Synthetic bundle `installedPaths` (which don't exist on disk) are safe
 * because `rmSync({ force: true })` ignores missing targets.
 *
 * Discovery mirrors are deleted via `removeMirror` from `./symlink.js`,
 * which refuses to delete anything kit does not own (real directories,
 * symlinks pointing somewhere unexpected). Errors and warnings are logged
 * to stderr but never propagate, mirroring the best-effort cleanup
 * semantics of the surrounding code.
 *
 * @param {{ dir: string, entry: { installedName: string, installedPaths?: string[], discoveryMirrors?: string[] } }} match
 */
export function removeEntryFromManifest({ dir, entry }) {
  for (const p of entry.installedPaths || []) {
    rmSync(p, { recursive: true, force: true });
  }
  if (Array.isArray(entry.discoveryMirrors) && entry.discoveryMirrors.length > 0) {
    const expectedTarget = entry.installedPaths?.[0];
    for (const mirrorPath of entry.discoveryMirrors) {
      try {
        const r = removeMirror(mirrorPath, { expectedTarget });
        if (r.warning) {
          process.stderr.write(`warning: ${r.warning}\n`);
        }
      } catch (err) {
        process.stderr.write(
          `warning: failed to remove discovery mirror at ${mirrorPath}: ${err.message}\n`,
        );
      }
    }
  }
  const manifest = readManifest(dir);
  delete manifest[entry.installedName];
  writeManifest(dir, manifest);
}

/**
 * Find artifact installations matching `identifier` across every installable
 * type plus bundle manifests. Returns `{ typeName, dir, entry }` tuples so
 * the caller can remove/update without another round-trip to discover
 * the type.
 *
 * Matches by installed-name (manifest key) or `source` package spec.
 *
 * @param {string} identifier
 * @param {string} projectPath
 * @returns {Array<{ typeName: string, dir: string, entry: object }>}
 */
export function findArtifactAcrossTypes(identifier, projectPath) {
  if (typeof identifier !== "string" || identifier.length === 0) {
    return [];
  }
  const results = [];
  const seen = new Set();

  const absorb = (typeName, dir, entry) => {
    const key = dir + "|" + entry.installedName;
    if (seen.has(key)) return;
    if (entry.installedName === identifier || entry.source === identifier) {
      seen.add(key);
      results.push({ typeName, dir, entry });
    }
  };

  for (const typeName of INSTALLABLE_TYPE_NAMES) {
    for (const dir of discoverArtifactDirs(typeName, projectPath)) {
      for (const entry of getInstalledArtifacts(dir)) {
        if (entry.type !== typeName) continue;
        absorb(typeName, dir, entry);
      }
    }
  }
  for (const dir of discoverBundleManifestDirs(projectPath)) {
    for (const entry of getInstalledArtifacts(dir)) {
      if (entry.type !== "bundle") continue;
      absorb("bundle", dir, entry);
    }
  }

  return results;
}
