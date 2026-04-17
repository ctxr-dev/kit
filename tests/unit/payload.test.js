import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractPackJson,
  packagePayload,
  sanitizePayload,
} from "../../src/lib/payload.js";

// packagePayload shells out to `npm pack --dry-run --json` so every test
// creates a real on-disk package fixture and asserts against npm's actual
// output. This makes the tests slower (~50-200ms each) but gives us true
// end-to-end coverage of the payload layer.

describe("packagePayload", () => {
  let tmpRoot;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ctxr-payload-test-"));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  let caseId = 0;
  function newPackage(pkgJson, extraFiles = {}) {
    const dir = join(tmpRoot, `pkg-${caseId++}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
    for (const [relPath, content] of Object.entries(extraFiles)) {
      const abs = join(dir, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return dir;
  }

  describe("files field is honored", () => {
    it("returns exactly the files listed plus npm's always-include set", () => {
      const dir = newPackage(
        {
          name: "fixture-files-basic",
          version: "1.0.0",
          files: ["SKILL.md", "reviewers"],
        },
        {
          "SKILL.md": "# skill",
          "reviewers/a.md": "a",
          "reviewers/b.md": "b",
          "should-not-ship.md": "nope",
          "README.md": "# readme",
          LICENSE: "MIT",
        },
      );

      const payload = packagePayload(dir);

      // Explicit from files
      assert.ok(payload.includes("SKILL.md"));
      assert.ok(payload.includes("reviewers/a.md"));
      assert.ok(payload.includes("reviewers/b.md"));
      // Always-include
      assert.ok(payload.includes("package.json"));
      assert.ok(payload.includes("README.md"));
      assert.ok(payload.includes("LICENSE"));
      // Not whitelisted → not shipped
      assert.ok(!payload.includes("should-not-ship.md"));
    });

    it("dev files outside files[] are excluded", () => {
      const dir = newPackage(
        {
          name: "fixture-files-exclude-dev",
          version: "1.0.0",
          files: ["index.js"],
        },
        {
          "index.js": "export default {};",
          "test.js": "// not shipped",
          ".editorconfig": "",
          ".nvmrc": "20",
        },
      );

      const payload = packagePayload(dir);
      assert.ok(payload.includes("index.js"));
      assert.ok(!payload.includes("test.js"));
    });
  });

  describe("nested directories recurse", () => {
    it("a top-level dir in files[] includes every file under it", () => {
      const dir = newPackage(
        {
          name: "fixture-nested",
          version: "1.0.0",
          files: ["overlays"],
        },
        {
          "overlays/frameworks/react.md": "react",
          "overlays/frameworks/vue.md": "vue",
          "overlays/languages/ts.md": "ts",
          "overlays/index.md": "idx",
        },
      );

      const payload = packagePayload(dir);
      assert.ok(payload.includes("overlays/index.md"));
      assert.ok(payload.includes("overlays/frameworks/react.md"));
      assert.ok(payload.includes("overlays/frameworks/vue.md"));
      assert.ok(payload.includes("overlays/languages/ts.md"));
    });
  });

  describe(".npmignore and .gitignore semantics", () => {
    it(".npmignore excludes files that would otherwise ship", () => {
      const dir = newPackage(
        {
          name: "fx-npmignore-basic",
          version: "1.0.0",
        },
        {
          "index.js": "// ships",
          "secret.js": "// excluded",
          ".npmignore": "secret.js\n",
        },
      );
      const payload = packagePayload(dir);
      assert.ok(payload.includes("index.js"));
      assert.ok(!payload.includes("secret.js"));
    });

    it("falls back to .gitignore when no .npmignore present", () => {
      const dir = newPackage(
        {
          name: "fx-gitignore-fallback",
          version: "1.0.0",
        },
        {
          "index.js": "// ships",
          "ignored.js": "// excluded",
          ".gitignore": "ignored.js\n",
        },
      );
      const payload = packagePayload(dir);
      assert.ok(payload.includes("index.js"));
      assert.ok(!payload.includes("ignored.js"));
    });

    it(".npmignore overrides .gitignore when both present", () => {
      const dir = newPackage(
        {
          name: "fx-npmignore-wins",
          version: "1.0.0",
        },
        {
          "keep.js": "// ships",
          "gitignored-only.js": "// ships (npmignore does not list it)",
          "npmignored.js": "// excluded",
          ".gitignore": "gitignored-only.js\n",
          ".npmignore": "npmignored.js\n",
        },
      );
      const payload = packagePayload(dir);
      assert.ok(payload.includes("keep.js"));
      // .npmignore takes over → gitignored-only.js is NOT ignored
      assert.ok(payload.includes("gitignored-only.js"));
      // But npmignored.js IS excluded
      assert.ok(!payload.includes("npmignored.js"));
    });
  });

  describe("npm's always-exclude rules", () => {
    it("top-level node_modules is never shipped", () => {
      const dir = newPackage(
        {
          name: "fixture-exclude-top-nm",
          version: "1.0.0",
          // No files field → blacklist mode, but top-level node_modules is
          // always excluded by npm regardless.
        },
        {
          "index.js": "// real",
          "node_modules/junk/index.js": "// never ships",
          "node_modules/junk/package.json": "{}",
        },
      );

      const payload = packagePayload(dir);
      assert.ok(payload.includes("index.js"));
      for (const p of payload) {
        assert.ok(
          !p.startsWith("node_modules/"),
          `top-level node_modules must not ship: saw ${p}`,
        );
      }
    });

    it(".git is never shipped", () => {
      const dir = newPackage(
        {
          name: "fixture-exclude-git",
          version: "1.0.0",
        },
        {
          "index.js": "// real",
          ".git/HEAD": "ref: refs/heads/main",
          ".git/config": "[core]",
        },
      );

      const payload = packagePayload(dir);
      for (const p of payload) {
        assert.ok(!p.startsWith(".git/"), `.git must not ship: saw ${p}`);
      }
    });
  });

  describe("single-file payload (target:\"file\" use case)", () => {
    it("files array with exactly one .md produces a single-entry payload", () => {
      const dir = newPackage(
        {
          name: "fixture-single-file",
          version: "1.0.0",
          files: ["ctxr-agent-foo.md"],
        },
        {
          "ctxr-agent-foo.md": "# agent",
        },
      );

      const payload = packagePayload(dir);
      // npm always includes package.json; the "single payload file" from
      // kit's perspective is the files[] subset, but payload() returns
      // everything npm ships. The target:"file" installer is the one that
      // enforces exactly-one-file — payload just faithfully reports what
      // npm would publish.
      assert.ok(payload.includes("ctxr-agent-foo.md"));
      assert.ok(payload.includes("package.json"));
    });
  });

  describe("error handling", () => {
    it("errors on missing directory", () => {
      assert.throws(
        () => packagePayload(join(tmpRoot, "does-not-exist")),
        /Package directory not found/,
      );
    });

    it("errors on a file (not a directory)", () => {
      const fakePath = join(tmpRoot, "not-a-dir");
      writeFileSync(fakePath, "");
      assert.throws(() => packagePayload(fakePath), /Not a directory/);
    });

    it("errors on directory without package.json", () => {
      const dir = join(tmpRoot, "no-pkg-json");
      mkdirSync(dir, { recursive: true });
      assert.throws(() => packagePayload(dir), /No package\.json/);
    });

    it("rejects null/undefined/non-string input", () => {
      assert.throws(() => packagePayload(null), TypeError);
      assert.throws(() => packagePayload(undefined), TypeError);
      assert.throws(() => packagePayload(42), TypeError);
      assert.throws(() => packagePayload(""), TypeError);
    });

    it("always ships package.json for a minimal package (no files, no README)", () => {
      // npm's always-include set guarantees package.json ships even when
      // nothing else is declared. Verifies the happy-path invariant rather
      // than an error branch.
      const dir = newPackage({
        name: "fixture-minimal",
        version: "1.0.0",
      });
      const payload = packagePayload(dir);
      assert.ok(payload.includes("package.json"));
      assert.ok(payload.length >= 1);
    });
  });

  describe("extractPackJson (stdout noise resilience)", () => {
    // CI runners occasionally leak non-JSON warnings onto stdout despite
    // `--silent --ignore-scripts` (observed on GitHub Actions Linux:
    // ".git can't be found ..."). The extractor must strip those so
    // JSON.parse still succeeds.
    it("returns raw input when it is already clean JSON", () => {
      const raw = '[{"name":"x","files":[{"path":"a.md"}]}]';
      assert.equal(extractPackJson(raw), raw);
    });

    it("strips a warning prefix before the JSON array", () => {
      const raw = '.git can\'t be found\n[{"name":"x"}]';
      assert.equal(extractPackJson(raw), '[{"name":"x"}]');
    });

    it("strips a warning suffix after the JSON array", () => {
      const raw = '[{"name":"x"}]\nnpm warn leftover message';
      assert.equal(extractPackJson(raw), '[{"name":"x"}]');
    });

    it("returns raw string when no bracket pair is present", () => {
      const raw = "completely broken output";
      assert.equal(extractPackJson(raw), raw);
    });
  });

  describe("sanitizePayload (direct unit tests)", () => {
    // These tests exercise the path-safety branches that npm's real output
    // never triggers, so a regression in sanitizePayload would otherwise
    // ship silently.
    const pkgDir = "/tmp/fake-pkg";

    it("accepts plain relative paths", () => {
      assert.deepEqual(
        sanitizePayload(["a.md", "b/c.md"], pkgDir),
        ["a.md", "b/c.md"],
      );
    });

    it("sorts alphabetically", () => {
      assert.deepEqual(
        sanitizePayload(["c.md", "a.md", "b.md"], pkgDir),
        ["a.md", "b.md", "c.md"],
      );
    });

    it("dedupes identical paths", () => {
      assert.deepEqual(
        sanitizePayload(["a.md", "b.md", "a.md"], pkgDir),
        ["a.md", "b.md"],
      );
    });

    it("rejects unix absolute paths", () => {
      assert.throws(
        () => sanitizePayload(["/etc/passwd"], pkgDir),
        /absolute path/,
      );
    });

    it("rejects Windows absolute paths with drive letters", () => {
      assert.throws(
        () => sanitizePayload(["C:\\windows\\system32\\evil.exe"], pkgDir),
        /absolute path/,
      );
      assert.throws(
        () => sanitizePayload(["c:/windows/x"], pkgDir),
        /absolute path/,
      );
    });

    it("rejects explicit .. segments (forward slash)", () => {
      assert.throws(
        () => sanitizePayload(["../outside.md"], pkgDir),
        /traversal/,
      );
      assert.throws(
        () => sanitizePayload(["a/../b/c"], pkgDir),
        /traversal/,
      );
    });

    it("rejects explicit .. segments (backslash)", () => {
      assert.throws(
        () => sanitizePayload(["..\\outside.md"], pkgDir),
        /traversal/,
      );
    });

    it("rejects empty string path (resolves to package root)", () => {
      assert.throws(
        () => sanitizePayload([""], pkgDir),
        /package root|absolute path|traversal/,
      );
    });

    it("rejects '.' (resolves to package root)", () => {
      assert.throws(
        () => sanitizePayload(["."], pkgDir),
        /package root/,
      );
    });

    it("normalizes backslash separators to forward slashes", () => {
      // POSIX-style output regardless of input separator
      const result = sanitizePayload(["reviewers\\a.md", "overlays\\b.md"], pkgDir);
      for (const p of result) {
        assert.ok(!p.includes("\\"), `POSIX output only: ${p}`);
      }
    });
  });

  describe("output format", () => {
    it("returns sorted, deduped, POSIX-separator paths", () => {
      const dir = newPackage(
        {
          name: "fixture-format",
          version: "1.0.0",
          files: ["a.md", "c.md", "b.md"],
        },
        {
          "a.md": "a",
          "b.md": "b",
          "c.md": "c",
        },
      );
      const payload = packagePayload(dir);
      const sorted = [...payload].sort();
      assert.deepEqual(payload, sorted, "payload must be sorted");
      assert.equal(
        new Set(payload).size,
        payload.length,
        "payload must be deduped",
      );
      for (const p of payload) {
        assert.ok(!p.includes("\\"), `posix separators only: ${p}`);
        assert.ok(!p.startsWith("/"), `no absolute paths: ${p}`);
        assert.ok(!p.includes(".."), `no parent segments: ${p}`);
      }
    });
  });
});
