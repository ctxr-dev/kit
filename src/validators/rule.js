/**
 * Rule validator.
 *
 * Rules are single-file `.md` artifacts whose YAML frontmatter declares
 * the scope / globs / priority the rule applies to. For `target: "file"`,
 * check frontmatter sanity.
 *
 * Exported as `validate(root, ctx, resolved)` to match the dispatcher
 * contract; shared implementation lives in `./common.js`.
 */

export { validateSingleFileArtifact as validate } from "./common.js";
