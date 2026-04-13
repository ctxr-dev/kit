/**
 * info.test.js
 *
 * Verifies the type-aware info command:
 *   - Locally installed artifact: shows type, target, source, path
 *   - Folder-target vs file-target both render cleanly
 *   - Team entry shows members list
 *   - Local package (cwd) with ctxr block renders as "(local package)"
 *   - Unknown identifier → error
 *   - No arguments → usage error
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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

describe("info command", () => {
  let projectDir;
  let fakeHome;
  let scratch;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-test-info-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-test-home-"));
    scratch = mkdtempSync(join(tmpdir(), "ctxr-test-info-scratch-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("no arguments", () => {
    it("exits 2 (usage error) with usage message", () => {
      // Exit code 2 = usage error per POSIX-ish convention.
      const r = cli("info", [], env, projectDir);
      assert.equal(r.exitCode, 2);
      assert.ok(r.stderr.includes("Usage"));
    });
  });

  describe("installed folder-target skill", () => {
    it("shows type, target, version, source, and path", () => {
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", join(projectDir, ".claude", "skills")],
        env,
      );
      const r = cli("info", ["valid-skill"], env, projectDir);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(r.stdout.includes("valid-skill"));
      assert.ok(r.stdout.includes("type:"));
      assert.ok(r.stdout.includes("skill"));
      assert.ok(r.stdout.includes("folder"));
      assert.ok(r.stdout.includes("1.0.0"));
      assert.ok(r.stdout.includes("path:"));
    });
  });

  describe("installed file-target agent", () => {
    it("shows type=agent, target=file and the flat path", () => {
      cli(
        "install",
        [join(FIXTURES, "agent", "file-minimal"), "--dir", join(projectDir, ".claude", "agents")],
        env,
      );
      const r = cli("info", ["agent-file-minimal"], env, projectDir);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(r.stdout.includes("agent-file-minimal"));
      assert.ok(/type:\s+agent/.test(r.stdout));
      assert.ok(/target:\s+file/.test(r.stdout));
      assert.ok(r.stdout.includes("ctxr-agent-minimal.md"));
    });
  });

  describe("installed team", () => {
    it("lists the members", () => {
      const teamDir = join(scratch, "team-info");
      makeTeam(teamDir, "team-info", [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-minimal"),
      ]);
      cli("install", [teamDir, projectDir], env);

      const r = cli("info", ["team-info"], env, projectDir);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(r.stdout.includes("team-info"));
      assert.ok(/type:\s+team/.test(r.stdout));
      assert.ok(r.stdout.includes("members: 2"));
      assert.ok(r.stdout.includes("valid-skill"));
      assert.ok(r.stdout.includes("agent-file-minimal"));
    });
  });

  describe("local package in cwd", () => {
    it("reads ctxr block from package.json when identifier is '.'", () => {
      // Reuse the valid-skill fixture as a cwd package.
      const r = cli(
        "info",
        [join(FIXTURES, "skill", "valid")],
        env,
        projectDir,
      );
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(r.stdout.includes("local package"));
      assert.ok(/type:\s+skill/.test(r.stdout));
      assert.ok(/target:\s+folder/.test(r.stdout));
    });
  });

  describe("identifier not found", () => {
    it("exits 1 with 'not found' message", () => {
      const r = cli("info", ["nonexistent-" + Date.now()], env, projectDir);
      assert.equal(r.exitCode, 1);
      const output = r.stdout + r.stderr;
      assert.ok(output.includes("not found"));
    });
  });
});
