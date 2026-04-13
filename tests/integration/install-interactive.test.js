/**
 * install-interactive.test.js
 *
 * Exercises `install.js`'s interactive code paths via in-process import +
 * dependency injection. The `install` command's default export accepts
 * `opts.prompt` as a mock of `src/lib/interactive.js`; tests pass a mock
 * whose `select`/`text`/`confirm` return pre-programmed answers, so we
 * can verify:
 *
 *   - the shared destination menu is shown with the right options
 *   - each destination strategy (PROJECT_CLAUDE / PROJECT_AGENTS /
 *     USER_GLOBAL / CUSTOM) lands files in the right place
 *   - the per-item stay/move prompt fires when an artifact is already
 *     installed at a DIFFERENT location than the shared choice
 *   - `--yes` + already-installed = sticky in place (never destructively
 *     moves)
 *   - CI=true triggers non-interactive fallback
 *   - `-i` / `--interactive` overrides CI=true
 *   - Ctrl+C inside a prompt aborts cleanly via UserAbortError
 *
 * The mock's call-log is asserted so tests pin the exact prompt messages
 * and options that were rendered. Using in-process imports avoids the
 * spawnSync/pty friction of scripting arrow-key navigation against a
 * real clack prompt — the interactive module is the sole integration
 * point, and it's fully controlled here.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import installCommand from "../../src/commands/install.js";
import { UserAbortError } from "../../src/lib/interactive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");

/**
 * Build a mock prompt module that records every call and returns
 * pre-programmed answers from a queue. Tests prep the queue, run the
 * command, then assert on `calls`.
 *
 * The mock deliberately does NOT respect flags for isNonInteractive —
 * it always reports "interactive" so the command's prompt paths fire.
 * Tests that want non-interactive coverage use real `interactive.js`
 * with CI=true or --yes in the flag set.
 */
function mockPrompt(answers) {
  const calls = [];
  let i = 0;
  const take = () => {
    if (i >= answers.length) {
      throw new Error(
        `Mock prompt ran out of answers (needed ${i + 1}, had ${answers.length})`,
      );
    }
    return answers[i++];
  };
  return {
    isNonInteractive: () => false,
    intro: (title) => calls.push({ type: "intro", title }),
    outro: (summary) => calls.push({ type: "outro", summary }),
    select: async ({ message, options, defaultValue }) => {
      calls.push({ type: "select", message, options, defaultValue });
      const ans = take();
      if (ans instanceof Error) throw ans;
      return ans;
    },
    text: async ({ message, defaultValue }) => {
      calls.push({ type: "text", message, defaultValue });
      const ans = take();
      if (ans instanceof Error) throw ans;
      return ans;
    },
    confirm: async ({ message, defaultValue }) => {
      calls.push({ type: "confirm", message, defaultValue });
      const ans = take();
      if (ans instanceof Error) throw ans;
      return ans;
    },
    UserAbortError,
    calls,
  };
}

