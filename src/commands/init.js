/**
 * kit init [name] [options]
 *
 * Scaffold a new ctxr artifact package from `templates/<type>/`. Kit `init`
 * is a **9-question interactive wizard** in a TTY; positional args and flags
 * bypass individual prompts, and `--yes` / CI / `!isTTY` skip the entire
 * wizard in favor of defaults.
 *
 * Wizard steps (in order, each one bypassed by the matching flag):
 *
 *   1. Type          — one of skill | agent | command | rule | output-style | team      [--type]
 *   2. Name          — default: cwd basename, sanitized to npm grammar                 [positional]
 *   3. Author        — default: `git config user.name <user.email>`                    [--author]
 *   4. Description   — required in the interactive wizard (validator blocks empty);
 *                      non-interactive runs fall through to a TODO placeholder         [--description]
 *   5. License       — default: MIT (choices: MIT, Apache-2.0, ISC, UNLICENSED, Custom)[--license]
 *   6. Target        — default: folder for skill, file for others                      [--target]
 *   7. Overwrite     — default: false (block non-empty target dir)                     [--force]
 *   8. Git init      — default: false (opt in via wizard or --git-init)                [--git-init]
 *   9. npm install   — default: false (opt in via wizard or --npm-install)             [--npm-install]
 *
 * Each template is a directory of files with `{{variable}}` placeholders in
 * both file contents and filenames. The engine in `src/lib/template.js`
 * walks the tree, interpolates placeholders, and applies the
 * `_gitignore → .gitignore` and `*.tmpl → *` renames.
 *
 * Description semantics:
 *   - Interactive wizard: required, no default — validator blocks empty
 *     input and caps length at 300 chars.
 *   - `--description "..."`: used verbatim regardless of mode.
 *   - Non-interactive (--yes, CI=true, !isTTY) WITHOUT `--description`:
 *     falls through to `"TODO — describe what this <type> does and when
 *     it should be used."` so scaffolded package.json is always valid
 *     JSON with a non-empty description the author can edit afterwards.
 *
 * Examples:
 *   kit init                            # wizard, name defaults to cwd basename
 *   kit init my-skill                   # wizard with name pre-filled
 *   kit init my-agent --type agent      # wizard with name+type pre-filled
 *   kit init my-skill --yes \           # scripted — all defaults except:
 *     --description "Reviews code"      #   description is required
 *   CI=true kit init auto --description "Auto-scaffolded" --type rule
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTemplate } from "../lib/template.js";
import { ARTIFACT_TYPE_NAMES } from "../lib/types.js";
import * as interactive from "../lib/interactive.js";
import { isFlagLike, unknownFlagError, usageError } from "../lib/cli-errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_ROOT = join(__dirname, "..", "..", "templates");
const DEFAULT_TYPE = "skill";
const LICENSE_CHOICES = ["MIT", "Apache-2.0", "ISC", "UNLICENSED"];

function toTitle(str) {
  return str.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Sanitize a raw string into a valid npm package-name segment:
 * lowercase, alphanumeric + hyphens, leading alphanumeric. Returns empty
 * string if nothing survives the sanitization.
 */
function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  const lowered = raw.toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const trimmed = cleaned.replace(/^-+|-+$/g, "");
  if (trimmed.length === 0) return "";
  // npm names must start with a letter or digit.
  if (!/^[a-z0-9]/.test(trimmed)) return "";
  return trimmed;
}

/**
 * Run a short git command and return its stdout trimmed, or an empty string
 * if git isn't on PATH or the command fails. Used to populate the "Author"
 * default from `git config user.name` / `user.email`.
 */
