import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { ARTIFACT_TYPES } from "../../src/lib/types.js";
import { installFolder } from "../../src/installers/folder.js";
import { installFile } from "../../src/installers/file.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const FIXTURES = join(__dirname, "..", "fixtures");

function runInstall(args, opts = {}) {
  // spawnSync captures both streams on success and failure — execSync would
  // drop stderr on zero-exit, which breaks the --help assertions that rely
  // on usage output going to stderr.
  const argv = args.trim() ? args.trim().split(/\s+/) : [];
  const r = spawnSync("node", [CLI, "install", ...argv], {
    encoding: "utf8",
    env: opts.env,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exitCode: r.status,
  };
}

describe("install command", () => {
  let projectDir;
  let fakeHome;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxr-test-install-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ctxr-test-home-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  /** Run install with HOME isolation. */
  function install(args) {
    return runInstall(args, { env: { ...process.env, HOME: fakeHome } });
  }

  describe("install from local path", () => {
    it("copies skill into specified dir under installedName wrapper", () => {
      const targetDir = join(projectDir, "skills");
      const { exitCode } = install(
        `${join(FIXTURES, "skill", "valid")} --dir ${targetDir}`,
      );
      assert.equal(exitCode, 0);
      assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
    });

    it("creates .ctxr-manifest.json with type-aware entry", () => {
      const targetDir = join(projectDir, "skills");
      install(`${join(FIXTURES, "skill", "valid")} --dir ${targetDir}`);
      const manifestPath = join(targetDir, ".ctxr-manifest.json");
      assert.ok(existsSync(manifestPath));
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const entry = manifest["valid-skill"];
      assert.ok(entry, "expected manifest entry for valid-skill");
      assert.equal(entry.type, "skill");
      assert.equal(entry.target, "folder");
      assert.equal(entry.sourceType, "local");
      assert.ok(entry.source);
      assert.ok(entry.installedAt);
      assert.ok(Array.isArray(entry.installedPaths));
      assert.equal(entry.installedPaths.length, 1);
    });

    it("records version from package.json", () => {
      const targetDir = join(projectDir, "skills");
      install(`${join(FIXTURES, "skill", "valid")} --dir ${targetDir}`);
      const manifest = JSON.parse(
        readFileSync(join(targetDir, ".ctxr-manifest.json"), "utf8"),
      );
      assert.equal(manifest["valid-skill"].version, "1.0.0");
    });

    it("copies package.json into the installed folder", () => {
      const targetDir = join(projectDir, "skills");
      install(`${join(FIXTURES, "skill", "valid")} --dir ${targetDir}`);
      const installed = join(targetDir, "valid-skill");
      assert.ok(existsSync(join(installed, "SKILL.md")));
      // Bundle runtime code can read its own package.json from the
      // installed directory (name, version, ctxr block, etc.). Kit
      // installs the full npm payload verbatim.
      assert.ok(existsSync(join(installed, "package.json")));
    });
  });

  describe("already installed", () => {
    it("exits 1 when wrapper folder already exists", () => {
      const targetDir = join(projectDir, "skills");
      install(`${join(FIXTURES, "skill", "valid")} --dir ${targetDir}`);
      const r = install(
        `${join(FIXTURES, "skill", "valid")} --dir ${targetDir}`,
      );
      assert.equal(r.exitCode, 1);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.toLowerCase().includes("already installed"),
        `Expected 'already installed' in: ${output}`,
      );
    });
  });

  describe("source classification", () => {
    it("exits 1 when local path does not exist", () => {
      const { exitCode } = install(
        `./nonexistent-path-${Date.now()} --dir ${join(projectDir, "skills")}`,
      );
      assert.equal(exitCode, 1);
    });

    it("exits 1 when local path has no package.json", () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "ctxr-test-empty-"));
      const { exitCode } = install(
        `${emptyDir} --dir ${join(projectDir, "skills")}`,
      );
      assert.equal(exitCode, 1);
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it("exits 1 when package has no ctxr block", () => {
      const { exitCode, stdout, stderr } = install(
        `${join(FIXTURES, "agent", "missing-ctxr")} --dir ${join(projectDir, "agents")}`,
      );
      assert.equal(exitCode, 1);
      const output = stdout + stderr;
      assert.ok(output.includes("ctxr"), `Expected ctxr error in: ${output}`);
    });

    it("exits 1 when package.json is malformed JSON", () => {
      const badDir = mkdtempSync(join(tmpdir(), "ctxr-test-badjson-"));
      writeFileSync(join(badDir, "package.json"), "{not valid json");
      const { exitCode, stdout, stderr } = install(
        `${badDir} --dir ${join(projectDir, "skills")}`,
      );
      assert.equal(exitCode, 1);
      const output = stdout + stderr;
      assert.ok(
        output.includes("package.json"),
        `Expected package.json parse error, got: ${output}`,
      );
      rmSync(badDir, { recursive: true, force: true });
    });

    it("exits 1 when package.json has no name field", () => {
      const noNameDir = mkdtempSync(join(tmpdir(), "ctxr-test-noname-"));
      writeFileSync(
        join(noNameDir, "package.json"),
        JSON.stringify({
          version: "1.0.0",
          files: ["SKILL.md"],
          ctxr: { type: "skill", target: "folder" },
        }),
      );
      writeFileSync(
        join(noNameDir, "SKILL.md"),
        "---\nname: x\ndescription: x.\n---\n# X\n",
      );
      const { exitCode, stdout, stderr } = install(
        `${noNameDir} --dir ${join(projectDir, "skills")}`,
      );
      assert.equal(exitCode, 1);
      const output = stdout + stderr;
      assert.ok(
        output.includes("name"),
        `Expected missing-name error, got: ${output}`,
      );
      rmSync(noNameDir, { recursive: true, force: true });
    });

    it("does not copy symlinks from a local package source (npm-pack filter)", () => {
      // npm pack --dry-run --json (which packagePayload uses) silently filters
      // symlinks out of the payload at every level — bare entry, files-listed
      // directory, glob expansion. This test pins that behavior so a future
      // npm regression that starts including symlinks would surface here as
      // a test failure, prompting us to verify the lstatSync gates in
      // installers/folder.js + installers/file.js still trip in time.
      //
      // The lstatSync gates remain in place as defense-in-depth: they cover
      // the (currently impossible) case where a payload entry slips past npm
      // pack and would otherwise let a malicious package smuggle a symlink to
      // `/etc/passwd` or `~/.ssh/id_rsa` into `.claude/<type>/`.
      const symPkg = mkdtempSync(join(tmpdir(), "ctxr-test-trap-"));
      writeFileSync(
        join(symPkg, "package.json"),
        JSON.stringify({
          name: "skill-trap",
          version: "1.0.0",
          files: ["SKILL.md", "leaked"],
          ctxr: { type: "skill", target: "folder" },
        }),
      );
      writeFileSync(
        join(symPkg, "SKILL.md"),
        "---\nname: skill-trap\ndescription: x.\n---\n# X\n",
      );
      // Hostname is a safe POSIX-portable target — we never read it; we just
      // need a real link in the source tree. /etc/hostname exists on Linux
      // and macOS (as a redirect on macOS). The link target is irrelevant
      // since npm pack filters the link entirely.
      symlinkSync("/etc/hostname", join(symPkg, "leaked"));
      const { exitCode } = install(
        `${symPkg} --dir ${join(projectDir, "skills")}`,
      );
      assert.equal(exitCode, 0, "install must succeed (npm pack filtered the symlink)");
      // The wrapper must exist with SKILL.md but NOT the symlink
      const wrapper = join(projectDir, "skills", "skill-trap");
      assert.ok(existsSync(join(wrapper, "SKILL.md")), "SKILL.md should be installed");
      assert.ok(
        !existsSync(join(wrapper, "leaked")),
        "symlink must not land in the destination — npm pack filters it",
      );
      rmSync(symPkg, { recursive: true, force: true });
    });
  });

  describe("no arguments", () => {
    it("exits 2 (usage error) with usage message", () => {
      // Exit code 2 = usage error per POSIX-ish convention. Distinct from
      // exit 1 (runtime failure) so CI scripts can tell the two apart.
      const { exitCode, stderr } = install("");
      assert.equal(exitCode, 2);
      assert.ok(stderr.includes("Usage"));
    });
  });

  describe("--dir flag", () => {
    it("installs to specified directory", () => {
      const customDir = join(projectDir, "custom-skills");
      const { exitCode } = install(
        `${join(FIXTURES, "skill", "valid")} --dir ${customDir}`,
      );
      assert.equal(exitCode, 0);
      assert.ok(existsSync(join(customDir, "valid-skill", "SKILL.md")));
    });

    it("creates manifest in the specified directory", () => {
      const customDir = join(projectDir, "custom-skills");
      install(`${join(FIXTURES, "skill", "valid")} --dir ${customDir}`);
      assert.ok(existsSync(join(customDir, ".ctxr-manifest.json")));
    });
  });

  describe("--user flag", () => {
    it("installs canonical to ~/.agents/<type>/ with mirrors at ~/.claude/ and ~/.codex/", function (t) {
      if (process.platform === "win32") {
        return t.skip("symlink mirrors require POSIX or Windows dev mode");
      }
      const { exitCode } = install(
        `${join(FIXTURES, "skill", "valid")} --user`,
      );
      assert.equal(exitCode, 0);

      const canonical = join(fakeHome, ".agents", "skills", "valid-skill");
      assert.ok(existsSync(join(canonical, "SKILL.md")), "canonical SKILL.md");
      // The lstat on the canonical path must NOT be a symlink — it's the real dir.
      assert.equal(lstatSync(canonical).isSymbolicLink(), false);

      // Mirrors at ~/.claude/skills/ and ~/.codex/skills/ are symlinks.
      const claudeMirror = join(fakeHome, ".claude", "skills", "valid-skill");
      const codexMirror = join(fakeHome, ".codex", "skills", "valid-skill");
      assert.equal(lstatSync(claudeMirror).isSymbolicLink(), true);
      assert.equal(lstatSync(codexMirror).isSymbolicLink(), true);
      // Mirrors resolve to the canonical.
      assert.equal(realpathSync(claudeMirror), realpathSync(canonical));
      assert.equal(realpathSync(codexMirror), realpathSync(canonical));
    });

    it("manifest entry records discoveryMirrors", function (t) {
      if (process.platform === "win32") {
        return t.skip("symlink mirrors require POSIX or Windows dev mode");
      }
      install(`${join(FIXTURES, "skill", "valid")} --user`);
      const manifest = JSON.parse(
        readFileSync(
          join(fakeHome, ".agents", "skills", ".ctxr-manifest.json"),
          "utf8",
        ),
      );
      const entry = manifest["valid-skill"];
      assert.ok(entry);
      assert.ok(Array.isArray(entry.discoveryMirrors));
      assert.equal(entry.discoveryMirrors.length, 2);
    });
  });

  describe("project-scope auto-default", () => {
    it("installs canonical to <project>/.agents/<type>/ with .claude mirror", function (t) {
      if (process.platform === "win32") {
        return t.skip("symlink mirrors require POSIX or Windows dev mode");
      }
      // Run from inside projectDir so the auto-default picks .agents under it.
      const r = spawnSync(
        "node",
        [CLI, "install", join(FIXTURES, "skill", "valid")],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: fakeHome, CI: "true" },
          cwd: projectDir,
        },
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const canonical = join(projectDir, ".agents", "skills", "valid-skill");
      assert.ok(existsSync(join(canonical, "SKILL.md")));
      assert.equal(lstatSync(canonical).isSymbolicLink(), false);

      const claudeMirror = join(projectDir, ".claude", "skills", "valid-skill");
      assert.equal(lstatSync(claudeMirror).isSymbolicLink(), true);
      assert.equal(realpathSync(claudeMirror), realpathSync(canonical));
    });
  });

  describe("--dir flag skips mirror emission", () => {
    it("custom --dir does NOT create .claude/ mirror", () => {
      const targetDir = join(projectDir, "custom-skills");
      const { exitCode } = install(
        `${join(FIXTURES, "skill", "valid")} --dir ${targetDir}`,
      );
      assert.equal(exitCode, 0);
      assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
      // No .claude/ mirror should appear when user explicitly named --dir.
      assert.equal(existsSync(join(projectDir, ".claude")), false);
    });
  });

  describe("non-TTY behavior", () => {
    it("does not hang in non-TTY context", () => {
      const targetDir = join(projectDir, "pipe-test");
      const { exitCode } = install(
        `${join(FIXTURES, "skill", "valid")} --dir ${targetDir}`,
      );
      assert.equal(exitCode, 0);
      assert.ok(existsSync(join(targetDir, "valid-skill", "SKILL.md")));
    });
  });

  describe("--help flag", () => {
    it("shows help with --dir, --user, --interactive options", () => {
      const { exitCode, stderr } = install("--help");
      // With no sources and --help, the command returns cleanly (exit 0).
      assert.equal(exitCode, 0);
      assert.ok(stderr.includes("--dir"));
      assert.ok(stderr.includes("--user"));
      assert.ok(stderr.includes("--interactive"));
    });
  });

  describe("idempotent mirror recording (BUG FIX B)", () => {
    // Regression for BUG FIX B: mirrors are recorded in the manifest when
    // `r.created || (r.kind === "noop" && !r.warning)` — i.e. an
    // already-correct mirror (a `noop` with no warning) is recorded too, not
    // only freshly-created ones. The pre-fix code recorded only `r.created`
    // mirrors, so a re-install whose mirror already existed dropped the mirror
    // from discoveryMirrors, and a later `kit remove` orphaned the symlink.
    //
    // A direct second `kit install` is blocked by the "already installed"
    // guard, so the idempotent path is exercised by re-running the installer
    // after deleting ONLY the canonical dir/file (leaving the correct mirror
    // in place) — the same on-disk state a partial/interrupted run leaves.
    it("folder install re-records an already-correct mirror in discoveryMirrors", function (t) {
      if (process.platform === "win32") {
        return t.skip("symlink mirrors require POSIX or Windows dev mode");
      }
      const targetRoot = join(projectDir, ".agents", "skills");
      const baseOpts = {
        sourceDir: join(FIXTURES, "skill", "valid"),
        targetRoot,
        type: "skill",
        packageName: "valid-skill",
        source: join(FIXTURES, "skill", "valid"),
        sourceType: "local",
        version: "1.0.0",
        typeCfg: ARTIFACT_TYPES.skill,
        projectPath: projectDir,
      };

      const first = installFolder(baseOpts);
      const mirror = join(projectDir, ".claude", "skills", "valid-skill");
      assert.ok(first.discoveryMirrors.includes(mirror));
      assert.equal(lstatSync(mirror).isSymbolicLink(), true);

      // Delete ONLY the canonical dir + its manifest row, leaving the correct
      // mirror symlink in place, then install again so the mirror is a noop.
      rmSync(join(targetRoot, "valid-skill"), { recursive: true, force: true });
      rmSync(join(targetRoot, ".ctxr-manifest.json"), { force: true });

      const second = installFolder(baseOpts);
      // The mirror already existed and is correct (noop, no warning) — it MUST
      // still be recorded so a subsequent `kit remove` cleans it up.
      assert.ok(
        second.discoveryMirrors.includes(mirror),
        `idempotent install must still record the already-correct mirror: ${JSON.stringify(second.discoveryMirrors)}`,
      );
      const manifest = JSON.parse(
        readFileSync(join(targetRoot, ".ctxr-manifest.json"), "utf8"),
      );
      assert.ok(manifest["valid-skill"].discoveryMirrors.includes(mirror));
    });

    it("file install re-records an already-correct mirror in discoveryMirrors", function (t) {
      if (process.platform === "win32") {
        return t.skip("symlink mirrors require POSIX or Windows dev mode");
      }
      const targetRoot = join(projectDir, ".agents", "agents");
      const baseOpts = {
        sourceDir: join(FIXTURES, "agent", "file-minimal"),
        targetRoot,
        type: "agent",
        packageName: "agent-file-minimal",
        source: join(FIXTURES, "agent", "file-minimal"),
        sourceType: "local",
        version: "1.0.0",
        typeCfg: ARTIFACT_TYPES.agent,
        projectPath: projectDir,
      };

      const first = installFile(baseOpts);
      const destBasename = first.installedPaths[0].split("/").pop();
      const mirror = join(projectDir, ".claude", "agents", destBasename);
      assert.ok(first.discoveryMirrors.includes(mirror));
      assert.equal(lstatSync(mirror).isSymbolicLink(), true);

      // Delete ONLY the canonical file + manifest row, leaving the mirror.
      rmSync(first.installedPaths[0], { force: true });
      rmSync(join(targetRoot, ".ctxr-manifest.json"), { force: true });

      const second = installFile(baseOpts);
      assert.ok(
        second.discoveryMirrors.includes(mirror),
        `idempotent file install must still record the already-correct mirror: ${JSON.stringify(second.discoveryMirrors)}`,
      );
      const manifest = JSON.parse(
        readFileSync(join(targetRoot, ".ctxr-manifest.json"), "utf8"),
      );
      assert.ok(
        manifest["agent-file-minimal"].discoveryMirrors.includes(mirror),
      );
    });
  });

  describe("filters node_modules and .git via npm pack semantics", () => {
    it("top-level node_modules and .git never ship", () => {
      // Build a local fixture with node_modules/.git and a proper ctxr block.
      const srcDir = mkdtempSync(join(tmpdir(), "ctxr-test-filter-"));
      writeFileSync(
        join(srcDir, "SKILL.md"),
        "---\nname: filter-test\ndescription: Test fixture for filter test.\n---\n# Test\n",
      );
      writeFileSync(
        join(srcDir, "package.json"),
        JSON.stringify({
          name: "filter-test",
          version: "1.0.0",
          files: ["SKILL.md"],
          ctxr: { type: "skill", target: "folder" },
        }),
      );
      mkdirSync(join(srcDir, "node_modules"), { recursive: true });
      writeFileSync(join(srcDir, "node_modules", "pkg.js"), "module");
      mkdirSync(join(srcDir, ".git"), { recursive: true });
      writeFileSync(join(srcDir, ".git", "HEAD"), "ref");

      const targetDir = join(projectDir, "skills");
      install(`${srcDir} --dir ${targetDir}`);

      const installed = join(targetDir, "filter-test");
      assert.ok(existsSync(join(installed, "SKILL.md")));
      assert.ok(!existsSync(join(installed, "node_modules")));
      assert.ok(!existsSync(join(installed, ".git")));

      rmSync(srcDir, { recursive: true, force: true });
    });
  });
});
