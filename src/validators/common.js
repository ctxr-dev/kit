/**
 * Shared frontmatter sanity check for single-file artifact validators.
 *
 * Agents, commands, rules, and output-styles with `ctxr.target: "file"` all
 * ship exactly one `.md` file whose YAML frontmatter declares `name` and
 * `description`. The four thin validator modules re-export this helper so
 * each type has its own dispatch key while sharing identical logic — adding
 * type-specific checks later is a one-file edit.
 *
 * For `ctxr.target: "folder"` non-skill bundles there is no canonical entry
 * file and no content convention Claude Code enforces, so this helper just
 * acknowledges the bundle. Generic payload checks in the dispatcher have
 * already confirmed `files` is non-empty.
 *
 * The validator runs AFTER the dispatcher's generic payload check, so the
 * already-computed `fileTargetResolution` is threaded through the `resolved`
 * context and reused here — no second `npm pack --dry-run` per validate run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

/**
 * Validate a single-file artifact (target:"file") by inspecting the one
 * artifact file's YAML frontmatter. If the package declares `target:"folder"`
 * we emit an info line and return — folder bundles have no canonical entry.
 *
 * @param {string} root — absolute package directory
 * @param {object} ctx — { error, warn, ok } closures
 * @param {object} resolved — { type, target, config, pkgJson,
 *                              payload, fileTargetResolution }
 */
export function validateSingleFileArtifact(root, ctx, resolved) {
  if (resolved.target === "folder") {
    console.log(`\n▸ ${resolved.type} bundle`);
    ctx.ok(`${resolved.type} folder bundle — payload is the entire tree`);
    return;
  }

  // target: "file" — the dispatcher has already asserted the payload filters
  // down to exactly one `.md` file AND reported the error on failure. If the
  // resolution failed upstream we silently return so we don't double-report.
  const resolution = resolved.fileTargetResolution;
  if (!resolution || !resolution.ok) return;

  const single = resolution.single;
  const filePath = join(root, single);

  console.log(`\n▸ ${single} frontmatter`);

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    ctx.error(`${single}: could not read file — ${e.message}`);
    return;
  }

  let data;
  try {
    ({ data } = matter(content));
  } catch (e) {
    ctx.error(`${single}: invalid frontmatter — ${e.message}`);
    return;
  }

  if (!data.name) ctx.error(`${single}: missing 'name' in frontmatter`);
  else ctx.ok(`name: ${data.name}`);

  if (!data.description) {
    ctx.error(`${single}: missing 'description' in frontmatter`);
  } else if (data.description.length > 300) {
    ctx.warn(
      `${single}: description is ${data.description.length} chars (recommended ≤300)`,
    );
  } else {
    ctx.ok(`description: ${data.description.length} chars`);
  }
}
