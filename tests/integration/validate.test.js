/**
 * validate.test.js
 *
 * Covers:
 *   - Existing skill validation scenarios (frontmatter, cross-refs, code-review
 *     auto-detect, line count, description length) — behavior-preserving after
 *     the Phase 4 dispatcher rewrite.
 *   - Per-type validator coverage for every file-target type
 *     (agent/command/rule/output-style).
 *   - Folder-target non-skill bundle coverage (agent/folder-bundle).
 *   - Dispatcher error surfaces: path missing, package.json missing,
 *     malformed JSON.
 *
 * Schema-level negative coverage (missing ctxr block, invalid target, etc.)
 * lives in schema-validation.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const FIXTURES = join(__dirname, "..", "fixtures");

function cli(args) {
  const r = spawnSync("node", [CLI, "validate", ...args], {
    encoding: "utf8",
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
}

/**
 * Build a minimal valid package directory for a given type/target pair.
 * Returns the absolute path; caller is responsible for cleaning up.
 */
function makeTmpPackage({
  type,
  target,
  name = "tmp-pkg",
  files,
  extraWrites = [],
}) {
  const dir = mkdtempSync(join(tmpdir(), `ctxr-test-validate-${type}-`));
  const ctxr =
    type === "team"
      ? { type: "team", includes: ["@ctxr/skill-example"] }
      : { type, target };
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        description: `Tmp ${type} fixture.`,
        files,
        ctxr,
      },
      null,
      2,
    ),
  );
  for (const { path, content, mode = "file" } of extraWrites) {
    const full = join(dir, path);
    if (mode === "dir") {
      mkdirSync(full, { recursive: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  return dir;
}

describe("validate command", () => {
  describe("--help flag", () => {
    it("exits 0 and prints usage", () => {
      const r = cli(["--help"]);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stderr.includes("Usage"));
      assert.ok(r.stderr.includes("ctxr.type"));
    });
  });

  describe("generic dispatcher errors", () => {
    it("fails on non-existent path", () => {
      const r = cli(["/tmp/does-not-exist-" + Date.now()]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("does not exist"));
    });

    it("fails when package.json is missing", () => {
      const dir = mkdtempSync(join(tmpdir(), "ctxr-test-validate-nopkg-"));
      writeFileSync(join(dir, "README.md"), "# Hello");
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("No package.json"));
      rmSync(dir, { recursive: true, force: true });
    });

    it("fails when package.json has malformed JSON", () => {
      const dir = mkdtempSync(join(tmpdir(), "ctxr-test-validate-badjson-"));
      writeFileSync(join(dir, "package.json"), "{ not: valid json }");
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("Could not parse package.json"));
      rmSync(dir, { recursive: true, force: true });
    });

    it("fails when package.json has no `name` field", () => {
      const dir = mkdtempSync(join(tmpdir(), "ctxr-test-validate-noname-"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ version: "1.0.0", files: ["x.md"], ctxr: { type: "agent", target: "file" } }),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("missing a `name`"));
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("skill: valid fixture", () => {
    it("passes with exit 0 and reports name", () => {
      const r = cli([join(FIXTURES, "skill", "valid")]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("Validation passed"));
      assert.ok(r.stdout.includes("name: valid-skill"));
    });
  });

  describe("skill: broken fixture — missing name + broken xref", () => {
    it("fails with exit 1 reporting missing name", () => {
      const r = cli([join(FIXTURES, "skill", "broken")]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.combined.includes("missing 'name'"));
    });

    it("reports broken cross-reference", () => {
      const r = cli([join(FIXTURES, "skill", "broken")]);
      assert.ok(r.combined.includes("broken link"));
    });
  });

  describe("skill: code-review auto-detect", () => {
    it("passes with reviewer + overlay index consistency checks", () => {
      const r = cli([join(FIXTURES, "skill", "code-review")]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("reviewer IDs match"));
      assert.ok(r.stdout.includes("index entries match"));
    });
  });

  describe("skill: orphan-overlay fixture", () => {
    it("reports overlay not listed in index", () => {
      const r = cli([join(FIXTURES, "skill", "orphan-overlay")]);
      assert.ok(r.combined.includes("not listed in overlays/index.md"));
    });
  });

  describe("skill: description > 300 chars warning", () => {
    it("warns but still passes", () => {
      const longDesc = "A".repeat(301);
      const dir = makeTmpPackage({
        type: "skill",
        target: "folder",
        name: "tmp-longdesc",
        files: ["SKILL.md"],
        extraWrites: [
          {
            path: "SKILL.md",
            content: `---\nname: test\ndescription: ${longDesc}\n---\n# Test\n`,
          },
        ],
      });
      const r = cli([dir]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("warning"));
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("skill: line count > 500 warning", () => {
    it("warns on big.md but still passes", () => {
      const dir = makeTmpPackage({
        type: "skill",
        target: "folder",
        name: "tmp-bigfile",
        files: ["SKILL.md", "big.md"],
        extraWrites: [
          {
            path: "SKILL.md",
            content: "---\nname: test\ndescription: Test skill.\n---\n# Test\n",
          },
          { path: "big.md", content: "line\n".repeat(501) },
        ],
      });
      const r = cli([dir]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.combined.includes("big.md"));
      assert.ok(r.combined.includes("warning"));
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("agent: file-target minimal fixture", () => {
    it("passes and reports single artifact + frontmatter", () => {
      const r = cli([join(FIXTURES, "agent", "file-minimal")]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("single artifact file"));
      assert.ok(r.stdout.includes("name: ctxr-agent-minimal"));
    });
  });

  describe("agent: folder-bundle fixture", () => {
    it("passes with bundle acknowledgement (no entry-file check)", () => {
      const r = cli([join(FIXTURES, "agent", "folder-bundle")]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("folder bundle"));
    });
  });

  describe("command: file-valid fixture", () => {
    it("passes and reports command frontmatter", () => {
      const r = cli([join(FIXTURES, "command", "file-valid")]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("name: ctxr-command-valid"));
    });
  });

  describe("rule: file-valid fixture", () => {
    it("passes and reports rule frontmatter", () => {
      const r = cli([join(FIXTURES, "rule", "file-valid")]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("name: ctxr-rule-valid"));
    });
  });

  describe("output-style: file-valid fixture", () => {
    it("passes and reports output-style frontmatter", () => {
      const r = cli([join(FIXTURES, "output-style", "file-valid")]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("name: ctxr-output-style-valid"));
    });
  });

  describe("single-file artifact: missing frontmatter fields", () => {
    it("errors on missing name", () => {
      const dir = makeTmpPackage({
        type: "agent",
        target: "file",
        name: "tmp-agent-noname",
        files: ["ctxr-agent-test.md"],
        extraWrites: [
          {
            path: "ctxr-agent-test.md",
            content: "---\ndescription: agent with no name\n---\n# body\n",
          },
        ],
      });
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.combined.includes("missing 'name'"));
      rmSync(dir, { recursive: true, force: true });
    });

    it("errors on missing description", () => {
      const dir = makeTmpPackage({
        type: "rule",
        target: "file",
        name: "tmp-rule-nodesc",
        files: ["ctxr-rule-test.md"],
        extraWrites: [
          {
            path: "ctxr-rule-test.md",
            content: "---\nname: tmp-rule\n---\n# body\n",
          },
        ],
      });
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.combined.includes("missing 'description'"));
      rmSync(dir, { recursive: true, force: true });
    });

    it("warns on description > 300 chars for file-target", () => {
      const longDesc = "Z".repeat(350);
      const dir = makeTmpPackage({
        type: "command",
        target: "file",
        name: "tmp-command-longdesc",
        files: ["ctxr-command-test.md"],
        extraWrites: [
          {
            path: "ctxr-command-test.md",
            content: `---\nname: tmp-command\ndescription: ${longDesc}\n---\n# body\n`,
          },
        ],
      });
      const r = cli([dir]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.combined.includes("recommended ≤300"));
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("team: dynamic fixture", () => {
    it("passes with npm-spec members", () => {
      const dir = makeTmpPackage({
        type: "team",
        name: "tmp-team",
        files: ["README.md"],
        extraWrites: [{ path: "README.md", content: "# Team\n" }],
      });
      // overwrite package.json to add a richer includes list
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify(
          {
            name: "tmp-team",
            version: "1.0.0",
            files: ["README.md"],
            ctxr: {
              type: "team",
              includes: ["@ctxr/skill-foo", "@acme/agent-bar"],
            },
          },
          null,
          2,
        ),
      );
      const r = cli([dir]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.stdout.includes("2 member spec(s) parse cleanly"));
      rmSync(dir, { recursive: true, force: true });
    });

    it("warns on duplicate member specs", () => {
      const dir = mkdtempSync(join(tmpdir(), "ctxr-test-validate-team-dup-"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "tmp-team-dup",
          version: "1.0.0",
          files: ["README.md"],
          ctxr: {
            type: "team",
            includes: ["@ctxr/skill-foo", "@ctxr/skill-foo"],
          },
        }),
      );
      writeFileSync(join(dir, "README.md"), "# Team dup\n");
      const r = cli([dir]);
      assert.equal(r.exitCode, 0, r.combined);
      assert.ok(r.combined.includes("duplicate entry"));
      rmSync(dir, { recursive: true, force: true });
    });

    it("errors on malformed member specs", () => {
      const dir = mkdtempSync(join(tmpdir(), "ctxr-test-validate-team-bad-"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "tmp-team-bad",
          version: "1.0.0",
          files: ["README.md"],
          ctxr: {
            type: "team",
            // starts with "-" → argv-injection guard
            includes: ["-evil-flag"],
          },
        }),
      );
      writeFileSync(join(dir, "README.md"), "# Team bad\n");
      const r = cli([dir]);
      assert.equal(r.exitCode, 1);
      assert.ok(r.combined.includes("not a valid source spec"));
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
