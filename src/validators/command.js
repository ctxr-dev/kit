/**
 * Command validator.
 *
 * Slash commands are single-file `.md` artifacts with YAML frontmatter
 * declaring the command metadata. For `target: "file"`, check frontmatter
 * sanity. For `target: "folder"` (rare — a command bundle with helper
 * files), acknowledge the bundle.
 *
 * Exported as `validate(root, ctx, resolved)` to match the dispatcher
 * contract; shared implementation lives in `./common.js`.
 */

export { validateSingleFileArtifact as validate } from "./common.js";