function gitConfigGet(key) {
  try {
    return execFileSync("git", ["config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
  } catch {
    return "";
  }
}

function defaultAuthor() {
  const name = gitConfigGet("user.name");
  const email = gitConfigGet("user.email");
  if (name && email) return `${name} <${email}>`;
  if (name) return name;
  if (email) return email;
  return "";
}

/**
 * Parse argv into `{ flags, positional }`. Every wizard-field flag is
 * optional; their presence bypasses the corresponding prompt. The rule
 * "value must not start with -" is preserved from the old init to catch
 * obvious typos like `--type -t agent`.
 */
function parseArgs(args) {
  const flags = {
    help: false,
    yes: false,
    interactive: false,
    type: null,
    author: null,
    description: null,
    license: null,
    target: null,
    force: false,
    gitInit: null, // null = ask, true/false = bypass
    npmInstall: null,
  };
  const positional = [];

  const takeValue = (name, raw, i) => {
    const value = args[++i];
    if (typeof value !== "string" || value.length === 0) {
      throw usageError(`${name} requires a value (e.g. ${name} <value>)`);
    }
    if (value.startsWith("-")) {
      throw usageError(
        `${name} value must not start with '-' (got "${value}") — did you forget the value?`,
      );
    }
    return { value, i };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--interactive" || arg === "-i") flags.interactive = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--git-init") flags.gitInit = true;
    else if (arg === "--no-git-init") flags.gitInit = false;
    else if (arg === "--npm-install") flags.npmInstall = true;
    else if (arg === "--no-npm-install") flags.npmInstall = false;
    else if (arg === "--type" || arg === "-t") {
      const r = takeValue(arg, args[i], i);
      flags.type = r.value;
      i = r.i;
    } else if (arg.startsWith("--type=")) {
      flags.type = arg.slice("--type=".length);
      if (flags.type.length === 0) {
        throw usageError("--type= requires a value (e.g. --type=agent)");
      }
    } else if (arg === "--author") {
      const r = takeValue(arg, args[i], i);
      flags.author = r.value;
      i = r.i;
    } else if (arg === "--description") {
      const r = takeValue(arg, args[i], i);
      flags.description = r.value;
      i = r.i;
    } else if (arg === "--license") {
      const r = takeValue(arg, args[i], i);
      flags.license = r.value;
      i = r.i;
    } else if (arg === "--target") {
      const r = takeValue(arg, args[i], i);
      flags.target = r.value;
      i = r.i;
    } else if (isFlagLike(arg)) {
      throw unknownFlagError(arg, "init");
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw usageError(
      `init takes at most one positional argument (the project name), got ${positional.length}: ${positional.join(", ")}`,
    );
  }

  return { flags, positional };
}

function printUsage() {
  console.error("Usage: npx @ctxr/kit init [name] [options]");
  console.error("");
  console.error("Scaffold a new ctxr artifact package via a 9-question wizard.");
  console.error("Each wizard step is bypassed by passing the matching flag.");
  console.error("");
  console.error("Arguments:");
  console.error("  name                target directory name (default: cwd basename)");
  console.error("");
  console.error("Wizard field flags:");
  console.error(`  -t, --type <type>   artifact type (default: ${DEFAULT_TYPE})`);
  console.error(`                      one of: ${ARTIFACT_TYPE_NAMES.join(", ")}`);
  console.error("  --author <name>     author string for package.json (default: git config)");
  console.error("  --description <s>   package description (required in wizard; TODO placeholder");
  console.error("                      non-interactively)");
  console.error("  --license <name>    SPDX license id (default: MIT)");
  console.error("  --target <t>        folder | file (default: folder for skill, file for others)");
  console.error("  --force             overwrite an existing target directory");
  console.error("  --git-init          run `git init` after scaffolding");
  console.error("  --no-git-init       skip git init even in interactive mode");
  console.error("  --npm-install       run `npm install` after scaffolding");
  console.error("  --no-npm-install    skip npm install even in interactive mode");
  console.error("");
  console.error("Behavior flags:");
  console.error("  -y, --yes           skip wizard, use defaults (description falls through to TODO)");
  console.error("  -i, --interactive   force wizard (overrides CI auto-detection)");
  console.error("  -h, --help          show this help");
  console.error("");
  console.error("Examples:");
  console.error("  npx @ctxr/kit init my-skill");
  console.error("  npx @ctxr/kit init my-agent --type agent");
  console.error("  npx @ctxr/kit init my-skill --yes --description 'Reviews code'");
}

// ─── The 9 wizard questions ──────────────────────────────────────────────

/** Step 1 — type */
async function askType(flags, prompt) {
  if (flags.type) return flags.type;
  return prompt.select({
    message: "What type of artifact?",
    options: ARTIFACT_TYPE_NAMES.map((t) => ({ value: t, label: t })),
    defaultValue: DEFAULT_TYPE,
    flags,
  });
}

/**
 * Step 2 — name. The positional argument may be either a bare name
 * (`kit init my-skill`) or a target path (`kit init ./path/to/my-skill`).
 * Either way, the *package name* is the basename of that path. Matches
 * the pre-wizard init behavior so existing tests and callers that pass
 * paths continue to work.
 */
async function askName(positional, flags, prompt, cwdBasename) {
  if (positional.length > 0) return basename(positional[0]);
  const defaultName = sanitizeName(cwdBasename) || "";
  return prompt.text({
    message: "Package name",
    placeholder: "my-skill",
    defaultValue: defaultName,
    validate: (v) => {
      const s = (v ?? "").trim();
      if (s.length === 0) return "Name cannot be empty";
      if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) {
        return "Name must be lowercase alphanumeric + hyphens, starting with a letter or digit";
      }
      return undefined;
    },
    flags,
  });
}

/** Step 3 — author */
async function askAuthor(flags, prompt) {
  if (typeof flags.author === "string") return flags.author;
  const def = defaultAuthor();
  return prompt.text({
    message: "Author (optional, press Enter to skip)",
    placeholder: "Jane Doe <jane@example.com>",
    defaultValue: def,
    flags,
  });
}

/**
 * Step 4 — description (required in the interactive wizard).
 *
 * In non-interactive mode (--yes, CI=true, !isTTY) a missing --description
 * falls through to a placeholder of the form "TODO — describe what this
 * <type> does and when it should be used." so existing scaffolded packages
 * get a valid string and the author can edit it afterwards. The interactive
 * wizard has no fallback — the user must type something (or cancel).
 */
async function askDescription(flags, prompt, type) {
  if (typeof flags.description === "string" && flags.description.length > 0) {
    return flags.description;
  }
  if (prompt.isNonInteractive(flags)) {
    return `TODO — describe what this ${type} does and when it should be used.`;
  }
  return prompt.text({
    message: `Short description — what does this ${type} do?`,
    placeholder: "Reviews code using the @ctxr/kit standard",
    validate: (v) => {
      const s = (v ?? "").trim();
      if (s.length === 0) return "Description is required";
      if (s.length > 300) return `Description is too long (${s.length}/300 chars)`;
      return undefined;
    },
    flags,
  });
}

/**
 * Normalize a user-entered license string into a canonical SPDX shape.
 * SPDX identifiers are case-sensitive in the spec (`MIT`, `Apache-2.0`,
 * `BSD-3-Clause`, `ISC`, `UNLICENSED`). Users who type `mit` or `APACHE-2.0`
 * expect the same thing; we map the common cases to their canonical form.
 * Anything else passes through unchanged.
 */
function normalizeLicense(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const upper = trimmed.toUpperCase();
  // Match the standard choices first.
  if (upper === "MIT") return "MIT";
  if (upper === "APACHE-2.0") return "Apache-2.0";
  if (upper === "ISC") return "ISC";
  if (upper === "UNLICENSED") return "UNLICENSED";
  // BSD family.
  if (upper === "BSD-2-CLAUSE") return "BSD-2-Clause";
  if (upper === "BSD-3-CLAUSE") return "BSD-3-Clause";
  // Pass through whatever the user typed — they might be specifying a
  // less-common identifier kit doesn't know about.
  return trimmed;
}

/** Step 5 — license */
async function askLicense(flags, prompt) {
  if (flags.license) return normalizeLicense(flags.license);
  const options = [
    ...LICENSE_CHOICES.map((l) => ({ value: l, label: l })),
    { value: "__custom__", label: "Custom…" },
  ];
  const choice = await prompt.select({
    message: "License",
    options,
    defaultValue: "MIT",
    flags,
  });
  if (choice === "__custom__") {
    const raw = await prompt.text({
      message: "SPDX license identifier",
      placeholder: "BSD-3-Clause",
      defaultValue: "MIT",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "License cannot be empty";
        return undefined;
      },
      flags,
    });
    return normalizeLicense(raw);
  }
  return choice;
}

