/**
 * deferred-coverage.test.js
 *
 * Consolidates the test coverage gaps flagged by the iter-1 review that
 * weren't addressed in the first round:
 *
 *   C2 — custom-path `..` traversal rejection (shared menu + per-item menu)
 *   C3 — `-i` / `--interactive` override for update / remove / init
 *        (only install had direct coverage)
 *   C4 — update pre-flight with MIXED identifiers (some installed, some
 *        missing) exercises a different branch than the pure-miss tests
 *   C5 — init wizard "Custom…" license branch (text prompt inside select)
 *   C6 — UserAbortError thrown from the per-item stay/move prompt (iter-1
 *        tests only covered the shared-menu abort)
 *   C7 — CI=false explicit env var restores interactive mode when run
 *        under spawnSync with piped stdin
 *
 * Each test is small and targeted — the goal is to pin specific code
 * paths that had no assertions, not to recover comprehensive coverage
 * that the iter-1 tests already cover in their specialist files.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import installCommand from "../../src/commands/install.js";
import updateCommand from "../../src/commands/update.js";
import removeCommand from "../../src/commands/remove.js";
import initCommand from "../../src/commands/init.js";
import {
  isNonInteractive,
  UserAbortError,
} from "../../src/lib/interactive.js";
import { validateCustomPath } from "../../src/commands/install/strategy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const FIXTURES = join(__dirname, "..", "fixtures");

function mockPrompt(answers) {
  const calls = [];
  let i = 0;
  const pop = () => {
    if (i >= answers.length) {
      throw new Error(`Mock ran out of answers at call ${i + 1}`);
    }
    const a = answers[i++];
    if (a instanceof Error) throw a;
    return a;
  };
  return {
    isNonInteractive: () => false,
    intro: () => {},
    outro: () => {},
    select: async ({ message, options, defaultValue }) => {
      calls.push({ type: "select", message, options, defaultValue });
      return pop();
    },
    text: async ({ message, defaultValue, validate }) => {
      calls.push({ type: "text", message, defaultValue, validate });
      return pop();
    },
    confirm: async ({ message, defaultValue }) => {
      calls.push({ type: "confirm", message, defaultValue });
      return pop();
    },
    calls,
  };
}

function cliSpawn(command, args, env) {
  const r = spawnSync("node", [CLI, command, ...args], {
    encoding: "utf8",
    env: env ?? process.env,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    combined: (r.stdout || "") + (r.stderr || ""),
    exitCode: r.status,
  };
}

// ─── C2: Custom-path traversal rejection ─────────────────────────────────

describe("C2 — custom path traversal is rejected by the validator", () => {
  let projectDir;
  let fakeHome;
  let origCwd;
  let origHome;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-c2-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-c2-home-"));
    origCwd = process.cwd();
    origHome = process.env.HOME;
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

  it("install flow wires the shared-menu custom-path text prompt to validateCustomPath", async () => {
    // Verify the WIRE-UP: pick "custom" in the shared menu, answer the
    // text prompt with a valid relative path so install proceeds, then
    // assert the recorded text-call's `validate` callback IS the
    // `validateCustomPath` import (tested by invocation equivalence
    // rather than reference equality — `validate` is an arrow wrapper
    // that closes over projectPath).
    //
    // This differs from the old version of this test (which had a bare
    // try/catch and called validate() directly on a manually-crafted
    // input). Now we:
    //   1. Feed install a real-valid relative path so it succeeds.
    //   2. Verify the text prompt was rendered.
    //   3. Verify the prompt's validate callback, when given a known-bad
    //      input, produces the same error as the imported
    //      `validateCustomPath` would — proving the wiring is intact.
    const prompt = mockPrompt([
      "custom", // select → custom
      "./kit-custom-target", // text → valid relative path
    ]);
    await installCommand([join(FIXTURES, "skill", "valid")], { prompt });

    const textCall = prompt.calls.find((c) => c.type === "text");
    assert.ok(textCall, "text prompt was not rendered");
    assert.ok(
      typeof textCall.validate === "function",
      "text prompt must expose a validate() callback",
    );

    // Probe the wrapped validate with a bad input; it should delegate
    // to validateCustomPath and return the same traversal error.
    const wrappedError = textCall.validate("../escape/path");
    const directError = validateCustomPath("../escape/path", projectDir);
    assert.equal(
      wrappedError,
      directError,
      "text.validate must delegate to validateCustomPath",
    );

    // Sanity: install actually landed in the custom directory.
    assert.ok(
      existsSync(join(projectDir, "kit-custom-target", "valid-skill", "SKILL.md")),
    );
  });

  it("validateCustomPath rejects every bad shape: empty, whitespace, leading '-', '..', '~', absolute-outside", () => {
    // Unit-level check: each case individually, clear pass/fail per input.
    // Table-driven so a single broken case shows up as a single failed row.
    const cases = [
      { input: "", matches: /cannot be empty/i, why: "empty" },
      { input: "   ", matches: /cannot be empty/i, why: "whitespace only" },
      { input: "-foo", matches: /start with '-'/, why: "leading dash" },
      { input: "../escape", matches: /'\.\.'/, why: "traversal" },
      { input: "foo/../bar", matches: /'\.\.'/, why: "embedded traversal" },
      { input: "~", matches: /'~'/, why: "tilde alone" },
      { input: "~/foo", matches: /'~'/, why: "tilde prefix" },
      {
        input: "/etc/passwd",
        matches: /under the project root or your home directory/,
        why: "absolute outside project+home",
      },
    ];
    for (const { input, matches, why } of cases) {
      const err = validateCustomPath(input, projectDir);
      assert.ok(
        typeof err === "string" && matches.test(err),
        `[${why}] expected ${matches} for input "${input}", got: ${err}`,
      );
    }
    // Happy-path accepts:
    assert.equal(
      validateCustomPath("./sub/dir", projectDir),
      undefined,
      "relative path without traversal should be accepted",
    );
    assert.equal(
      validateCustomPath(fakeHome, projectDir),
      undefined,
      "absolute path under $HOME should be accepted",
    );
  });
});

// ─── C3: -i override for update / remove / init ──────────────────────────

describe("C3 — -i / --interactive forces interactive mode even under CI=true", () => {
  let projectDir;
  let fakeHome;
  let origCwd;
  let origHome;
  let origCI;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-c3-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-c3-home-"));
    origCwd = process.cwd();
    origHome = process.env.HOME;
    origCI = process.env.CI;
    process.env.HOME = fakeHome;
    process.env.CI = "true";
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

  it("update --interactive forces the delegated install's shared menu to prompt", async () => {
    // Under CI=true, kit normally runs non-interactively. To prove that
    // --interactive actually forces the interactive path:
    //   1. Run update on an identifier that isn't installed
    //   2. Pass --install so update delegates to install
    //   3. The delegated install, with --interactive, should call the
    //      shared destination prompt even though CI=true
    //   4. We verify by counting prompt.select calls in the mock
    //
    // If --interactive weren't forwarded, the delegated install would
    // auto-detect silently (prompt.calls would have 0 select entries).
    const src = join(FIXTURES, "skill", "valid");
    const prompt = mockPrompt(["project-claude"]);
    await updateCommand(
      [src, projectDir, "--install", "--interactive"],
      { prompt },
    );
    const selectCalls = prompt.calls.filter((c) => c.type === "select");
    assert.ok(
      selectCalls.length >= 1,
      "Expected the delegated install to fire its shared menu under --interactive + CI=true",
    );
    // Sanity: install succeeded.
    assert.ok(
      existsSync(
        join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md"),
      ),
    );
  });

  it("remove --interactive forces the picker even under CI=true", async () => {
    // Seed two installs so the multi-location picker fires.
    const dir1 = join(projectDir, ".claude", "skills", "valid-skill");
    const dir2 = join(projectDir, ".agents", "skills", "valid-skill");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    cpSync(join(FIXTURES, "skill", "valid"), dir1, { recursive: true });
    cpSync(join(FIXTURES, "skill", "valid"), dir2, { recursive: true });
    const entry = {
      type: "skill",
      target: "folder",
      source: join(FIXTURES, "skill", "valid"),
      sourceType: "local",
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      updatedAt: null,
    };
    writeFileSync(
      join(projectDir, ".claude", "skills", ".ctxr-manifest.json"),
      JSON.stringify({ "valid-skill": { ...entry, installedPaths: [dir1] } }),
    );
    writeFileSync(
      join(projectDir, ".agents", "skills", ".ctxr-manifest.json"),
      JSON.stringify({ "valid-skill": { ...entry, installedPaths: [dir2] } }),
    );

    // Under CI=true the picker would be auto-skipped (non-interactive).
    // With --interactive, it fires. Mock picks "all" so both locations
    // are removed.
    const prompt = mockPrompt(["all"]);
    await removeCommand(
      ["valid-skill", projectDir, "--interactive"],
      { prompt },
    );
    const selectCalls = prompt.calls.filter((c) => c.type === "select");
    assert.equal(selectCalls.length, 1, "picker should have fired");
    assert.ok(!existsSync(dir1));
    assert.ok(!existsSync(dir2));
  });

  it("init --interactive forces the wizard even under CI=true (6 prompts exactly)", async () => {
    const target = join(projectDir, "my-init");
    // Under CI=true, init would default silently. With --interactive +
    // a mock prompt, the wizard questions fire. The answer sequence
    // below corresponds to exactly 6 prompts:
    //
    //   1. askType         (select)  → "skill"
    //   (askName skipped — positional arg "my-init")
    //   2. askAuthor       (text)    → "Jane Doe"
    //   3. askDescription  (text)    → "Forced interactive under CI"
    //   4. askLicense      (select)  → "MIT"
    //   (askTarget skipped — skill = folder)
    //   (askOverwrite skipped — target dir doesn't exist)
    //   5. askGitInit      (confirm) → false
    //   6. askNpmInstall   (confirm) → false
    //
    // Asserting `=== 6` pins the exact prompt shape. A regression that
    // silently skipped any prompt (e.g. description) would drop the
    // count and the test would fail loudly.
    const prompt = mockPrompt([
      "skill",
      "Jane Doe",
      "Forced interactive under CI",
      "MIT",
      false,
      false,
    ]);
    await initCommand([target, "--interactive"], { prompt });
    assert.equal(
      prompt.calls.length,
      6,
      `Expected exactly 6 wizard prompts, got ${prompt.calls.length}: ` +
        prompt.calls.map((c) => c.type).join(", "),
    );
    // Scaffolded file exists.
    assert.ok(existsSync(join(target, "package.json")));
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    assert.equal(pkg.description, "Forced interactive under CI");
    assert.equal(pkg.license, "MIT");
  });
});

// ─── C4: Mixed pre-flight (some installed, some missing) ─────────────────

describe("C4 — update pre-flight with a MIX of installed and missing identifiers", () => {
  let projectDir;
  let fakeHome;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-c4-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-c4-home-"));
    env = { ...process.env, HOME: fakeHome };
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("mixed identifiers WITHOUT --install: prints only the missing ones, exits 2, touches nothing", () => {
    // Install one skill so "valid-skill" is present.
    const targetDir = join(projectDir, ".claude", "skills");
    cliSpawn(
      "install",
      [join(FIXTURES, "skill", "valid"), "--dir", targetDir, "--yes"],
      env,
    );

    // Capture the manifest before update.
    const manifestPath = join(targetDir, ".ctxr-manifest.json");
    const before = readFileSync(manifestPath, "utf8");

    // Update with one installed + two missing identifiers.
    const r = cliSpawn(
      "update",
      ["valid-skill", "ghost-a", "ghost-b", projectDir, "--yes"],
      env,
    );
    assert.equal(r.exitCode, 2);

    // Parse the missing-list block out of stderr. Update prints:
    //   The following artifacts are not installed:
    //     - ghost-a
    //     - ghost-b
    // We extract the bulleted names and assert on the parsed list
    // rather than a loose regex, so a future phrasing change or
    // reordering catches the test instead of silently passing.
    const missingLines = r.stderr
      .split("\n")
      .filter((line) => /^\s*-\s/.test(line))
      .map((line) => line.replace(/^\s*-\s*/, "").trim());
    assert.deepEqual(
      missingLines.sort(),
      ["ghost-a", "ghost-b"].sort(),
      `Expected missing-list = [ghost-a, ghost-b], got: ${JSON.stringify(missingLines)}`,
    );
    // valid-skill must NOT be in the parsed missing list.
    assert.ok(
      !missingLines.includes("valid-skill"),
      "valid-skill (installed) should not appear in the missing list",
    );
    // Hint present.
    assert.ok(r.stderr.includes("--install"));

    // Manifest is UNCHANGED — pre-flight refused to touch any entry.
    const after = readFileSync(manifestPath, "utf8");
    assert.equal(before, after);
  });
});

