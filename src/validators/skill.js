/**
 * Skill validator — absorbs the full legacy `kit validate` logic:
 *
 *   - SKILL.md frontmatter (name, description, 300-char description warning)
 *   - Required files (SKILL.md) + recommended files (README.md, LICENSE)
 *   - Cross-references: every `[text](file.md)` link inside the skill's
 *     own `.md` tree must resolve on disk.
 *   - Line count budget: warn on any `.md` > 500 lines.
 *   - Code-review auto-detect: if `reviewers/` and `code-reviewer.md` are
 *     present, verify the reviewer index matches the files on disk and the
 *     overlay index matches `overlays/{frameworks,languages,infra}/`.
 *
 * The skill validator intentionally does NOT call `packagePayload()` — the
 * generic check in the dispatcher already asserts `files` is non-empty,
 * and skill validation is about the *content* on disk (broken links,
 * frontmatter, reviewer index consistency), not the publish payload.
 *
 * Errors/warnings flow through the caller-provided `ctx` object (plain
 * closures over a counter) rather than module-level state so a single
 * process can validate multiple packages without counter bleed.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import matter from "gray-matter";

function collectMdFiles(dir, exclude = ["node_modules", ".git"]) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectMdFiles(full, exclude));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

// ─── Generic Skill Validation ──────────────────────────────────────────────

function validateSkillFrontmatter(root, ctx) {
  console.log("\n▸ SKILL.md frontmatter");

  const skillPath = join(root, "SKILL.md");
  if (!existsSync(skillPath)) {
    ctx.error("SKILL.md not found — every skill must have a SKILL.md");
    return null;
  }

  const content = readFileSync(skillPath, "utf8");
  let data;
  try {
    ({ data } = matter(content));
  } catch (e) {
    ctx.error(`SKILL.md: invalid frontmatter — ${e.message}`);
    return null;
  }

  if (!data.name) ctx.error("SKILL.md: missing 'name' in frontmatter");
  else ctx.ok(`name: ${data.name}`);

  if (!data.description) ctx.error("SKILL.md: missing 'description' in frontmatter");
  else if (data.description.length > 300)
    ctx.warn(
      `SKILL.md: description is ${data.description.length} chars (recommended ≤300)`,
    );
  else ctx.ok(`description: ${data.description.length} chars`);

  return data;
}

function validateRequiredFiles(root, ctx) {
  console.log("\n▸ Required files");

  const required = ["SKILL.md"];
  const recommended = ["README.md", "LICENSE"];

  for (const file of required) {
    if (!existsSync(join(root, file))) {
      ctx.error(`Required file missing: ${file}`);
    }
  }

  for (const file of recommended) {
    if (!existsSync(join(root, file))) {
      ctx.warn(`Recommended file missing: ${file}`);
    }
  }

  ctx.ok("Required files check complete");
}

// Match `[text](path.md)` and `[text](path.md#anchor)` where the path part
// has no scheme and ends in `.md`. The path capture stops at `#`, `)`, or
// whitespace so anchored links still resolve to their base file on disk.
//
// Excluded by design:
//   - `http://`, `https://`, `mailto:`, `tel:`, `ftp://`, `file://`, etc.
//     (any URL with a scheme — `://` or `mailto:`/`tel:` prefix).
//   - Reference-style links (`[foo]: path.md`) — those are documentation
//     conventions not currently used by ctxr skills; if they appear we'd
//     rather false-negative than false-positive at the publish gate.
//   - Links inside fenced code blocks. We strip ```...``` and `...` spans
//     before matching so a skill that documents broken-link examples in
//     its own README does not fail validation.
const MD_LINK_RE =
  /\[([^\]]*)\]\((?!\w[\w+.-]*:)([^)#\s]+\.md)(?:#[^)\s]*)?\)/g;

function stripCodeSpans(content) {
  // Remove fenced code blocks first (multi-line, greedy per fence pair),
  // then inline backtick spans. Order matters — fences can contain backticks.
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function validateCrossReferences(root, ctx) {
  console.log("\n▸ Cross-references");

  const allMd = collectMdFiles(root);
  let broken = 0;

  for (const file of allMd) {
    const raw = readFileSync(file, "utf8");
    const content = stripCodeSpans(raw);
    const links = [...content.matchAll(MD_LINK_RE)];

    for (const [, , ref] of links) {
      const target = join(dirname(file), ref);
      if (!existsSync(target)) {
        ctx.error(
          `${relative(root, file)} → broken link to '${ref}' (resolved: ${relative(root, target)})`,
        );
        broken++;
      }
    }
  }

  if (broken === 0) {
    ctx.ok(`All cross-references valid across ${allMd.length} files`);
  }
}

function validateLineCount(root, ctx) {
  console.log("\n▸ Line count budget");

  const allMd = collectMdFiles(root);
  let oversized = 0;

  for (const file of allMd) {
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > 500) {
      ctx.warn(
        `${relative(root, file)}: ${lines} lines (recommended ≤500 for token budget)`,
      );
      oversized++;
    }
  }

  if (oversized === 0) {
    ctx.ok("All files within token budget");
  }
}

// ─── Skill-Specific: Code Review ───────────────────────────────────────────

function detectAndValidateCodeReview(root, ctx) {
  // Auto-detect code-review skill by presence of reviewers/ and code-reviewer.md
  const hasReviewers = existsSync(join(root, "reviewers"));
  const hasOrchestrator = existsSync(join(root, "code-reviewer.md"));
  if (!hasReviewers || !hasOrchestrator) return;

  console.log("\n▸ Code review: reviewer files");

  const reviewerFiles = readdirSync(join(root, "reviewers")).filter((f) =>
    f.endsWith(".md"),
  );

  if (reviewerFiles.length === 0) {
    ctx.error("No reviewer files found in reviewers/");
  } else {
    ctx.ok(`${reviewerFiles.length} reviewer files found`);
  }

  for (const file of reviewerFiles) {
    const content = readFileSync(join(root, "reviewers", file), "utf8");
    const h1 = content.split("\n").find((l) => l.startsWith("# "));
    if (!h1) ctx.error(`reviewers/${file}: missing H1 title`);
  }

  // Reviewer index consistency — check both reviewers/index.yaml and code-reviewer.md
  console.log("\n▸ Code review: reviewer index consistency");

  let indexSource = "";
  const yamlIndex = join(root, "reviewers", "index.yaml");
  if (existsSync(yamlIndex)) {
    indexSource = readFileSync(yamlIndex, "utf8");
  } else {
    indexSource = readFileSync(join(root, "code-reviewer.md"), "utf8");
  }
  const idMatches = [...indexSource.matchAll(/^- id:\s*(.+)$/gm)];
  const indexedIds = idMatches.map((m) => m[1].trim());
  const fileIds = reviewerFiles.map((f) => f.replace(/\.md$/, ""));

  for (const id of indexedIds) {
    if (!fileIds.includes(id)) {
      ctx.error(
        `Reviewer index references '${id}' but reviewers/${id}.md does not exist`,
      );
    }
  }

  for (const id of fileIds) {
    if (!indexedIds.includes(id)) {
      ctx.error(
        `reviewers/${id}.md exists but is not referenced in code-reviewer.md index`,
      );
    }
  }

  if (indexedIds.length > 0) {
    ctx.ok(`${indexedIds.length} reviewer IDs match ${fileIds.length} files`);
  }

  // Overlay index consistency
  if (existsSync(join(root, "overlays", "index.md"))) {
    console.log("\n▸ Code review: overlay index consistency");

    const overlayIndex = readFileSync(join(root, "overlays", "index.md"), "utf8");
    const linkMatches = [
      ...overlayIndex.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g),
    ];
    const indexedFiles = linkMatches.map((m) => m[2]);

    const overlayDirs = ["frameworks", "languages", "infra"];
    const actualFiles = [];

    for (const dir of overlayDirs) {
      const dirPath = join(root, "overlays", dir);
      if (!existsSync(dirPath)) continue;
      const files = readdirSync(dirPath).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        actualFiles.push(`${dir}/${file}`);
      }
    }

    for (const ref of indexedFiles) {
      if (!existsSync(join(root, "overlays", ref))) {
        ctx.error(`Overlay index references '${ref}' but file does not exist`);
      }
    }

    for (const file of actualFiles) {
      if (!indexedFiles.includes(file)) {
        ctx.error(
          `overlays/${file} exists on disk but is not listed in overlays/index.md`,
        );
      }
    }

    ctx.ok(
      `${indexedFiles.length} index entries match ${actualFiles.length} overlay files`,
    );
  }
}

/**
 * Run skill-specific validation. Called by the dispatcher after the generic
 * (ctxr block, type, target) checks have passed.
 *
 * @param {string} root — absolute package directory
 * @param {object} ctx — { error, warn, ok } closures
 * @param {object} _resolved — resolveType() output + pkgJson (unused for skill;
 *                             disk state drives every check)
 */
export function validate(root, ctx, _resolved) {
  validateSkillFrontmatter(root, ctx);
  validateRequiredFiles(root, ctx);
  validateCrossReferences(root, ctx);
  validateLineCount(root, ctx);
  detectAndValidateCodeReview(root, ctx);
}