/** Step 6 — target */
async function askTarget(flags, prompt, type) {
  if (flags.target) return flags.target;
  // Teams have no target (no files shipped).
  if (type === "team") return null;
  const defaultTarget = type === "skill" ? "folder" : "file";
  // Skills are always folder; the prompt is only meaningful for types where
  // both shapes make sense (agents in particular).
  if (type === "skill") return "folder";
  return prompt.select({
    message: "Layout",
    options: [
      { value: "file", label: "file (single .md in .claude/<type>/)" },
      { value: "folder", label: "folder (wrapper dir with multi-file payload)" },
    ],
    defaultValue: defaultTarget,
    flags,
  });
}

/**
 * Step 7 — overwrite confirmation.
 *
 * Existing-dir-blocks-init is a runtime state, not a usage error — the
 * user's args are syntactically valid, the filesystem just won't let us
 * scaffold on top of existing files. Throws plain Error (exit 1) rather
 * than `usageError` (exit 2) so scripts can distinguish the two modes.
 */
async function askOverwrite(flags, prompt, targetDir) {
  if (flags.force === true) return true;
  if (!existsSync(targetDir)) return true;
  // Empty dir is fine — kit can scaffold into it without stomping.
  try {
    const contents = readdirSync(targetDir);
    if (contents.length === 0) return true;
  } catch {
    // If we can't read it, fall through to the prompt.
  }
  if (prompt.isNonInteractive(flags)) {
    // Non-interactive: bail unless --force was explicit.
    throw new Error(`Directory already exists: ${targetDir}`);
  }
  return prompt.confirm({
    message: `Directory ${targetDir} exists and is not empty. Overwrite?`,
    defaultValue: false,
    flags,
  });
}

