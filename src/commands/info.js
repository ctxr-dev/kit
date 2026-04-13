/**
 * kit info <identifier>
 *
 * Show info about an installed artifact — by installed-name or original
 * source. Reads the unified manifest at every known `(type, dir)` pair.
 *
 * Fallbacks for artifact authors: if nothing matches by installed-name,
 * check whether `cwd` looks like a ctxr package (has `package.json` with a
 * `ctxr` block) and display that. Finally, fall back to `npm view` so a
 * package name that exists on the registry but isn't installed can still be
 * inspected.
 *
 * Examples:
 *   kit info ctxr-skill-code-review
 *   kit info @ctxr/skill-code-review
 *   kit info .                          # info on the package in cwd
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { findArtifactAcrossTypes } from "../lib/discover.js";

function countFiles(target) {
  if (!existsSync(target)) return 0;
  try {
    const stat = lstatSync(target);
    if (stat.isFile()) return 1;
    if (!stat.isDirectory()) return 0;
  } catch {
    return 0;
  }
  let n = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else n++;
    }
  };
  walk(target);
  return n;
}

function readCwdPackage(cwdPath) {
  const pkgPath = join(cwdPath, "package.json");
  if (!existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  if (!pkg.ctxr || typeof pkg.ctxr !== "object") return null;
  return {
    name: pkg.name ?? "(unnamed)",
    version: pkg.version ?? null,
    description: pkg.description ?? null,
    type: pkg.ctxr.type ?? null,
    target: pkg.ctxr.target ?? null,
    includes: Array.isArray(pkg.ctxr.includes) ? pkg.ctxr.includes : null,
    files: Array.isArray(pkg.files) ? pkg.files : null,
    path: cwdPath,
  };
}

function getNpmInfo(pkg) {
  // Defense in depth: reject any identifier starting with `-` so a user
  // input like `kit info --registry=http://attacker` cannot be smuggled
  // through to npm as a flag. The `--` separator below is belt-and-braces.
  if (pkg.startsWith("-")) return null;
  try {
    const output = execFileSync(
      "npm",
      ["view", "--json", "--", pkg],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15_000,
      },
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function renderInstalled(match) {
  const { typeName, dir, entry } = match;
  const divider = "─".repeat(40);
  console.log(`  ${entry.installedName} (installed)`);
  console.log(`  ${divider}`);
  console.log(`  type:    ${typeName}`);
  if (entry.target) console.log(`  target:  ${entry.target}`);
  if (entry.source) console.log(`  source:  ${entry.source}`);
  if (entry.sourceType) console.log(`  via:     ${entry.sourceType}`);
  if (entry.version) console.log(`  version: ${entry.version}`);
  if (entry.installedAt) console.log(`  installed: ${entry.installedAt}`);
  if (entry.updatedAt) console.log(`  updated:  ${entry.updatedAt}`);
  if (Array.isArray(entry.installedPaths) && entry.installedPaths.length > 0) {
    const paths = entry.installedPaths;
    console.log(`  path:    ${paths[0]}`);
    for (let i = 1; i < paths.length; i++) console.log(`           ${paths[i]}`);
    const fileCount = paths.reduce((n, p) => n + countFiles(p), 0);
    if (fileCount > 0) console.log(`  files:   ${fileCount}`);
  }
  if (entry.type === "team" && Array.isArray(entry.members)) {
    console.log(`  members: ${entry.members.length}`);
    for (const m of entry.members) console.log(`    - ${m}`);
  }
  console.log(`  manifest: ${dir}`);
  console.log();
}

function renderCwd(info) {
  const divider = "─".repeat(40);
  console.log(`  ${info.name} (local package)`);
  console.log(`  ${divider}`);
  if (info.description) console.log(`  ${info.description}`);
  if (info.type) console.log(`  type:    ${info.type}`);
  if (info.target) console.log(`  target:  ${info.target}`);
  if (info.version) console.log(`  version: ${info.version}`);
  if (info.includes) console.log(`  includes: ${info.includes.length} member(s)`);
  if (info.files) console.log(`  files:   ${info.files.length} entry(ies) in package.json`);
  console.log(`  path:    ${info.path}`);
  console.log();
}

function renderNpm(npmInfo) {
  const divider = "─".repeat(40);
  console.log(`  ${npmInfo.name} (npm)`);
  console.log(`  ${divider}`);
  if (npmInfo.description) console.log(`  ${npmInfo.description}`);
  console.log(
    `  latest:  ${npmInfo["dist-tags"]?.latest || npmInfo.version}`,
  );
  if (npmInfo.ctxr?.type) console.log(`  type:    ${npmInfo.ctxr.type}`);
  if (npmInfo.ctxr?.target) console.log(`  target:  ${npmInfo.ctxr.target}`);
  if (npmInfo.homepage) console.log(`  homepage: ${npmInfo.homepage}`);
  if (npmInfo.license) console.log(`  license: ${npmInfo.license}`);
  console.log();
}

function printUsage() {
  console.error(`
Usage: npx @ctxr/kit info <identifier>

Show information about an installed artifact, a local ctxr package, or a
package on the npm registry. Searches in this order:
  1. installed artifacts in every known location (by installed-name or source)
  2. ctxr package in the current directory (or the path you pass)
  3. npm view <identifier>

Arguments:
  identifier                installed-name, package spec, or local path

Options:
  -h, --help                Show this help message
`);
}

export default async function info(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  if (args.length === 0) {
    printUsage();
    const err = new Error("Missing required argument: <identifier>");
    err.exitCode = 2;
    throw err;
  }

  const identifier = args[0];
  if (identifier.startsWith("-")) {
    const err = new Error(
      `<identifier> cannot start with "-" (got "${identifier}"). Did you mean to pass a flag?`,
    );
    err.exitCode = 2;
    throw err;
  }
  const projectPath = resolve(".");

  // 1. Installed matches (walk all types + team manifests)
  const matches = findArtifactAcrossTypes(identifier, projectPath);

  // 2. Cwd package fallback (artifact author)
  const looksLikePath =
    identifier.startsWith(".") || identifier.startsWith("/") || identifier.startsWith("~");
  let cwdInfo = null;
  if (looksLikePath) {
    const abs = resolve(identifier);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      cwdInfo = readCwdPackage(abs);
    }
  } else if (matches.length === 0) {
    // Fall back to cwd only when there's no installed match AND the user
    // is in a package directory themselves.
    cwdInfo = readCwdPackage(projectPath);
  }

  // 3. npm fallback (only for identifiers that look like package specs)
  const looksLikePkgSpec = /^(@[^/]+\/)?[^/\s]+$/.test(identifier) && !looksLikePath;
  const npmInfo = looksLikePkgSpec && matches.length === 0 && !cwdInfo
    ? getNpmInfo(identifier)
    : null;

  console.log();

  if (matches.length > 0) {
    for (const match of matches) renderInstalled(match);
  }
  if (cwdInfo && matches.length === 0) {
    renderCwd(cwdInfo);
  }
  if (npmInfo) {
    renderNpm(npmInfo);
  }

  if (matches.length === 0 && !cwdInfo && !npmInfo) {
    console.log(`  '${identifier}' not found locally or on npm.\n`);
    throw new Error(`Artifact '${identifier}' not found`);
  }
}
