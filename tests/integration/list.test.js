/**
 * list.test.js
 *
 * Verifies the type-aware list command:
 *   - Empty state message
 *   - Installed artifacts grouped by type with installed-name, target, and source
 *   - Multi-type install (skill + agent + rule) renders one section per type
 *   - Teams appear with their member count
 *   - User-scope dirs are displayed with ~ prefix
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const FIXTURES = join(__dirname, "..", "fixtures");

function cli(cmd, args, env) {
  const r = spawnSync("node", [CLI, cmd, ...args], {
    encoding: "utf8",
    env: env || { ...process.env },
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
}

describe("list command", () => {
  let projectDir;
  let fakeHome;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-test-list-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-test-home-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  describe("empty state", () => {
    it("prints 'No artifacts installed' when nothing is installed", () => {
      const r = cli("list", [projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.toLowerCase().includes("no artifacts"),
        `Expected empty-state message, got: ${r.stdout}`,
      );
    });

    it("prints 'No artifacts installed' when type dirs exist but are empty", () => {
      // Installing a fixture then manually deleting the manifest leaves the
      // directory on disk — the list command should not choke on that.
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", join(projectDir, ".claude", "skills")],
        env,
      );
      rmSync(join(projectDir, ".claude", "skills", ".ctxr-manifest.json"));
      const r = cli("list", [projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.toLowerCase().includes("no artifacts"),
        `Expected empty-state message, got: ${r.stdout}`,
      );
    });
  });

  describe("grouped by type", () => {
    it("lists a single installed skill under a skill section", () => {
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", join(projectDir, ".claude", "skills")],
        env,
      );
      const r = cli("list", [projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(/skill \(1\)/.test(r.stdout), `Expected skill section, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("valid-skill"));
      assert.ok(r.stdout.includes("[folder]"));
      assert.ok(/Total: 1 artifact\b/.test(r.stdout));
    });

    it("lists skill + agent + rule in three separate sections", () => {
      cli(
        "install",
        [
          join(FIXTURES, "skill", "valid"),
          join(FIXTURES, "agent", "file-minimal"),
          join(FIXTURES, "rule", "file-valid"),
          projectDir,
        ],
        env,
      );
      const r = cli("list", [projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(/skill \(1\)/.test(r.stdout));
      assert.ok(/agent \(1\)/.test(r.stdout));
      assert.ok(/rule \(1\)/.test(r.stdout));
      assert.ok(r.stdout.includes("valid-skill"));
      assert.ok(r.stdout.includes("agent-file-minimal"));
      assert.ok(r.stdout.includes("rule-file-valid"));
      assert.ok(/Total: 3 artifacts/.test(r.stdout));
    });

    it("shows source, target, and version when available", () => {
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", join(projectDir, ".claude", "skills")],
        env,
      );
      const r = cli("list", [projectDir], env);
      // Local sources are recorded with the absolute path — just check the
      // version was read from package.json and the target label rendered.
      assert.ok(r.stdout.includes("v1.0.0"));
      assert.ok(r.stdout.includes("[folder]"));
    });
  });

  describe("teams", () => {
    it("lists a team entry with its member count", () => {
      // Build a team whose members point at real fixture paths.
      const scratch = mkdtempSync(join(tmpdir(), "ctxr-test-list-team-"));
      const teamDir = join(scratch, "team-list");
      mkdirSync(teamDir, { recursive: true });
      writeFileSync(
        join(teamDir, "package.json"),
        JSON.stringify({
          name: "team-list",
          version: "1.0.0",
          files: ["README.md"],
          ctxr: {
            type: "team",
            includes: [
              join(FIXTURES, "skill", "valid"),
              join(FIXTURES, "agent", "file-minimal"),
            ],
          },
        }),
      );
      writeFileSync(join(teamDir, "README.md"), "# team-list\n");

      cli("install", [teamDir, projectDir], env);

      const r = cli("list", [projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(/team \(1\)/.test(r.stdout), `Expected team section, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("team-list"));
      assert.ok(r.stdout.includes("2 members"));
      // Members should still show up in their own sections
      assert.ok(/skill \(1\)/.test(r.stdout));
      assert.ok(/agent \(1\)/.test(r.stdout));

      rmSync(scratch, { recursive: true, force: true });
    });
  });

  describe("user scope", () => {
    it("shows ~-prefixed location for user-scope installs", () => {
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--user"],
        env,
      );
      const r = cli("list", [projectDir], env);
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("~/.claude/skills"),
        `Expected ~-prefixed user path, got: ${r.stdout}`,
      );
      assert.ok(
        existsSync(join(fakeHome, ".claude", "skills", "valid-skill", "SKILL.md")),
      );
    });
  });
});
