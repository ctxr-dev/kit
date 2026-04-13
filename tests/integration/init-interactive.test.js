/**
 * init-interactive.test.js
 *
 * Pins the 9-question wizard and its smart defaults + flag bypass.
 * Uses in-process import + mock prompt to script the wizard answers
 * without pty emulation. Every test constructs a temp target dir,
 * answers the wizard, and asserts on the scaffolded package.json.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import initCommand from "../../src/commands/init.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function mockPrompt(answers) {
  const calls = [];
  let i = 0;
  return {
    isNonInteractive: () => false,
    intro: () => {},
    outro: () => {},
    select: async ({ message, options, defaultValue }) => {
      calls.push({ type: "select", message, options, defaultValue });
      if (i >= answers.length)
        throw new Error(`Mock ran out of answers at select #${i + 1}`);
      return answers[i++];
    },
    text: async ({ message, defaultValue }) => {
      calls.push({ type: "text", message, defaultValue });
      if (i >= answers.length)
        throw new Error(`Mock ran out of answers at text #${i + 1}`);
      return answers[i++];
    },
    confirm: async ({ message, defaultValue }) => {
      calls.push({ type: "confirm", message, defaultValue });
      if (i >= answers.length)
        throw new Error(`Mock ran out of answers at confirm #${i + 1}`);
      return answers[i++];
    },
    calls,
  };
}

describe("init-interactive — wizard", () => {
  let scratch;
  let origCwd;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ctxr-init-"));
    origCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("walks the wizard questions in order when none are flag-bypassed", async () => {
    const target = join(scratch, "wiz");
    // Answer sequence (positional provides name, so askName doesn't prompt;
    // skill is always folder so askTarget doesn't prompt; target dir doesn't
    // exist so askOverwrite returns true without prompting):
    //   1. askType        → select "skill"
    //   (askName skipped — positional "wiz")
    //   2. askAuthor      → text "Test Author"
    //   3. askDescription → text "A test skill for the wizard"
    //   4. askLicense     → select "MIT"
    //   (askTarget skipped — skill → folder)
    //   (askOverwrite skipped — target doesn't exist yet)
    //   5. askGitInit     → confirm false
    //   6. askNpmInstall  → confirm false
    const prompt = mockPrompt([
      "skill",
      "Test Author",
      "A test skill for the wizard",
      "MIT",
      false,
      false,
    ]);
    await initCommand([target], { prompt });

    // Expected call sequence (intro first, then the wizard steps, then outro)
    const types = prompt.calls.map((c) => c.type);
    // Must include at least: select (type), select (license), confirm, confirm
    // The name prompt is skipped because positional was given.
    // The author/description prompts are text calls.
    assert.ok(types.includes("select"));
    assert.ok(types.includes("text"));
    assert.ok(types.includes("confirm"));

    // Package was scaffolded.
    assert.ok(existsSync(join(target, "package.json")));
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    assert.equal(pkg.ctxr.type, "skill");
    assert.equal(pkg.description, "A test skill for the wizard");
    assert.equal(pkg.license, "MIT");
  });

  it("flag bypasses: --type and positional skip their respective prompts", async () => {
    const target = join(scratch, "flaggy");
    // With --type agent and positional "flaggy", kit skips askType and askName.
    // Sequence: askAuthor, askDescription, askLicense, askTarget (agent has
    // both folder and file shapes), askGitInit, askNpmInstall.
    const prompt = mockPrompt([
      "Flag Author",
      "Agent via wizard",
      "Apache-2.0",
      "file",
      false,
      false,
    ]);
    await initCommand([target, "--type", "agent"], { prompt });

    // No "select type" call should have happened.
    const typeSelect = prompt.calls.find(
      (c) => c.type === "select" && c.message && c.message.toLowerCase().includes("type"),
    );
    assert.equal(typeSelect, undefined, "--type should skip the type prompt");

    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    assert.equal(pkg.ctxr.type, "agent");
  });

  it("smart default for author comes from git config (or empty if git missing)", async () => {
    // Just assert the text() default for the author step is a string
    // (possibly empty). Real git config may or may not be set in the
    // test environment — we don't assert on the value, only the shape.
    // Answer sequence with positional → skip askName:
    //   type, author, description, license, git, npm
    const target = join(scratch, "gitauth");
    const prompt = mockPrompt([
      "skill",
      "",
      "Desc",
      "MIT",
      false,
      false,
    ]);
    await initCommand([target], { prompt });

    const authorCall = prompt.calls.find(
      (c) => c.type === "text" && c.message && c.message.toLowerCase().includes("author"),
    );
    assert.ok(authorCall, "author text prompt was not rendered");
    assert.equal(typeof authorCall.defaultValue, "string");
  });

  it("--yes skips wizard entirely, uses all defaults", async () => {
    // With --yes, the wizard is skipped. Description falls through to
    // the non-interactive placeholder default. No prompt should fire.
    //
    // Use the REAL interactive module (no mock) because the mock's
    // isNonInteractive returns false unconditionally to force prompt
    // paths in other tests. For --yes we want the real precedence logic.
    const target = join(scratch, "yesskill");
    await initCommand([target, "--yes"]);

    assert.ok(existsSync(join(target, "package.json")));
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    assert.equal(pkg.ctxr.type, "skill");
    // Description has the TODO placeholder from the non-interactive fallback.
    assert.ok(pkg.description.toLowerCase().includes("todo"));
  });

  it("empty target dir scaffolds cleanly without overwrite prompt", async () => {
    // askOverwrite short-circuits to true on an empty existing dir —
    // kit scaffolds directly into it. No confirm() call for overwrite.
    const target = join(scratch, "empty-existing");
    mkdirSync(target, { recursive: true });

    const prompt = mockPrompt([
      "skill",
      "", // author
      "Fills an empty dir",
      "MIT",
      false, // git
      false, // npm
    ]);
    await initCommand([target], { prompt });

    // No overwrite confirm was called (count confirms: git + npm = 2,
    // no additional confirm for overwrite).
    const confirms = prompt.calls.filter((c) => c.type === "confirm");
    assert.equal(
      confirms.length,
      2,
      "Empty target dir should not trigger overwrite confirm (only git + npm)",
    );

    // Scaffolded.
    assert.ok(existsSync(join(target, "package.json")));
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    assert.equal(pkg.description, "Fills an empty dir");
  });

  it("wizard 'overwrite' prompt fires when target dir exists and is non-empty", async () => {
    const target = join(scratch, "existing");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "junk.txt"), "pre-existing");

    // Positional → skip askName. askTarget skipped (skill=folder).
    // askOverwrite fires because dir exists + non-empty; we answer `false`
    // so init throws "Overwrite declined" BEFORE reaching git/npm.
    // (The interactive decline path uses a distinct error message from
    // the non-interactive path, which says "Directory already exists"
    // because the user never saw a prompt — see init.js askOverwrite.)
    const prompt = mockPrompt([
      "skill", // askType
      "", // askAuthor
      "Test", // askDescription
      "MIT", // askLicense
      false, // askOverwrite → decline → throws
    ]);
    await assert.rejects(
      initCommand([target], { prompt }),
      /overwrite declined/i,
    );
    // Pre-existing file is still there — the wizard refused to overwrite.
    assert.ok(existsSync(join(target, "junk.txt")));
  });
});
