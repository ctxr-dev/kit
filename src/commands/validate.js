/**
 * kit validate [path]
 *
 * Generic package validator that runs before publish. Reads the package's
 * `package.json`, validates the `ctxr` block, runs the payload-size /
 * target-layout rules shared with the installer, then dispatches to the
 * per-type validator (`src/validators/<type>.js`) for content-level checks.
 *
 * Generic checks (same invariants the installer enforces at install time,
 * run here so authors can catch them before publishing):
 *   1. Path exists and contains a package.json
 *   2. `ctxr` block present, `ctxr.type` known
 *   3. Non-team types declare `ctxr.target ∈ {"folder", "file"}`
 *   4. Team types declare a non-empty `ctxr.includes` array
 *   5. `packagePayload()` resolves (≥1 file) for non-team types
 *   6. For `target: "file"`: after filtering npm's always-include metadata
 *      (README, LICENSE, CHANGELOG, NOTICE, package.json), exactly one
 *      artifact file remains AND that file is `.md`
 *
 * After the generic layer succeeds, the per-type validator runs for deeper
 * checks (e.g. the skill validator inspects SKILL.md frontmatter, reviewer
 * index consistency, cross-references, and line budgets).
 *
 * Examples:
 *   kit validate               # validate cwd
 *   kit validate ./my-skill    # validate a sibling package
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packagePayload } from "../lib/payload.js";
import { resolveType } from "../lib/types.js";
import { resolveFileTargetArtifact } from "../installers/manifest-writer.js";

import * as skillValidator from "../validators/skill.js";
import * as agentValidator from "../validators/agent.js";
import * as commandValidator from "../validators/command.js";
import * as ruleValidator from "../validators/rule.js";
import * as outputStyleValidator from "../validators/output-style.js";
import * as teamValidator from "../validators/team.js";

// Static dispatch map. Adding a new type is a two-line edit (registry + this
// table) rather than a string-search across commands.
const VALIDATORS = Object.freeze({
  skill: skillValidator,
  agent: agentValidator,
  command: commandValidator,
  rule: ruleValidator,
  "output-style": outputStyleValidator,
  team: teamValidator,
});

function printUsage() {
  console.error("Usage: kit validate [path]");
  console.error("");
  console.error("Validate a ctxr artifact package before publishing.");
  console.error("");
  console.error("Arguments:");
  console.error("  path   package directory to validate (defaults to cwd)");
  console.error("");
  console.error("Checks:");
  console.error("  - package.json exists and has a valid `ctxr` block");
  console.error("  - ctxr.type is one of: skill, agent, command, rule, output-style, team");
  console.error("  - Non-team: ctxr.target ∈ {folder, file}; `files` payload is valid");
  console.error("  - target:\"file\": exactly one .md artifact after metadata filter");
  console.error("  - Type-specific content checks (frontmatter, cross-refs, etc.)");
}

/**
 * Run the generic layout check for non-team packages and return a context
 * bundle the per-type validator can reuse:
 *
 *   - `payload` (output of packagePayload) — cached so the validator doesn't
 *     re-spawn npm pack if it also needs the file list.
 *   - `fileTargetResolution` — result of resolveFileTargetArtifact for
 *     target:"file" packages, so the per-type validator can jump straight
 *     to the resolved single file without re-running the filter.
 *
 * Returns `null` on payload error (already reported via ctx).
 */
function runGenericPayloadCheck(root, resolved, ctx) {
  console.log("\n▸ Package payload");
  let payload;
  try {
    payload = packagePayload(root);
  } catch (e) {
    ctx.error(`Payload error: ${e.message}`);
    return null;
  }
  ctx.ok(`Package payload resolves to ${payload.length} file(s)`);

  if (resolved.target !== "file") {
    return { payload, fileTargetResolution: null };
  }

  const fileTargetResolution = resolveFileTargetArtifact(payload);
  if (!fileTargetResolution.ok) {
    ctx.error(fileTargetResolution.reason);
    return { payload, fileTargetResolution };
  }
  ctx.ok(`single artifact file: ${fileTargetResolution.single}`);
  return { payload, fileTargetResolution };
}

export default async function validate(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const positionals = args.filter((a) => !a.startsWith("-"));
  const targetPath = positionals[0] || ".";
  const root = resolve(targetPath);

  if (!existsSync(root)) {
    throw new Error(`Path does not exist: ${root}`);
  }

  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(
      `No package.json at ${root} — kit validate expects an artifact package directory.`,
    );
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    throw new Error(`Could not parse package.json: ${e.message}`);
  }

  if (typeof pkgJson.name !== "string" || pkgJson.name.length === 0) {
    throw new Error("package.json is missing a `name` field");
  }

  // resolveType enforces the ctxr schema (type known, target ∈ {folder,file}
  // for non-team, includes non-empty for team). Surface its errors as hard
  // failures — these are schema violations, not content issues, and the
  // per-type validator would only produce noise on a broken schema.
  let resolved;
  try {
    resolved = resolveType(pkgJson);
  } catch (e) {
    throw new Error(e.message);
  }

  let errors = 0;
  let warnings = 0;
  const ctx = {
    error(msg) {
      console.error(`  ✗ ${msg}`);
      errors++;
    },
    warn(msg) {
      console.warn(`  ⚠ ${msg}`);
      warnings++;
    },
    ok(msg) {
      console.log(`  ✓ ${msg}`);
    },
  };

  console.log(`Validating ${resolved.type} package at: ${root}`);
  console.log(
    `  name: ${pkgJson.name}${resolved.target ? ` · target: ${resolved.target}` : ""}`,
  );

  // Generic payload check for non-team types. Teams have no `files` payload
  // (the package ships only metadata), so we skip straight to the per-type
  // validator which checks the `includes` list.
  let payloadCtx = null;
  if (resolved.type !== "team") {
    payloadCtx = runGenericPayloadCheck(root, resolved, ctx);
  }

  const validator = VALIDATORS[resolved.type];
  if (!validator || typeof validator.validate !== "function") {
    // Defensive: resolveType only accepts types that exist in ARTIFACT_TYPES,
    // and VALIDATORS has an entry for every one of them. Any mismatch here
    // is a kit-internal bug, not user input.
    throw new Error(
      `Internal: no validator registered for type "${resolved.type}"`,
    );
  }
  validator.validate(root, ctx, {
    ...resolved,
    pkgJson,
    payload: payloadCtx ? payloadCtx.payload : null,
    fileTargetResolution: payloadCtx ? payloadCtx.fileTargetResolution : null,
  });

  console.log("\n" + "─".repeat(50));
  if (errors > 0) {
    throw new Error(
      `Validation failed: ${errors} error(s), ${warnings} warning(s)`,
    );
  } else if (warnings > 0) {
    console.log(`\n✓ Validation passed with ${warnings} warning(s)\n`);
  } else {
    console.log("\n✓ Validation passed\n");
  }
}
