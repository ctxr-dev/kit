/**
 * install-mixed.test.js
 *
 * Verifies the flagship plan-§7 use case: one command installs a mix of
 * types with different targets.
 *
 *   kit install @ctxr/skill-a @ctxr/agent-b @ctxr/rule-c
 *
 * In this test we use local fixtures rather than real npm packages to keep
 * the suite offline.
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

function cli(args, env) {
  const r = spawnSync("node", [CLI, "install", ...args], {
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

describe("kit install — mixed types in one command", () => {
  let projectDir;
  let fakeHome;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-mixed-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-mixed-home-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("installs skill + agent + rule + command in one invocation (default dirs)", () => {
    // No --dir → each type lands in its own default .claude/<typeDir>/.
    const r = cli(
      [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-minimal"),
        join(FIXTURES, "rule", "file-valid"),
        join(FIXTURES, "command", "file-valid"),
        projectDir,
      ],
      env,
    );
    assert.equal(r.exitCode, 0, r.combined);

    // Each type in its own directory
    assert.ok(
      existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(projectDir, ".claude", "agents", "ctxr-agent-minimal.md")),
    );
    assert.ok(
      existsSync(join(projectDir, ".claude", "rules", "ctxr-rule-valid.md")),
    );
    assert.ok(
      existsSync(join(projectDir, ".claude", "commands", "ctxr-command-valid.md")),
    );

    // Each type dir has its own manifest with the correct entry
    const skillManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".claude", "skills", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    const agentManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".claude", "agents", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    const ruleManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".claude", "rules", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    const commandManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".claude", "commands", ".ctxr-manifest.json"),
        "utf8",
      ),
    );

    assert.equal(skillManifest["valid-skill"].type, "skill");
    assert.equal(skillManifest["valid-skill"].target, "folder");
    assert.equal(agentManifest["agent-file-minimal"].type, "agent");
    assert.equal(agentManifest["agent-file-minimal"].target, "file");
    assert.equal(ruleManifest["rule-file-valid"].type, "rule");
    assert.equal(ruleManifest["rule-file-valid"].target, "file");
    assert.equal(commandManifest["command-file-valid"].type, "command");
    assert.equal(commandManifest["command-file-valid"].target, "file");
  });

  it("reports Summary with every installed type when all succeed", () => {
    const r = cli(
      [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-minimal"),
        join(FIXTURES, "command", "file-valid"),
        projectDir,
      ],
      env,
    );
    assert.equal(r.exitCode, 0, r.combined);
    assert.ok(r.combined.match(/Summary: 3 installed, 0 failed/));
  });

  it("mixed install to --user scope routes each type to its own ~/.claude/<type>/", () => {
    const r = cli(
      [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-minimal"),
        join(FIXTURES, "rule", "file-valid"),
        "--user",
      ],
      env,
    );
    assert.equal(r.exitCode, 0, r.combined);

    assert.ok(
      existsSync(join(fakeHome, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(fakeHome, ".claude", "agents", "ctxr-agent-minimal.md")),
    );
    assert.ok(
      existsSync(join(fakeHome, ".claude", "rules", "ctxr-rule-valid.md")),
    );
  });
});
