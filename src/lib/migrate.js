/**
 * Migration of legacy `.claude/` installs to the canonical `.agents/` layout.
 *
 * Pre-flip kit installed every artefact under `<projectPath>/.claude/<type>/`
 * with a manifest at `<projectPath>/.claude/<type>/.ctxr-manifest.json`. After
 * the canonical-paths flip the canonical location is `<projectPath>/.agents/<type>/`.
 * On every `install` call this helper walks every legacy manifest row and,
 * when the legacy directory is a real (non-symlink) folder, moves it to the
 * canonical path, replaces the original with a symlink (so Claude Code still
 * discovers it), and migrates the manifest row. `update` intentionally does
 * NOT auto-migrate, to preserve user-deliberate layouts. Idempotent:
 * re-running after migration is a no-op.
 *
 * Migration is best-effort. A row whose move fails is left in place with a
 * one-line warning. Manifest writes use the same atomic temp+fsync+rename
 * pattern as `writeManifest` in `./discover.js`.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { readManifest, writeManifest } from "./discover.js";
import { ensureMirror } from "./symlink.js";
import { ARTIFACT_TYPES, INSTALLABLE_TYPE_NAMES, LEGACY_PROJECT_DIRS } from "./types.js";

function moveDir(src, dst) {
  try {
    renameSync(src, dst);
  } catch (err) {
    // Cross-device rename → fall back to recursive copy + recursive delete.
    if (err.code === "EXDEV") {
      cpSync(src, dst, { recursive: true });
      // `rmSync({ force: true, recursive: true })` swallows per-entry errors
      // silently. Verify the source is fully gone so a partial-rmSync
      // doesn't leave the project stuck in a "canonical exists, legacy still
      // here" state that loops the migrator forever on subsequent runs.
      rmSync(src, { recursive: true, force: true });
      if (existsSync(src)) {
        throw new Error(
          `EXDEV migration of ${src} → ${dst} succeeded the copy but failed to fully remove the source. Inspect ${src} for permission issues and remove it manually.`,
        );
      }
      return;
    }
    throw err;
  }
}

/**
 * Defence-in-depth: refuse any move whose source or destination is not
 * strictly contained within the manifest directory we are migrating from /
 * to. A hostile legacy manifest with key `"../../etc/something"` would
 * otherwise cause `migrateOneRow` to walk outside the kit-managed tree.
 * Both the manifest key (used as the leaf basename) and `installedPaths[0]`
 * (used by `findLegacyFileLeaf` for `target: "file"` rows) flow into this
 * guard so a malformed entry never escapes.
 */
function isContainedUnder(child, parent) {
  if (typeof child !== "string" || typeof parent !== "string") return false;
  if (child.length === 0 || parent.length === 0) return false;
  if (child === parent) return false;
  return child.startsWith(parent + sep);
}

