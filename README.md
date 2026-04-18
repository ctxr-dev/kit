# @ctxr/kit

[![npm](https://img.shields.io/npm/v/@ctxr/kit)](https://www.npmjs.com/package/@ctxr/kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Universal CLI for Claude Code artifacts — install, validate, update, and
scaffold **skills, agents, commands, rules, output-styles, and teams** with
one command. The `package.json` `files` field is the single source of truth
for what each package ships, and the manifest filename `.ctxr-manifest.json`
is written per install root. Run the CLI via `npx @ctxr/kit` — no global
install required.

## Quick start

```bash
npx @ctxr/kit install @ctxr/skill-code-review     # add the code-review skill
npx @ctxr/kit list                                # see what's installed
```

That's the whole loop. Run `npx @ctxr/kit --help` for the full command set.

## Prerequisites

- **Node.js ≥ 18.0.0** (uses ESM, `node:test`, and the modern `node:fs` API)
- A project directory where you want artifacts installed. Project-scope
  installs land under `.claude/<type>/` by default; user-scope installs
  (`--user`) land under `~/.claude/<type>/`.

## Install

Kit is run exclusively via `npx` — no global install required.

```bash
npx @ctxr/kit <command>
```

Every example below uses the `npx @ctxr/kit` form. If you prefer a short
alias, add one to your shell (`alias kit='npx @ctxr/kit'`) — kit itself
never asks you to install it globally.

## Interactive mode (default)

`kit` is **interactive by default**. In a terminal, every command that has
a choice to make prompts you with an arrow-key menu or a short question:

- `install` shows a destination menu with every candidate location
  (`.claude/<type>/`, `.agents/<type>/`, `~/.claude/<type>/`, or a custom
  path you type) and pre-highlights the one kit would auto-pick.
- For any artifact you're installing that's already installed at a
  *different* location than you just picked, `install` asks per-item
  whether to **keep** it there (update in place) or **move** it to the
  chosen destination.
- `update` pre-flights the list — if any identifier you named isn't
  installed yet, it prints the missing list and exits so you don't
  silently update "everything except those".
- `remove` that finds an artifact in multiple locations asks which one to
  remove. Missing identifiers are soft-skipped with a one-line note.
- `init` runs a 9-question wizard (type, name, author, description,
  license, target, overwrite confirmation, git init, npm install) with
  smart defaults drawn from `git config` and the current directory name.

### Non-interactive / scripted use

Non-interactive mode kicks in automatically in three cases, no flag
required:

1. **`CI=true`** environment variable is set (GitHub Actions, GitLab CI,
   CircleCI, Travis, Buildkite, and most other CI runners set this).
2. **stdin is not a TTY** (e.g. `kit install X < /dev/null`, or kit
   running under `spawn()` with piped stdio).
3. **Explicit `--yes` / `-y`** flag on the command line.

In non-interactive mode every prompt resolves to its declared default, and
`install` never destructively moves an existing install — it updates in
place at whatever location the artifact is currently at. This keeps
automation stable: pipelines that run `npx @ctxr/kit install X` will
always land the artifact in a predictable place.

```bash
# All equivalent — all three trigger silent, no-prompt behavior:
npx @ctxr/kit install @ctxr/skill-code-review --yes
CI=true npx @ctxr/kit install @ctxr/skill-code-review
npx @ctxr/kit install @ctxr/skill-code-review < /dev/null
```

### Forcing interactive mode in CI

If you need prompts even under `CI=true` (rare, but useful in dev
containers), pass `-i` / `--interactive`. That flag overrides all three
auto-detection triggers.

## Artifact types

`kit` understands every artifact type Claude Code can discover, plus a `team`
meta-type that bundles several of them into a single installable package.

| Type           | Lands in                          | `ctxr.target`     | Typical payload          |
|----------------|-----------------------------------|-------------------|--------------------------|
| `skill`        | `.claude/skills/<name>/`          | `folder`          | `SKILL.md` + assets      |
| `agent`        | `.claude/agents/<name>.md`        | `file` or `folder`| Single `.md` (or bundle) |
| `command`      | `.claude/commands/<name>.md`      | `file`            | Single `.md`             |
| `rule`         | `.claude/rules/<name>.md`         | `file`            | Single `.md`             |
| `output-style` | `.claude/output-styles/<name>.md` | `file`            | Single `.md`             |
| `team`         | (cascades to `ctxr.includes`)     | n/a               | No payload               |

`.agents/<typeDir>/` and `~/.claude/<typeDir>/` are also discovered when
they exist — see [Install locations](#install-locations) below.

## Per-package schema

Every artifact package declares a `ctxr` block in its `package.json`. Only
`type` and `target` (or `includes` for teams) are required — kit reads
nothing else. The npm-native `files` field is the **single source of truth**
for what ships in the package.

```json
{
  "name": "@ctxr/skill-code-review",
  "version": "1.0.5",
  "files": [
    "SKILL.md",
    "code-reviewer.md",
    "reviewers",
    "overlays",
    "README.md",
    "LICENSE"
  ],
  "ctxr": {
    "type": "skill",
    "target": "folder"
  }
}
```

```json
{
  "name": "@ctxr/team-full-stack",
  "files": ["README.md"],
  "ctxr": {
    "type": "team",
    "includes": [
      "@ctxr/skill-code-review",
      "@ctxr/agent-researcher",
      "@ctxr/rule-typescript-strict"
    ]
  }
}
```

- **`ctxr.type`** — one of `skill | agent | command | rule | output-style | team`. Picks the destination directory.
- **`ctxr.target`** — `"folder"` (wrap full payload in a folder) or `"file"` (copy the single payload file flat). Required for every non-team type.
- **`ctxr.includes`** — required only for teams. Array of package specs to install when this team is installed.

`kit` never introduces a second copy list. There is no `ctxr.copy`, no
`ctxr.entry`, no prefix-inferred type. If `npm pack` would ship it, `kit`
installs it; if not, it doesn't.

## Commands

### `npx @ctxr/kit install <source> [<source>...] [options]`

Install one or more artifacts in a single command. Sources can be mixed —
npm packages, GitHub shorthand, and local paths all work side by side.

```bash
# single artifact
npx @ctxr/kit install @ctxr/skill-code-review

# mixed batch — different types, different sources
npx @ctxr/kit install \
  @ctxr/skill-code-review \
  @ctxr/agent-researcher \
  @ctxr/rule-typescript-strict \
  github:ctxr-dev/output-style-teaching

# team meta-package — cascades to every member
npx @ctxr/kit install @ctxr/team-full-stack

# user-global instead of project-local
npx @ctxr/kit install @ctxr/skill-code-review --user

# explicit destination
npx @ctxr/kit install @ctxr/skill-code-review --dir .agents/skills

# local path (must start with ./, /, or ~/)
npx @ctxr/kit install ./path/to/local-skill
```

**Batch behavior:** if one package in the batch fails (broken `ctxr` block,
`target: "file"` payload that resolves to ≠1 file, network error on a single
fetch), that package is reported and skipped — the rest of the batch
proceeds and `kit` exits non-zero only if anything failed. No all-or-nothing
abort.

#### Install locations

| Location                          | When it's used                                          |
|-----------------------------------|---------------------------------------------------------|
| `.claude/<type>/`                 | Project-level, Claude Code's native discovery directory |
| `.agents/<type>/`                 | Project-level, open-standard parallel                   |
| `~/.claude/<type>/`               | User-global (with `--user`)                             |
| Custom path                       | Via `--dir <path>`                                      |

Auto-detect: `kit` walks the project-level candidates in order
(`.claude/<type>/` first, then `.agents/<type>/`) and installs into the
first one that already exists. If neither exists, it creates
`.claude/<type>/` — Claude Code's native discovery directory — and uses
that.

### `npx @ctxr/kit update [name]`

Re-install one or all artifacts in place using the source recorded in the
manifest. Searches every project- and user-scope manifest, so you don't
need to remember where each artifact lives.

```bash
npx @ctxr/kit update                          # update everything
npx @ctxr/kit update ctxr-skill-code-review   # update one
```

Team updates cascade to every member.

### `npx @ctxr/kit remove <name> [--keep-members]`

Remove an installed artifact (or team). For teams, every member listed in
the manifest is removed too unless `--keep-members` is passed.

```bash
npx @ctxr/kit remove ctxr-skill-code-review
npx @ctxr/kit remove ctxr-team-full-stack --keep-members
```

### `npx @ctxr/kit list [path]`

List installed artifacts from every discovered location, grouped by type.

```bash
npx @ctxr/kit list
npx @ctxr/kit list ./other-project
```

### `npx @ctxr/kit info <source>`

Show details about an installed or remote artifact: type, target layout,
source, version, file count, install paths.

```bash
npx @ctxr/kit info @ctxr/skill-code-review
npx @ctxr/kit info ctxr-agent-researcher
```

### `npx @ctxr/kit validate [path]`

Validate an artifact package's structure ahead of publishing. Dispatches
to a per-type validator: skill validation (frontmatter, broken-link
checker, file budget) is the heaviest; the rest are thin frontmatter
sanity checks plus the universal `target: "file"` ⇒ exactly-one-`.md`-file
rule that the installer enforces.

```bash
npx @ctxr/kit validate                  # validate package in current dir
npx @ctxr/kit validate ./my-skill       # validate at a path
```

### `npx @ctxr/kit init [--type <type>] [name]`

Scaffold a new artifact package from a template. Defaults to
`--type skill` because that's the most common authoring case.

```bash
npx @ctxr/kit init my-skill                       # default --type skill
npx @ctxr/kit init --type agent my-agent          # scaffold an agent
npx @ctxr/kit init -t command deploy              # short-form flag
npx @ctxr/kit init --type team team-full-stack    # scaffold a team meta-package
```

Each template ships a `package.json` with the right `ctxr` block already
filled in, plus `README.md`, `LICENSE`, and `.gitignore` (the skill
template additionally ships `.markdownlint.jsonc` and a starter
`SKILL.md`; file-target templates ship a pre-named `ctxr-{{name}}.md`).
The scaffolded result passes `npx @ctxr/kit validate` immediately — edit
the contents, then publish.

## Global options

| Flag                  | Effect                                                   |
|-----------------------|----------------------------------------------------------|
| `--dir <path>`        | Operate against a specific directory                     |
| `--user`              | Use `~/.claude/<type>/` (user-global) instead of project |
| `-i`, `--interactive` | Prompt for choices where applicable                      |
| `--help`, `-h`        | Show help (top-level or per-command)                     |
| `--version`, `-v`     | Print the installed version of `@ctxr/kit`               |

Run `npx @ctxr/kit <command> --help` for command-specific options.

## Releasing

Releases are PR-gated. Version bumps land on `main` through a review gate like any other change; only the tag push is automated.

### One-time setup

Enable these on the repo before your first release:

- Repository secret `NPM_TOKEN` set to an npm access token with publish rights on the `@ctxr` scope (`npm token create`, then **Settings → Secrets → Actions** → add `NPM_TOKEN`).
- (Optional, recommended) GitHub-managed CodeQL default setup: **Security → Code security** → enable default setup for `javascript-typescript` and `actions`.
- (Optional) A branch ruleset on `main` requiring PR review + code scanning. The release flow works without it; gates are strictly stricter when enabled.

### Cutting a release

1. **Actions → Release → Run workflow**.
   - Branch selector: `main` (the workflow refuses any other ref).
   - Version bump: `patch` / `minor` / `major`.
   - Click **Run workflow**.
2. The workflow bumps `package.json` on a fresh `release/v<version>` branch and opens a PR to `main` titled `release: v<version>`.
3. Review the PR (diff is just version fields). Approve + merge.
4. On merge, `tag-on-main.yml` fires automatically:
   - Detects the version change.
   - Creates and pushes the annotated `v<version>` tag.
5. The tag push fires `publish.yml`, which runs the check pipeline, verifies the tag matches `package.json`, and publishes `@ctxr/kit` to npm.

From **Run workflow** to **published on npm** is one dispatch + one PR merge.

### Troubleshooting

- **Release workflow fails with "dispatched from non-main ref"** — you selected a feature branch in the Actions UI. Re-dispatch with `main`.
- **`tag-on-main` fails with "Tag vX.Y.Z exists but points at …"** — a stale/orphan tag from a prior failed release. Delete and re-run:

  ```bash
  git push origin --delete vX.Y.Z
  ```

  Then merge a trivial no-op PR to `main` (or revert-and-re-merge the release PR) to retrigger `tag-on-main`. Direct pushes to `main` may be blocked by branch protection, so the PR path is the reliable retrigger.
- **`publish.yml` fails on "Verify tag matches package.json"** — tag and `package.json` disagree. Investigate the merge commit; this should not happen under the PR-based flow.
- **GitHub Actions is not permitted to create pull requests** — org or enterprise policy blocks the `GITHUB_TOKEN` from opening PRs. Enable **Allow GitHub Actions to create and approve pull requests** at the org level (**Settings → Actions → General → Workflow permissions**), or ask the enterprise admin to unlock the setting.

## Development

```bash
npm install
npm test                  # unit + integration
npm run test:unit         # unit only
npm run test:integration  # integration only
npm run test:e2e          # multi-location + multi-type
```

## License

[MIT](LICENSE)
