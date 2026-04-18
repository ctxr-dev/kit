# {{titleName}}

A Claude Code rule.

## Installation

```bash
npx @ctxr/kit install @ctxr/{{name}}
```

Installs as a single `.md` file into `.claude/rules/`.

## Usage

Claude Code applies this rule automatically based on the scope declared in its frontmatter.

## Releasing

Releases are PR-gated. Version bumps land on `main` through a review gate like any other change; only the tag push is automated.

### One-time setup

- Repository secret `NPM_TOKEN` set to an npm access token with publish rights on this package's scope (`npm token create`, then **Settings → Secrets → Actions**).
- (Optional, recommended) GitHub-managed CodeQL default setup: **Security → Code security** → enable default setup for `javascript-typescript` and `actions`.
- In this repository, enable **Allow GitHub Actions to create and approve pull requests** under **Settings → Actions → General → Workflow permissions**. If the option is greyed out, an organization-level Actions policy is restricting it — an org admin must unlock the setting first. Without this, `release.yml` fails with `GitHub Actions is not permitted to create or approve pull requests`.

### Cutting a release

1. **Actions → Release → Run workflow**. Branch: `main` (the workflow refuses any other ref). Version bump: `patch` / `minor` / `major`. Click **Run workflow**.
2. The workflow bumps `package.json` on a `release/v<version>` branch and opens a PR.
3. Review + merge the PR.
4. `tag-on-main.yml` fires on the merge, detects the version change, creates the annotated `v<version>` tag, and pushes it.
5. The tag push triggers `publish.yml`, which runs checks, verifies tag/version agreement, and publishes the package to npm.

From **Run workflow** to **published on npm** is one dispatch + one PR merge.

### Troubleshooting

- **Release fails with "dispatched from non-main ref"** — select `main` in the Actions UI and re-dispatch.
- **`tag-on-main` fails with "Tag vX.Y.Z exists but points at …"** — a stale tag from a prior failed run. Delete it (`git push origin --delete vX.Y.Z`) and re-trigger.
- **`publish.yml` fails on tag/version mismatch** — investigate the merge commit; should not happen under the PR-based flow.

## License

{{license}}
