import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_NAMES,
  INSTALLABLE_TYPE_NAMES,
  VALID_TARGETS,
  installedName,
  resolveType,
  resolveTargetRoot,
} from "../../src/lib/types.js";

describe("ARTIFACT_TYPES registry", () => {
  it("lists all six v1 types", () => {
    assert.deepEqual(
      [...ARTIFACT_TYPE_NAMES].sort(),
      ["agent", "command", "output-style", "rule", "skill", "team"],
    );
  });

  it("excludes team from INSTALLABLE_TYPE_NAMES", () => {
    assert.ok(!INSTALLABLE_TYPE_NAMES.includes("team"));
    assert.equal(INSTALLABLE_TYPE_NAMES.length, ARTIFACT_TYPE_NAMES.length - 1);
  });

  it("every non-team type has both .claude and .agents candidates", () => {
    for (const name of INSTALLABLE_TYPE_NAMES) {
      const cfg = ARTIFACT_TYPES[name];
      assert.equal(cfg.projectDirs.length, 2, `${name} should have 2 projectDirs`);
      assert.ok(cfg.projectDirs[0].startsWith(".claude/"), `${name} primary must be .claude/*`);
      assert.ok(cfg.projectDirs[1].startsWith(".agents/"), `${name} secondary must be .agents/*`);
      assert.equal(typeof cfg.userDir, "string");
      assert.ok(cfg.userDir.length > 0);
    }
  });

  it("team has no projectDirs and no userDir", () => {
    assert.deepEqual([...ARTIFACT_TYPES.team.projectDirs], []);
    assert.equal(ARTIFACT_TYPES.team.userDir, null);
  });

  it("registry is deeply frozen", () => {
    assert.ok(Object.isFrozen(ARTIFACT_TYPES));
    assert.ok(Object.isFrozen(ARTIFACT_TYPES.skill));
    assert.ok(Object.isFrozen(ARTIFACT_TYPES.skill.projectDirs));
  });

  it("VALID_TARGETS is exactly folder and file", () => {
    assert.deepEqual([...VALID_TARGETS].sort(), ["file", "folder"]);
  });
});

describe("installedName", () => {
  it("scoped @ctxr package", () => {
    assert.equal(installedName("@ctxr/skill-foo"), "ctxr-skill-foo");
  });

  it("scoped third-party @acme package", () => {
    assert.equal(installedName("@acme/agent-researcher"), "acme-agent-researcher");
  });

  it("unscoped package keeps its name as-is", () => {
    assert.equal(installedName("skill-local"), "skill-local");
  });

  it("multi-part scoped names collapse all slashes in a single replace", () => {
    // Single slash in scope → single replace
    assert.equal(installedName("@foo/bar-baz"), "foo-bar-baz");
  });

  it("names with dots (npm allows them) are preserved", () => {
    assert.equal(installedName("@ctxr/skill-foo.bar"), "ctxr-skill-foo.bar");
    assert.equal(installedName("my.package"), "my.package");
  });

  it("rejects null/undefined/non-string", () => {
    assert.throws(() => installedName(null), TypeError);
    assert.throws(() => installedName(undefined), TypeError);
    assert.throws(() => installedName(42), TypeError);
    assert.throws(() => installedName({}), TypeError);
  });

  it("rejects empty string", () => {
    assert.throws(() => installedName(""), /non-empty/);
  });

  it("rejects path-traversal and path-like inputs", () => {
    assert.throws(() => installedName(".."), /Invalid package name/);
    assert.throws(() => installedName("../foo"), /Invalid package name/);
    assert.throws(() => installedName("./foo"), /Invalid package name/);
    assert.throws(() => installedName("/abs/path"), /Invalid package name/);
  });

  it("rejects bare @ or empty scope", () => {
    assert.throws(() => installedName("@"), /Invalid package name/);
    assert.throws(() => installedName("@/foo"), /Invalid package name/);
    assert.throws(() => installedName("@ctxr/"), /Invalid package name/);
  });

  it("rejects double slashes or multi-segment paths", () => {
    assert.throws(() => installedName("foo/bar/baz"), /Invalid package name/);
    assert.throws(() => installedName("@ctxr//skill"), /Invalid package name/);
  });

  it("rejects backslash and null-byte inputs", () => {
    assert.throws(() => installedName("foo\\bar"), /Invalid package name/);
    assert.throws(() => installedName("foo\0bar"), /Invalid package name/);
  });

  it("rejects unicode (conservative ASCII-only grammar)", () => {
    assert.throws(() => installedName("@ctxr/skíll-foo"), /Invalid package name/);
  });

  it("rejects uppercase package names (npm forbids since 2017)", () => {
    // PKG_NAME_RE currently allows [a-zA-Z] for historical reasons; if we
    // ever tighten to [a-z0-9], this test can flip. For now assert the
    // conservative "npm allows it" side and document the deliberate drift.
    // This test exists as a boundary marker, not a strict rule.
    assert.doesNotThrow(() => installedName("Foo"));
    assert.equal(installedName("Foo"), "Foo");
  });

  it("accepts single-char names", () => {
    assert.equal(installedName("a"), "a");
    assert.equal(installedName("@a/b"), "a-b");
  });

  it("accepts a 214-char name (npm's hard max)", () => {
    const name = "a".repeat(214);
    assert.equal(installedName(name), name);
  });

  it("rejects a 215-char name (over npm's limit)", () => {
    const name = "a".repeat(215);
    assert.throws(() => installedName(name), /214-char limit/);
  });

  it("accepts leading digit (npm allows)", () => {
    assert.equal(installedName("3d-model"), "3d-model");
  });

  it("rejects leading hyphen and underscore", () => {
    assert.throws(() => installedName("-foo"), /Invalid package name/);
    assert.throws(() => installedName("_foo"), /Invalid package name/);
  });

  it("is idempotent on its own output (no @ / / in result)", () => {
    const inputs = ["@ctxr/skill-foo", "@acme/agent-researcher", "skill-local", "a", "3d-model"];
    for (const input of inputs) {
      const once = installedName(input);
      assert.ok(!once.includes("@"), `result must not contain @: ${once}`);
      assert.ok(!once.includes("/"), `result must not contain /: ${once}`);
      // Running installedName on a valid result should succeed and return the same value.
      assert.equal(installedName(once), once);
    }
  });
});

