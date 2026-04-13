/**
 * schema-validation.test.js
 *
 * Negative ctxr-schema coverage for the `kit validate` dispatcher. These
 * scenarios all target the generic check layer (package.json → resolveType
 * → payload rules) rather than per-type content validation.
 *
 * Every case constructs a minimal on-disk package that violates one schema
 * rule and asserts `kit validate` fails with a pointing error message.
 *
 * Scenarios:
 *   - Missing `ctxr` block
 *   - Non-object / array `ctxr` block
 *   - Missing `ctxr.type`
 *   - Unknown `ctxr.type`
 *   - Missing `ctxr.target` on non-team
 *   - Invalid `ctxr.target` on non-team
 *   - `target:"file"` with zero artifact files (README only)
 *   - `target:"file"` with two artifact files
 *   - `target:"file"` with a single non-`.md` file
 *   - Team missing `ctxr.includes`
 *   - Team with empty `ctxr.includes`
 *   - Team with non-string `ctxr.includes` entry
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");

function cli(args) {
  const r = spawnSync("node", [CLI, "validate", ...args], { encoding: "utf8" });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
}

/**
 * Build a tmp package directory with an arbitrary package.json shape plus
 * a set of sibling files (so npm pack can resolve its payload).
 */
function makePackage({ pkgJson, files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "ctxr-test-schema-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("schema validation (ctxr block)", () => {
  let scratch;

  beforeEach(() => {
    scratch = [];
  });

  afterEach(() => {
    for (const dir of scratch) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function track(dir) {
    scratch.push(dir);
    return dir;
  }

  describe("missing or malformed ctxr block", () => {
    it("fails on missing ctxr block", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "no-ctxr",
            version: "1.0.0",
            files: ["x.md"],
          },
          files: { "x.md": "# x\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("Missing \"ctxr\" block"));
    });

    it("fails when ctxr is an array (not an object)", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "ctxr-array",
            version: "1.0.0",
            files: ["x.md"],
            ctxr: ["skill"],
          },
          files: { "x.md": "# x\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("Missing \"ctxr\" block"));
    });

    it("fails when ctxr.type is missing", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "no-type",
            version: "1.0.0",
            files: ["x.md"],
            ctxr: { target: "file" },
          },
          files: { "x.md": "# x\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("ctxr.type"));
    });

    it("fails when ctxr.type is unknown", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "unknown-type",
            version: "1.0.0",
            files: ["x.md"],
            ctxr: { type: "prompt", target: "file" },
          },
          files: { "x.md": "# x\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("Unknown \"ctxr.type\""));
    });
  });

  describe("ctxr.target rules for non-team types", () => {
    it("fails when ctxr.target is missing on non-team", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "no-target",
            version: "1.0.0",
            files: ["x.md"],
            ctxr: { type: "agent" },
          },
          files: { "x.md": "# x\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("Missing \"ctxr.target\""));
    });

    it("fails when ctxr.target is an unknown value", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "bad-target",
            version: "1.0.0",
            files: ["x.md"],
            ctxr: { type: "agent", target: "bundle" },
          },
          files: { "x.md": "# x\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("Invalid \"ctxr.target\""));
    });
  });

  describe("target:\"file\" payload-size invariants", () => {
    it("errors when target:file payload has zero artifact files (README-only)", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "file-zero",
            version: "1.0.0",
            files: ["README.md"],
            ctxr: { type: "agent", target: "file" },
          },
          files: { "README.md": "# readme only\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(
        r.combined.includes("target:\"file\" requires files to resolve to exactly one"),
      );
    });

    it("errors when target:file payload has two artifact files", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "file-too-many",
            version: "1.0.0",
            files: ["a.md", "b.md"],
            ctxr: { type: "agent", target: "file" },
          },
          files: {
            "a.md": "# a\n",
            "b.md": "# b\n",
          },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(
        r.combined.includes("target:\"file\" requires files to resolve to exactly one"),
      );
      assert.ok(r.combined.includes("got 2"));
    });

    it("errors when target:file single file is not .md", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "file-not-md",
            version: "1.0.0",
            files: ["rules.yaml"],
            ctxr: { type: "rule", target: "file" },
          },
          files: { "rules.yaml": "rules:\n  - foo\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.combined.includes("must be a .md file"));
    });
  });

  describe("team ctxr.includes rules", () => {
    it("fails when team is missing ctxr.includes", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "team-no-includes",
            version: "1.0.0",
            files: ["README.md"],
            ctxr: { type: "team" },
          },
          files: { "README.md": "# team\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("non-empty \"ctxr.includes\""));
    });

    it("fails when ctxr.includes is an empty array", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "team-empty-includes",
            version: "1.0.0",
            files: ["README.md"],
            ctxr: { type: "team", includes: [] },
          },
          files: { "README.md": "# team\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("non-empty \"ctxr.includes\""));
    });

    it("errors on non-string member entry (number)", () => {
      const dir = track(
        makePackage({
          pkgJson: {
            name: "team-bad-entry",
            version: "1.0.0",
            files: ["README.md"],
            ctxr: { type: "team", includes: [42] },
          },
          files: { "README.md": "# team\n" },
        }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(
        r.combined.includes("not a non-empty string") ||
          r.combined.includes("not a valid source spec"),
      );
    });
  });
});
