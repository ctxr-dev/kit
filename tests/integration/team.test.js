/**
 * team.test.js
 *
 * Verifies the team installer:
 *   - cascade: installs every member in ctxr.includes (non-interactive default)
 *   - batch-continue: a broken member records an error but siblings still install
 *   - cycle detection: team A → team B → team A fails cleanly
 *   - team manifest entry records successfully-installed members
 *
 * Team fixtures are built dynamically because ctxr.includes needs absolute
 * paths to other fixtures which only exist at test time.
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

/**
 * Build a team package at `dir` that includes the given member specs.
 */
function makeTeam(dir, name, includes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      files: ["README.md"],
      ctxr: {
        type: "team",
        includes,
      },
    }),
  );
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
}

describe("kit install — team cascade", () => {
  let projectDir;
  let fakeHome;
  let env;
  let scratch;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-team-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-team-home-"));
    scratch = mkdtempSync(join(tmpdir(), "ctxr-team-scratch-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("installs every member of a valid team non-interactively", () => {
    const teamDir = join(scratch, "team-valid");
    makeTeam(teamDir, "team-valid", [
      join(FIXTURES, "skill", "valid"),
      join(FIXTURES, "agent", "file-minimal"),
      join(FIXTURES, "rule", "file-valid"),
    ]);

    const r = cli([teamDir, projectDir], env);
    assert.equal(r.exitCode, 0, r.combined);

    // Every member landed in its own type dir
    assert.ok(
      existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(projectDir, ".claude", "agents", "ctxr-agent-minimal.md")),
    );
    assert.ok(
      existsSync(join(projectDir, ".claude", "rules", "ctxr-rule-valid.md")),
    );

    // Team manifest recorded the members
    const teamManifestPath = join(
      projectDir,
      ".claude",
      "teams",
      ".ctxr-manifest.json",
    );
    assert.ok(existsSync(teamManifestPath));
    const teamManifest = JSON.parse(readFileSync(teamManifestPath, "utf8"));
    assert.ok(teamManifest["team-valid"]);
    assert.equal(teamManifest["team-valid"].type, "team");
    assert.deepEqual(teamManifest["team-valid"].members.sort(), [
      "agent-file-minimal",
      "rule-file-valid",
      "valid-skill",
    ]);
  });

  it("team with a broken member installs the rest and records the failure", () => {
    const teamDir = join(scratch, "team-with-broken");
    makeTeam(teamDir, "team-with-broken", [
      join(FIXTURES, "skill", "valid"),
      join(FIXTURES, "agent", "file-too-many"), // broken
      join(FIXTURES, "agent", "file-minimal"),
    ]);

    const r = cli([teamDir, projectDir], env);
    assert.notEqual(r.exitCode, 0);

    // Good members installed
    assert.ok(
      existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(projectDir, ".claude", "agents", "ctxr-agent-minimal.md")),
    );

    // Broken member errored
    assert.ok(r.combined.includes("file-too-many"));

    // Team manifest records only the successfully installed members
    const teamManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".claude", "teams", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(teamManifest["team-with-broken"].members.sort(), [
      "agent-file-minimal",
      "valid-skill",
    ]);
  });

  it("cyclic team (A → B → A) is rejected cleanly", () => {
    const teamADir = join(scratch, "team-a");
    const teamBDir = join(scratch, "team-b");

    // A includes B; B includes A — pure cycle with no artifacts.
    makeTeam(teamADir, "team-a", [teamBDir]);
    makeTeam(teamBDir, "team-b", [teamADir]);

    const r = cli([teamADir, projectDir], env);
    // A cycle must surface as an error somewhere in the batch.
    assert.ok(
      r.combined.toLowerCase().includes("cyclic") ||
        r.combined.toLowerCase().includes("cycle"),
      `Expected cycle error, got: ${r.combined}`,
    );
  });

  it("nested team cascades transitively with flattened outer members", () => {
    // inner: skill + agent
    const innerDir = join(scratch, "team-inner");
    makeTeam(innerDir, "team-inner", [
      join(FIXTURES, "skill", "valid"),
      join(FIXTURES, "agent", "file-minimal"),
    ]);
    // outer: inner + rule
    const outerDir = join(scratch, "team-outer");
    makeTeam(outerDir, "team-outer", [innerDir, join(FIXTURES, "rule", "file-valid")]);

    const r = cli([outerDir, projectDir], env);
    assert.equal(r.exitCode, 0, r.combined);

    assert.ok(
      existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(projectDir, ".claude", "agents", "ctxr-agent-minimal.md")),
    );
    assert.ok(
      existsSync(join(projectDir, ".claude", "rules", "ctxr-rule-valid.md")),
    );

    const teamManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".claude", "teams", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    // Both inner and outer teams are recorded.
    assert.ok(teamManifest["team-inner"]);
    assert.ok(teamManifest["team-outer"]);

    // Inner team records its two direct leaves.
    assert.deepEqual(teamManifest["team-inner"].members.sort(), [
      "agent-file-minimal",
      "valid-skill",
    ]);

    // Outer team flattens nested-team members into its leaf list — remove
    // cascades walk the leaves directly without needing to traverse a tree
    // of nested team entries.
    assert.deepEqual(teamManifest["team-outer"].members.sort(), [
      "agent-file-minimal",
      "rule-file-valid",
      "valid-skill",
    ]);
  });

  it('duplicate top-level team install emits "already installed", not "cyclic"', () => {
    // Regression guard: a naive global `visited` set would flag the second
    // occurrence of the same top-level team as a cycle. The dispatcher
    // scopes `visited` per-root-recursion to give a meaningful error.
    const teamDir = join(scratch, "team-dup-top");
    makeTeam(teamDir, "team-dup-top", [join(FIXTURES, "skill", "valid")]);

    const r = cli([teamDir, teamDir, projectDir], env);
    assert.notEqual(r.exitCode, 0);
    const combined = r.combined.toLowerCase();
    assert.ok(
      combined.includes("already installed"),
      `Expected 'already installed' for duplicate team, got: ${r.combined}`,
    );
    assert.ok(
      !combined.includes("cyclic"),
      `Duplicate top-level team should NOT report as cyclic, got: ${r.combined}`,
    );
  });

  it("team with empty or missing ctxr.includes is rejected", () => {
    const emptyTeamDir = join(scratch, "team-empty");
    makeTeam(emptyTeamDir, "team-empty", []);

    const r = cli([emptyTeamDir, projectDir], env);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.combined.toLowerCase().includes("includes"));
  });

  it("team install via --user routes members to user-scope type dirs", () => {
    const teamDir = join(scratch, "team-user");
    makeTeam(teamDir, "team-user", [
      join(FIXTURES, "skill", "valid"),
      join(FIXTURES, "agent", "file-minimal"),
    ]);

    const r = cli([teamDir, "--user"], env);
    assert.equal(r.exitCode, 0, r.combined);

    assert.ok(
      existsSync(join(fakeHome, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(fakeHome, ".claude", "agents", "ctxr-agent-minimal.md")),
    );

    // User-scope team manifest
    const teamManifest = JSON.parse(
      readFileSync(
        join(fakeHome, ".claude", "teams", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    assert.ok(teamManifest["team-user"]);
  });
});
