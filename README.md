# @ctxr/kit

[![npm](https://img.shields.io/npm/v/@ctxr/kit)](https://www.npmjs.com/package/@ctxr/kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Universal CLI for Claude Code artifacts — install, validate, update, and
scaffold **skills, agents, commands, rules, output-styles, and teams** with
one command. The `package.json` `files` field is the single source of truth
for what each package ships, the manifest filename `.ctxr-manifest.json`
is written per install root, and the binary is `kit`.

## Quick start

```bash
npm install -g @ctxr/kit
kit install @ctxr/skill-code-review     # add the code-review skill
kit list                                 # see what's installed
```

That's the whole loop. Run `kit --help` for the full command set.

## Prerequisites

- **Node.js ≥ 18.0.0** (uses ESM, `node:test`, and the modern `node:fs` API)
- A project directory where you want artifacts installed. Project-scope
  installs land under `.claude/<type>/` by default; user-scope installs
  (`--user`) land under `~/.claude/<type>/`.

## Install

```bash
npm install -g @ctxr/kit
# or use without installing
npx @ctxr/kit <command>
```

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

### `kit install <source> [<source>...] [options]`

Install one or more artifacts in a single command. Sources can be mixed —
npm packages, GitHub shorthand, and local paths all work side by side.

```bash
# single artifact
kit install @ctxr/skill-code-review

# mixed batch — different types, different sources
kit install \
  @ctxr/skill-code-review \
  @ctxr/agent-researcher \
  @ctxr/rule-typescript-strict \
  github:ctxr-dev/output-style-teaching

# team meta-package — cascades to every member
kit install @ctxr/team-full-stack

# user-global instead of project-local
kit install @ctxr/skill-code-review --user

# explicit destination
kit install @ctxr/skill-code-review --dir .agents/skills

# local path (must start with ./, /, or ~/)
kit install ./path/to/local-skill
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

### `kit update [name]`

Re-install one or all artifacts in place using the source recorded in the
manifest. Searches every project- and user-scope manifest, so you don't
need to remember where each artifact lives.

```bash
kit update                          # update everything
kit update ctxr-skill-code-review   # update one
```

Team updates cascade to every member.

### `kit remove <name> [--keep-members]`

Remove an installed artifact (or team). For teams, every member listed in
the manifest is removed too unless `--keep-members` is passed.

```bash
kit remove ctxr-skill-code-review
kit remove ctxr-team-full-stack --keep-members
```

### `kit list [path]`

List installed artifacts from every discovered location, grouped by type.

```bash
kit list
kit list ./other-project
```

### `kit info <source>`

Show details about an installed or remote artifact: type, target layout,
source, version, file count, install paths.

```bash
kit info @ctxr/skill-code-review
kit info ctxr-agent-researcher
```

### `kit validate [path]`

Validate an artifact package's structure ahead of publishing. Dispatches
to a per-type validator: skill validation (frontmatter, broken-link
checker, file budget) is the heaviest; the rest are thin frontmatter
sanity checks plus the universal `target: "file"` ⇒ exactly-one-`.md`-file
rule that the installer enforces.

```bash
kit validate                  # validate package in current dir
kit validate ./my-skill       # validate at a path
```

### `kit init [--type <type>] [name]`

Scaffold a new artifact package from a template. Defaults to
`--type skill` because that's the most common authoring case.

```bash
kit init my-skill                       # default --type skill
kit init --type agent my-agent          # scaffold an agent
kit init -t command deploy              # short-form flag
kit init --type team team-full-stack    # scaffold a team meta-package
```

Each template ships a `package.json` with the right `ctxr` block already
filled in, plus `README.md`, `LICENSE`, and `.gitignore` (the skill
template additionally ships `.markdownlint.jsonc` and a starter
`SKILL.md`; file-target templates ship a pre-named `ctxr-{{name}}.md`).
The scaffolded result passes `kit validate` immediately — edit the
contents, then publish.

## Global options

| Flag                  | Effect                                                   |
|-----------------------|----------------------------------------------------------|
| `--dir <path>`        | Operate against a specific directory                     |
| `--user`              | Use `~/.claude/<type>/` (user-global) instead of project |
| `-i`, `--interactive` | Prompt for choices where applicable                      |
| `--help`, `-h`        | Show help (top-level or per-command)                     |
| `--version`, `-v`     | Print the installed version of `@ctxr/kit`               |

Run `kit <command> --help` for command-specific options.

## Publishing

### First-time setup

1. Create an npm access token: `npm token create`
2. In the GitHub repo: **Settings → Secrets → Actions** → add `NPM_TOKEN`

### Release

1. **Actions → Release → Run workflow** → choose patch / minor / major
2. The workflow bumps the version, tags, and pushes — that triggers the
   Publish workflow, which runs `npm publish`.

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