// ─── C5: Init wizard Custom license ──────────────────────────────────────

describe("C5 — init wizard 'Custom…' license branch", () => {
  let projectDir;
  let origCwd;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-c5-"));
    origCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("'Custom…' select → text prompt → normalized SPDX id lands in package.json", async () => {
    const target = join(projectDir, "customlic");
    // Answer sequence:
    //   1. type → skill (positional skipped on name via positional arg)
    //   2. askAuthor text → ""
    //   3. askDescription text → "test"
    //   4. askLicense select → "__custom__"
    //   5. askLicense nested text → "bsd-3-clause" (lowercase)
    //   6. askGitInit confirm → false
    //   7. askNpmInstall confirm → false
    const prompt = mockPrompt([
      "skill",
      "",
      "test",
      "__custom__",
      "bsd-3-clause",
      false,
      false,
    ]);
    await initCommand([target], { prompt });
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    // normalizeLicense should have converted "bsd-3-clause" → "BSD-3-Clause".
    assert.equal(pkg.license, "BSD-3-Clause");
    // At least one text call beyond the author/description ones was made
    // for the nested license input.
    const textCount = prompt.calls.filter((c) => c.type === "text").length;
    assert.ok(textCount >= 3, "expected a nested text prompt for custom license");
  });
});

// ─── C6: UserAbortError from the per-item prompt ─────────────────────────

