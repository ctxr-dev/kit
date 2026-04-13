/**
 * Type-agnostic package fetchers for kit's install pipeline.
 *
 * Each fetcher accepts a source identifier and a caller-provided throwaway
 * tmpDir, fetches the package into it, and returns metadata describing the
 * fetched content. The caller is responsible for cleaning up tmpDir in a
 * `finally` block (see src/commands/install.js in Phase 2).
 *
 * Sources:
 *   - npm:    "name", "@scope/name", "@scope/name@version"
 *   - github: "github:owner/repo"
 *   - local:  "./path", "/abs/path", or any existing path
 *
 * Extracted verbatim-ish from the pre-refactor src/commands/install.js so
 * that Phase 2's install-dispatcher rewrite can import fetchers cleanly.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXEC_TIMEOUT = 60_000;
// Both owner and name must start with an alphanumeric and can only contain
// alphanumerics, dots, underscores, hyphens. Deliberately tighter than
// GitHub's own rules so "." and ".." cannot slip through as full segments
// (which would URL-normalize to a different repo when git clone resolves
// `https://github.com/../evil.git`).
const GITHUB_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\/[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/;
// Clean env for npm child processes — prevents a user .npmrc from
// influencing kit's behavior (registry override, auth tokens, etc.).
// We override user config only; overriding both to the same sentinel
// makes npm refuse to load them ("double-loading config"), so we point
// userconfig at a nonexistent path and leave globalconfig alone.
function buildCleanNpmEnv() {
  const env = { ...process.env };
  env.npm_config_userconfig = "/nonexistent/.npmrc";
  return Object.freeze(env);
}
const CLEAN_NPM_ENV = buildCleanNpmEnv();

/**
 * Classify a source identifier.
 *
 * @param {string} source
 * @returns {{ type: "local", path: string } | { type: "github", repo: string } | { type: "npm", package: string }}
 */
export function resolveSource(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError(`Invalid source: ${String(source)}`);
  }
  // Local path — require an explicit prefix. We deliberately do NOT probe the
  // filesystem for bare strings because that makes classification depend on
  // CWD state, which is a POLA / TOCTOU footgun: a user running
  // `kit install lodash` from a dir that happens to contain ./lodash would
  // silently install the local folder instead of the npm package.
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("~")) {
    // Only support `~/` form (current-user home). Reject bare `~` or
    // `~user` to avoid surprising path degradation when HOME is unset.
    let expanded = source;
    if (source === "~" || (source.startsWith("~") && !source.startsWith("~/"))) {
      throw new Error(
        `Only "~/..." home expansion is supported (not "~user" or bare "~"): "${source}"`,
      );
    }
    if (source.startsWith("~/")) {
      const home = process.env.HOME;
      if (!home) {
        throw new Error(`Cannot expand "~" — HOME is not set: "${source}"`);
      }
      expanded = home + source.slice(1);
    }
    const abs = resolve(expanded);
    if (!existsSync(abs)) {
      throw new Error(`Local path not found: ${abs}`);
    }
    return { type: "local", path: abs };
  }
  // GitHub shorthand
  if (source.startsWith("github:")) {
    const repo = source.slice("github:".length);
    if (!GITHUB_REPO_RE.test(repo) || repo.includes("..") || repo.includes("/.") || repo.startsWith(".")) {
      throw new Error(`Invalid GitHub repo format: "${repo}" (expected "owner/name")`);
    }
    return { type: "github", repo };
  }
  // Default: npm package spec. Reject anything starting with "-" so a caller
  // cannot smuggle "--registry=http://attacker" or similar flags into the
  // npm pack command line.
  if (source.startsWith("-")) {
    throw new Error(`npm package spec cannot start with "-": "${source}"`);
  }
  return { type: "npm", package: source };
}

/**
 * Create a fresh throwaway tmp directory. Caller must rmSync it in a finally.
 */
