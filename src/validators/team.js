/**
 * Team validator.
 *
 * Team packages declare `ctxr.includes: [<spec>...]` — an array of member
 * package specs that `kit install` will cascade to. The generic dispatcher
 * has already confirmed (via `resolveType`) that `includes` is a non-empty
 * array, so this validator only adds:
 *
 *   - Every entry is a non-empty string
 *   - Every entry looks like a plausible source spec (local path, github:
 *     shorthand, or npm package name grammar) — format check only, no
 *     network / filesystem probes. Real availability is a kit install
 *     concern, not a validate concern (members may be unpublished at
 *     validate-time and become available later).
 *   - Member specs are deduplicated — a team with the same member listed
 *     twice is flagged as a warning.
 */

// Mirrors resolveSource's accepted shapes without hitting the filesystem.
// Validator runs at publish time, where local paths in ctxr.includes are
// a bad idea anyway (the path won't exist on the consumer's machine).
const NPM_SPEC_RE =
  /^(?:@[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\/)?[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*(?:@[^\s]+)?$/;
const GITHUB_REPO_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\/[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/;

function looksLikeSpec(spec) {
  if (typeof spec !== "string" || spec.length === 0) return false;
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~")) {
    // Accept local-path shape but flag it via a separate warning above.
    return true;
  }
  if (spec.startsWith("github:")) {
    const repo = spec.slice("github:".length);
    return (
      GITHUB_REPO_RE.test(repo) &&
      !repo.includes("..") &&
      !repo.includes("/.") &&
      !repo.startsWith(".")
    );
  }
  if (spec.startsWith("-")) return false;
  return NPM_SPEC_RE.test(spec);
}

export function validate(root, ctx, resolved) {
  const includes = resolved.pkgJson.ctxr.includes;
  console.log(`\n▸ team members`);

  const seen = new Set();
  let valid = 0;

  for (const spec of includes) {
    if (typeof spec !== "string" || spec.length === 0) {
      ctx.error(
        `ctxr.includes entry is not a non-empty string: ${JSON.stringify(spec)}`,
      );
      continue;
    }
    if (seen.has(spec)) {
      ctx.warn(`ctxr.includes: duplicate entry "${spec}"`);
      continue;
    }
    seen.add(spec);

    if (!looksLikeSpec(spec)) {
      ctx.error(
        `ctxr.includes["${spec}"]: not a valid source spec (expected npm package, github:owner/repo, or ./local path)`,
      );
      continue;
    }

    // Warn on local-path members — they are technically accepted but will
    // not resolve on a consumer machine. Publishable teams should reference
    // npm or GitHub specs.
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~")) {
      ctx.warn(
        `ctxr.includes["${spec}"]: local-path member will not resolve outside this machine`,
      );
    }

    valid++;
  }

  if (valid === includes.length && valid > 0) {
    ctx.ok(`${valid} member spec(s) parse cleanly`);
  }
}
