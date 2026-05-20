import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureMirror,
  mirrorIsCorrect,
  removeMirror,
  SENTINEL_SUFFIX,
} from "../../src/lib/symlink.js";

describe("ensureMirror — POSIX project mirror", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ctxr-symlink-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates a relative symlink for a project-scope folder mirror", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, ".agents/skills/foo");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "ok\n");
    const mirror = join(root, ".claude/skills/foo");
    const r = ensureMirror({
      canonicalPath: canonical,
      mirrorPath: mirror,
      target: "folder",
    });
    assert.equal(r.created, true);
    assert.equal(r.kind, "symlink");
    assert.equal(lstatSync(mirror).isSymbolicLink(), true);
    assert.equal(realpathSync(mirror), realpathSync(canonical));
    // Reading the mirrored payload works.
    assert.equal(readFileSync(join(mirror, "SKILL.md"), "utf8"), "ok\n");
  });

  it("uses an absolute target for cross-tree user mirrors", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const home = mkdtempSync(join(tmpdir(), "ctxr-fakehome-"));
    try {
      const canonical = join(home, ".agents/skills/foo");
      mkdirSync(canonical, { recursive: true });
      writeFileSync(join(canonical, "SKILL.md"), "ok\n");
      const mirror = join(home, ".claude/skills/foo");
      const r = ensureMirror({
        canonicalPath: canonical,
        mirrorPath: mirror,
        target: "folder",
      });
      assert.equal(r.created, true);
      assert.equal(realpathSync(mirror), realpathSync(canonical));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent: re-running on a correct mirror is a noop", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, ".agents/skills/foo");
    mkdirSync(canonical, { recursive: true });
    const mirror = join(root, ".claude/skills/foo");
    const first = ensureMirror({
      canonicalPath: canonical,
      mirrorPath: mirror,
      target: "folder",
    });
    assert.equal(first.created, true);
    const second = ensureMirror({
      canonicalPath: canonical,
      mirrorPath: mirror,
      target: "folder",
    });
    assert.equal(second.created, false);
    assert.equal(second.kind, "noop");
  });

  it("replaces a broken symlink left by a previous kit run", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, ".agents/skills/foo");
    mkdirSync(canonical, { recursive: true });
    const mirror = join(root, ".claude/skills/foo");
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    symlinkSync(join(root, "nonexistent-target"), mirror);
    const r = ensureMirror({
      canonicalPath: canonical,
      mirrorPath: mirror,
      target: "folder",
    });
    assert.equal(r.created, true);
    assert.equal(realpathSync(mirror), realpathSync(canonical));
  });

  it("refuses to overwrite a real (non-symlink) directory at the mirror path", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, ".agents/skills/foo");
    mkdirSync(canonical, { recursive: true });
    const mirror = join(root, ".claude/skills/foo");
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(mirror, "user-edited.md"), "do not touch\n");
    const r = ensureMirror({
      canonicalPath: canonical,
      mirrorPath: mirror,
      target: "folder",
    });
    assert.equal(r.created, false);
    assert.match(r.warning || "", /not owned by kit/);
    assert.ok(existsSync(join(mirror, "user-edited.md")));
  });

  it("creates a file mirror via symlink with target=file", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, ".agents/agents/foo.md");
    mkdirSync(join(root, ".agents/agents"), { recursive: true });
    writeFileSync(canonical, "agent body\n");
    const mirror = join(root, ".claude/agents/foo.md");
    const r = ensureMirror({
      canonicalPath: canonical,
      mirrorPath: mirror,
      target: "file",
    });
    assert.equal(r.created, true);
    assert.equal(r.kind, "symlink");
    assert.equal(readFileSync(mirror, "utf8"), "agent body\n");
  });
});

describe("mirrorIsCorrect", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ctxr-symlink-correct-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns true for a symlink pointing at the canonical", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, "canonical");
    mkdirSync(canonical, { recursive: true });
    const mirror = join(root, "mirror");
    symlinkSync(canonical, mirror);
    assert.equal(mirrorIsCorrect(mirror, canonical), true);
  });

  it("returns false when the symlink points elsewhere", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, "canonical");
    mkdirSync(canonical, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const mirror = join(root, "mirror");
    symlinkSync(elsewhere, mirror);
    assert.equal(mirrorIsCorrect(mirror, canonical), false);
  });

  it("returns false when the mirror is absent", () => {
    assert.equal(mirrorIsCorrect(join(root, "absent"), join(root, "canonical")), false);
  });
});

describe("removeMirror", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ctxr-symlink-remove-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("removes a kit-owned symlink", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, "canonical");
    mkdirSync(canonical, { recursive: true });
    const mirror = join(root, "mirror");
    symlinkSync(canonical, mirror);
    const r = removeMirror(mirror, { expectedTarget: canonical });
    assert.equal(r.removed, true);
    assert.equal(existsSync(mirror), false);
  });

  it("refuses to remove a real directory at the mirror path", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const real = join(root, "real-dir");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "user-data"), "stay\n");
    const r = removeMirror(real);
    assert.equal(r.removed, false);
    assert.match(r.warning || "", /not owned by kit/);
    assert.ok(existsSync(join(real, "user-data")));
  });

  it("refuses to remove a symlink pointing somewhere unexpected", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, "canonical");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const mirror = join(root, "mirror");
    symlinkSync(elsewhere, mirror);
    const r = removeMirror(mirror, { expectedTarget: canonical });
    assert.equal(r.removed, false);
    assert.match(r.warning || "", /points at/);
    assert.ok(existsSync(mirror));
  });

  it("removes a copy fallback by deleting copy + sentinel", function (t) {
    if (process.platform === "win32") return t.skip("POSIX-only");
    const canonical = join(root, ".agents/skills/foo");
    mkdirSync(canonical, { recursive: true });
    const mirror = join(root, ".claude/skills/foo");
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    cpSync(canonical, mirror, { recursive: true });
    writeFileSync(mirror + SENTINEL_SUFFIX, "ctxr-kit\n");
    const r = removeMirror(mirror);
    assert.equal(r.removed, true);
    assert.equal(r.kind, "copy");
    assert.equal(existsSync(mirror), false);
    assert.equal(existsSync(mirror + SENTINEL_SUFFIX), false);
  });

  it("noop on absent mirror", () => {
    const r = removeMirror(join(root, "absent"));
    assert.equal(r.removed, false);
    assert.equal(r.kind, "noop");
  });
});