export function createTmpDir(prefix = "ctxr-kit-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Download an npm package via `npm pack`, extract the tarball, and return
 * the unpacked package directory plus metadata.
 *
 * @param {string} pkg — npm package spec
 * @param {string} tmpDir — caller-owned throwaway directory
 * @returns {{ dir: string, version: string|null, integrity: string }}
 */
export function fetchFromNpm(pkg, tmpDir) {
  if (typeof pkg !== "string" || pkg.length === 0) {
    throw new TypeError(`Invalid npm package: ${String(pkg)}`);
  }
  // Defense in depth: reject leading "-" so an npm flag cannot be smuggled
  // through the spec positional (e.g. "--registry=http://attacker"). The
  // `--` separator below is belt-and-braces.
  if (pkg.startsWith("-")) {
    throw new Error(`npm package spec cannot start with "-": "${pkg}"`);
  }
  if (typeof tmpDir !== "string" || !existsSync(tmpDir)) {
    throw new Error(`fetchFromNpm requires an existing tmpDir, got: ${String(tmpDir)}`);
  }
  execFileSync(
    "npm",
    ["pack", "--pack-destination", tmpDir, "--silent", "--", pkg],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXEC_TIMEOUT,
      env: CLEAN_NPM_ENV,
    },
  );

  const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length === 0) {
    throw new Error(`Failed to download ${pkg} — no tarball in ${tmpDir}`);
  }
  const tarball = join(tmpDir, tarballs[0]);

  // Version from tarball filename (e.g. "package-1.2.3.tgz")
  const versionMatch = tarballs[0].match(/-(\d+\.\d+\.\d+[^.]*)\.tgz$/);
  const version = versionMatch ? versionMatch[1] : null;

  // SHA-256 integrity of the tarball for manifest recording
  const integrity =
    "sha256-" +
    createHash("sha256").update(readFileSync(tarball)).digest("base64");

  // Pre-flight in two passes — splitting the path check from the entry-type
  // check is what keeps both robust against pathological filenames:
  //
  //   Pass 1 (`tar -tzf`): names only, one per line, no leading metadata.
  //     This is the AUTHORITATIVE source for the path string. Splitting
  //     `tar -tv` lines on whitespace would lose any filename containing a
  //     space, masking `..` segments hidden after the first space and
  //     letting traversal entries slip past the check.
  //
  //   Pass 2 (`tar -tvzf`): verbose listing with type codes in column 1.
  //     We use this only for the type-code whitelist, never for the path
  //     string. The whitelist allows `-` (regular file) and `d` (directory)
  //     and rejects everything else: `l` (symlink), `h` (hardlink),
  //     `b`/`c` (device files), `s` (socket), `p` (FIFO/named pipe).
  //     Devices and sockets and FIFOs do not belong in a Claude Code
  //     artifact directory; a FIFO entry could even DoS a future reader
  //     that opens it with `readFileSync`.
  //
  // After both passes, `tar -xzf` runs normally. The install-time
  // `lstatSync` gates in installers/folder.js + installers/file.js are
  // belt-and-braces in case anything slips through.
  const namesOnly = execFileSync(
    "tar",
    ["-tzf", tarball],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXEC_TIMEOUT,
    },
  );
  const paths = namesOnly
    .split("\n")
    .map((s) => s.replace(/\/+$/, "")) // strip trailing slashes from dir entries
    .filter((s) => s.length > 0);
  for (const path of paths) {
    if (path.startsWith("/") || path.startsWith("~") || /^[a-zA-Z]:/.test(path)) {
      throw new Error(`Refusing to extract tarball with absolute entry: ${path}`);
    }
    const segments = path.split("/");
    if (segments.includes("..")) {
      throw new Error(`Refusing to extract tarball with traversal entry: ${path}`);
    }
  }
  const tvOutput = execFileSync(
    "tar",
    ["-tvzf", tarball],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXEC_TIMEOUT,
    },
  );
  const tvLines = tvOutput
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const line of tvLines) {
    const typeCode = line.charAt(0);
    // Whitelist: regular files (`-`) and directories (`d`) only.
    if (typeCode !== "-" && typeCode !== "d") {
      const kind =
        typeCode === "l"
          ? "symlink"
          : typeCode === "h"
            ? "hardlink"
            : typeCode === "b"
              ? "block device"
              : typeCode === "c"
                ? "character device"
                : typeCode === "s"
                  ? "socket"
                  : typeCode === "p"
                    ? "FIFO/named pipe"
                    : `non-regular entry (type "${typeCode}")`;
      throw new Error(
        `Refusing to extract tarball with ${kind} entry: ${line}`,
      );
    }
  }

  // Extract tarball/package with ownership/permission restoration disabled
  // so a malicious tarball cannot restore hostile uid/mode bits.
  const extractDir = join(tmpDir, "extracted");
  mkdirSync(extractDir, { recursive: true });
  execFileSync(
    "tar",
    ["-xzf", tarball, "-C", extractDir, "--no-same-owner", "--no-same-permissions"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXEC_TIMEOUT,
    },
  );
  const dir = join(extractDir, "package");
  if (!existsSync(dir)) {
    throw new Error(`Tarball did not contain a "package" directory: ${tarball}`);
  }
  return { dir, version, integrity };
}

/**
 * Shallow-clone a GitHub repo and return the clone path plus commit SHA.
 *
 * @param {string} repo — "owner/name" form
 * @param {string} tmpDir — caller-owned throwaway directory
 * @returns {{ dir: string, commit: string|null }}
 */
export function fetchFromGitHub(repo, tmpDir) {
  if (typeof repo !== "string" || !GITHUB_REPO_RE.test(repo)) {
    throw new Error(`Invalid GitHub repo: "${repo}" (expected "owner/name")`);
  }
  // Extra belt-and-braces against URL normalization attacks even though
  // the regex already forbids these segments.
  if (repo.includes("..") || repo.includes("/.") || repo.startsWith(".")) {
    throw new Error(`Refusing GitHub repo with "." or ".." segment: "${repo}"`);
  }
  if (typeof tmpDir !== "string" || !existsSync(tmpDir)) {
    throw new Error(`fetchFromGitHub requires an existing tmpDir, got: ${String(tmpDir)}`);
  }
  const cloneDir = join(tmpDir, "repo");
  // `--` separator prevents any future regex loosening from smuggling flags.
  execFileSync(
    "git",
    ["clone", "--depth", "1", "--", `https://github.com/${repo}.git`, cloneDir],
    { stdio: ["ignore", "pipe", "pipe"], timeout: EXEC_TIMEOUT },
  );
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: cloneDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // non-critical: leave commit as null
  }
  return { dir: cloneDir, commit };
}

/**
 * Resolve a local path. Returns the absolute path plus an optionally
 * detected version from a sibling package.json (best-effort, non-fatal).
 *
 * @param {string} path — relative or absolute local path
 * @returns {{ dir: string, version: string|null }}
 */
export function fetchFromLocal(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError(`Invalid local path: ${String(path)}`);
  }
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`Local path not found: ${abs}`);
  }
  let version = null;
  const pkgJsonPath = join(abs, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (parsed && typeof parsed.version === "string") {
        version = parsed.version;
      }
    } catch {
      // ignore — best effort
    }
  }
  return { dir: abs, version };
}
