/**
 * update.test.js
 *
 * Verifies the type-aware update command:
 *   - No artifacts installed → error
 *   - Unknown identifier → error listing installed
 *   - Missing source → warn + skip
 *   - Update a single folder-target skill → reinstalls, preserves dir
 *   - Update a file-target agent → reinstalls the flat file
 *   - Match by manifest source (npm-ish spec)
 *   - Team update cascades members
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const FIXTURES = join(__dirname, "..", "fixtures");

function cli(cmd, args, env, cwd) {
  const r = spawnSync("node", [CLI, cmd, ...args], {
    encoding: "utf8",
    env,
    cwd,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
}

function makeLocalSkill(tmpRoot, name, description = "Test fixture.") {
  const dir = mkdtempSync(join(tmpRoot, `${name}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      files: ["SKILL.md"],
      ctxr: { type: "skill", target: "folder" },
    }),
  );
  return dir;
}

function makeTeam(dir, name, includes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      files: ["README.md"],
      ctxr: { type: "team", includes },
    }),
  );
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
}

describe("update command", () => {
  let projectDir;
  let fakeHome;
  let scratch;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-test-update-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-test-home-"));
    scratch = mkdtempSync(join(tmpdir(), "ctxr-test-update-scratch-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("--help flag", () => {
    it("exits 0 and prints usage", () => {
      const r = cli("update", ["--help"], env);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stderr.includes("Usage"));
      assert.ok(r.stderr.includes("identifier"));
    });
  });

  describe("no artifacts installed", () => {
    it("exits 1 with 'No artifacts installed' error", () => {
      // Run with cwd=projectDir so there's no ambiguity between "identifier"
      // and "project path" — update probes cwd and finds an empty project.
      const r = cli("update", [], env, projectDir);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("No artifacts installed"));
    });
  });

  describe("identifier not found", () => {
    it("exits 2 (usage error) with missing-list and --install hint", () => {
      // New pre-flight behavior: update splits requested identifiers into
      // installed/missing and, when any are missing and --install wasn't
      // passed, prints the missing list and exits without touching any
      // already-installed entry. This is a usage error (exit 2) because
      // the caller asked for something the manifest can't do.
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", join(projectDir, ".claude", "skills")],
        env,
      );
      const r = cli("update", ["nonexistent", projectDir], env);
      assert.equal(r.exitCode, 2);
      // Missing identifier listed + --install hint
      assert.ok(r.stderr.includes("nonexistent"));
      assert.ok(r.stderr.includes("--install"));
    });
  });

  describe("missing source in manifest", () => {
    it("warns and skips entries with no recorded source", () => {
      // Install first so the manifest + wrapper dir exist with the right shape.
      const targetDir = join(projectDir, ".claude", "skills");
      cli("install", [join(FIXTURES, "skill", "valid"), "--dir", targetDir], env);

      // Patch the manifest: drop the source field.
      const manifestPath = join(targetDir, ".ctxr-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest["valid-skill"].source;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

      const r = cli("update", ["valid-skill", projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("no recorded source"),
        `Expected skip message, got: ${r.stdout}`,
      );
    });
  });

  describe("update a folder-target skill", () => {
    it("re-installs in place from the recorded source", () => {
      const targetDir = join(projectDir, ".claude", "skills");
      const srcPath = join(FIXTURES, "skill", "valid");
      cli("install", [srcPath, "--dir", targetDir], env);

      const r = cli("update", ["valid-skill", projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("updated") || r.stdout.includes("installed"),
      );
      // Artifact still present after update
      assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));

      // Manifest still valid
      const manifest = JSON.parse(
        readFileSync(join(targetDir, ".ctxr-manifest.json"), "utf8"),
      );
      assert.ok(manifest["valid-skill"]);
      assert.equal(manifest["valid-skill"].source, srcPath);
    });
  });

  describe("update a file-target agent", () => {
    it("re-installs the flat file", () => {
      const targetDir = join(projectDir, ".claude", "agents");
      cli(
        "install",
        [join(FIXTURES, "agent", "file-minimal"), "--dir", targetDir],
        env,
      );

      const r = cli("update", ["agent-file-minimal", projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(
        existsSync(join(targetDir, "ctxr-agent-minimal.md")),
      );
    });
  });

  describe("match by source name", () => {
    it("finds the artifact by its manifest source field", () => {
      const id = `source-match-${Date.now()}`;
      const srcDir = makeLocalSkill(tmpdir(), id);

      const targetDir = join(projectDir, ".claude", "skills");
      cli("install", [srcDir, "--dir", targetDir], env);

      const r = cli("update", [srcDir, projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes(`Updating ${id}`));

      rmSync(srcDir, { recursive: true, force: true });
    });
  });

  describe("update all", () => {
    it("updates every installed artifact", () => {
      cli(
        "install",
        [
          join(FIXTURES, "skill", "valid"),
          join(FIXTURES, "agent", "file-minimal"),
          projectDir,
        ],
        env,
      );
      const r = cli("update", [projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Updating valid-skill"));
      assert.ok(r.stdout.includes("Updating agent-file-minimal"));
    });
  });

  describe("team update cascade", () => {
    it("cascade-updates every member", () => {
      const teamDir = join(scratch, "team-update");
      makeTeam(teamDir, "team-update", [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-minimal"),
      ]);
      cli("install", [teamDir, projectDir], env);

      const r = cli("update", ["team-update", projectDir], env);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("team cascade complete"));

      // Members still present after update
      assert.ok(
        existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
      );
      assert.ok(
        existsSync(join(projectDir, ".claude", "agents", "ctxr-agent-minimal.md")),
      );
    });
  });
});
