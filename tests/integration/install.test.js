import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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
    it("installs to fakeHome ~/.claude/<type>/", () => {
      // valid-skill is a skill → ~/.claude/skills/
      const { exitCode } = install(
        `${join(FIXTURES, "skill", "valid")} --user`,
      );
      assert.equal(exitCode, 0);

      const userSkillDir = join(fakeHome, ".claude", "skills", "valid-skill");
      assert.ok(existsSync(join(userSkillDir, "SKILL.md")));
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