describe("install-interactive — shared destination menu", () => {
  let projectDir;
  let fakeHome;
  let origHome;
  let origCwd;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-iinst-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-iinst-home-"));
    origHome = process.env.HOME;
    origCwd = process.cwd();
    process.env.HOME = fakeHome;
    process.chdir(projectDir);
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("renders a menu with exactly four distinct strategy options", async () => {
    // Answer: pick PROJECT_CLAUDE (the default auto-detect in a fresh project).
    const prompt = mockPrompt(["project-claude"]);
    await installCommand(
      [join(FIXTURES, "skill", "valid")],
      { prompt },
    );
    const select = prompt.calls.find((c) => c.type === "select");
    assert.ok(select, "shared destination select was not rendered");
    const values = select.options.map((o) => o.value);
    // Pin cardinality — a regression that adds or removes an option must
    // fail here rather than sneaking through the sort() equality below.
    assert.equal(values.length, 4, "expected exactly 4 strategy options");
    // Pin distinctness — catches a duplicate-key regression that sort()
    // wouldn't notice.
    assert.equal(
      new Set(values).size,
      4,
      "expected 4 distinct option values",
    );
    // Pin identity of the 4 options.
    assert.deepEqual(
      [...values].sort(),
      ["custom", "project-agents", "project-claude", "user-global"].sort(),
    );
    // Default is the auto-detect — PROJECT_CLAUDE for a fresh project.
    assert.equal(select.defaultValue, "project-claude");
    // Skill landed under the project-claude target.
    assert.ok(
      existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
  });

  it("PROJECT_AGENTS choice routes the install to .agents/skills/", async () => {
    const prompt = mockPrompt(["project-agents"]);
    await installCommand([join(FIXTURES, "skill", "valid")], { prompt });
    assert.ok(
      existsSync(join(projectDir, ".agents", "skills", "valid-skill", "SKILL.md")),
    );
    assert.ok(
      !existsSync(join(projectDir, ".claude", "skills", "valid-skill")),
    );
  });

  it("USER_GLOBAL choice routes the install to ~/.claude/skills/", async () => {
    const prompt = mockPrompt(["user-global"]);
    await installCommand([join(FIXTURES, "skill", "valid")], { prompt });
    assert.ok(
      existsSync(join(fakeHome, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
  });

  it("CUSTOM choice prompts for a path via text() and uses it", async () => {
    const customBase = join(projectDir, "my-custom-loc");
    const prompt = mockPrompt(["custom", customBase]);
    await installCommand([join(FIXTURES, "skill", "valid")], { prompt });
    // Text prompt was shown for the path
    const textCall = prompt.calls.find((c) => c.type === "text");
    assert.ok(textCall, "custom path text prompt was not rendered");
    // Skill landed under the custom base + <installedName>
    assert.ok(
      existsSync(join(customBase, "valid-skill", "SKILL.md")),
      `Expected custom install at ${customBase}/valid-skill/`,
    );
  });

  it("skips the shared prompt entirely when --user is explicit", async () => {
    // --user bypasses the menu — kit should not call prompt.select at all.
    const prompt = mockPrompt([]);
    await installCommand(
      [join(FIXTURES, "skill", "valid"), "--user"],
      { prompt },
    );
    const selectCalls = prompt.calls.filter((c) => c.type === "select");
    assert.equal(selectCalls.length, 0, "select should not be called when --user is set");
    assert.ok(
      existsSync(join(fakeHome, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
  });

  it("skips the shared prompt entirely when --dir is explicit", async () => {
    const targetBase = join(projectDir, "explicit-target");
    const prompt = mockPrompt([]);
    await installCommand(
      [join(FIXTURES, "skill", "valid"), "--dir", targetBase],
      { prompt },
    );
    const selectCalls = prompt.calls.filter((c) => c.type === "select");
    assert.equal(selectCalls.length, 0, "select should not be called when --dir is set");
    assert.ok(
      existsSync(join(targetBase, "valid-skill", "SKILL.md")),
    );
  });
});

describe("install-interactive — per-item stay/move prompt", () => {
  let projectDir;
  let fakeHome;
  let origHome;
  let origCwd;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-iinst-existing-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-iinst-existing-home-"));
    origHome = process.env.HOME;
    origCwd = process.cwd();
    process.env.HOME = fakeHome;
    process.chdir(projectDir);
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("fires per-item stay/move prompt when existing location differs from shared choice", async () => {
    // First install: user picks project-claude in the shared menu.
    // The skill lands in .claude/skills/.
    await installCommand(
      [join(FIXTURES, "skill", "valid")],
      { prompt: mockPrompt(["project-claude"]) },
    );
    assert.ok(existsSync(join(projectDir, ".claude", "skills", "valid-skill")));

    // Second install: user picks USER_GLOBAL this time. The skill is
    // already installed in project-claude, so kit should fire a per-item
    // prompt asking "keep at .claude/skills/ or move to ~/.claude/skills/?".
    // The per-item menu includes each strategy's resolved leaf + custom +
    // skip. We answer with the MOVE value shape for user-global.
    const projectLeaf = join(projectDir, ".claude", "skills", "valid-skill");
    const userLeaf = join(fakeHome, ".claude", "skills", "valid-skill");

    const prompt2 = mockPrompt([
      "user-global", // shared menu
      { kind: "move", strategy: "user-global", target: userLeaf }, // per-item stay/move
    ]);
    await installCommand(
      [join(FIXTURES, "skill", "valid")],
      { prompt: prompt2 },
    );

    // Should have at least two select calls (shared + per-item)
    const selectCalls = prompt2.calls.filter((c) => c.type === "select");
    assert.ok(
      selectCalls.length >= 2,
      `Expected at least 2 select calls (shared + per-item), got ${selectCalls.length}`,
    );

    // Old location removed, new location populated.
    assert.ok(
      !existsSync(projectLeaf),
      "Old project-claude install should be removed after move",
    );
    assert.ok(
      existsSync(join(userLeaf, "SKILL.md")),
      "New user-global install should be present after move",
    );
  });

  it("per-item prompt with 'keep' decision updates in place at existing location", async () => {
    // First install to project-claude.
    await installCommand(
      [join(FIXTURES, "skill", "valid")],
      { prompt: mockPrompt(["project-claude"]) },
    );
    const projectLeaf = join(projectDir, ".claude", "skills", "valid-skill");
    assert.ok(existsSync(projectLeaf));

    // Second install: pick USER_GLOBAL in the shared menu, then pick
    // "keep at current location" in the per-item menu. Result: the skill
    // should STILL be at .claude/skills/ (not moved).
    const prompt2 = mockPrompt([
      "user-global",
      { kind: "move", strategy: "project-claude", target: projectLeaf },
    ]);
    await installCommand(
      [join(FIXTURES, "skill", "valid")],
      { prompt: prompt2 },
    );

    // Still at project-claude, nothing at user-global.
    assert.ok(
      existsSync(join(projectLeaf, "SKILL.md")),
      "Skill should remain at .claude/skills/",
    );
    assert.ok(
      !existsSync(join(fakeHome, ".claude", "skills", "valid-skill")),
      "User-global install should NOT exist",
    );
  });

  it("per-item 'skip' decision skips the item and records it in the summary", async () => {
    // First install to project-claude.
    await installCommand(
      [join(FIXTURES, "skill", "valid")],
      { prompt: mockPrompt(["project-claude"]) },
    );

    // Second install: pick USER_GLOBAL, then 'skip' in the per-item menu.
    const prompt2 = mockPrompt([
      "user-global",
      { kind: "skip" },
    ]);
    await installCommand(
      [join(FIXTURES, "skill", "valid")],
      { prompt: prompt2 },
    );

    // The skill should still be at its original project-claude location.
    assert.ok(
      existsSync(join(projectDir, ".claude", "skills", "valid-skill")),
    );
    // And not at user-global.
    assert.ok(
      !existsSync(join(fakeHome, ".claude", "skills", "valid-skill")),
    );
  });
});

describe("install-interactive — non-interactive fallback paths", () => {
  let projectDir;
  let fakeHome;
  let origHome;
  let origCwd;
  let origCI;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-iinst-non-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-iinst-non-home-"));
    origHome = process.env.HOME;
    origCwd = process.cwd();
    origCI = process.env.CI;
    process.env.HOME = fakeHome;
    process.chdir(projectDir);
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCI === undefined) delete process.env.CI;
    else process.env.CI = origCI;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("--yes skips the shared menu and uses auto-detect default", async () => {
    // Use the REAL interactive module (no mock). --yes should short-
    // circuit isNonInteractive → no prompts fire, install proceeds
    // with auto-detect to .claude/skills/.
    await installCommand([join(FIXTURES, "skill", "valid"), "--yes"]);
    assert.ok(
      existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
  });

  it("--yes + already installed at auto-detect location = sticky in place", async () => {
    // First install with --yes lands at .claude/skills/ (auto-detect).
    await installCommand([join(FIXTURES, "skill", "valid"), "--yes"]);
    const projectLeaf = join(projectDir, ".claude", "skills", "valid-skill");
    assert.ok(existsSync(projectLeaf));

    // Second install with --yes ALONE (no --user/--dir): the auto-detect
    // path runs through handleExistingInstall which sticks at the
    // existing location. Exit 0, no move.
    await installCommand([join(FIXTURES, "skill", "valid"), "--yes"]);
    assert.ok(
      existsSync(join(projectLeaf, "SKILL.md")),
      "Sticky-in-place: --yes alone should update the existing install in place",
    );
    // And no user-global install was created.
    assert.ok(
      !existsSync(join(fakeHome, ".claude", "skills", "valid-skill")),
    );
  });

  it("--yes + --user = explicit directive MOVES existing install", async () => {
    // Different semantics: --user is an explicit destination directive.
    // When combined with --yes, kit honors the directive (moves to
    // user-global) rather than sticking at the auto-detected location.
    await installCommand([join(FIXTURES, "skill", "valid"), "--yes"]);
    const projectLeaf = join(projectDir, ".claude", "skills", "valid-skill");
    assert.ok(existsSync(projectLeaf));

    // --yes --user: the explicit --user directive takes precedence over
    // sticky-in-place. The install moves to ~/.claude/skills/.
    await installCommand([join(FIXTURES, "skill", "valid"), "--yes", "--user"]);
    assert.ok(
      !existsSync(projectLeaf),
      "With --yes --user, the existing install should be moved to user-global",
    );
    assert.ok(
      existsSync(join(fakeHome, ".claude", "skills", "valid-skill", "SKILL.md")),
      "With --yes --user, the new install should land at user-global",
    );
  });

  it("CI=true triggers non-interactive auto-detect with no prompts", async () => {
    process.env.CI = "true";
    // Without a mock prompt and without --yes — CI alone should suffice.
    await installCommand([join(FIXTURES, "skill", "valid")]);
    assert.ok(
      existsSync(join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md")),
    );
  });

  it("-i/--interactive beats CI=true and re-enables the prompt", async () => {
    process.env.CI = "true";
    // -i forces interactive even in CI. Without a mock prompt, this would
    // try to spawn real clack UI (and fail under spawnSync's piped stdin).
    // With a mock prompt, the select call goes through as normal.
    const prompt = mockPrompt(["project-claude"]);
    await installCommand(
      [join(FIXTURES, "skill", "valid"), "--interactive"],
      { prompt },
    );
    const selectCalls = prompt.calls.filter((c) => c.type === "select");
    assert.ok(
      selectCalls.length > 0,
      "Expected --interactive to force the shared prompt even under CI=true",
    );
  });
});

describe("install-interactive — Ctrl+C abort", () => {
  let projectDir;
  let fakeHome;
  let origHome;
  let origCwd;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-iinst-abort-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-iinst-abort-home-"));
    origHome = process.env.HOME;
    origCwd = process.cwd();
    process.env.HOME = fakeHome;
    process.chdir(projectDir);
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("propagates UserAbortError from the shared menu cleanly", async () => {
    // Mock prompt throws UserAbortError on first call, simulating Ctrl+C.
    const prompt = mockPrompt([new UserAbortError()]);
    await assert.rejects(
      installCommand([join(FIXTURES, "skill", "valid")], { prompt }),
      (err) => err instanceof UserAbortError && err.exitCode === 130,
    );
    // No files should have been copied since the prompt aborted before
    // install phase.
    assert.ok(
      !existsSync(join(projectDir, ".claude", "skills", "valid-skill")),
    );
  });
});
