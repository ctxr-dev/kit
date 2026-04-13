/**
 * Lightweight template engine for scaffolding.
 *
 * Copies a directory tree, replacing {{variable}} placeholders in both
 * file contents and filenames. Handles special naming conventions:
 *
 *   _gitignore  →  .gitignore   (npm strips dotfiles from packages)
 *   *.tmpl      →  * (extension removed, e.g. package.json.tmpl → package.json)
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * Interpolate {{variable}} placeholders in a string.
 * @param {string} content
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function interpolate(content, vars) {
  return content.replace(PLACEHOLDER_RE, (match, key) => {
    if (key in vars) return vars[key];
    return match; // leave unmatched placeholders as-is
  });
}

/**
 * Transform a template filename to its output name.
 *   _gitignore     → .gitignore
 *   foo.json.tmpl  → foo.json
 */
function transformFilename(name, vars) {
  let out = name;

  // _dotfile convention
  if (out.startsWith("_")) {
    out = "." + out.slice(1);
  }

  // Strip .tmpl extension
  if (out.endsWith(".tmpl")) {
    out = out.slice(0, -5);
  }

  // Interpolate placeholders in filename
  out = interpolate(out, vars);

  return out;
}

/**
 * Copy a template directory tree to a destination, replacing placeholders.
 *
 * @param {string} templateDir  Absolute path to template source
 * @param {string} destDir      Absolute path to output destination
 * @param {Record<string, string>} vars  Variable values to interpolate
 * @returns {string[]}  List of created file paths (relative to destDir)
 */
export function copyTemplate(templateDir, destDir, vars) {
  const created = [];

  function walk(srcDir, outDir) {
    mkdirSync(outDir, { recursive: true });

    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name);
      const outName = transformFilename(entry.name, vars);
      const outPath = join(outDir, outName);

      if (entry.isDirectory()) {
        walk(srcPath, outPath);
      } else {
        const raw = readFileSync(srcPath, "utf8");
        const rendered = interpolate(raw, vars);
        writeFileSync(outPath, rendered);
        created.push(outPath.slice(destDir.length + 1));
      }
    }
  }

  walk(templateDir, destDir);
  return created;
}