/** Step 8 — git init */
async function askGitInit(flags, prompt) {
  if (flags.gitInit !== null) return flags.gitInit;
  return prompt.confirm({
    message: "Run `git init` in the new directory?",
    defaultValue: false,
    flags,
  });
}

/** Step 9 — npm install */
async function askNpmInstall(flags, prompt) {
  if (flags.npmInstall !== null) return flags.npmInstall;
  return prompt.confirm({
    message: "Run `npm install` in the new directory?",
    defaultValue: false,
    flags,
  });
}

// ─── Actions ─────────────────────────────────────────────────────────────

/**
 * Format a child-process error for user display. `execFileSync` surfaces
 * different failure modes through different properties: timeouts set
 * `signal === "SIGTERM"`, missing binaries set `code === "ENOENT"`, and
 * crashes set `status` (exit code) + include stderr in `message`. Kit
 * surfaces the distinction so users can tell "binary not installed" from
 * "binary ran too long" from "binary exited non-zero".
 */
function describeChildError(err, binary) {
  if (err?.code === "ENOENT") {
    return `${binary} is not installed or not on PATH`;
  }
  if (err?.signal === "SIGTERM") {
    return `${binary} timed out`;
  }
  if (typeof err?.status === "number") {
    return `${binary} exited with code ${err.status}`;
  }
  return err?.message ?? `${binary} failed`;
}

function runGitInit(cwd) {
  try {
    execFileSync("git", ["init"], {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 15_000,
    });
    console.log("  ✓ git init complete");
    return true;
  } catch (err) {
    console.error(`  ⚠ git init failed: ${describeChildError(err, "git")}`);
    return false;
  }
}