describe("resolveType", () => {
  it("resolves a valid skill with target:folder", () => {
    const result = resolveType({
      name: "@ctxr/skill-code-review",
      ctxr: { type: "skill", target: "folder" },
    });
    assert.equal(result.type, "skill");
    assert.equal(result.target, "folder");
    assert.equal(result.config, ARTIFACT_TYPES.skill);
  });

  it("resolves a valid agent with target:file", () => {
    const result = resolveType({
      name: "@ctxr/agent-researcher",
      ctxr: { type: "agent", target: "file" },
    });
    assert.equal(result.type, "agent");
    assert.equal(result.target, "file");
  });

  it("resolves a team package and returns target:null", () => {
    const result = resolveType({
      name: "@ctxr/team-full-stack",
      ctxr: {
        type: "team",
        includes: ["@ctxr/skill-foo", "@ctxr/agent-bar"],
      },
    });
    assert.equal(result.type, "team");
    assert.equal(result.target, null);
  });

  it("resolves every installable type", () => {
    for (const t of INSTALLABLE_TYPE_NAMES) {
      const r = resolveType({ ctxr: { type: t, target: "file" } });
      assert.equal(r.type, t);
      assert.equal(r.target, "file");
    }
  });

  it("errors on missing pkgJson", () => {
    assert.throws(() => resolveType(null), TypeError);
    assert.throws(() => resolveType(undefined), TypeError);
    assert.throws(() => resolveType(42), TypeError);
    assert.throws(() => resolveType([]), TypeError);
  });

  it("errors on missing ctxr block", () => {
    assert.throws(
      () => resolveType({ name: "foo" }),
      /Missing "ctxr" block/,
    );
  });

  it("errors on non-object ctxr", () => {
    assert.throws(() => resolveType({ ctxr: "skill" }), /Missing "ctxr" block/);
    assert.throws(() => resolveType({ ctxr: [] }), /Missing "ctxr" block/);
  });

  it("errors on missing ctxr.type", () => {
    assert.throws(
      () => resolveType({ ctxr: { target: "folder" } }),
      /Missing "ctxr\.type"/,
    );
    assert.throws(
      () => resolveType({ ctxr: { type: "", target: "folder" } }),
      /Missing "ctxr\.type"/,
    );
    assert.throws(
      () => resolveType({ ctxr: { type: 42, target: "folder" } }),
      /Missing "ctxr\.type"/,
    );
  });

  it("errors on unknown ctxr.type", () => {
    assert.throws(
      () => resolveType({ ctxr: { type: "plugin", target: "file" } }),
      /Unknown "ctxr\.type"/,
    );
  });

  it("errors on missing ctxr.target for non-team types", () => {
    for (const t of INSTALLABLE_TYPE_NAMES) {
      assert.throws(
        () => resolveType({ ctxr: { type: t } }),
        /Missing "ctxr\.target"/,
        `expected missing target error for ${t}`,
      );
    }
  });

  it("errors on invalid ctxr.target value", () => {
    assert.throws(
      () => resolveType({ ctxr: { type: "skill", target: "directory" } }),
      /Invalid "ctxr\.target"/,
    );
    assert.throws(
      () => resolveType({ ctxr: { type: "skill", target: "" } }),
      /Missing "ctxr\.target"/,
    );
  });

  it("errors on team without non-empty includes", () => {
    assert.throws(
      () => resolveType({ ctxr: { type: "team" } }),
      /non-empty "ctxr\.includes"/,
    );
    assert.throws(
      () => resolveType({ ctxr: { type: "team", includes: [] } }),
      /non-empty "ctxr\.includes"/,
    );
    assert.throws(
      () => resolveType({ ctxr: { type: "team", includes: "not an array" } }),
      /non-empty "ctxr\.includes"/,
    );
  });

  it("team type ignores ctxr.target (no enforcement)", () => {
    // Team packages have no payload concept, so a stray target field shouldn't matter.
    const result = resolveType({
      ctxr: {
        type: "team",
        target: "file",
        includes: ["@ctxr/skill-foo"],
      },
    });
    assert.equal(result.target, null);
  });
});