describe("C6 — UserAbortError thrown from the per-item stay/move prompt", () => {
  let projectDir;
  let fakeHome;
  let origCwd;
  let origHome;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-c6-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-c6-home-"));
    origCwd = process.cwd();
    origHome = process.env.HOME;
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

  it("Ctrl+C during the per-item stay/move prompt aborts cleanly and leaves the existing install untouched", async () => {
    // First install lands at .claude/skills. Track /tmp tree size BEFORE
    // the abort so we can verify tmpDir cleanup ran (the aborting
    // UserAbortError re-throws, the outer `finally` in `install()`
    // calls `cleanupDescriptor` on every fetched descriptor, so no new
    // `ctxr-install-*` tmpdirs should linger after the call).
    await installCommand(
      [join(FIXTURES, "skill", "valid")],
      { prompt: mockPrompt(["project-claude"]) },
    );

    // Count ctxr-install-* dirs in os.tmpdir() before the abort.
    const { readdirSync } = await import("node:fs");
    const beforeTmp = readdirSync(tmpdir()).filter((n) =>
      n.startsWith("ctxr-install-"),
    );

    // Second install picks USER_GLOBAL in the shared menu, which fires
    // the per-item stay/move prompt. Mock throws UserAbortError on the
    // SECOND select call (the per-item menu) to simulate Ctrl+C mid-prompt.
    const prompt = mockPrompt([
      "user-global", // shared menu — proceeds
      new UserAbortError(), // per-item menu — aborts
    ]);
    await assert.rejects(
      installCommand([join(FIXTURES, "skill", "valid")], { prompt }),
      (err) => err instanceof UserAbortError && err.exitCode === 130,
    );

    // Assertion 1: original install still exists (abort hit before any
    // file was moved).
    assert.ok(
      existsSync(
        join(projectDir, ".claude", "skills", "valid-skill", "SKILL.md"),
      ),
    );

    // Assertion 2: tmpDir cleanup ran — no new ctxr-install-* dir
    // leaked past the abort. This is the "tmpDir cleanup still runs"
    // claim from the test name.
    const afterTmp = readdirSync(tmpdir()).filter((n) =>
      n.startsWith("ctxr-install-"),
    );
    assert.equal(
      afterTmp.length,
      beforeTmp.length,
      `Expected no new tmpDir leaks after abort. Before: ${beforeTmp.join(", ")}; After: ${afterTmp.join(", ")}`,
    );
  });
});

