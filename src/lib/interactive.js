/**
 * Interactive-mode detection and `@clack/prompts` wrappers for kit commands.
 *
 * Kit is **interactive by default** — a user running `npx @ctxr/kit install X`
 * in a terminal is prompted for destination, confirmations, and wizard fields.
 * Non-interactive execution is explicit and covers four signals with this
 * precedence (most-to-least override-y):
 *
 *   1. `flags.interactive === true` (from `-i` / `--interactive`)
 *      → FORCE INTERACTIVE, beats CI and `!isTTY` detection
 *   2. `flags.yes === true` (from `--yes` / `-y`)
 *      → non-interactive, use declared defaults
 *   3. `process.env.CI` truthy
 *      → non-interactive (GitHub Actions, GitLab, CircleCI, Travis, Drone,
 *         Buildkite, AppVeyor, Netlify, Vercel, and most CI runners set this)
 *   4. `process.stdin.isTTY !== true`
 *      → non-interactive (piped stdin, spawned by a script, detached)
 *
 * Commands never import `@clack/prompts` directly. They import the wrappers
 * here so (a) tests can substitute a mock `prompt` module via dependency
 * injection and (b) the `isCancel` symbol handling and default-value
 * fallback live in exactly one place.
 *
 * Ctrl+C inside a clack prompt returns a cancel symbol rather than throwing.
 * Every wrapper checks for it and throws `UserAbortError`, which the
 * top-level CLI catch handler converts to a clean "Cancelled." message +
 * exit code 130 (standard SIGINT convention).
 */

import { intro as clackIntro, outro as clackOutro, select as clackSelect, text as clackText, confirm as clackConfirm, isCancel } from "@clack/prompts";

/**
 * Signals that the user interrupted an interactive prompt (Ctrl+C, escape,
 * stdin EOF before a value could be read). Separate from plain `Error` so
 * command code can distinguish "user asked to stop" from "something went
 * wrong at runtime".
 */
export class UserAbortError extends Error {
  constructor(message = "Cancelled by user") {
    super(message);
    this.name = "UserAbortError";
    this.exitCode = 130;
  }
}

/**
 * Decide whether kit should prompt or fall through to defaults for this
 * invocation. Pure function — no side effects, no console output.
 *
 * @param {object} [flags] — command flags; may include `.yes`, `.interactive`
 * @param {object} [env] — env override for tests (defaults to `process.env`)
 * @param {object} [tty] — stdin override for tests (defaults to `process.stdin`)
 * @returns {boolean} true → use defaults silently; false → prompt
 */
export function isNonInteractive(flags = {}, env = process.env, tty = process.stdin) {
  // 1. -i / --interactive force override beats CI and !isTTY
  if (flags.interactive === true) return false;
  // 2. --yes / -y explicit opt-out
  if (flags.yes === true) return true;
  // 3. CI=true auto-detect — accept any truthy non-"false", non-"0" value
  const ci = env.CI;
  if (typeof ci === "string" && ci.length > 0 && ci !== "false" && ci !== "0") {
    return true;
  }
  // 4. stdin not a TTY — undefined counts as "not a tty"
  if (tty.isTTY !== true) return true;
  return false;
}

/**
 * Print an intro section (title + decorative rule). Clack no-ops gracefully
 * when stdout isn't a TTY, but we additionally skip entirely in
 * non-interactive mode so `--yes` runs produce zero clack output.
 */
export function intro(title, flags = {}) {
  if (isNonInteractive(flags)) return;
  clackIntro(title);
}

/**
 * Print an outro section (summary + decorative rule). Same skip rule as
 * `intro`.
 */
export function outro(summary, flags = {}) {
  if (isNonInteractive(flags)) return;
  clackOutro(summary);
}

/**
 * Arrow-key menu. Returns the selected option's `value`. Falls through to
 * `defaultValue` in non-interactive mode without ever touching the terminal.
 *
 * @template T
 * @param {object} opts
 * @param {string} opts.message — prompt question
 * @param {Array<{ value: T, label: string, hint?: string }>} opts.options
 * @param {T} opts.defaultValue — value returned in non-interactive mode AND
 *   used as clack's `initialValue` when interactive. Must match one of the
 *   option values so clack pre-highlights the right entry.
 * @param {object} [opts.flags]
 * @returns {Promise<T>}
 * @throws {UserAbortError} if the user cancels with Ctrl+C
 */
export async function select(opts) {
  if (!opts || !Array.isArray(opts.options) || opts.options.length === 0) {
    throw new TypeError("select requires a non-empty options array");
  }
  if (isNonInteractive(opts.flags)) return opts.defaultValue;

  const result = await clackSelect({
    message: opts.message,
    options: opts.options,
    initialValue: opts.defaultValue,
  });
  if (isCancel(result)) throw new UserAbortError();
  return result;
}

/**
 * Free-form text input with optional default and validator. In
 * non-interactive mode returns `opts.defaultValue` without validation.
 *
 * @param {object} opts
 * @param {string} opts.message
 * @param {string} [opts.defaultValue=""]
 * @param {string} [opts.placeholder]
 * @param {(v: string) => string | undefined} [opts.validate] — return an
 *   error string to re-prompt; return nothing to accept the value
 * @param {object} [opts.flags]
 * @returns {Promise<string>}
 * @throws {UserAbortError}
 */
export async function text(opts) {
  if (!opts) throw new TypeError("text requires an opts object");
  if (isNonInteractive(opts.flags)) return opts.defaultValue ?? "";

  const result = await clackText({
    message: opts.message,
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue,
    validate: opts.validate,
  });
  if (isCancel(result)) throw new UserAbortError();
  return typeof result === "string" ? result : (opts.defaultValue ?? "");
}

/**
 * Yes/no confirmation. Returns boolean.
 *
 * @param {object} opts
 * @param {string} opts.message
 * @param {boolean} [opts.defaultValue=false]
 * @param {object} [opts.flags]
 * @returns {Promise<boolean>}
 * @throws {UserAbortError}
 */
export async function confirm(opts) {
  if (!opts) throw new TypeError("confirm requires an opts object");
  const defaultValue = opts.defaultValue === true;
  if (isNonInteractive(opts.flags)) return defaultValue;

  const result = await clackConfirm({
    message: opts.message,
    initialValue: defaultValue,
  });
  if (isCancel(result)) throw new UserAbortError();
  return result === true;
}

/**
 * Default prompt module export — a frozen bag of the wrappers so commands
 * can accept a single `prompt` dependency in their options for testing.
 *
 * Production code:
 *   import * as prompt from "../lib/interactive.js";
 *   await prompt.select({ ... });
 *
 * Test code:
 *   const mockPrompt = { select: async () => "mocked", ... };
 *   await installCommand(args, { prompt: mockPrompt });
 */
export const prompt = Object.freeze({
  isNonInteractive,
  intro,
  outro,
  select,
  text,
  confirm,
  UserAbortError,
});