function runNpmInstall(cwd) {
  try {
    execFileSync("npm", ["install"], {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 300_000,
    });
    console.log("  ✓ npm install complete");
    return true;
  } catch (err) {
    console.error(
      `  ⚠ npm install failed: ${describeChildError(err, "npm")}`,
    );
    return false;
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────

export default async function init(args, opts = {}) {
  const prompt = opts.prompt ?? interactive;

  const { flags, positional } = parseArgs(args);

  if (flags.help) {
    printUsage();
    return;
  }

  // Show intro in interactive mode.
  prompt.intro?.("@ctxr/kit init", flags);

  try {
    // Run all 9 wizard questions. Each function bypasses its own prompt if
    // the matching flag was passed, and falls through to its default when
    // running non-interactively without a flag.
    const cwdBasename = basename(resolve("."));
    const type = await askType(flags, prompt);
    if (!ARTIFACT_TYPE_NAMES.includes(type)) {
      // Match the legacy error message shape `Unknown --type "x"` so
      // existing tests and scripted error-message scraping keep working.
      throw usageError(
        `Unknown --type "${type}". Must be one of: ${ARTIFACT_TYPE_NAMES.join(", ")}.`,
      );
    }

    const name = await askName(positional, flags, prompt, cwdBasename);
    if (!name || name.length === 0) {
      throw usageError("Name is required");
    }
    // Validate positional-sourced names too — `askName` only runs the
    // grammar validator for the wizard `text()` prompt, not for the
    // positional arg. Without this, `kit init MY-UPPER` would write
    // `@ctxr/MY-UPPER` into package.json and fail on `npm publish`.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw usageError(
        `Invalid name "${name}" — must be lowercase alphanumeric + hyphens, starting with a letter or digit`,
      );
    }

    const author = await askAuthor(flags, prompt);
    const description = await askDescription(flags, prompt, type);
    const license = await askLicense(flags, prompt);
    const target = await askTarget(flags, prompt, type);

    // Decide target directory.
    //   - positional given → resolve it as-is
    //   - no positional    → scaffold into the CURRENT working directory
    //                        (not `resolve(name)`) so `kit init` in an
    //                        empty dir writes package.json etc. into the
    //                        dir itself, matching the pre-wizard behavior.
    const targetDir =
      positional.length > 0 ? resolve(positional[0]) : resolve(".");
    const overwrite = await askOverwrite(flags, prompt, targetDir);
    if (!overwrite) {
      // User explicitly declined the overwrite confirm (interactive path).
      // Distinct from the non-interactive path, which throws directly from
      // `askOverwrite` with a "Directory already exists" precondition error.
      // Here the user saw the question and said no, so the message reflects
      // their choice rather than falsely implying a broken arg.
      throw new Error(`Overwrite declined for ${targetDir}`);
    }

    const wantGitInit = await askGitInit(flags, prompt);
    const wantNpmInstall = await askNpmInstall(flags, prompt);

    // Scaffold.
    const templateDir = join(TEMPLATES_ROOT, type);
    if (!existsSync(templateDir)) {
      throw new Error(
        `Internal: template directory missing for type "${type}" at ${templateDir}`,
      );
    }

    console.log(`\nScaffolding ${type}: ${name}\n`);

    const vars = {
      name,
      titleName: toTitle(name),
      type,
      description,
      license,
      year: String(new Date().getFullYear()),
      author: author || "",
      // target may be null for teams; substitute empty to avoid `{{target}}`
      // literal showing up in rendered templates.
      target: target || "",
    };

    const created = copyTemplate(templateDir, targetDir, vars);

    console.log("  Created:");
    for (const file of created) {
      console.log(`    ${file}`);
    }
    console.log();

    if (wantGitInit) runGitInit(targetDir);
    if (wantNpmInstall) runNpmInstall(targetDir);

    console.log("  Next steps:");
    console.log(`    1. Edit the generated files to describe your ${type}`);
    console.log("    2. Run 'npx @ctxr/kit validate' to check structure");
    console.log();

    prompt.outro?.(`${name} scaffolded at ${targetDir}`, flags);
  } catch (err) {
    if (err instanceof interactive.UserAbortError) {
      console.error("\n  Cancelled.");
    }
    throw err;
  }
}

// Expose helpers for tests (and any future caller).
export { parseArgs, sanitizeName, defaultAuthor, normalizeLicense };
