/**
 * Shared CLI error helpers — used by every subcommand's `parseArgs` so
 * usage errors, unknown flags, and missing arguments produce consistent
 * messages + exit codes across the whole CLI.
 *
 * The old code duplicated a `usageError()` helper and an unknown-flag
 * regex in four separate command files. Centralizing the logic here
 * means:
 *
 *   - every command exits with `2` for usage errors (POSIX-ish
 *     convention: 0 = success, 1 = runtime failure, 2 = misuse)
 *   - the unknown-flag grammar is defined once, so a future escape-hatch
 *     like negative-number positionals works uniformly everywhere
 *   - a future enhancement (suggestions, did-you-mean, coloring) can
 *     land in one place instead of four
 */

/**
 * Wrap a message as a usage-error `Error` with `exitCode = 2`. The
 * top-level CLI catch in `src/cli.js` reads this tag and forwards it
 * to `process.exit`, so a subcommand throwing `usageError("...")`
 * produces a clean exit 2 without touching `process.exit` directly.
 *
 * @param {string} message — the error message shown to the user
 * @returns {Error}
 */
export function usageError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  // Tag with a distinguishable name so test assertions and future
  // top-level handlers can recognize usage errors without string-matching
  // the message.
  err.name = "UsageError";
  return err;
}

/**
 * True if a raw argv token looks like a flag that's not recognized by
 * any subcommand. The rule is:
 *
 *   - starts with `--` (any long flag)
 *   - starts with `-` followed by a non-digit (short flag like `-y`)
 *
 * We deliberately allow `-` alone (POSIX stdin marker) and `-123`
 * (negative number positional) to fall through as non-flag. This is
 * identical to the duplicated regex in each command's `parseArgs` pre-
 * refactor, extracted here so a single place owns the grammar.
 *
 * @param {string} arg
 * @returns {boolean}
 */
export function isFlagLike(arg) {
  if (typeof arg !== "string" || arg.length < 2) return false;
  if (arg.startsWith("--")) return true;
  if (arg[0] === "-" && !/^-?\d/.test(arg)) return true;
  return false;
}

/**
 * Build an "unknown flag" usage error message. Takes the offending
 * argument and the short command name so the user sees `kit install
 * --help`, `kit update --help`, etc., tailored to the command they
 * were running.
 *
 * @param {string} flag — the offending token (e.g. `--tpe`)
 * @param {string} command — the subcommand (e.g. `"install"`)
 * @returns {Error}
 */
export function unknownFlagError(flag, command) {
  return usageError(
    `Unknown flag: ${flag} (run 'npx @ctxr/kit ${command} --help' for valid flags)`,
  );
}
