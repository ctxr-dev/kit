/**
 * kit init [--type <type>] [name]
 *
 * Scaffold a new ctxr artifact package from `templates/<type>/`. The `--type`
 * flag selects the template family and defaults to `skill` because that is
 * the most common authoring case — typing `kit init my-thing` should still
 * Just Work for the 80% path without forcing every user to remember a flag.
 *
 * Each template is a directory of files with `{{variable}}` placeholders in
 * both file contents and filenames. The lightweight engine in
 * `src/lib/template.js` walks the tree, interpolates placeholders, and
 * applies the `_gitignore → .gitignore` and `*.tmpl → *` renames.
 *
 * Examples:
 *   kit init my-skill                    # default --type skill
 *   kit init --type agent my-agent       # scaffold an agent package
 *   kit init --type team team-full-stack # scaffold a team meta-package
 *
 * Type validation runs against the artifact registry, so an unknown `--type`
 * fails fast with the full list of accepted types — no silent fallback.
 */

import { existsSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTemplate } from "../lib/template.js";
import { ARTIFACT_TYPE_NAMES } from "../lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_ROOT = join(__dirname, "..", "..", "templates");
const DEFAULT_TYPE = "skill";

function toTitle(str) {
  return str
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse `init`'s argv into `{ type, positional }`.
 *
 * Supports `--type <value>`, `--type=<value>`, and `-t <value>`. Unknown
 * flags are rejected so a typo like `--tpe agent` doesn't silently fall back
 * to the default template — better to fail loudly than scaffold the wrong
 * type and confuse the author.
 *
 * Hardening: a flag value that itself starts with `-` (e.g. `--type -t`) is
 * almost certainly a user typo where the value was forgotten and the next
 * flag was consumed instead. Catching it here gives a pointed error instead
 * of leaking through and producing the generic "Unknown --type" downstream.
 *
 * Extra positional args are rejected — `init` takes at most one name. Silent
 * truncation hides typos like `kit init agent foo` (missing `--type`).
 *
 * `--help`/`-h` is a special case the caller peels off first.
 */
function parseArgs(args) {
  let type = DEFAULT_TYPE;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--type" || arg === "-t") {
      const value = args[++i];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${arg} requires a value (e.g. ${arg} agent)`);
      }
      if (value.startsWith("-")) {
        throw new Error(
          `${arg} value must not start with '-' (got "${value}") — did you forget the type name?`,
        );
      }
      type = value;
    } else if (arg.startsWith("--type=")) {
      type = arg.slice("--type=".length);
      if (type.length === 0) {
        throw new Error("--type= requires a value (e.g. --type=agent)");
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error(
      `init takes at most one positional argument (the project name), got ${positional.length}: ${positional.join(", ")}`,
    );
  }

  return { type, positional };
}

function printUsage() {
  console.error("Usage: kit init [--type <type>] [name]");
  console.error("");
  console.error("Scaffold a new ctxr artifact package.");
  console.error("");
  console.error("Options:");
  console.error(`  --type <type>   artifact template (default: ${DEFAULT_TYPE})`);
  console.error(`                  one of: ${ARTIFACT_TYPE_NAMES.join(", ")}`);
  console.error("  -t <type>       short form of --type");
  console.error("  -h, --help      show this help");
  console.error("");
  console.error("Examples:");
  console.error("  kit init my-skill                    # default --type skill");
  console.error("  kit init --type agent my-agent       # scaffold an agent");
  console.error("  kit init --type team team-full-stack # scaffold a team bundle");
}

export default async function init(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const { type, positional } = parseArgs(args);

  if (!ARTIFACT_TYPE_NAMES.includes(type)) {
    throw new Error(
      `Unknown --type "${type}". Must be one of: ${ARTIFACT_TYPE_NAMES.join(", ")}.`,
    );
  }

  const templateDir = join(TEMPLATES_ROOT, type);
  if (!existsSync(templateDir)) {
    // Defensive: every type in ARTIFACT_TYPE_NAMES has a template directory
    // under templates/. If this fires it's a packaging bug, not user input.
    throw new Error(`Internal: template directory missing for type "${type}" at ${templateDir}`);
  }

  const rawArg = positional[0];
  const targetDir = rawArg ? resolve(rawArg) : resolve(".");
  const name = basename(targetDir);

  if (rawArg && existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }

  console.log(`\nScaffolding ${type}: ${name}\n`);

  const vars = {
    name,
    titleName: toTitle(name),
    type,
    description: `TODO — describe what this ${type} does and when it should be used.`,
    license: "MIT",
    year: String(new Date().getFullYear()),
    author: "",
  };

  const created = copyTemplate(templateDir, targetDir, vars);

  console.log("  Created:");
  for (const file of created) {
    console.log(`    ${file}`);
  }

  console.log();
  console.log("  Next steps:");
  console.log(`    1. Edit the generated files to describe your ${type}`);
  console.log("    2. Run 'npx @ctxr/kit validate' to check structure");
  console.log();
}
