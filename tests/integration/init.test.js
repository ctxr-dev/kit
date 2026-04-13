/**
 * init.test.js
 *
 * Covers:
 *   - Default (--type skill) scaffold: file set, placeholder interpolation,
 *     filename rewrites (_gitignore → .gitignore, *.tmpl → *).
 *   - Per-type matrix: every artifact type produces a package whose
 *     `kit validate` exits 0.
 *   - --type flag parsing: short form, long form, `--type=value`, missing
 *     value, unknown flag, invalid type name.
 *   - "directory already exists" guard.
 *
 * Each test creates a fresh temp directory under the OS tmpdir so the
 * suite remains hermetic and parallel-safe.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");

/** Spawn `kit init …` and return stdout/stderr/exitCode without throwing. */
function runInit(args) {
  const r = spawnSync("node", [CLI, "init", ...args], { encoding: "utf8" });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
}

/** Spawn `kit validate <dir>` and return the result. */
function runValidate(dir) {
  const r = spawnSync("node", [CLI, "validate", dir], { encoding: "utf8" });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
}

/**
 * Allocate a fresh temp scratch directory, then point at a NON-existent
 * child path inside it for `kit init` to create. Using a child path lets us
 * exercise the "directory does not yet exist" code path without polluting
 * the parent tmpdir scratch root.
 */
function freshTarget(prefix) {
  const root = mkdtempSync(join(tmpdir(), `ctxr-test-init-${prefix}-`));
  return { root, target: join(root, `${prefix}-pkg`) };
}

