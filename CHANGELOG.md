# Changelog

All notable changes to `@ctxr/kit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.4] - 2026-05-31

### Changed

- Repointed the remaining `install @ctxr/bundle-full-stack` example shown by `kit install --help` to a published package. 2.0.3 only fixed the README and the top-level `--help`, so the install subcommand's help still printed a 404 target.

## [2.0.3] - 2026-05-31

### Changed

- Repointed the `@ctxr/bundle-*` install examples in the README and CLI help to a published package: no `@ctxr/bundle-*` package is on npm yet, so the old examples 404'd on copy-paste.
- Documented the 2.0.1 and 2.0.2 releases below and marked 2.0.0 as released (it had been left as "Unreleased").

## [2.0.2] - 2026-05-29

### Changed

- Pinned the CLI's own printed usage, examples, and error hints to `npx @ctxr/kit@latest` so copy-pasted commands resolve reliably on newer npm, where an unpinned scoped npx spec can fail to link its bin. Test assertions updated to match.

## [2.0.1] - 2026-05-29

### Changed

- Pinned every documented `npx @ctxr/kit` invocation (README plus the six scaffolding templates) to `npx @ctxr/kit@latest`.

## [2.0.0] - 2026-05-29

### BREAKING

- **Renamed the `team` meta-type to `bundle`.** Every consumer-facing surface (the package.json `ctxr.type`, the install/list/remove/update/info/init commands, the manifest dir `.agents/bundles/`, the cycle-detection error string, the per-type validator, the help text, the keywords) now references `bundle` exclusively. Both `ctxr.type: "team"` and `ctxr.target: "team"` are rejected up-front in `resolveType` with a pointing error. No alias, no shim, no deprecation window: no consumer was on `team` at cutover (`team` shipped during the pre-1.0 dev cycle but no published artefact ever used it from outside this monorepo), so 2.0.0 is the clean break. **To upgrade:** replace `"type": "team"` with `"type": "bundle"` AND remove any `"target"` field on bundle meta-packages (`ctxr.target` is only used for ordinary artifacts, where it must be `"folder"` or `"file"`; bundles do not use it). For ordinary artifacts that previously read `"target": "team"`, that combination was invalid then too: set `"target": "folder"` or `"target": "file"` as appropriate. The `templates/bundle/` scaffold (formerly `templates/team/`) ships the new shape; `kit init --type bundle` offers it by default.
- Renamed the `tests/fixtures/team/` corpus to `tests/fixtures/bundle/` and updated every fixture name/description so a future test fixture audit reads `bundle` consistently.

### Changed

- **Repositioned as the Universal CLI for Agent Skills artifacts** (Claude Code, OpenAI Codex CLI, OpenCode, and any other harness implementing the open [Agent Skills standard](https://agentskills.io)). README headline, package.json description, and keywords now lead with the cross-harness framing.
- **Canonical install location flipped to `.agents/<type>/`** (project) and `~/.agents/<type>/` (user) for every artifact type (skill, agent, command, rule, output-style, bundle). The legacy `.claude/<type>/` location is no longer a destination; it becomes a discovery-mirror symlink that kit creates automatically so Claude Code's native discovery still finds the artefact. User-scope installs additionally create symlinks at `~/.claude/<type>/<name>` and `~/.codex/<type>/<name>` so Claude Code and Codex CLI both auto-discover global installs.
- Symlink mirrors are best-effort relative on POSIX (so checked-in repos stay portable across hosts) and fall back to junction → hardlink → copy + sentinel on Windows when symlink permissions are missing.
- Reordered package.json keywords to lead with `agent-skills`, `agents-md`, `codex`, `claude-code` so registry searches for open-standard terms surface this package first.

### Added

- **`subagent.dispatch.v1` envelope spec** at `docs/subagent-dispatch-v1.md` plus a JSON Schema at `templates/_common/subagent-dispatch-v1.schema.json`. Defines the cross-harness sub-agent dispatch contract that skill-llm-wiki's Tier 2 protocol and skill-code-review's `--print-batch-envelope --format=dispatch-v1` mode both conform to. The schema is JSON Schema Draft 2020-12 with `additionalProperties: true` so skills can add extension fields (e.g. `tier2_kind`); the spec documents extension-profile rules.
- **Auto-emitted `AGENTS.md`** at the project root for project-scope installs, with stable `<!-- ctxr:skills:start -->` / `<!-- ctxr:skills:end -->` markers. Codex CLI and other harnesses that read top-level `AGENTS.md` discover installed skills via this file. Hand-authored content outside the markers is preserved verbatim across re-installs and removes. Disable entirely with `CTXR_NO_AGENTS_MD=1`.
- **Migration of legacy `.claude/<type>/<name>/` installs** on every `kit install` invocation. Idempotent move-and-symlink semantics: real legacy directories are moved to `.agents/<type>/<name>/`, replaced with a symlink, and the manifest row is migrated with a `migratedFrom` stamp. `kit update` does NOT auto-migrate to preserve user-deliberate layouts. Skipped when `--dir` is set.
- **Symlink-injection-resistant `ensureMirror`/`removeMirror` helpers** at `src/lib/symlink.js`. Refuses to overwrite real (non-symlink) files or directories at mirror paths; refuses to remove symlinks pointing somewhere unexpected.
- `publishConfig.access: "public"` so `npm publish` does not require a trailing `--access public`.
- `prepublishOnly` script running the test suite before publish.
- Spec doc and schema both ship in the npm payload via `files`.

### Security

- **AGENTS.md row sanitiser** strips newlines/CR/tabs, backticks, and HTML-comment delimiters from every row value (description, name, type, path) before serialisation. A package shipping a description containing the section end marker would previously DoS the AGENTS.md emitter on parse-back; rows are now always parse-safe.
- **`flag: "wx"` (O_EXCL)** on the atomic-write tmp paths in `agents-md.js` and `discover.js#writeManifest` so a pre-planted symlink at the tmp slot causes EEXIST instead of being followed and written through.
- **Manifest pollution-key reviver** drops `__proto__` / `constructor` / `prototype` keys at JSON.parse time as defence-in-depth against malicious manifest entries.
- **Migration containment guards** (`isContainedUnder`) refuse migration when the legacy or canonical leaf escapes its manifest directory, blocking traversal-style installedNames.

### Removed

- `STRATEGY_PROJECT_CLAUDE` symbolic strategy and its menu option. The destination menu now has three options: project-local (`.agents/`), user-global (`~/.agents/`), and Custom path.

## Pre-history

Versions ≤ 1.2.2 shipped as a Claude Code-only artefact installer with `.claude/<type>/` as the primary install location. Release notes for those versions live as annotated git tags and on GitHub Releases.