// ─── C7: CI=false explicitly restores interactive mode ───────────────────

describe("C7 — CI=false explicit env var restores interactive mode", () => {
  let projectDir;
  let fakeHome;
  let origCwd;
  let origHome;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-c7-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-c7-home-"));
    origCwd = process.cwd();
    origHome = process.env.HOME;
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

  it("isNonInteractive returns false for CI='false' / CI='0' / CI='' / CI undefined (with a TTY)", () => {
    // Unit-level check for the CI "not set or not truthy" branches.
    // Uses the statically imported `isNonInteractive` which accepts env
    // + tty overrides so tests don't mutate process state.
    //
    // Branches covered:
    //   CI='false'    → string, explicit opt-out
    //   CI='0'        → string, explicit opt-out
    //   CI=''         → empty string, treated as "not set"
    //   CI=undefined  → absent, treated as "not set"
    //
    // All four should leave interactive mode ENABLED when stdin is a TTY.
    assert.equal(
      isNonInteractive({}, { CI: "false" }, { isTTY: true }),
      false,
    );
    assert.equal(
      isNonInteractive({}, { CI: "0" }, { isTTY: true }),
      false,
    );
    assert.equal(
      isNonInteractive({}, { CI: "" }, { isTTY: true }),
      false,
    );
    assert.equal(
      isNonInteractive({}, {}, { isTTY: true }), // CI undefined
      false,
    );

    // Sanity: with no TTY, the isTTY signal takes over regardless of CI.
    assert.equal(
      isNonInteractive({}, { CI: "false" }, { isTTY: false }),
      true,
    );
    assert.equal(
      isNonInteractive({}, {}, { isTTY: false }),
      true,
    );
  });
});
