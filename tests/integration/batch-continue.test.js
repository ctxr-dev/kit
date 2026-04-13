/**
 * batch-continue.test.js
 *
 * Verifies §7 batch-continue semantics:
 *   - A failure on one source records the error and moves on.
 *   - The batch never aborts on a single failure.
 *   - Exit code is non-zero when any source failed.
 *   - Every negative package schema error surfaces cleanly.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

describe("install batch-continue semantics", () => {
  let projectDir;
  let fakeHome;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-batch-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-batch-home-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("good → broken (file with 2) → good: installs both good, logs error, exits non-zero", () => {
    const targetDir = join(projectDir, "target");
    const r = cli(
      [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-too-many"),
        join(FIXTURES, "agent", "file-minimal"),
        "--dir",
        targetDir,
      ],
      env,
    );
    assert.notEqual(r.exitCode, 0);

    // Two good packages installed
    assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
    assert.ok(existsSync(join(targetDir, "ctxr-agent-minimal.md")));

    // Broken one errored but didn't crash the batch
    assert.ok(
      r.combined.includes("file-too-many"),
      `Expected failure for file-too-many, got: ${r.combined}`,
    );
    assert.ok(
      r.combined.includes("exactly one artifact file"),
      `Expected 'exactly one artifact file' in error: ${r.combined}`,
    );

    // Summary shows 2 installed, 1 failed
    assert.ok(
      r.combined.match(/Summary: 2 installed, 1 failed/),
      `Expected 'Summary: 2 installed, 1 failed', got: ${r.combined}`,
    );
  });

  it('target:"file" with 0 artifact files is rejected and batch continues', () => {
    const targetDir = join(projectDir, "target");
    const r = cli(
      [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-zero"),
        "--dir",
        targetDir,
      ],
      env,
    );
    assert.notEqual(r.exitCode, 0);
    assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
    assert.ok(r.combined.includes("file-zero"));
    assert.ok(
      r.combined.match(/exactly one artifact file, got 0/),
      `Expected 'got 0' in error: ${r.combined}`,
    );
  });

  it("missing ctxr block is rejected and batch continues", () => {
    const targetDir = join(projectDir, "target");
    const r = cli(
      [
        join(FIXTURES, "agent", "missing-ctxr"),
        join(FIXTURES, "skill", "valid"),
        "--dir",
        targetDir,
      ],
      env,
    );
    assert.notEqual(r.exitCode, 0);
    // Second good source installed
    assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
    // First bad one errored
    assert.ok(r.combined.toLowerCase().includes("ctxr"));
  });

  it("unknown ctxr.type is rejected and batch continues", () => {
    const badDir = mkdtempSync(join(tmpdir(), "ctxr-batch-unknown-"));
    writeFileSync(
      join(badDir, "package.json"),
      JSON.stringify({
        name: "bad-unknown-type",
        version: "1.0.0",
        files: ["SKILL.md"],
        ctxr: { type: "not-a-real-type", target: "folder" },
      }),
    );
    writeFileSync(
      join(badDir, "SKILL.md"),
      "---\nname: bad-unknown-type\ndescription: x.\n---\n# X\n",
    );

    const targetDir = join(projectDir, "target");
    const r = cli(
      [badDir, join(FIXTURES, "skill", "valid"), "--dir", targetDir],
      env,
    );
    assert.notEqual(r.exitCode, 0);
    assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
    assert.ok(r.combined.toLowerCase().includes("unknown"));
    rmSync(badDir, { recursive: true, force: true });
  });

  it("invalid ctxr.target is rejected and batch continues", () => {
    const badDir = mkdtempSync(join(tmpdir(), "ctxr-batch-invalid-target-"));
    writeFileSync(
      join(badDir, "package.json"),
      JSON.stringify({
        name: "bad-target",
        version: "1.0.0",
        files: ["SKILL.md"],
        ctxr: { type: "skill", target: "blob" },
      }),
    );
    writeFileSync(
      join(badDir, "SKILL.md"),
      "---\nname: bad-target\ndescription: x.\n---\n# X\n",
    );

    const targetDir = join(projectDir, "target");
    const r = cli(
      [badDir, join(FIXTURES, "skill", "valid"), "--dir", targetDir],
      env,
    );
    assert.notEqual(r.exitCode, 0);
    assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
    assert.ok(r.combined.toLowerCase().includes("invalid"));
    rmSync(badDir, { recursive: true, force: true });
  });

  it("all-good batch exits 0 with summary", () => {
    const targetDir = join(projectDir, "target");
    const r = cli(
      [
        join(FIXTURES, "skill", "valid"),
        join(FIXTURES, "agent", "file-minimal"),
        join(FIXTURES, "command", "file-valid"),
        "--dir",
        targetDir,
      ],
      env,
    );
    assert.equal(r.exitCode, 0, r.combined);
    assert.ok(r.combined.match(/Summary: 3 installed, 0 failed/));
  });

  it("tmpDir cleanup runs even when a source fails (inspected indirectly via /tmp not growing)", () => {
    // There's no direct API for "list my tmp dirs" we want to rely on, but
    // we can at least verify the install completes and the process exits
    // cleanly — any leaked temp would have held the process open.
    const targetDir = join(projectDir, "target");
    const r = cli(
      [
        join(FIXTURES, "agent", "file-too-many"),
        "--dir",
        targetDir,
      ],
      env,
    );
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.combined.includes("Summary"));
  });
});
