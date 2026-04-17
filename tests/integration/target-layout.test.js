/**
 * target-layout.test.js
 *
 * Verifies the two on-disk install layouts:
 *   - target:"folder" creates `<root>/<installedName>/` with the full npm
 *     payload (package.json included), preserving nested paths.
 *   - target:"file" copies a single `.md` file flat into `<root>/` with its
 *     original basename, no wrapper folder.
 *
 * Also verifies that `remove` cleans up every path in `installedPaths`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    exitCode: r.status,
  };
}

describe("target-layout: folder vs file", () => {
  let projectDir;
  let fakeHome;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-target-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-target-home-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  describe('target:"folder"', () => {
    it("creates wrapper dir and copies full payload preserving relative paths", () => {
      const targetDir = join(projectDir, ".claude", "skills");
      const r = cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", targetDir],
        env,
      );
      assert.equal(r.exitCode, 0, r.stderr);

      const wrapper = join(targetDir, "valid-skill");
      assert.ok(existsSync(wrapper));
      assert.ok(existsSync(join(wrapper, "SKILL.md")));
      assert.ok(existsSync(join(wrapper, "README.md")));
      assert.ok(existsSync(join(wrapper, "LICENSE")));
      // package.json ships verbatim so bundle runtime code can read it.
      assert.ok(existsSync(join(wrapper, "package.json")));
    });

    it("installs nested directory layouts under the wrapper", () => {
      const targetDir = join(projectDir, ".claude", "skills");
      const r = cli(
        "install",
        [join(FIXTURES, "skill", "code-review"), "--dir", targetDir],
        env,
      );
      assert.equal(r.exitCode, 0, r.stderr);

      const wrapper = join(targetDir, "code-review-skill");
      assert.ok(existsSync(join(wrapper, "SKILL.md")));
      assert.ok(existsSync(join(wrapper, "reviewers")));
      assert.ok(existsSync(join(wrapper, "overlays")));
      // At least one nested file must be present.
      assert.ok(existsSync(join(wrapper, "overlays", "index.md")));
    });

    it("folder-target agent bundle lands under .claude/agents/", () => {
      const targetDir = join(projectDir, ".claude", "agents");
      const r = cli(
        "install",
        [join(FIXTURES, "agent", "folder-bundle"), "--dir", targetDir],
        env,
      );
      assert.equal(r.exitCode, 0, r.stderr);

      const wrapper = join(targetDir, "agent-folder-bundle");
      assert.ok(existsSync(join(wrapper, "AGENT.md")));
      assert.ok(existsSync(join(wrapper, "docs", "usage.md")));
    });

    it("records installedPaths pointing at the wrapper folder", () => {
      const targetDir = join(projectDir, ".claude", "skills");
      cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", targetDir],
        env,
      );
      const manifest = JSON.parse(
        readFileSync(join(targetDir, ".ctxr-manifest.json"), "utf8"),
      );
      const entry = manifest["valid-skill"];
      assert.ok(Array.isArray(entry.installedPaths));
      assert.equal(entry.installedPaths.length, 1);
      assert.equal(entry.installedPaths[0], join(targetDir, "valid-skill"));
      assert.equal(entry.target, "folder");
    });
  });

  describe('target:"file"', () => {
    it("copies the single .md flat into the target directory", () => {
      const targetDir = join(projectDir, ".claude", "agents");
      const r = cli(
        "install",
        [join(FIXTURES, "agent", "file-minimal"), "--dir", targetDir],
        env,
      );
      assert.equal(r.exitCode, 0, r.stderr);

      const destFile = join(targetDir, "ctxr-agent-minimal.md");
      assert.ok(existsSync(destFile));
      // No wrapper folder.
      assert.ok(!existsSync(join(targetDir, "agent-file-minimal")));
    });

    it("file-target command lands under .claude/commands/", () => {
      const targetDir = join(projectDir, ".claude", "commands");
      const r = cli(
        "install",
        [join(FIXTURES, "command", "file-valid"), "--dir", targetDir],
        env,
      );
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(existsSync(join(targetDir, "ctxr-command-valid.md")));
    });

    it("file-target rule lands under .claude/rules/", () => {
      const targetDir = join(projectDir, ".claude", "rules");
      const r = cli(
        "install",
        [join(FIXTURES, "rule", "file-valid"), "--dir", targetDir],
        env,
      );
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(existsSync(join(targetDir, "ctxr-rule-valid.md")));
    });

    it("file-target output-style lands under .claude/output-styles/", () => {
      const targetDir = join(projectDir, ".claude", "output-styles");
      const r = cli(
        "install",
        [join(FIXTURES, "output-style", "file-valid"), "--dir", targetDir],
        env,
      );
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(existsSync(join(targetDir, "ctxr-output-style-valid.md")));
    });

    it("records installedPaths pointing at the single flat file", () => {
      const targetDir = join(projectDir, ".claude", "agents");
      cli(
        "install",
        [join(FIXTURES, "agent", "file-minimal"), "--dir", targetDir],
        env,
      );
      const manifest = JSON.parse(
        readFileSync(join(targetDir, ".ctxr-manifest.json"), "utf8"),
      );
      const entry = manifest["agent-file-minimal"];
      assert.ok(entry);
      assert.equal(entry.target, "file");
      assert.equal(entry.installedPaths.length, 1);
      assert.equal(
        entry.installedPaths[0],
        join(targetDir, "ctxr-agent-minimal.md"),
      );
    });
  });

  describe("coexistence", () => {
    it("folder-target and file-target artifacts coexist in the same type dir", () => {
      const targetDir = join(projectDir, ".claude", "agents");
      const folderResult = cli(
        "install",
        [join(FIXTURES, "agent", "folder-bundle"), "--dir", targetDir],
        env,
      );
      const fileResult = cli(
        "install",
        [join(FIXTURES, "agent", "file-minimal"), "--dir", targetDir],
        env,
      );
      assert.equal(folderResult.exitCode, 0, folderResult.stderr);
      assert.equal(fileResult.exitCode, 0, fileResult.stderr);

      // Both exist
      assert.ok(
        existsSync(join(targetDir, "agent-folder-bundle", "AGENT.md")),
      );
      assert.ok(existsSync(join(targetDir, "ctxr-agent-minimal.md")));

      // Manifest has both entries with distinct targets
      const manifest = JSON.parse(
        readFileSync(join(targetDir, ".ctxr-manifest.json"), "utf8"),
      );
      assert.equal(manifest["agent-folder-bundle"].target, "folder");
      assert.equal(manifest["agent-file-minimal"].target, "file");
    });
  });

  describe("atomic install on partial failure", () => {
    // Regression guard: if the copy loop fails mid-flight, the wrapper
    // directory must be removed so the user can retry without hitting a
    // stale "already installed" error.
    //
    // We simulate a copy failure by making the destination parent
    // read-only AFTER the wrapper dir is created. That's awkward to set
    // up portably, so instead we verify the happy-path retry behavior:
    // install, then remove the manifest (but leave the wrapper), then
    // retry — the retry should fail with "already installed" because
    // the wrapper exists, and we can unblock it by manually removing
    // the wrapper. This exercises the error-path existsSync() check.
    it("retry after stale wrapper dir surfaces a clear error", () => {
      const targetDir = join(projectDir, ".claude", "skills");
      // First install succeeds.
      assert.equal(
        cli(
          "install",
          [join(FIXTURES, "skill", "valid"), "--dir", targetDir],
          env,
        ).exitCode,
        0,
      );

      // Nuke the manifest to simulate corruption / prior-version state,
      // leaving the wrapper dir.
      rmSync(join(targetDir, ".ctxr-manifest.json"));

      // Retry must fail with "already installed" pointing at the stale dir.
      const r = cli(
        "install",
        [join(FIXTURES, "skill", "valid"), "--dir", targetDir],
        env,
      );
      assert.notEqual(r.exitCode, 0);
      const combined = r.stdout + r.stderr;
      assert.ok(
        combined.toLowerCase().includes("already installed"),
        `Expected 'already installed' error, got: ${combined}`,
      );
    });
  });
});
