/**
 * bundle.test.js
 *
 * Verifies the bundle installer (renamed from `team` in @ctxr/kit 2.0.0):
 *   - cascade: installs every member in ctxr.includes (non-interactive default)
 *   - batch-continue: a broken member records an error but siblings still install
 *   - cycle detection: bundle A -> bundle B -> bundle A fails cleanly
 *   - bundle manifest entry records successfully-installed members
 *   - legacy `type: "team"` is rejected with a pointing migration error
 *
 * Bundle fixtures are built dynamically because ctxr.includes needs absolute
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
 * Build a bundle package at `dir` that includes the given member specs.
 */
function makeBundle(dir, name, includes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      files: ["README.md"],
      ctxr: {
        type: "bundle",
        includes,
      },
    }),
  );
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
}

describe("kit install: bundle cascade", () => {
  let projectDir;
  let fakeHome;
  let env;
  let scratch;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-bundle-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-bundle-home-"));
    scratch = mkdtempSync(join(tmpdir(), "ctxr-bundle-scratch-"));
    env = { ...process.env, HOME: fakeHome };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("installs every member of a valid bundle non-interactively", () => {
    const bundleDir = join(scratch, "bundle-valid");
    makeBundle(bundleDir, "bundle-valid", [
      join(FIXTURES, "skill", "valid"),
      join(FIXTURES, "agent", "file-minimal"),
      join(FIXTURES, "rule", "file-valid"),
    ]);

    const r = cli([bundleDir, projectDir], env);
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

    // Bundle manifest recorded the members
    const bundleManifestPath = join(
      projectDir,
      ".agents",
      "bundles",
      ".ctxr-manifest.json",
    );
    assert.ok(existsSync(bundleManifestPath));
    const bundleManifest = JSON.parse(readFileSync(bundleManifestPath, "utf8"));
    assert.ok(bundleManifest["bundle-valid"]);
    assert.equal(bundleManifest["bundle-valid"].type, "bundle");
    assert.deepEqual(bundleManifest["bundle-valid"].members.sort(), [
      "agent-file-minimal",
      "rule-file-valid",
      "valid-skill",
    ]);
  });

  it("bundle with a broken member installs the rest and records the failure", () => {
    const bundleDir = join(scratch, "bundle-with-broken");
    makeBundle(bundleDir, "bundle-with-broken", [
      join(FIXTURES, "skill", "valid"),
      join(FIXTURES, "agent", "file-too-many"), // broken
      join(FIXTURES, "agent", "file-minimal"),
    ]);

    const r = cli([bundleDir, projectDir], env);
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

    // Bundle manifest records only the successfully installed members
    const bundleManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".agents", "bundles", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(bundleManifest["bundle-with-broken"].members.sort(), [
      "agent-file-minimal",
      "valid-skill",
    ]);
  });

  it("cyclic bundle (A -> B -> A) is rejected cleanly with a bundle-named message", () => {
    const bundleADir = join(scratch, "bundle-a");
    const bundleBDir = join(scratch, "bundle-b");

    // A includes B; B includes A: pure cycle with no artifacts.
    makeBundle(bundleADir, "bundle-a", [bundleBDir]);
    makeBundle(bundleBDir, "bundle-b", [bundleADir]);

    const r = cli([bundleADir, projectDir], env);
    // A cycle must surface as an error somewhere in the batch.
    assert.ok(
      r.combined.toLowerCase().includes("cyclic") ||
        r.combined.toLowerCase().includes("cycle"),
      `Expected cycle error, got: ${r.combined}`,
    );
    // The cycle-detection message must reference "bundle" (the new name),
    // not "team": this pins the rename through the user-facing error path.
    assert.ok(
      r.combined.toLowerCase().includes("bundle"),
      `Cycle error must reference "bundle", got: ${r.combined}`,
    );
  });

  it("nested bundle cascades transitively with flattened outer members", () => {
    // inner: skill + agent
    const innerDir = join(scratch, "bundle-inner");
    makeBundle(innerDir, "bundle-inner", [
      join(FIXTURES, "skill", "valid"),
      join(FIXTURES, "agent", "file-minimal"),
    ]);
    // outer: inner + rule
    const outerDir = join(scratch, "bundle-outer");
    makeBundle(outerDir, "bundle-outer", [innerDir, join(FIXTURES, "rule", "file-valid")]);

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

    const bundleManifest = JSON.parse(
      readFileSync(
        join(projectDir, ".agents", "bundles", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    // Both inner and outer bundles are recorded.
    assert.ok(bundleManifest["bundle-inner"]);
    assert.ok(bundleManifest["bundle-outer"]);

    // Inner bundle records its two direct leaves.
    assert.deepEqual(bundleManifest["bundle-inner"].members.sort(), [
      "agent-file-minimal",
      "valid-skill",
    ]);

    // Outer bundle flattens nested-bundle members into its leaf list:
    // remove cascades walk the leaves directly without needing to traverse
    // a tree of nested bundle entries.
    assert.deepEqual(bundleManifest["bundle-outer"].members.sort(), [
      "agent-file-minimal",
      "rule-file-valid",
      "valid-skill",
    ]);
  });

  it('duplicate top-level bundle install does not false-positive "cyclic"', () => {
    // Regression guard: a naive global `visited` set would flag the second
    // occurrence of the same top-level bundle as a cycle. The dispatcher
    // scopes `visited` per-root-recursion so the duplicate is a no-op
    // redundant re-install (cascade members hit their existing-install
    // detection and update in place). Exit code is 0 because every
    // target ends up in the desired state; the critical assertion is
    // that "cyclic" does NOT appear in the output.
    const bundleDir = join(scratch, "bundle-dup-top");
    makeBundle(bundleDir, "bundle-dup-top", [join(FIXTURES, "skill", "valid")]);

    const r = cli([bundleDir, bundleDir, projectDir], env);
    const combined = r.combined.toLowerCase();
    assert.ok(
      !combined.includes("cyclic"),
      `Duplicate top-level bundle should NOT report as cyclic, got: ${r.combined}`,
    );
  });

  it("bundle with empty or missing ctxr.includes is rejected", () => {
    const emptyBundleDir = join(scratch, "bundle-empty");
    makeBundle(emptyBundleDir, "bundle-empty", []);

    const r = cli([emptyBundleDir, projectDir], env);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.combined.toLowerCase().includes("includes"));
  });

  it("bundle install via --user routes members to user-scope type dirs", () => {
    const bundleDir = join(scratch, "bundle-user");
    makeBundle(bundleDir, "bundle-user", [
      join(FIXTURES, "skill", "valid"),
      join(FIXTURES, "agent", "file-minimal"),
    ]);

    const r = cli([bundleDir, "--user"], env);
    assert.equal(r.exitCode, 0, r.combined);

    assert.ok(
      existsSync(join(fakeHome, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(fakeHome, ".claude", "agents", "ctxr-agent-minimal.md")),
    );

    // User-scope bundle manifest
    const bundleManifest = JSON.parse(
      readFileSync(
        join(fakeHome, ".agents", "bundles", ".ctxr-manifest.json"),
        "utf8",
      ),
    );
    assert.ok(bundleManifest["bundle-user"]);
  });

  describe("legacy `team` rejection (BREAKING in 2.0.0)", () => {
    it('rejects ctxr.type: "team" with a pointing migration error', () => {
      const legacyDir = join(scratch, "legacy-team-type");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, "package.json"),
        JSON.stringify({
          name: "legacy-team-type",
          version: "1.0.0",
          files: ["README.md"],
          ctxr: { type: "team", includes: [join(FIXTURES, "skill", "valid")] },
        }),
      );
      writeFileSync(join(legacyDir, "README.md"), "# legacy\n");

      const r = cli([legacyDir, projectDir], env);
      assert.notEqual(r.exitCode, 0);
      // The error string must name `bundle` as the replacement so a user
      // upgrading from the pre-release `team` knows exactly what to do.
      assert.ok(
        r.combined.includes("bundle"),
        `Expected migration error referencing "bundle", got: ${r.combined}`,
      );
      assert.ok(
        r.combined.includes("team"),
        `Expected migration error mentioning the retired "team" keyword, got: ${r.combined}`,
      );
    });

    it('rejects ctxr.target: "team" with a pointing migration error', () => {
      const legacyDir = join(scratch, "legacy-team-target");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, "package.json"),
        JSON.stringify({
          name: "legacy-team-target",
          version: "1.0.0",
          files: ["README.md"],
          ctxr: { type: "skill", target: "team" },
        }),
      );
      writeFileSync(join(legacyDir, "README.md"), "# legacy\n");

      const r = cli([legacyDir, projectDir], env);
      assert.notEqual(r.exitCode, 0);
      assert.ok(
        r.combined.includes("bundle"),
        `Expected migration error referencing "bundle", got: ${r.combined}`,
      );
    });
  });
});