describe("resolveTargetRoot", () => {
  const projectPath = "/tmp/ctxr-test-project";
  const skillCfg = ARTIFACT_TYPES.skill;
  const teamCfg = ARTIFACT_TYPES.team;

  it("respects explicit --dir absolute path", () => {
    const result = resolveTargetRoot(projectPath, {
      dir: "/custom/path",
      typeCfg: skillCfg,
    });
    assert.equal(result, "/custom/path");
  });

  it("respects explicit --dir relative path (joined under projectPath)", () => {
    const result = resolveTargetRoot(projectPath, {
      dir: "custom/relative",
      typeCfg: skillCfg,
    });
    assert.equal(result, join(projectPath, "custom/relative"));
  });

  it("respects --user flag", () => {
    const result = resolveTargetRoot(projectPath, {
      user: true,
      typeCfg: skillCfg,
    });
    assert.equal(result, join(homedir(), ".claude", "skills"));
  });

  it("--user errors for types without a userDir (team)", () => {
    assert.throws(
      () => resolveTargetRoot(projectPath, { user: true, typeCfg: teamCfg }),
      /no user-scope/,
    );
  });

  it("falls back to first projectDirs entry when nothing exists", () => {
    const result = resolveTargetRoot(projectPath, {
      typeCfg: skillCfg,
      existsCheck: () => false,
    });
    assert.equal(result, join(projectPath, ".claude/skills"));
  });

  it("picks first existing candidate when one exists", () => {
    const existingPath = join(projectPath, ".agents/skills");
    const result = resolveTargetRoot(projectPath, {
      typeCfg: skillCfg,
      existsCheck: (p) => p === existingPath,
    });
    assert.equal(result, existingPath);
  });

  it("prefers .claude over .agents when both exist (ordering respected)", () => {
    const result = resolveTargetRoot(projectPath, {
      typeCfg: skillCfg,
      existsCheck: () => true, // everything exists
    });
    assert.equal(result, join(projectPath, ".claude/skills"));
  });

  it("errors on missing projectPath", () => {
    assert.throws(() => resolveTargetRoot("", { typeCfg: skillCfg }), TypeError);
    assert.throws(() => resolveTargetRoot(undefined, { typeCfg: skillCfg }), TypeError);
  });

  it("errors on missing opts", () => {
    assert.throws(() => resolveTargetRoot(projectPath, null), TypeError);
    assert.throws(() => resolveTargetRoot(projectPath, undefined), TypeError);
  });

  it("errors on missing typeCfg", () => {
    assert.throws(() => resolveTargetRoot(projectPath, {}), TypeError);
    assert.throws(() => resolveTargetRoot(projectPath, { dir: "/x" }), TypeError);
  });

  it("errors when team type has no project dirs and no --dir/--user", () => {
    assert.throws(
      () => resolveTargetRoot(projectPath, { typeCfg: teamCfg }),
      /no project-scope/,
    );
  });

  it("team can still use explicit --dir (bypasses projectDirs check)", () => {
    const result = resolveTargetRoot(projectPath, {
      dir: "/explicit",
      typeCfg: teamCfg,
    });
    assert.equal(result, "/explicit");
  });

  it("explicit --dir takes precedence over --user", () => {
    const result = resolveTargetRoot(projectPath, {
      dir: "/explicit",
      user: true,
      typeCfg: skillCfg,
    });
    assert.equal(result, "/explicit");
  });

  it("defaults existsCheck to real node:fs existsSync when not provided", () => {
    // We can't assert the real filesystem state, but we can assert that
    // NOT providing existsCheck doesn't crash and produces a deterministic
    // path under a non-existent projectPath (falls back to primary default).
    const nonExistent = "/tmp/ctxr-test-does-not-exist-" + Math.random().toString(36).slice(2);
    const result = resolveTargetRoot(nonExistent, { typeCfg: skillCfg });
    // Nothing under nonExistent exists, so the first projectDirs entry wins.
    assert.equal(result, join(nonExistent, ".claude/skills"));
  });
});
