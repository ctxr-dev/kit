/**
 * fetch.test.js
 *
 * Unit-level coverage for the source classifier and pure-JS validation in
 * `src/lib/fetch.js`. We exercise `resolveSource` end-to-end across every
 * source kind (local, npm, github) plus the negative-input partitions:
 *
 *   - leading-dash inputs (flag-smuggling defense)
 *   - `..` and `/.` traversal segments in github specs
 *   - bare or wide `~` home expansion
 *   - missing local paths
 *   - empty/non-string inputs
 *
 * `fetchFromNpm` and `fetchFromGitHub` shell out to `npm` and `git` so they
 * are exercised by integration tests; the input-validation guards on those
 * functions are covered here without spawning child processes.
 *
 * The classifier is the sharpest blade in kit's security model — once a
 * source string passes `resolveSource`, the rest of the pipeline trusts
 * that classification. Regressions here can mean dependency confusion,
 * directory traversal, or shell-flag smuggling, so the table is
 * deliberately exhaustive for every documented input partition.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchFromGitHub,
  fetchFromNpm,
  resolveSource,
} from "../../src/lib/fetch.js";

// Tests that need to stub process.env.HOME for ~/ expansion do so inside
// a try/finally; we avoid global beforeEach/afterEach so each test reads
// top-to-bottom without hidden setup.

describe("resolveSource — local paths", () => {
  it("classifies an existing absolute path as local", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ctxr-fetch-local-"));
    try {
      const r = resolveSource(tmp);
      assert.equal(r.type, "local");
      assert.equal(r.path, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("classifies an existing ./relative path as local (cwd-resolved)", () => {
    // Truly exercise the `source.startsWith(".")` branch by chdir-ing into
    // a fresh tmp dir and passing a relative `./child` string. Without this
    // chdir the test would just exercise the absolute-path branch.
    const tmp = mkdtempSync(join(tmpdir(), "ctxr-fetch-local-rel-"));
    writeFileSync(join(tmp, "marker"), "");
    const originalCwd = process.cwd();
    try {
      process.chdir(tmp);
      const r = resolveSource("./marker");
      assert.equal(r.type, "local");
      // resolveSource calls path.resolve, which expands `./marker` against
      // the now-current cwd. Compare via realpathSync to absorb /tmp ↔
      // /private/tmp on macOS.
      assert.equal(realpathSync(r.path), realpathSync(join(tmp, "marker")));
    } finally {
      process.chdir(originalCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("expands '~/relative' against process.env.HOME", () => {
    // Positive case for the home-expansion branch (lines 73-79 of fetch.js).
    // Negative cases (`~`, `~root`) are covered separately. We stub HOME to
    // a fresh tmpdir, drop a file inside it, and assert resolveSource
    // returns the absolute path joining HOME + the suffix.
    const fakeHome = mkdtempSync(join(tmpdir(), "ctxr-fetch-home-"));
    writeFileSync(join(fakeHome, "marker"), "");
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = fakeHome;
      const r = resolveSource("~/marker");
      assert.equal(r.type, "local");
      assert.equal(realpathSync(r.path), realpathSync(join(fakeHome, "marker")));
    } finally {
      // Restore HOME precisely. Setting `process.env.X = undefined` writes
      // the literal string "undefined" rather than unsetting; use `delete`
      // to actually remove the var when it wasn't set in the first place.
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("rejects bare '~' (home shorthand without a slash)", () => {
    assert.throws(
      () => resolveSource("~"),
      /Only "~\/\.\.\." home expansion is supported/,
    );
  });

  it("rejects '~user' (user-name expansion not supported)", () => {
    assert.throws(
      () => resolveSource("~root"),
      /Only "~\/\.\.\." home expansion is supported/,
    );
  });

  it("rejects an unresolvable local path with a clear error", () => {
    const ghost = join(tmpdir(), `ctxr-fetch-ghost-${Date.now()}-${process.pid}`);
    assert.throws(() => resolveSource(ghost), /Local path not found/);
  });
});

describe("resolveSource — github specs", () => {
  it("classifies a well-formed github:owner/name shorthand", () => {
    const r = resolveSource("github:ctxr-dev/example");
    assert.equal(r.type, "github");
    assert.equal(r.repo, "ctxr-dev/example");
  });

  it("accepts owner/name with dots, hyphens, and underscores", () => {
    const r = resolveSource("github:my-org/my.tool_v2");
    assert.equal(r.type, "github");
    assert.equal(r.repo, "my-org/my.tool_v2");
  });

  it("rejects '..' segment in github repo (traversal)", () => {
    assert.throws(
      () => resolveSource("github:owner/.."),
      /Invalid GitHub repo format/,
    );
    assert.throws(
      () => resolveSource("github:../evil/repo"),
      /Invalid GitHub repo format/,
    );
  });

  it("rejects leading-dot segment in github repo", () => {
    assert.throws(
      () => resolveSource("github:.evil/repo"),
      /Invalid GitHub repo format/,
    );
  });

  it("rejects extra path segment after owner/name", () => {
    assert.throws(
      () => resolveSource("github:owner/name/extra"),
      /Invalid GitHub repo format/,
    );
  });

  it("rejects whitespace in repo spec", () => {
    assert.throws(
      () => resolveSource("github:owner/name space"),
      /Invalid GitHub repo format/,
    );
  });

  it("rejects empty repo after the github: prefix", () => {
    assert.throws(
      () => resolveSource("github:"),
      /Invalid GitHub repo format/,
    );
  });
});

describe("resolveSource — npm specs", () => {
  it("classifies a bare package name as npm", () => {
    const r = resolveSource("lodash");
    assert.equal(r.type, "npm");
    assert.equal(r.package, "lodash");
  });

  it("classifies a scoped package as npm", () => {
    const r = resolveSource("@ctxr/skill-code-review");
    assert.equal(r.type, "npm");
    assert.equal(r.package, "@ctxr/skill-code-review");
  });

  it("classifies a scoped+versioned package as npm", () => {
    const r = resolveSource("@ctxr/skill-code-review@1.2.3");
    assert.equal(r.type, "npm");
    assert.equal(r.package, "@ctxr/skill-code-review@1.2.3");
  });

  it("rejects npm spec starting with '-' (flag smuggling defense)", () => {
    // A user (or a doc example interpolating a variable) typing
    // `kit install --registry=http://attacker` must NOT be silently passed
    // to `npm pack` as a flag. The classifier rejects leading-dash inputs
    // before they reach any child process. Boundary cases include:
    //   - a single `-` (which would otherwise be a "package named dash")
    //   - `-foo` (single-dash short flag form)
    //   - `--anything` (long flag form)
    assert.throws(
      () => resolveSource("-"),
      /npm package spec cannot start with "-"/,
    );
    assert.throws(
      () => resolveSource("--registry=http://attacker"),
      /npm package spec cannot start with "-"/,
    );
    assert.throws(
      () => resolveSource("-foo"),
      /npm package spec cannot start with "-"/,
    );
  });
});

describe("resolveSource — invalid inputs", () => {
  it("rejects an empty string", () => {
    assert.throws(() => resolveSource(""), /Invalid source/);
  });

  it("rejects null", () => {
    assert.throws(() => resolveSource(null), /Invalid source/);
  });

  it("rejects undefined", () => {
    assert.throws(() => resolveSource(undefined), /Invalid source/);
  });

  it("rejects a number", () => {
    assert.throws(() => resolveSource(42), /Invalid source/);
  });
});

describe("fetchFromNpm — input validation", () => {
  it("rejects an empty package name", () => {
    assert.throws(() => fetchFromNpm("", "/tmp"), /Invalid npm package/);
  });

  it("rejects a non-string package name", () => {
    assert.throws(() => fetchFromNpm(null, "/tmp"), /Invalid npm package/);
  });

  it("rejects leading-dash even when called directly (defense in depth)", () => {
    // The classifier blocks this earlier, but `fetchFromNpm` is exported and
    // could be called directly from a future caller. The redundant guard is
    // load-bearing.
    assert.throws(
      () => fetchFromNpm("--registry=http://evil", "/tmp"),
      /npm package spec cannot start with "-"/,
    );
  });

  it("rejects a missing tmpDir", () => {
    assert.throws(
      () =>
        fetchFromNpm(
          "lodash",
          join(tmpdir(), `ctxr-fetch-no-such-dir-${Date.now()}-${process.pid}`),
        ),
      /requires an existing tmpDir/,
    );
  });
});

describe("fetchFromGitHub — input validation", () => {
  it("rejects an empty repo", () => {
    assert.throws(() => fetchFromGitHub("", "/tmp"), /Invalid GitHub repo/);
  });

  it("rejects a malformed repo (no slash)", () => {
    assert.throws(
      () => fetchFromGitHub("badrepo", "/tmp"),
      /Invalid GitHub repo/,
    );
  });

  it("rejects '..' segment even when called directly", () => {
    assert.throws(
      () => fetchFromGitHub("owner/..", "/tmp"),
      /Invalid GitHub repo/,
    );
  });

  it("rejects a missing tmpDir", () => {
    assert.throws(
      () =>
        fetchFromGitHub(
          "ctxr-dev/example",
          join(tmpdir(), `ctxr-fetch-no-such-dir-${Date.now()}-${process.pid}`),
        ),
      /requires an existing tmpDir/,
    );
  });
});
