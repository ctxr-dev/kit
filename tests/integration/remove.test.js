/**
 * remove.test.js
 *
 * Verifies the type-aware remove command:
 *   - Single-match remove by installed-name, with --force to skip prompt
 *   - Match by source package spec (--force)
 *   - Manifest cleanup after removal
 *   - Cross-type discovery (agent fixture removed by installed-name)
 *   - Team cascade removes members; --keep-members preserves them
 *   - Multi-location remove with --all --force
 *   - Non-TTY without --force errors; non-TTY with multiple matches requires --all
 *   - uninstall alias
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

function cli(cmd, args, env) {
  const r = spawnSync("node", [CLI, cmd, ...args], {
    encoding: "utf8",
    env,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
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

describe("remove command", () => {
  let projectDir;
  let fakeHome;
  let scratch;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-test-remove-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-test-home-"));
    scratch = mkdtempSync(join(tmpdir(), "ctxr-test-remove-scratch-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("no arguments", () => {
    it("exits 1 with usage message", () => {
      const r = cli("remove", [], env);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("Usage"));
    });
  });

  describe("--help flag", () => {
    it("shows help with --force, --all, --keep-members", () => {
      const r = cli("remove", ["--help"], env);
      // --help is handled cleanly (exit 0).
      assert.equal(r.exitCode, 0);
      assert.ok(r.stderr.includes("--force"));
      assert.ok(r.stderr.includes("--all"));
      assert.ok(r.stderr.includes("--keep-members"));
    });
  });

  describe("artifact not found", () => {
    it("exits 1 with 'not found' error listing what IS installed", () => {
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", join(projectDir, ".claude", "skills")],
        env,
      );
      const r = cli("remove", ["nonexistent-thing", projectDir], env);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("not found"));
      assert.ok(r.stderr.includes("valid-skill"));
    });
  });

  describe("remove by installed-name (skill, folder target)", () => {
    it("deletes the wrapper dir and drops its manifest row", () => {
      const targetDir = join(projectDir, ".claude", "skills");
      cli("install", [join(FIXTURES, "skill", "valid"), "--dir", targetDir], env);
      assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));

      const r = cli("remove", ["valid-skill", projectDir, "--force"], env);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("removed 'valid-skill'"));
      assert.ok(!existsSync(join(targetDir, "valid-skill")));

      // Manifest entry dropped
      const manifest = JSON.parse(
        readFileSync(join(targetDir, ".ctxr-manifest.json"), "utf8"),
      );
      assert.ok(!manifest["valid-skill"]);
    });
  });

  describe("remove by installed-name (agent, file target)", () => {
    it("deletes the flat .md file and drops its manifest row", () => {
      const targetDir = join(projectDir, ".claude", "agents");
      cli(
        "install",
        [join(FIXTURES, "agent", "file-minimal"), "--dir", targetDir],
        env,
      );
      const destFile = join(targetDir, "ctxr-agent-minimal.md");
      assert.ok(existsSync(destFile));

      const r = cli("remove", ["agent-file-minimal", projectDir, "--force"], env);
      assert.equal(r.exitCode, 0);
      assert.ok(!existsSync(destFile));

      const manifest = JSON.parse(
        readFileSync(join(targetDir, ".ctxr-manifest.json"), "utf8"),
      );
      assert.ok(!manifest["agent-file-minimal"]);
    });
  });

  describe("remove by source package spec", () => {
    it("matches by manifest source field", () => {
      const targetDir = join(projectDir, ".claude", "skills");
      const srcPath = join(FIXTURES, "skill", "valid");
      cli("install", [srcPath, "--dir", targetDir], env);

      const r = cli("remove", [srcPath, projectDir, "--force"], env);
      assert.equal(r.exitCode, 0);
      assert.ok(!existsSync(join(targetDir, "valid-skill")));
    });
  });

  describe("team cascade", () => {
    it("removes every member by default", () => {
      const teamDir = join(scratch, "team-cascade");
      makeTeam(teamDir, "team-cascade", [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-minimal"),
      ]);
      cli("install", [teamDir, projectDir], env);
      assert.ok(
        existsSync(join(projectDir, ".claude", "skills", "valid-skill")),
      );
      assert.ok(
        existsSync(join(projectDir, ".claude", "agents", "ctxr-agent-minimal.md")),
      );

      const r = cli("remove", ["team-cascade", projectDir, "--force"], env);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("removed member 'valid-skill'"));
      assert.ok(r.stdout.includes("removed member 'agent-file-minimal'"));
      assert.ok(r.stdout.includes("removed 'team-cascade'"));

      assert.ok(
        !existsSync(join(projectDir, ".claude", "skills", "valid-skill")),
      );
      assert.ok(
        !existsSync(join(projectDir, ".claude", "agents", "ctxr-agent-minimal.md")),
      );

      // Team manifest entry dropped
      const teamManifest = JSON.parse(
        readFileSync(
          join(projectDir, ".claude", "teams", ".ctxr-manifest.json"),
          "utf8",
        ),
      );
      assert.ok(!teamManifest["team-cascade"]);
    });

    it("--keep-members preserves members on team removal", () => {
      const teamDir = join(scratch, "team-keep");
      makeTeam(teamDir, "team-keep", [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-minimal"),
      ]);
      cli("install", [teamDir, projectDir], env);

      const r = cli(
        "remove",
        ["team-keep", projectDir, "--force", "--keep-members"],
        env,
      );
      assert.equal(r.exitCode, 0);

      // Members still on disk
      assert.ok(
        existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
      );
      assert.ok(
        existsSync(join(projectDir, ".claude", "agents", "ctxr-agent-minimal.md")),
      );

      // But the team manifest row is gone
      const teamManifest = JSON.parse(
        readFileSync(
          join(projectDir, ".claude", "teams", ".ctxr-manifest.json"),
          "utf8",
        ),
      );
      assert.ok(!teamManifest["team-keep"]);
    });
  });

  describe("--all --force across multiple locations", () => {
    it("removes a shared artifact from every dir where it lives", () => {
      // Install the same skill into both .claude/skills/ and .agents/skills/
      // so `findArtifactAcrossTypes` returns two matches for one name.
      const dir1 = join(projectDir, ".claude", "skills");
      const dir2 = join(projectDir, ".agents", "skills");
      cli("install", [join(FIXTURES, "skill", "valid"), "--dir", dir1], env);
      cli("install", [join(FIXTURES, "skill", "valid"), "--dir", dir2], env);

      assert.ok(existsSync(join(dir1, "valid-skill", "SKILL.md")));
      assert.ok(existsSync(join(dir2, "valid-skill", "SKILL.md")));

      const r = cli(
        "remove",
        ["valid-skill", projectDir, "--all", "--force"],
        env,
      );
      assert.equal(r.exitCode, 0, r.stderr);

      assert.ok(!existsSync(join(dir1, "valid-skill")));
      assert.ok(!existsSync(join(dir2, "valid-skill")));

      // Both manifest entries dropped
      const m1 = JSON.parse(
        readFileSync(join(dir1, ".ctxr-manifest.json"), "utf8"),
      );
      const m2 = JSON.parse(
        readFileSync(join(dir2, ".ctxr-manifest.json"), "utf8"),
      );
      assert.ok(!m1["valid-skill"]);
      assert.ok(!m2["valid-skill"]);
    });

    it("errors in non-TTY with multiple matches and no --all", () => {
      const dir1 = join(projectDir, ".claude", "skills");
      const dir2 = join(projectDir, ".agents", "skills");
      cli("install", [join(FIXTURES, "skill", "valid"), "--dir", dir1], env);
      cli("install", [join(FIXTURES, "skill", "valid"), "--dir", dir2], env);

      const r = cli("remove", ["valid-skill", projectDir, "--force"], env);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("--all") || r.stderr.includes("TTY"));
    });
  });

  describe("non-TTY without --force", () => {
    it("errors asking for --force", () => {
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", join(projectDir, ".claude", "skills")],
        env,
      );
      const r = cli("remove", ["valid-skill", projectDir], env);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("--force") || r.stderr.includes("TTY"));
    });
  });

  describe("uninstall alias", () => {
    it("works as alias for remove", () => {
      const targetDir = join(projectDir, ".claude", "skills");
      cli("install", [join(FIXTURES, "skill", "valid"), "--dir", targetDir], env);
      const r = cli(
        "uninstall",
        ["valid-skill", projectDir, "--force"],
        env,
      );
      assert.equal(r.exitCode, 0);
      assert.ok(!existsSync(join(targetDir, "valid-skill")));
    });
  });
});
