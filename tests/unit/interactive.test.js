/**
 * interactive.test.js — unit tests for `src/lib/interactive.js`.
 *
 * Focus: `isNonInteractive` precedence. The wrappers around `@clack/prompts`
 * (`select`, `text`, `confirm`) are exercised in command-level integration
 * tests where a mock `prompt` module is injected via dependency injection.
 * Here we pin the pure decision logic so it's covered without any child
 * process, pty, or real stdin manipulation.
 *
 * Precedence (most-to-least override-y, documented in the module):
 *   1. flags.interactive === true   → FALSE (force interactive override)
 *   2. flags.yes === true           → TRUE  (explicit opt-out)
 *   3. process.env.CI truthy        → TRUE  (CI auto-detect)
 *   4. !stdin.isTTY                 → TRUE  (piped/detached stdin)
 *   5. otherwise                    → FALSE
 *
 * We inject env + tty parameters rather than mutating process state so the
 * tests are hermetic and parallelizable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNonInteractive, UserAbortError } from "../../src/lib/interactive.js";

// Helper: a fake stdin object with a configurable `isTTY` property.
const tty = (isTTY) => ({ isTTY });

describe("isNonInteractive — precedence matrix", () => {
  it("returns FALSE when flags.interactive === true (force override)", () => {
    // Force-interactive beats every auto-detect trigger.
    assert.equal(isNonInteractive({ interactive: true }, { CI: "true" }, tty(false)), false);
    assert.equal(isNonInteractive({ interactive: true, yes: true }, { CI: "true" }, tty(false)), false);
    assert.equal(isNonInteractive({ interactive: true }, {}, tty(false)), false);
  });

  it("returns TRUE when flags.yes === true and no interactive override", () => {
    assert.equal(isNonInteractive({ yes: true }, {}, tty(true)), true);
    assert.equal(isNonInteractive({ yes: true }, { CI: "false" }, tty(true)), true);
  });

  it("returns TRUE when CI env var is truthy (string 'true')", () => {
    assert.equal(isNonInteractive({}, { CI: "true" }, tty(true)), true);
  });

  it("returns TRUE when CI env var is any non-empty non-'false'/'0' string", () => {
    // GitHub Actions, GitLab, CircleCI, Travis, Buildkite all set different
    // values for CI — cover the common shapes.
    assert.equal(isNonInteractive({}, { CI: "1" }, tty(true)), true);
    assert.equal(isNonInteractive({}, { CI: "yes" }, tty(true)), true);
    assert.equal(isNonInteractive({}, { CI: "github-actions" }, tty(true)), true);
  });

  it("returns FALSE when CI env var is explicitly falsy ('false' or '0')", () => {
    // Some dev setups set CI=false to disable CI-style behavior in scripts.
    assert.equal(isNonInteractive({}, { CI: "false" }, tty(true)), false);
    assert.equal(isNonInteractive({}, { CI: "0" }, tty(true)), false);
    assert.equal(isNonInteractive({}, { CI: "" }, tty(true)), false);
  });

  it("returns TRUE when stdin is not a TTY", () => {
    assert.equal(isNonInteractive({}, {}, tty(false)), true);
    // undefined / null also count as "not a tty" (stdin detached)
    assert.equal(isNonInteractive({}, {}, { isTTY: undefined }), true);
    assert.equal(isNonInteractive({}, {}, { isTTY: null }), true);
  });

  it("returns FALSE in the default 'interactive tty, no override' path", () => {
    assert.equal(isNonInteractive({}, {}, tty(true)), false);
    assert.equal(isNonInteractive({}, { CI: "false" }, tty(true)), false);
  });

  it("force-interactive (flags.interactive) beats CI=true AND non-TTY", () => {
    // The override is absolute: if someone explicitly passes -i, kit
    // prompts even in CI and even with piped stdin (where prompts would
    // fail — that's the user's problem, -i is an emergency lever).
    assert.equal(
      isNonInteractive({ interactive: true }, { CI: "true" }, tty(false)),
      false,
    );
  });

  it("--yes + --interactive → --interactive wins (force override)", () => {
    // The docs state that --interactive overrides everything including
    // --yes. Pinning that here so a future reorder doesn't silently flip
    // the precedence.
    assert.equal(
      isNonInteractive({ interactive: true, yes: true }, {}, tty(true)),
      false,
    );
  });

  it("defaults work when env/tty are omitted (uses process.env + process.stdin)", () => {
    // This test is slightly coupled to the environment — we just assert
    // the call doesn't throw and returns a boolean. The spawned test
    // runner has no TTY so the returned value will be `true`, which
    // matches the "piped stdin → non-interactive" rule.
    const result = isNonInteractive({});
    assert.equal(typeof result, "boolean");
  });
});

describe("UserAbortError", () => {
  it("is an Error subclass with exitCode 130 (standard SIGINT)", () => {
    const err = new UserAbortError();
    assert.ok(err instanceof Error);
    assert.equal(err.name, "UserAbortError");
    assert.equal(err.exitCode, 130);
  });

  it("pins the class name string as 'UserAbortError' — cli.js top-level catch uses string match", () => {
    // cli.js:125 uses `err?.name !== "UserAbortError"` to suppress the
    // duplicate "Cancelled." message when a command threw a UserAbortError.
    // It can't `instanceof` check without importing interactive.js, so
    // the match is by `.name`. If anyone renames this class, that check
    // silently reverts to double-printing. This test pins the contract.
    const err = new UserAbortError();
    assert.equal(err.name, "UserAbortError");
    assert.equal(UserAbortError.name, "UserAbortError");
  });

  it("accepts a custom message", () => {
    const err = new UserAbortError("nope");
    assert.equal(err.message, "nope");
  });

  it("defaults to 'Cancelled by user' when no message given", () => {
    const err = new UserAbortError();
    assert.equal(err.message, "Cancelled by user");
  });
});