function migrateOneRow({
  legacyDir,
  canonicalDir,
  legacyManifestDir,
  canonicalManifestDir,
  installedName,
  legacyEntry,
  legacyRelLabel,
  canonicalRelLabel,
  mirrorTarget,
}) {
  // Containment guards: refuse to move anything outside the per-manifest
  // directory. A hostile legacy manifest with traversal keys would
  // otherwise allow migration to write outside `.agents/<type>/`.
  if (!isContainedUnder(legacyDir, legacyManifestDir)) {
    return {
      migrated: false,
      reason: "legacy-out-of-tree",
      warning: `migration: refusing legacy path "${legacyDir}" outside "${legacyManifestDir}"`,
    };
  }
  if (!isContainedUnder(canonicalDir, canonicalManifestDir)) {
    return {
      migrated: false,
      reason: "canonical-out-of-tree",
      warning: `migration: refusing canonical path "${canonicalDir}" outside "${canonicalManifestDir}"`,
    };
  }
  // Legacy dir is a symlink (already migrated): just clean up the legacy
  // manifest row if it still exists and stop.
  let legacyStat;
  try {
    legacyStat = lstatSync(legacyDir);
  } catch {
    return { migrated: false, reason: "legacy-missing" };
  }
  if (legacyStat.isSymbolicLink()) {
    return { migrated: false, reason: "already-symlink" };
  }

  // If the canonical path already has a real install, refuse to clobber it.
  let canonicalExists = false;
  try {
    canonicalExists = existsSync(canonicalDir);
  } catch {
    canonicalExists = false;
  }
  if (canonicalExists) {
    return {
      migrated: false,
      reason: "canonical-already-exists",
      warning: `migration: refusing to migrate ${legacyRelLabel} to ${canonicalRelLabel} (canonical already exists)`,
    };
  }

  mkdirSync(canonicalManifestDir, { recursive: true });
  moveDir(legacyDir, canonicalDir);

  // Stamp the new manifest row with `migratedFrom`. Project-scope rows use a
  // path relative to projectPath; user-scope rows are absolute (no portable
  // anchor).
  const newEntry = {
    ...legacyEntry,
    installedPaths: [canonicalDir],
    discoveryMirrors: Array.from(
      new Set([
        ...(Array.isArray(legacyEntry.discoveryMirrors) ? legacyEntry.discoveryMirrors : []),
        legacyDir,
      ]),
    ),
    migratedFrom: legacyRelLabel,
    updatedAt: new Date().toISOString(),
  };

  // Two-manifest atomicity: drop the legacy row FIRST, then write the
  // canonical row. If the canonical write fails after the legacy row is
  // gone, the next migration run won't see the row in either manifest, but
  // the on-disk canonical directory is already in place, so the operator
  // can restore it manually with `kit install --dir .agents/<type>` from
  // the source. The reverse order (canonical first, legacy second) risks
  // duplicate rows on partial failure, which surfaces as a "shown twice"
  // bug in `kit list` until the operator hand-edits one of the manifests.
  const legacyManifest = readManifest(legacyManifestDir);
  delete legacyManifest[installedName];
  if (Object.keys(legacyManifest).length === 0) {
    rmSync(join(legacyManifestDir, ".ctxr-manifest.json"), { force: true });
  } else {
    writeManifest(legacyManifestDir, legacyManifest);
  }
  const canonicalManifest = readManifest(canonicalManifestDir);
  canonicalManifest[installedName] = newEntry;
  writeManifest(canonicalManifestDir, canonicalManifest);

  // Re-create the legacy path as a discovery mirror.
  ensureMirror({
    canonicalPath: canonicalDir,
    mirrorPath: legacyDir,
    target: mirrorTarget,
  });

  return { migrated: true };
}

/**
 * Walk every legacy `.claude/<type>/.ctxr-manifest.json` and migrate every
 * real-folder install to the canonical `.agents/<type>/` layout.
 *
 * @param {object} args
 * @param {string} args.projectPath — absolute project root
 * @returns {{ migrated: Array<{ from: string, to: string, type: string, name: string }> }}
 */