describe("init command", () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      const dir = cleanups.pop();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
  function track(dir) {
    cleanups.push(dir);
    return dir;
  }

  describe("default (--type skill) scaffold", () => {
    it("creates all expected skill files", () => {
      const { root, target } = freshTarget("default");
      track(root);
      const r = runInit([target]);
      assert.equal(r.exitCode, 0, r.combined);

      const expected = [
        "SKILL.md",
        "README.md",
        "LICENSE",
        "package.json",
        ".gitignore",
        ".markdownlint.jsonc",
      ];
      for (const file of expected) {
        assert.ok(
          existsSync(join(target, file)),
          `Expected ${file} to exist (got ${r.combined})`,
        );
      }
    });

    it("interpolates {{name}} in SKILL.md frontmatter", () => {
      const { root, target } = freshTarget("interp-name");
      track(root);
      runInit([target]);
      const content = readFileSync(join(target, "SKILL.md"), "utf8");
      const name = target.split("/").pop();
      assert.ok(
        content.includes(`name: ${name}`),
        `SKILL.md should contain name: ${name}`,
      );
    });

    it("interpolates {{titleName}} in SKILL.md", () => {
      const { root, target } = freshTarget("interp-title");
      track(root);
      runInit([target]);
      const content = readFileSync(join(target, "SKILL.md"), "utf8");
      assert.ok(content.includes("# "));
      assert.ok(!content.includes("{{titleName}}"));
    });

    it("renames _gitignore to .gitignore", () => {
      const { root, target } = freshTarget("gitignore");
      track(root);
      runInit([target]);
      assert.ok(existsSync(join(target, ".gitignore")));
      assert.ok(!existsSync(join(target, "_gitignore")));
    });

    it("renames package.json.tmpl to package.json with @ctxr scope", () => {
      const { root, target } = freshTarget("pkgname");
      track(root);
      runInit([target]);
      assert.ok(existsSync(join(target, "package.json")));
      assert.ok(!existsSync(join(target, "package.json.tmpl")));
      const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      assert.ok(pkg.name.startsWith("@ctxr/"), `expected @ctxr scope, got ${pkg.name}`);
      assert.equal(pkg.ctxr.type, "skill");
      assert.equal(pkg.ctxr.target, "folder");
    });

    it("interpolates {{year}} in LICENSE", () => {
      const { root, target } = freshTarget("year");
      track(root);
      runInit([target]);
      const content = readFileSync(join(target, "LICENSE"), "utf8");
      assert.ok(content.includes(String(new Date().getFullYear())));
    });
  });

  // Per-type matrix. Each entry declares the type, the expected file set
  // (in addition to the universal README/LICENSE/package.json/.gitignore),
  // and the expected ctxr block fields. The matrix lives in one place so
  // adding a new type is one row plus a sibling template directory.
  const TYPE_MATRIX = [
    {
      type: "skill",
      target: "folder",
      typeFiles: ["SKILL.md", ".markdownlint.jsonc"],
      hasArtifact: false,
    },
    {
      type: "agent",
      target: "file",
      typeFiles: [],
      hasArtifact: true,
    },
    {
      type: "command",
      target: "file",
      typeFiles: [],
      hasArtifact: true,
    },
    {
      type: "rule",
      target: "file",
      typeFiles: [],
      hasArtifact: true,
    },
    {
      type: "output-style",
      target: "file",
      typeFiles: [],
      hasArtifact: true,
    },
    {
      type: "team",
      target: null,
      typeFiles: [],
      hasArtifact: false,
    },
  ];

  describe("per-type matrix", () => {
    for (const entry of TYPE_MATRIX) {
      describe(`--type ${entry.type}`, () => {
        it("scaffolds the expected files", () => {
          const { root, target } = freshTarget(entry.type);
          track(root);
          const r = runInit(["--type", entry.type, target]);
          assert.equal(r.exitCode, 0, r.combined);

          // Universal files for every template family.
          const universal = ["package.json", "README.md", "LICENSE", ".gitignore"];
          for (const f of universal) {
            assert.ok(
              existsSync(join(target, f)),
              `[${entry.type}] missing universal file ${f}`,
            );
          }
          for (const f of entry.typeFiles) {
            assert.ok(
              existsSync(join(target, f)),
              `[${entry.type}] missing type file ${f}`,
            );
          }
          if (entry.hasArtifact) {
            // file-target templates ship `ctxr-{{name}}.md` interpolated.
            const name = target.split("/").pop();
            assert.ok(
              existsSync(join(target, `ctxr-${name}.md`)),
              `[${entry.type}] missing ctxr-${name}.md artifact`,
            );
          }
        });

        it("writes a package.json with the correct ctxr block", () => {
          const { root, target } = freshTarget(entry.type);
          track(root);
          runInit(["--type", entry.type, target]);
          const pkg = JSON.parse(
            readFileSync(join(target, "package.json"), "utf8"),
          );
          assert.ok(pkg.name.startsWith("@ctxr/"));
          assert.equal(pkg.ctxr.type, entry.type);
          if (entry.type === "team") {
            assert.ok(Array.isArray(pkg.ctxr.includes));
            assert.ok(pkg.ctxr.includes.length > 0);
          } else {
            assert.equal(pkg.ctxr.target, entry.target);
          }
        });

        it("scaffolded package passes kit validate", () => {
          const { root, target } = freshTarget(entry.type);
          track(root);
          const init = runInit(["--type", entry.type, target]);
          assert.equal(init.exitCode, 0, init.combined);
          const v = runValidate(target);
          assert.equal(
            v.exitCode,
            0,
            `[${entry.type}] validate should pass:\n${v.combined}`,
          );
        });
      });
    }
  });

  describe("--type flag parsing", () => {
    it("accepts -t shorthand", () => {
      const { root, target } = freshTarget("short-flag");
      track(root);
      const r = runInit(["-t", "agent", target]);
      assert.equal(r.exitCode, 0, r.combined);
      const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      assert.equal(pkg.ctxr.type, "agent");
    });

    it("accepts --type=value form", () => {
      const { root, target } = freshTarget("eq-flag");
      track(root);
      const r = runInit([`--type=command`, target]);
      assert.equal(r.exitCode, 0, r.combined);
      const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      assert.equal(pkg.ctxr.type, "command");
    });

    it("rejects unknown --type", () => {
      const { root, target } = freshTarget("bad-type");
      track(root);
      const r = runInit(["--type", "skil", target]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /Unknown --type "skil"/);
      assert.ok(!existsSync(target), "unknown --type must not create the target dir");
    });

    it("rejects --type with no value", () => {
      const r = runInit(["--type"]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /--type requires a value/);
    });

    it("rejects --type= empty value", () => {
      const r = runInit(["--type="]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /--type= requires a value/);
    });

    it("rejects unknown flags", () => {
      const r = runInit(["--tpe", "skill"]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /Unknown flag: --tpe/);
    });

    it("rejects --type value that starts with '-' (forgotten value)", () => {
      // User typed `kit init --type -t agent` — clearly a typo. We refuse to
      // consume `-t` as the type value because that would generate a
      // generic "Unknown --type" message instead of a pointed error.
      const r = runInit(["--type", "-t", "agent"]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /value must not start with '-'/);
    });

    it("rejects extra positional arguments", () => {
      const { root, target } = freshTarget("extras");
      track(root);
      const r = runInit(["--type", "agent", target, "extra-arg"]);
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /at most one positional argument/);
      assert.ok(!existsSync(target), "rejected init must not create the target dir");
    });
  });

  describe("cwd-init mode (no positional arg)", () => {
    it("scaffolds into the current working directory", () => {
      // No positional → init writes into cwd. Use spawnSync's cwd option to
      // sandbox into a fresh tmpdir so we do not pollute the test runner's
      // working directory.
      const cwd = mkdtempSync(join(tmpdir(), "ctxr-test-init-cwd-"));
      track(cwd);
      const r = spawnSync("node", [CLI, "init"], { encoding: "utf8", cwd });
      assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
      assert.ok(existsSync(join(cwd, "SKILL.md")), "SKILL.md should land in cwd");
      assert.ok(existsSync(join(cwd, "package.json")));
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      assert.equal(pkg.ctxr.type, "skill");
    });
  });

  describe("--help flag", () => {
    it("exits 0 and prints usage", () => {
      const r = runInit(["--help"]);
      assert.equal(r.exitCode, 0);
      assert.match(r.stderr, /Usage: kit init/);
      assert.match(r.stderr, /--type/);
    });
  });

  describe("directory already exists", () => {
    it("exits 1 with error", () => {
      const { root, target } = freshTarget("collision");
      track(root);
      const first = runInit([target]);
      assert.equal(first.exitCode, 0, first.combined);
      const second = runInit([target]);
      assert.equal(second.exitCode, 1);
      assert.match(second.stderr, /already exists/);
    });
  });
});
