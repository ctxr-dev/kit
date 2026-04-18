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
5. On the newly created `v<version>` tag, **Actions → Publish to npm → Run workflow**. The workflow re-runs the check pipeline, verifies tag/version agreement, and publishes the package to npm.

> **Why a manual dispatch for step 5?** GitHub's built-in `GITHUB_TOKEN` cannot trigger further workflows, so the `v<version>` tag created by `tag-on-main.yml` does NOT automatically fire `publish.yml`. A one-click dispatch on the tag works around it. To fully automate, swap the tag-push credential in `tag-on-main.yml` for a GitHub App token or fine-grained PAT (stored as a repo secret) — then the `push: tags` trigger on `publish.yml` fires and step 5 happens by itself.

From **Run workflow** on Release to **published on npm** is one dispatch + one PR merge + one dispatch (or one dispatch + one PR merge, once a PAT/App-token is wired in).

### Troubleshooting

- **Release fails with "dispatched from non-main ref"** — select `main` in the Actions UI and re-dispatch.
- **`tag-on-main` fails with "Tag vX.Y.Z exists but points at …"** — a stale tag from a prior failed run. Delete it (`git push origin --delete vX.Y.Z`) and re-trigger.
- **`publish.yml` fails on "Verify version matches tag"** — tag and `package.json` disagree. Investigate the merge commit; should not happen under the PR-based flow.

## License

{{license}}
