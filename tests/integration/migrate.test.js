import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { migrateLegacyClaudePaths } from "../../src/lib/migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const FIXTURES = join(__dirname, "..", "fixtures");

function seedLegacySkill(projectDir, name, version = "1.0.0") {
  const dir = join(projectDir, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURES, "skill", "valid"), dir, { recursive: true });
  const manifestPath = join(
    projectDir,
    ".claude",
    "skills",
    ".ctxr-manifest.json",
  );
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : {};
  manifest[name] = {
    type: "skill",
    target: "folder",
    source: join(FIXTURES, "skill", "valid"),
    sourceType: "local",
    version,
    installedPaths: [dir],
    installedAt: new Date().toISOString(),
    updatedAt: null,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

describe("migrateLegacyClaudePaths (unit)", () => {
  let projectDir;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-migrate-"));
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it("moves a legacy .claude/skills/foo/ to .agents/skills/foo/ + symlink", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlinks require POSIX or Windows dev mode");
    }
    seedLegacySkill(projectDir, "legacy-foo");
    const r = migrateLegacyClaudePaths({ projectPath: projectDir });
    assert.equal(r.migrated.length, 1);
    assert.equal(r.migrated[0].name, "legacy-foo");

    const canonical = join(projectDir, ".agents", "skills", "legacy-foo");
    const legacy = join(projectDir, ".claude", "skills", "legacy-foo");
    assert.ok(existsSync(canonical));
    assert.equal(lstatSync(canonical).isSymbolicLink(), false);
    assert.equal(lstatSync(legacy).isSymbolicLink(), true);
    assert.equal(realpathSync(legacy), realpathSync(canonical));

    // Manifest row moved.
    const canonicalManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".agents", "skills", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    assert.ok(canonicalManifest["legacy-foo"]);
    assert.equal(
      canonicalManifest["legacy-foo"].migratedFrom,
      ".claude/skills/legacy-foo",
    );
    // Legacy manifest empty / removed.
    const legacyManifestPath = join(
      projectDir,
      ".claude",
      "skills",
      ".ctxr-manifest.json",
    );
    if (existsSync(legacyManifestPath)) {
      const legacyManifest = JSON.parse(
        readFileSync(legacyManifestPath, "utf8"),
      );
      assert.ok(!legacyManifest["legacy-foo"]);
    }
  });

  it("re-running migration is idempotent", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlinks require POSIX or Windows dev mode");
    }
    seedLegacySkill(projectDir, "legacy-foo");
    const r1 = migrateLegacyClaudePaths({ projectPath: projectDir });
    assert.equal(r1.migrated.length, 1);
    const r2 = migrateLegacyClaudePaths({ projectPath: projectDir });
    assert.equal(r2.migrated.length, 0);
    // State is still healthy.
    const canonical = join(projectDir, ".agents", "skills", "legacy-foo");
    const legacy = join(projectDir, ".claude", "skills", "legacy-foo");
    assert.ok(existsSync(canonical));
    assert.equal(realpathSync(legacy), realpathSync(canonical));
  });

  it("refuses to clobber an existing canonical install", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlinks require POSIX or Windows dev mode");
    }
    // Both legacy AND canonical present (different content). Migration
    // must leave the legacy alone.
    seedLegacySkill(projectDir, "conflict");
    const canonical = join(projectDir, ".agents", "skills", "conflict");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "different.md"), "ok\n");

    const r = migrateLegacyClaudePaths({ projectPath: projectDir });
    assert.equal(r.migrated.length, 0);
    // Canonical preserved untouched.
    assert.ok(existsSync(join(canonical, "different.md")));
    // Legacy still present as a real dir.
    const legacy = join(projectDir, ".claude", "skills", "conflict");
    assert.equal(lstatSync(legacy).isSymbolicLink(), false);
  });

  it("refuses a hostile manifest key that escapes the manifest dir", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlinks require POSIX or Windows dev mode");
    }
    // Hand-author a legacy manifest whose installedName is a traversal
    // string. `migrateOneRow`'s `isContainedUnder` guard must refuse it
    // and emit the `legacy-out-of-tree` warning instead of moving any
    // files.
    const legacyDir = join(projectDir, ".claude", "skills");
    mkdirSync(legacyDir, { recursive: true });
    const hostileKey = "../../../etc/evil";
    const manifest = {
      [hostileKey]: {
        type: "skill",
        target: "folder",
        source: "fake",
        sourceType: "local",
        version: "1.0.0",
        installedPaths: [join(legacyDir, hostileKey)],
        installedAt: new Date().toISOString(),
        updatedAt: null,
      },
    };
    writeFileSync(
      join(legacyDir, ".ctxr-manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    // Capture the migrator's stderr warning by intercepting process.stderr.
    const warnings = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      warnings.push(String(chunk));
      return true;
    };
    let r;
    try {
      r = migrateLegacyClaudePaths({ projectPath: projectDir });
    } finally {
      process.stderr.write = origWrite;
    }
    assert.equal(r.migrated.length, 0);
    assert.ok(
      warnings.some((w) => /out-of-tree|outside/.test(w)),
      `expected out-of-tree warning, got: ${warnings.join("|")}`,
    );
    // Nothing was created under .agents/.
    assert.equal(existsSync(join(projectDir, ".agents")), false);
  });

  it("noop when there are no legacy installs", () => {
    const r = migrateLegacyClaudePaths({ projectPath: projectDir });
    assert.equal(r.migrated.length, 0);
  });
});

describe("migrateLegacyClaudePaths via kit install / kit update", () => {
  let projectDir;
  let fakeHome;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-migrate-cli-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-migrate-home-"));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("kit install on an unrelated skill triggers migration of pre-existing legacy installs", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlinks require POSIX or Windows dev mode");
    }
    seedLegacySkill(projectDir, "legacy-skill");

    const r = spawnSync(
      "node",
      [CLI, "install", join(FIXTURES, "skill", "valid")],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, CI: "true" },
        cwd: projectDir,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    // Legacy moved.
    const canonical = join(projectDir, ".agents", "skills", "legacy-skill");
    const legacy = join(projectDir, ".claude", "skills", "legacy-skill");
    assert.ok(existsSync(canonical));
    assert.equal(lstatSync(legacy).isSymbolicLink(), true);
    // Stderr contains the migration line.
    assert.match(r.stderr, /migrated skill legacy-skill/);
  });

  it("kit update does NOT auto-migrate (preserves user's deliberate layout)", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlinks require POSIX or Windows dev mode");
    }
    // Use the package's own installedName ("valid-skill") so update can
    // round-trip without renaming the manifest key.
    seedLegacySkill(projectDir, "valid-skill");

    const r = spawnSync("node", [CLI, "update", "valid-skill"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fakeHome, CI: "true" },
      cwd: projectDir,
    });
    assert.equal(r.status, 0, r.stderr);
    // The artefact stays at its legacy location; only `kit install` migrates.
    const legacy = join(projectDir, ".claude", "skills", "valid-skill");
    assert.ok(existsSync(legacy));
    assert.equal(lstatSync(legacy).isSymbolicLink(), false);
    // No canonical version was created.
    assert.equal(
      existsSync(join(projectDir, ".agents", "skills", "valid-skill")),
      false,
    );
  });
});