export function migrateLegacyClaudePaths({ projectPath }) {
  const migrated = [];
  if (typeof projectPath !== "string" || projectPath.length === 0) {
    return { migrated };
  }
  for (const typeName of INSTALLABLE_TYPE_NAMES) {
    const typeCfg = ARTIFACT_TYPES[typeName];
    if (!typeCfg.userDir) continue;
    const legacyRel = LEGACY_PROJECT_DIRS[typeName];
    const canonicalRel = typeCfg.projectDirs[0];
    if (!legacyRel || !canonicalRel) continue;

    // Project-scope migration.
    const legacyManifestDir = join(projectPath, legacyRel);
    if (existsSync(legacyManifestDir)) {
      const legacyManifest = readManifest(legacyManifestDir);
      for (const [installedName, legacyEntry] of Object.entries(legacyManifest)) {
        if (!legacyEntry || typeof legacyEntry !== "object") continue;
        const legacyDir = join(legacyManifestDir, installedName);
        const canonicalManifestDir = join(projectPath, canonicalRel);
        const canonicalDir = join(canonicalManifestDir, installedName);
        const target = legacyEntry.target === "file" ? "file" : "folder";
        // Files have a `.md` extension; rebuild paths accordingly.
        const legacyLeaf = target === "file"
          ? findLegacyFileLeaf(legacyEntry, legacyManifestDir, installedName)
          : legacyDir;
        const canonicalLeaf = target === "file"
          ? join(canonicalManifestDir, basenameOfPath(legacyLeaf))
          : canonicalDir;
        try {
          const r = migrateOneRow({
            legacyDir: legacyLeaf,
            canonicalDir: canonicalLeaf,
            legacyManifestDir,
            canonicalManifestDir,
            installedName,
            legacyEntry,
            legacyRelLabel: relative(projectPath, legacyLeaf),
            canonicalRelLabel: relative(projectPath, canonicalLeaf),
            mirrorTarget: target,
          });
          if (r.migrated) {
            migrated.push({
              from: legacyLeaf,
              to: canonicalLeaf,
              type: typeName,
              name: installedName,
            });
            process.stderr.write(
              `migrated ${typeName} ${installedName}: ${relative(projectPath, legacyLeaf)} -> ${relative(projectPath, canonicalLeaf)}\n`,
            );
          } else if (r.warning) {
            process.stderr.write(`warning: ${r.warning}\n`);
          }
        } catch (err) {
          process.stderr.write(
            `warning: migration failed for ${typeName} ${installedName}: ${err.message}\n`,
          );
        }
      }
    }

    // User-scope migration: legacy `~/.claude/<type>/` → canonical `~/.agents/<type>/`.
    const userLegacyDir = join(homedir(), ".claude", typeCfg.userDir);
    if (existsSync(userLegacyDir)) {
      const legacyManifest = readManifest(userLegacyDir);
      const userCanonicalDir = join(homedir(), ".agents", typeCfg.userDir);
      for (const [installedName, legacyEntry] of Object.entries(legacyManifest)) {
        if (!legacyEntry || typeof legacyEntry !== "object") continue;
        const target = legacyEntry.target === "file" ? "file" : "folder";
        const legacyLeaf = target === "file"
          ? findLegacyFileLeaf(legacyEntry, userLegacyDir, installedName)
          : join(userLegacyDir, installedName);
        const canonicalLeaf = target === "file"
          ? join(userCanonicalDir, basenameOfPath(legacyLeaf))
          : join(userCanonicalDir, installedName);
        try {
          const r = migrateOneRow({
            legacyDir: legacyLeaf,
            canonicalDir: canonicalLeaf,
            legacyManifestDir: userLegacyDir,
            canonicalManifestDir: userCanonicalDir,
            installedName,
            legacyEntry,
            legacyRelLabel: legacyLeaf,
            canonicalRelLabel: canonicalLeaf,
            mirrorTarget: target,
          });
          if (r.migrated) {
            migrated.push({
              from: legacyLeaf,
              to: canonicalLeaf,
              type: typeName,
              name: installedName,
            });
            process.stderr.write(
              `migrated ${typeName} ${installedName}: ${legacyLeaf} -> ${canonicalLeaf}\n`,
            );
          } else if (r.warning) {
            process.stderr.write(`warning: ${r.warning}\n`);
          }
        } catch (err) {
          process.stderr.write(
            `warning: migration failed for ${typeName} ${installedName}: ${err.message}\n`,
          );
        }
      }
    }
  }

  // Team manifests: legacy `.claude/teams/` → canonical `.agents/teams/`.
  for (const [legacyParent, canonicalParent] of [
    [join(projectPath, ".claude", "teams"), join(projectPath, ".agents", "teams")],
    [join(homedir(), ".claude", "teams"), join(homedir(), ".agents", "teams")],
  ]) {
    if (!existsSync(legacyParent)) continue;
    const legacyManifest = readManifest(legacyParent);
    if (Object.keys(legacyManifest).length === 0) continue;
    mkdirSync(canonicalParent, { recursive: true });
    const canonicalManifest = readManifest(canonicalParent);
    let movedAny = false;
    for (const [installedName, entry] of Object.entries(legacyManifest)) {
      if (canonicalManifest[installedName]) continue;
      canonicalManifest[installedName] = {
        ...entry,
        migratedFrom: legacyParent,
        updatedAt: new Date().toISOString(),
      };
      movedAny = true;
      process.stderr.write(
        `migrated team ${installedName}: ${legacyParent} -> ${canonicalParent}\n`,
      );
    }
    if (movedAny) {
      writeManifest(canonicalParent, canonicalManifest);
      // Empty out the legacy team manifest so the rows don't show up twice.
      rmSync(join(legacyParent, ".ctxr-manifest.json"), { force: true });
    }
  }

  return { migrated };
}

function basenameOfPath(p) {
  if (typeof p !== "string") return "";
  // Use `path.basename` so Windows separators (`\\`) are honoured too;
  // a hand-rolled `lastIndexOf("/")` would mis-split Windows paths.
  return basename(p);
}

/**
 * For a `target: "file"` legacy entry, recover the on-disk file path.
 * Pre-flip manifests stored `installedPaths: ["<dir>/<basename>.md"]`. Newer
 * code uses the same shape. We try the manifest, then fall back to scanning
 * the legacy dir for `<installedName>*` matches.
 */
function findLegacyFileLeaf(legacyEntry, legacyManifestDir, installedName) {
  const paths = Array.isArray(legacyEntry.installedPaths)
    ? legacyEntry.installedPaths
    : [];
  if (paths.length === 1 && typeof paths[0] === "string") return paths[0];
  // Best-effort: assume `<installedName>.md`.
  return join(legacyManifestDir, `${installedName}.md`);
}
