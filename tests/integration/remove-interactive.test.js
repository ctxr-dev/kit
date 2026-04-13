/**
 * remove-interactive.test.js
 *
 * Pins remove's three new behaviors:
 *
 *   1. Soft-skip missing identifier — no error, exit 0, friendly note.
 *   2. --yes removes from EVERY matching location when the identifier
 *      has multiple installs.
 *   3. Interactive multi-location picker via injected prompt mock.
 *
 * The first two use spawnSync for realistic end-to-end coverage; the
 * picker test uses in-process import + mock prompt to script the
 * select() answer without pty emulation.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import removeCommand from "../../src/commands/remove.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const FIXTURES = join(__dirname, "..", "fixtures");

function cli(command, args, env) {
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

/**
 * Mock prompt module for in-process testing of the multi-location picker.
 * Always reports "interactive" so the picker path fires. Answers are a
 * queue; each prompt call consumes one.
 */
function mockPrompt(answers) {
  const calls = [];
  let i = 0;
  return {
    isNonInteractive: () => false,
    intro: () => {},
    outro: () => {},
    select: async ({ message, options, defaultValue }) => {
      calls.push({ type: "select", message, options, defaultValue });
      if (i >= answers.length) throw new Error("Mock ran out of answers");
      const ans = answers[i++];
      return ans;
    },
    text: async () => {
      throw new Error("remove should not call text()");
    },
    confirm: async ({ message, defaultValue }) => {
      calls.push({ type: "confirm", message, defaultValue });
      if (i >= answers.length) throw new Error("Mock ran out of answers");
      return answers[i++];
    },
    calls,
  };
}

describe("remove-interactive — soft-skip missing identifier", () => {
  let projectDir;
  let fakeHome;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-irem-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-irem-home-"));
    env = { ...process.env, HOME: fakeHome };
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("exits 0 with 'not installed' note when identifier is missing", () => {
    // Install something else so the project isn't empty — verifies the
    // soft-skip only applies to the missing identifier, not the whole
    // command.
    const targetDir = join(projectDir, ".claude", "skills");
    cli("install", [join(FIXTURES, "skill", "valid"), "--dir", targetDir, "--yes"], env);

    const r = cli("remove", ["totally-missing-skill", projectDir, "--yes"], env);
    assert.equal(r.exitCode, 0, r.combined);
    assert.ok(
      r.combined.includes("not installed"),
      `Expected 'not installed' note, got: ${r.combined}`,
    );
    // The OTHER skill is still installed — soft-skip doesn't touch
    // anything else.
    assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
  });
});

describe("remove-interactive — --yes removes from all matching locations", () => {
  let projectDir;
  let fakeHome;
  let env;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-irem-multi-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-irem-multi-home-"));
    env = { ...process.env, HOME: fakeHome };
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("--yes + multi-match = remove from every location, exit 0", () => {
    // Install the same skill to two different locations.
    const dir1 = join(projectDir, ".claude", "skills");
    const dir2 = join(projectDir, ".agents", "skills");
    cli("install", [join(FIXTURES, "skill", "valid"), "--dir", dir1, "--yes"], env);
    cli("install", [join(FIXTURES, "skill", "valid"), "--dir", dir2, "--yes"], env);

    assert.ok(existsSync(join(dir1, "valid-skill")));
    assert.ok(existsSync(join(dir2, "valid-skill")));

    const r = cli("remove", ["valid-skill", projectDir, "--yes"], env);
    assert.equal(r.exitCode, 0, r.combined);
    assert.ok(!existsSync(join(dir1, "valid-skill")));
    assert.ok(!existsSync(join(dir2, "valid-skill")));
  });
});

describe("remove-interactive — multi-location picker", () => {
  let projectDir;
  let fakeHome;
  let origHome;
  let origCwd;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-irem-picker-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-irem-picker-home-"));
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

  it("presents a picker listing each match + 'all' + 'cancel'", async () => {
    // Seed the filesystem directly to get two installs at two different
    // locations. We can't use `install` twice for this — the flag-driven
    // second install would MOVE the first one (explicit --dir overrides
    // sticky-in-place). Direct seeding lets us set up the multi-match
    // state that the picker is designed to handle.
    const claudeDir = join(projectDir, ".claude", "skills", "valid-skill");
    const agentsDir = join(projectDir, ".agents", "skills", "valid-skill");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    // Copy the real skill payload so SKILL.md etc exist.
    cpSync(join(FIXTURES, "skill", "valid"), claudeDir, { recursive: true });
    cpSync(join(FIXTURES, "skill", "valid"), agentsDir, { recursive: true });
    // Hand-write the two manifest entries so findArtifactAcrossTypes
    // returns two matches for "valid-skill".
    const manifestEntry = {
      type: "skill",
      target: "folder",
      source: join(FIXTURES, "skill", "valid"),
      sourceType: "local",
      version: "1.0.0",
      installedPaths: [claudeDir],
      installedAt: new Date().toISOString(),
      updatedAt: null,
    };
    writeFileSync(
      join(projectDir, ".claude", "skills", ".ctxr-manifest.json"),
      JSON.stringify({ "valid-skill": { ...manifestEntry, installedPaths: [claudeDir] } }, null, 2),
    );
    writeFileSync(
      join(projectDir, ".agents", "skills", ".ctxr-manifest.json"),
      JSON.stringify({ "valid-skill": { ...manifestEntry, installedPaths: [agentsDir] } }, null, 2),
    );

    // Pick "all" in the picker. That should remove both installs.
    const prompt = mockPrompt(["all"]);
    await removeCommand(["valid-skill", projectDir], { prompt });

    const selectCall = prompt.calls.find((c) => c.type === "select");
    assert.ok(selectCall, "picker select was not rendered");
    // Options include each match, plus 'all' and 'none' sentinels.
    const values = selectCall.options.map((o) => o.value);
    assert.ok(values.includes("all"));
    assert.ok(values.includes("none"));
    // At least the two numeric indices (0 and 1) for the two matches.
    assert.ok(values.includes(0) && values.includes(1));

    // Both locations removed.
    assert.ok(
      !existsSync(join(projectDir, ".claude", "skills", "valid-skill")),
    );
    assert.ok(
      !existsSync(join(projectDir, ".agents", "skills", "valid-skill")),
    );
  });
});
