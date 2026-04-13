/**
 * update-interactive.test.js
 *
 * Pins update's new pre-flight check + `--install` delegation behavior.
 * Each test spawns kit via `spawnSync` and uses `--yes` to suppress all
 * prompts — update itself doesn't have any interactive prompts beyond
 * what it forwards to install, so integration-level coverage is enough
 * here; no dependency injection is necessary.
 *
 * Scenarios covered:
 *   - all identifiers installed → normal update proceeds
 *   - some missing, no --install → print missing list, exit 2, touch nothing
 *   - some missing, --install → delegate to install, then update the rest
 *   - flag propagation: --yes forwarded to the delegated install
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

function cli(command, args, env) {
  const r = spawnSync("node", [CLI, command, ...args], {
    encoding: "utf8",
    env: env ?? process.env,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
}

describe("update-interactive — pre-flight check", () => {
  let projectDir;
  let fakeHome;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-uinst-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-uinst-home-"));
    env = { ...process.env, HOME: fakeHome };
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("updates cleanly when every identifier is installed", () => {
    const targetDir = join(projectDir, ".claude", "skills");
    cli("install", [join(FIXTURES, "skill", "valid"), "--dir", targetDir, "--yes"], env);
    const r = cli("update", ["valid-skill", projectDir, "--yes"], env);
    assert.equal(r.exitCode, 0, r.combined);
    assert.ok(r.stdout.includes("updated"));
  });

  it("missing identifier without --install: prints missing list, exits 2, touches nothing", () => {
    // Seed a real skill so we can verify it wasn't touched.
    const targetDir = join(projectDir, ".claude", "skills");
    cli("install", [join(FIXTURES, "skill", "valid"), "--dir", targetDir, "--yes"], env);

    // Read the manifest entry so we can compare before/after.
    const manifestPath = join(targetDir, ".ctxr-manifest.json");
    const before = readFileSync(manifestPath, "utf8");

    const r = cli("update", ["totally-nonexistent-skill", projectDir, "--yes"], env);
    assert.equal(r.exitCode, 2);
    assert.ok(r.stderr.includes("totally-nonexistent-skill"));
    assert.ok(r.stderr.includes("--install"));

    // Manifest is UNCHANGED — update refused to touch any entry when
    // the pre-flight failed.
    const after = readFileSync(manifestPath, "utf8");
    assert.equal(before, after);
  });

  it("missing identifier with --install: delegates to install, then runs update", () => {
    // Pre-flight routes the missing local-path source to install via the
    // delegation step. Use a local-path source so there's no network.
    const targetDir = join(projectDir, ".claude", "skills");
    const src = join(FIXTURES, "skill", "valid");
    const r = cli(
      "update",
      [src, projectDir, "--install", "--yes", "--dir", targetDir],
      env,
    );
    // The artifact wasn't installed before, so `update --install` becomes
    // a net install. Exit 0 is fine — the request "make sure this is up
    // to date" is satisfied.
    assert.equal(r.exitCode, 0, r.combined);
    assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
  });

  it("--yes is forwarded to the delegated install (silent success + manifest entry)", () => {
    // Flag-propagation check. update --install --yes calls the install
    // command with --yes, which triggers isNonInteractive → no prompts →
    // silent success. We assert on three positive signals rather than
    // on the absence of clack-internal UI characters (which would rot
    // if clack ever changes its glyphs):
    //
    //   1. exit code is 0
    //   2. the wrapper dir + SKILL.md actually land on disk
    //   3. the manifest entry exists for the installed name
    //   4. stdout contains a success marker ("installed")
    const targetDir = join(projectDir, ".claude", "skills");
    const src = join(FIXTURES, "skill", "valid");
    const r = cli(
      "update",
      [src, projectDir, "--install", "--yes", "--dir", targetDir],
      env,
    );
    assert.equal(r.exitCode, 0, r.combined);

    // Positive signal 1: wrapper + SKILL.md landed
    assert.ok(
      existsSync(join(targetDir, "valid-skill", "SKILL.md")),
      "install should have landed a valid-skill wrapper",
    );

    // Positive signal 2: manifest has the entry
    const manifestPath = join(targetDir, ".ctxr-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(
      manifest["valid-skill"],
      "manifest should contain valid-skill entry",
    );

    // Positive signal 3: success marker on stdout
    assert.ok(
      r.stdout.includes("installed"),
      `Expected success line in stdout, got: ${r.combined}`,
    );
  });
});
