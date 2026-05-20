import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  MARKER_END,
  MARKER_START,
  removeSkillRow,
  upsertSkillRow,
} from "../../src/lib/agents-md.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const FIXTURES = join(__dirname, "..", "fixtures");

describe("AGENTS.md unit-level upsert/remove", () => {
  let projectDir;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-agentsmd-"));
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it("creates AGENTS.md with preamble and one row when missing", () => {
    upsertSkillRow({
      projectPath: projectDir,
      installedName: "ctxr-skill-foo",
      type: "skill",
      description: "Foo skill",
      skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
    });
    const body = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    assert.match(body, /^# Agents/);
    assert.ok(body.includes(MARKER_START));
    assert.ok(body.includes(MARKER_END));
    assert.ok(body.includes("**`ctxr-skill-foo`**"));
    assert.ok(body.includes(".agents/skills/ctxr-skill-foo/SKILL.md"));
  });

  it("appends to a pre-existing AGENTS.md without disturbing prior content", () => {
    const path = join(projectDir, "AGENTS.md");
    writeFileSync(path, "# My Hand-Authored Agents\n\nSome notes.\n");
    upsertSkillRow({
      projectPath: projectDir,
      installedName: "ctxr-skill-foo",
      type: "skill",
      description: "Foo",
      skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
    });
    const body = readFileSync(path, "utf8");
    assert.ok(body.startsWith("# My Hand-Authored Agents"));
    assert.ok(body.includes("Some notes."));
    assert.ok(body.includes(MARKER_START));
    assert.ok(body.includes("ctxr-skill-foo"));
  });

  it("upsert is idempotent: re-running keeps exactly one row per installedName", () => {
    for (let i = 0; i < 3; i++) {
      upsertSkillRow({
        projectPath: projectDir,
        installedName: "ctxr-skill-foo",
        type: "skill",
        description: "Foo v" + i,
        skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
      });
    }
    const body = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    const matches = body.match(/\*\*`ctxr-skill-foo`\*\*/g) || [];
    assert.equal(matches.length, 1);
    // Last description wins.
    assert.ok(body.includes("Foo v2"));
  });

  it("upsert preserves multiple distinct rows in alphabetical order", () => {
    upsertSkillRow({
      projectPath: projectDir,
      installedName: "z-skill",
      type: "skill",
      description: "Z",
      skillRelPath: ".agents/skills/z-skill/SKILL.md",
    });
    upsertSkillRow({
      projectPath: projectDir,
      installedName: "a-skill",
      type: "skill",
      description: "A",
      skillRelPath: ".agents/skills/a-skill/SKILL.md",
    });
    const body = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    const aIdx = body.indexOf("a-skill");
    const zIdx = body.indexOf("z-skill");
    assert.ok(aIdx > 0);
    assert.ok(zIdx > aIdx);
  });

  it("remove deletes the row but preserves the marker section", () => {
    upsertSkillRow({
      projectPath: projectDir,
      installedName: "ctxr-skill-foo",
      type: "skill",
      description: "Foo",
      skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
    });
    removeSkillRow({ projectPath: projectDir, installedName: "ctxr-skill-foo" });
    const body = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    assert.ok(body.includes(MARKER_START));
    assert.ok(body.includes(MARKER_END));
    assert.ok(!body.includes("ctxr-skill-foo"));
  });

  it("remove on a non-existent row is a no-op", () => {
    upsertSkillRow({
      projectPath: projectDir,
      installedName: "ctxr-skill-foo",
      type: "skill",
      description: "Foo",
      skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
    });
    const before = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    const r = removeSkillRow({
      projectPath: projectDir,
      installedName: "nonexistent",
    });
    assert.equal(r.written, false);
    const after = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    assert.equal(before, after);
  });

  it("sanitises hostile description (end marker, newlines, backticks, >200 chars) and re-parses cleanly", () => {
    const hostile =
      `evil ${MARKER_END} oops\n\rinjected line\n` +
      "back`ticks` and <!--HTML--> and -->end<!-- " +
      "x".repeat(400);
    upsertSkillRow({
      projectPath: projectDir,
      installedName: "ctxr-skill-foo",
      type: "skill",
      description: hostile,
      skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
    });
    const body = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    // Section markers occur exactly once each (no premature close).
    assert.equal(body.match(/<!-- ctxr:skills:start -->/g).length, 1);
    assert.equal(body.match(/<!-- ctxr:skills:end -->/g).length, 1);
    // Backticks inside the description are stripped (only the row's own
    // delimiter backticks remain).
    assert.ok(!body.includes("back`ticks`"));
    // Comment-marker dashes are neutralised inside the row body.
    assert.ok(!/\sevil <!-- ctxr:skills:end -->/.test(body));
    // Re-parse: a second upsert finds and replaces the same row.
    const r2 = upsertSkillRow({
      projectPath: projectDir,
      installedName: "ctxr-skill-foo",
      type: "skill",
      description: "clean",
      skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
    });
    assert.equal(r2.written, true);
    const body2 = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    assert.equal(body2.match(/\*\*`ctxr-skill-foo`\*\*/g).length, 1);
    assert.ok(body2.includes("clean"));
  });

  it("malformed markers (start without end) are not touched", () => {
    const path = join(projectDir, "AGENTS.md");
    writeFileSync(path, `# Agents\n\n${MARKER_START}\nbroken\n`);
    const before = readFileSync(path, "utf8");
    const r = upsertSkillRow({
      projectPath: projectDir,
      installedName: "ctxr-skill-foo",
      type: "skill",
      description: "Foo",
      skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
    });
    assert.equal(r.written, false);
    const after = readFileSync(path, "utf8");
    assert.equal(before, after);
  });

  it("CTXR_NO_AGENTS_MD env-var opt-out: upsert and remove become no-ops, file stays absent", () => {
    const orig = process.env.CTXR_NO_AGENTS_MD;
    try {
      process.env.CTXR_NO_AGENTS_MD = "1";
      const upsertResult = upsertSkillRow({
        projectPath: projectDir,
        installedName: "ctxr-skill-foo",
        type: "skill",
        description: "Foo",
        skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
      });
      assert.equal(upsertResult.written, false);
      assert.equal(upsertResult.reason, "opted-out");
      // No AGENTS.md created.
      assert.equal(existsSync(join(projectDir, "AGENTS.md")), false);

      const removeResult = removeSkillRow({
        projectPath: projectDir,
        installedName: "ctxr-skill-foo",
      });
      assert.equal(removeResult.written, false);
      assert.equal(removeResult.reason, "opted-out");
    } finally {
      if (orig === undefined) delete process.env.CTXR_NO_AGENTS_MD;
      else process.env.CTXR_NO_AGENTS_MD = orig;
    }
  });

  it('CTXR_NO_AGENTS_MD="0" / "false" / unset are NOT opt-outs (kit still emits)', () => {
    const orig = process.env.CTXR_NO_AGENTS_MD;
    try {
      for (const val of ["0", "false", undefined]) {
        rmSync(join(projectDir, "AGENTS.md"), { force: true });
        if (val === undefined) delete process.env.CTXR_NO_AGENTS_MD;
        else process.env.CTXR_NO_AGENTS_MD = val;
        const r = upsertSkillRow({
          projectPath: projectDir,
          installedName: "ctxr-skill-foo",
          type: "skill",
          description: "Foo",
          skillRelPath: ".agents/skills/ctxr-skill-foo/SKILL.md",
        });
        assert.equal(r.written, true, `val=${val}: expected write`);
        assert.ok(existsSync(join(projectDir, "AGENTS.md")), `val=${val}: file missing`);
      }
    } finally {
      if (orig === undefined) delete process.env.CTXR_NO_AGENTS_MD;
      else process.env.CTXR_NO_AGENTS_MD = orig;
    }
  });
});

describe("AGENTS.md end-to-end via kit install / remove", () => {
  let projectDir;
  let fakeHome;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-agentsmd-e2e-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-agentsmd-home-"));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("kit install creates AGENTS.md with a row for the project-scope skill", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlink mirrors require POSIX or Windows dev mode");
    }
    const r = spawnSync(
      "node",
      [CLI, "install", join(FIXTURES, "skill", "valid")],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, CI: "true" },
        cwd: projectDir,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const body = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    assert.ok(body.includes("ctxr:skills:start"));
    assert.ok(body.includes("**`valid-skill`**"));
    assert.ok(body.includes(".agents/skills/valid-skill/SKILL.md"));
  });

  it("kit install does NOT create AGENTS.md for --user installs", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlink mirrors require POSIX or Windows dev mode");
    }
    const r = spawnSync(
      "node",
      [CLI, "install", join(FIXTURES, "skill", "valid"), "--user"],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, CI: "true" },
        cwd: projectDir,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(projectDir, "AGENTS.md")), false);
  });

  it("kit install does NOT create AGENTS.md when --dir overrides", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlink mirrors require POSIX or Windows dev mode");
    }
    const customDir = join(projectDir, "custom-skills");
    const r = spawnSync(
      "node",
      [CLI, "install", join(FIXTURES, "skill", "valid"), "--dir", customDir],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, CI: "true" },
        cwd: projectDir,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(projectDir, "AGENTS.md")), false);
  });

  it("kit remove deletes the row and preserves markers", function (t) {
    if (process.platform === "win32") {
      return t.skip("symlink mirrors require POSIX or Windows dev mode");
    }
    spawnSync("node", [CLI, "install", join(FIXTURES, "skill", "valid")], {
      encoding: "utf8",
      env: { ...process.env, HOME: fakeHome, CI: "true" },
      cwd: projectDir,
    });
    const r = spawnSync(
      "node",
      [CLI, "remove", "valid-skill", "--force"],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, CI: "true" },
        cwd: projectDir,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const body = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
    assert.ok(body.includes(MARKER_START));
    assert.ok(body.includes(MARKER_END));
    assert.ok(!body.includes("valid-skill"));
  });
});
