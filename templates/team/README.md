# {{titleName}}

A Claude Code team bundle — installs several artifacts in one command.

## Installation

```bash
npx @ctxr/kit install @ctxr/{{name}}
```

The installer will cascade-install every member listed in `ctxr.includes`.

## Members

Edit `ctxr.includes` in `package.json` to add the artifacts this team should
install. Each entry is an npm package spec (`@scope/name`),
`github:owner/repo`, or a local path.

## License

{{license}}
