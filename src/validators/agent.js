/**
 * Agent validator.
 *
 * For `target: "file"` agents (Claude Code's native single-file discovery
 * format), check YAML frontmatter on the single `.md` file. For
 * `target: "folder"` bundles, acknowledge the bundle — folder agents ship
 * docs/examples alongside AGENT.md and there is no canonical entry file for
 * kit to validate.
 *
 * Exported as `validate(root, ctx, resolved)` to match the dispatcher
 * contract; the implementation lives in `./common.js` so agent/command/
 * rule/output-style can diverge independently when type-specific checks
 * arrive later.
 */

export { validateSingleFileArtifact as validate } from "./common.js";
