/**
 * manifest-writer.test.js
 *
 * Unit tests for the shared file-target artifact resolver used by the
 * installer, the validator dispatcher, and per-type validators. Adding
 * direct branch coverage here guards the helper against drift — the
 * installer and validator both call it, and a subtle change to which
 * paths count as "metadata" could silently break both consumers at once.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isFileTargetMetadata,
  resolveFileTargetArtifact,
} from "../../src/installers/manifest-writer.js";

describe("isFileTargetMetadata", () => {
  it("rejects package.json", () => {
    assert.equal(isFileTargetMetadata("package.json"), true);
  });

  it("does not match nested package.json", () => {
    // Only top-level metadata is filtered; nested package.json inside a
    // bundle payload is real content.
    assert.equal(isFileTargetMetadata("nested/package.json"), false);
  });

  it("rejects README variants", () => {
    assert.equal(isFileTargetMetadata("README"), true);
    assert.equal(isFileTargetMetadata("README.md"), true);
    assert.equal(isFileTargetMetadata("readme.md"), true);
    assert.equal(isFileTargetMetadata("README.txt"), true);
  });

  it("rejects LICENSE / LICENCE variants", () => {
    assert.equal(isFileTargetMetadata("LICENSE"), true);
    assert.equal(isFileTargetMetadata("LICENCE"), true);
    assert.equal(isFileTargetMetadata("license.md"), true);
  });

  it("rejects CHANGELOG / NOTICE", () => {
    assert.equal(isFileTargetMetadata("CHANGELOG.md"), true);
    assert.equal(isFileTargetMetadata("NOTICE"), true);
  });

  it("keeps ordinary artifact files", () => {
    assert.equal(isFileTargetMetadata("ctxr-agent-foo.md"), false);
    assert.equal(isFileTargetMetadata("docs/usage.md"), false);
    assert.equal(isFileTargetMetadata("a.md"), false);
  });
});

describe("resolveFileTargetArtifact", () => {
  it("returns { ok: true, single } for a single .md artifact", () => {
    const r = resolveFileTargetArtifact([
      "README.md",
      "LICENSE",
      "package.json",
      "ctxr-agent-foo.md",
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.single, "ctxr-agent-foo.md");
    assert.deepEqual(r.artifacts, ["ctxr-agent-foo.md"]);
  });

  it("returns { ok: false } when metadata is all that's left (count = 0)", () => {
    const r = resolveFileTargetArtifact(["README.md", "LICENSE", "package.json"]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /got 0/);
    assert.deepEqual(r.artifacts, []);
  });

  it("returns { ok: false } with count and preview for 2+ artifact files", () => {
    const r = resolveFileTargetArtifact(["a.md", "b.md", "README.md"]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /got 2/);
    assert.match(r.reason, /\(a\.md, b\.md\)/);
  });

  it("truncates preview with ellipsis for >3 artifacts", () => {
    const r = resolveFileTargetArtifact(["a.md", "b.md", "c.md", "d.md", "e.md"]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /got 5/);
    assert.match(r.reason, /\(a\.md, b\.md, c\.md, …\)/);
  });

  it("returns { ok: false } when the single file is not .md", () => {
    const r = resolveFileTargetArtifact(["rules.yaml", "README.md"]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /must be a \.md file/);
    assert.match(r.reason, /rules\.yaml/);
  });

  it("accepts .MD uppercase", () => {
    const r = resolveFileTargetArtifact(["FOO.MD", "README.md"]);
    assert.equal(r.ok, true);
    assert.equal(r.single, "FOO.MD");
  });
});
