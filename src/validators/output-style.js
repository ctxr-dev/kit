/**
 * Output-style validator.
 *
 * Output styles are single-file `.md` artifacts with YAML frontmatter
 * describing the style's name, description, and matching conditions. For
 * `target: "file"`, check frontmatter sanity.
 *
 * Exported as `validate(root, ctx, resolved)` to match the dispatcher
 * contract; shared implementation lives in `./common.js`.
 */

export { validateSingleFileArtifact as validate } from "./common.js";
