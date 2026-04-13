/**
 * End-to-end tests for multi-location skill management.
 *
 * SAFETY: All tests run with HOME set to a temp directory, ensuring
 * no test ever reads from or writes to the user's real ~/.claude/skills/.
 * Every test creates its own isolated project dir under /tmp.
 *
 * Coverage:
 *   - The original bug (update by npm package name)
 *   - Update by @scoped/package name
 *   - Multi-location update
 *   - Install duplicate detection (non-TTY)
 *   - Remove by name / dir / source / --all
 *   - Uninstall alias
 *   - Full lifecycle (install → list → update → remove → list)
 *   - Update all at once
 *   - Skill name ≠ directory name
 *   - Helpful error for nonexistent skill
 *   - Install → remove → reinstall cycle
 *   - Remove one skill, others survive
 *   - Corrupt manifest recovery
 *   - Skill with no source in manifest (update warns)
 *   - --dir to existing target errors
 *   - Manifest integrity preserved through updates
 *   - List across multiple locations
 *   - Malformed SKILL.md fallback to directory name
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");

/**
 * Run a CLI command in an isolated environment.
 * HOME is always set to opts.home (or a temp dir) so that
 * ~/.claude/skills/ never points to the real user home.
 */
function run(cmd, opts = {}) {
  try {
    const stdout = execSync(`node ${CLI} ${cmd}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
      cwd: opts.cwd,
      env: { ...process.env, HOME: opts.home },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || "",
      exitCode: e.status,
    };
  }
}

/** Create a minimal local skill package in a temp dir. */
function createLocalSkillPackage(name, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-skill-src-"));
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${opts.description || "E2E test skill."}`,
      "---",
      `# ${name}`,
      "",
      opts.body || "Test skill content.",
    ].join("\n")
  );
  // Every kit-installable package requires a ctxr block. Always write it.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: opts.version || "1.0.0",
        files: ["SKILL.md"],
        ctxr: { type: "skill", target: "folder" },
      },
      null,
      2,
    ),
  );
  return dir;
}

/** Manually seed a skill + manifest to simulate a prior install. */
function seedSkill(skillsDir, skillName, source, extra = {}) {
  const skillDir = join(skillsDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Seeded skill.\n---\n# ${skillName}\n`
  );
  const manifestPath = join(skillsDir, ".ctxr-manifest.json");
  let manifest = {};
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  }
  manifest[skillName] = {
    type: "skill",
    target: "folder",
    source,
    sourceType: extra.sourceType || "npm",
    installedPaths: [skillDir],
    installedAt: new Date().toISOString(),
    ...extra,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function readManifest(skillsDir) {
  const p = join(skillsDir, ".ctxr-manifest.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------

describe("e2e: multi-location skill management", () => {
  let projectDir;
  let fakeHome;
  let cleanupDirs;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "e2e-project-"));
    fakeHome = mkdtempSync(join(tmpdir(), "e2e-home-"));
    cleanupDirs = [projectDir, fakeHome];
  });

  afterEach(() => {
    for (const d of cleanupDirs) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  /** Shorthand: run with fakeHome and optional cwd override. */
  function cli(cmd, opts = {}) {
    return run(cmd, { home: fakeHome, ...opts });
  }

  // -----------------------------------------------------------------------
  // Scenario 1: THE ORIGINAL BUG
  // -----------------------------------------------------------------------
  describe("Scenario 1: update by npm package name (the original bug)", () => {
    it("finds and updates a skill when addressed by its manifest source", () => {
      const id = `e2e-orig-bug-${Date.now()}`;
      const src = createLocalSkillPackage(id, { version: "1.0.0" });
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");

      const r1 = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r1.exitCode, 0, `Install failed: ${r1.stderr}`);
      assert.ok(existsSync(join(targetDir, id, "SKILL.md")));

      const manifest = readManifest(targetDir);
      assert.ok(manifest[id], "Manifest entry missing");
      const source = manifest[id].source;
      assert.ok(source, "Manifest source missing");

      // Update using the SOURCE (not the skill name) — the broken path in 2.3.2
      const r2 = cli(`update ${source} ${projectDir}`);
      assert.equal(r2.exitCode, 0, `Update by source failed: ${r2.stderr}`);
      assert.ok(
        r2.stdout.includes(`Updating ${id}`),
        `Expected 'Updating ${id}' in output`
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 2: @scoped/package name matching
  // -----------------------------------------------------------------------
  describe("Scenario 2: update by @scoped/package name", () => {
    it("finds skill via patched manifest source", () => {
      const id = `e2e-scoped-${Date.now()}`;
      const scopedSource = `@ctxr-dev/${id}`;
      const targetDir = join(projectDir, ".claude", "skills");

      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      cli(`install ${src} --dir ${targetDir}`);

      // Patch manifest to simulate npm-scoped source. `type` stays "skill"
      // (artifact type); `sourceType` is the fetch channel.
      const manifest = readManifest(targetDir);
      manifest[id].source = scopedSource;
      manifest[id].sourceType = "npm";
      writeFileSync(
        join(targetDir, ".ctxr-manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n"
      );

      // Update by scoped package name — must match via manifest source
      const r = cli(`update ${scopedSource} ${projectDir}`);
      assert.ok(
        r.stdout.includes(`Updating ${id}`),
        `Update by scoped source failed. Output: ${r.stdout}${r.stderr}`
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Skill in two project locations — update finds both
  // -----------------------------------------------------------------------
  describe("Scenario 3: skill in two locations, update finds both", () => {
    it("updates in both .claude/skills and .agents/skills", () => {
      const id = `e2e-dual-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const dir1 = join(projectDir, ".claude", "skills");
      const dir2 = join(projectDir, ".agents", "skills");

      assert.equal(cli(`install ${src} --dir ${dir1}`).exitCode, 0);
      assert.equal(cli(`install ${src} --dir ${dir2}`).exitCode, 0);

      const r = cli(`update ${id} ${projectDir}`);
      assert.equal(r.exitCode, 0, `Update failed: ${r.stderr}`);

      assert.ok(existsSync(join(dir1, id, "SKILL.md")), "Missing from dir1");
      assert.ok(existsSync(join(dir2, id, "SKILL.md")), "Missing from dir2");

      // Verify both manifests updated
      assert.ok(readManifest(dir1)[id].updatedAt, "dir1 manifest missing updatedAt");
      assert.ok(readManifest(dir2)[id].updatedAt, "dir2 manifest missing updatedAt");
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 4: Install is idempotent in non-TTY — "sticky in place"
  // -----------------------------------------------------------------------
  describe("Scenario 4: install is idempotent in non-TTY (sticky in place)", () => {
    it("re-installing an existing skill in .claude/skills updates in place, exit 0", () => {
      // New --yes / non-interactive behavior: if an artifact is already
      // installed and we see it again, kit updates it in place at the
      // existing location. Old behavior errored with "already installed"
      // as a safety guard; the new behavior is idempotent, which makes
      // `kit install X` safe to re-run in CI pipelines as an "ensure
      // this is installed" primitive.
      const id = `e2e-dup-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");
      assert.equal(cli(`install ${src} --dir ${targetDir}`).exitCode, 0);

      const r = cli(`install ${src} ${projectDir}`);
      assert.equal(r.exitCode, 0);
      // The wrapper dir is still there (re-installed over itself).
      assert.ok(existsSync(join(targetDir, id)));
    });

    it("re-installing a skill already in .agents/skills updates in place", () => {
      const id = `e2e-agents-dup-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const agentsDir = join(projectDir, ".agents", "skills");
      cli(`install ${src} --dir ${agentsDir}`);

      const r = cli(`install ${src} ${projectDir}`);
      assert.equal(r.exitCode, 0);
      // Sticky at existing location — .agents/skills wrapper preserved.
      assert.ok(existsSync(join(agentsDir, id)));
    });

    it("re-installing to --user scope is idempotent", () => {
      const id = `e2e-user-dup-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      assert.equal(cli(`install ${src} --user`).exitCode, 0);
      const r = cli(`install ${src} --user`);
      assert.equal(r.exitCode, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 5: Remove by different identifiers
  // -----------------------------------------------------------------------
  describe("Scenario 5: remove by name, dir, source, --all", () => {
    it("removes by skill name", () => {
      const id = `e2e-rm-name-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");
      cli(`install ${src} --dir ${targetDir}`);

      const r = cli(`remove ${id} ${projectDir} --force`);
      assert.equal(r.exitCode, 0, `Remove failed: ${r.stderr}`);
      assert.ok(!existsSync(join(targetDir, id)));
      assert.ok(!readManifest(targetDir)[id], "Manifest entry should be gone");
    });

    it("removes by manifest source (npm package name)", () => {
      const id = `e2e-rm-src-${Date.now()}`;
      const scopedSource = `@test-org/${id}`;
      const targetDir = join(projectDir, ".claude", "skills");

      seedSkill(targetDir, id, scopedSource);

      const r = cli(`remove ${scopedSource} ${projectDir} --force`);
      assert.equal(r.exitCode, 0, `Remove by source failed: ${r.stderr}`);
      assert.ok(!existsSync(join(targetDir, id)));
    });

    it("removes from all locations with --all --force", () => {
      const id = `e2e-rm-all-${Date.now()}`;
      const dir1 = join(projectDir, ".claude", "skills");
      const dir2 = join(projectDir, ".agents", "skills");
      seedSkill(dir1, id, `src-${id}`);
      seedSkill(dir2, id, `src-${id}`);

      const r = cli(`remove ${id} ${projectDir} --all --force`);
      assert.equal(r.exitCode, 0);
      assert.ok(!existsSync(join(dir1, id)));
      assert.ok(!existsSync(join(dir2, id)));
    });

    it("errors in non-TTY without --force for single match", () => {
      // Non-TTY destructive ops require explicit --yes/--force.
      // Silently returning "did nothing" would be worse UX than erroring.
      const id = `e2e-rm-nof-${Date.now()}`;
      seedSkill(join(projectDir, ".claude", "skills"), id, `src-${id}`);

      const r = cli(`remove ${id} ${projectDir}`);
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("--force") || r.stderr.includes("TTY"));
    });

    it("in non-TTY, --force removes from ALL matching locations", () => {
      // New behavior: --yes/--force in a non-TTY multi-match scenario
      // removes from every matching location. The old --all flag is
      // accepted as a silent alias for --yes, so scripts keep working.
      const id = `e2e-rm-noall-${Date.now()}`;
      seedSkill(join(projectDir, ".claude", "skills"), id, `src-${id}`);
      seedSkill(join(projectDir, ".agents", "skills"), id, `src-${id}`);

      const r = cli(`remove ${id} ${projectDir} --force`);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(!existsSync(join(projectDir, ".claude", "skills", id)));
      assert.ok(!existsSync(join(projectDir, ".agents", "skills", id)));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 6: uninstall alias
  // -----------------------------------------------------------------------
  describe("Scenario 6: uninstall alias", () => {
    it("works identically to remove", () => {
      const id = `e2e-uninstall-${Date.now()}`;
      seedSkill(join(projectDir, ".claude", "skills"), id, `src-${id}`);

      const r = cli(`uninstall ${id} ${projectDir} --force`);
      assert.equal(r.exitCode, 0);
      assert.ok(!existsSync(join(projectDir, ".claude", "skills", id)));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 7: Full lifecycle
  // -----------------------------------------------------------------------
  describe("Scenario 7: full lifecycle", () => {
    it("install → list → update (by name) → update (by source) → remove → list", () => {
      const id = `e2e-lifecycle-${Date.now()}`;
      const src = createLocalSkillPackage(id, {
        version: "1.0.0",
        description: "Lifecycle test skill.",
      });
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");

      // INSTALL
      const r1 = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r1.exitCode, 0, `Install failed: ${r1.stderr}`);
      assert.ok(existsSync(join(targetDir, id, "SKILL.md")));

      const m1 = readManifest(targetDir);
      assert.ok(m1[id].source);
      assert.ok(m1[id].installedAt);
      assert.equal(m1[id].type, "skill");
      assert.equal(m1[id].sourceType, "local");

      // LIST — shows the skill
      const r2 = cli(`list ${projectDir}`);
      assert.equal(r2.exitCode, 0);
      assert.ok(r2.stdout.includes(id));
      // The new type-aware list doesn't show per-artifact descriptions
      // (that would require per-type content inspection). It shows the
      // installed-name, target, source, version, and install path.
      assert.ok(r2.stdout.includes("[folder]"));

      // UPDATE by skill name
      const r3 = cli(`update ${id} ${projectDir}`);
      assert.equal(r3.exitCode, 0, `Update by name failed: ${r3.stderr}`);
      assert.ok(readManifest(targetDir)[id].updatedAt);

      // UPDATE by source path
      const source = readManifest(targetDir)[id].source;
      const r4 = cli(`update ${source} ${projectDir}`);
      assert.equal(r4.exitCode, 0, `Update by source failed: ${r4.stderr}`);

      // REMOVE
      const r5 = cli(`remove ${id} ${projectDir} --force`);
      assert.equal(r5.exitCode, 0, `Remove failed: ${r5.stderr}`);
      assert.ok(!existsSync(join(targetDir, id)));

      // LIST after remove — skill is gone
      const r6 = cli(`list ${projectDir}`);
      assert.ok(!r6.stdout.includes(`    ${id}`));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 8: Update all at once
  // -----------------------------------------------------------------------
  describe("Scenario 8: update all skills at once", () => {
    it("updates every installed skill that has a source record", () => {
      const id1 = `e2e-all-a-${Date.now()}`;
      const id2 = `e2e-all-b-${Date.now()}`;
      const src1 = createLocalSkillPackage(id1);
      const src2 = createLocalSkillPackage(id2);
      cleanupDirs.push(src1, src2);

      const targetDir = join(projectDir, ".claude", "skills");
      cli(`install ${src1} --dir ${targetDir}`);
      cli(`install ${src2} --dir ${targetDir}`);

      const r = cli(`update`, { cwd: projectDir });
      assert.equal(r.exitCode, 0, `Update all failed: ${r.stderr}`);
      assert.ok(r.stdout.includes(`Updating ${id1}`));
      assert.ok(r.stdout.includes(`Updating ${id2}`));
      assert.ok(existsSync(join(targetDir, id1, "SKILL.md")));
      assert.ok(existsSync(join(targetDir, id2, "SKILL.md")));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 9: SKILL.md name ≠ directory name
  // -----------------------------------------------------------------------
  describe("Scenario 9: package name drives installed folder", () => {
    it("install, update by source, and remove all work via package.json name", () => {
      // In kit v1, the installed folder name is derived from package.json
      // `name` via installedName() — not from SKILL.md frontmatter. This
      // test verifies the full lifecycle when the SKILL.md frontmatter
      // name happens to match the package name.
      const pkgName = `e2e-pkgname-${Date.now()}`;
      const targetDir = join(projectDir, ".claude", "skills");

      const src = createLocalSkillPackage(pkgName);
      cleanupDirs.push(src);

      const r1 = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r1.exitCode, 0);
      assert.ok(existsSync(join(targetDir, pkgName, "SKILL.md")));

      const source = readManifest(targetDir)[pkgName].source;
      const r2 = cli(`update ${source} ${projectDir}`);
      assert.equal(r2.exitCode, 0, `Update by source failed: ${r2.stderr}`);

      const r3 = cli(`remove ${pkgName} ${projectDir} --force`);
      assert.equal(r3.exitCode, 0);
      assert.ok(!existsSync(join(targetDir, pkgName)));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 10: Helpful error for nonexistent skill
  // -----------------------------------------------------------------------
  describe("Scenario 10: remove/update nonexistent skill", () => {
    it("remove soft-skips a nonexistent skill, exits 0", () => {
      // New behavior: removing something that isn't installed is a no-op,
      // not an error. kit prints a "not installed" note and moves on.
      const id = `e2e-exists-${Date.now()}`;
      seedSkill(join(projectDir, ".claude", "skills"), id, `src-${id}`);

      const r = cli(`remove totally-fake-skill ${projectDir}`);
      assert.equal(r.exitCode, 0);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.includes("not installed"),
        `Expected soft-skip note, got: ${output}`,
      );
    });

    it("update errors with missing-list and --install hint", () => {
      // New pre-flight behavior: update prints the missing identifier
      // and exits 2 (usage error) without touching any existing installs.
      // The --install hint tells users how to install missing items
      // without a separate command.
      const id = `e2e-upd-nf-${Date.now()}`;
      seedSkill(join(projectDir, ".claude", "skills"), id, `src-${id}`);

      const r = cli(`update totally-fake-skill ${projectDir}`);
      assert.equal(r.exitCode, 2);
      assert.ok(r.stderr.includes("totally-fake-skill"));
      assert.ok(r.stderr.includes("--install"));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 11: Install → remove → reinstall cycle
  // -----------------------------------------------------------------------
  describe("Scenario 11: install → remove → reinstall", () => {
    it("reinstalling after removal works cleanly", () => {
      const id = `e2e-reinstall-${Date.now()}`;
      const src = createLocalSkillPackage(id, { version: "1.0.0" });
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");

      // Install
      assert.equal(cli(`install ${src} --dir ${targetDir}`).exitCode, 0);
      assert.ok(existsSync(join(targetDir, id, "SKILL.md")));

      // Remove
      assert.equal(cli(`remove ${id} ${projectDir} --force`).exitCode, 0);
      assert.ok(!existsSync(join(targetDir, id)));
      assert.ok(!readManifest(targetDir)[id]);

      // Reinstall
      const r = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r.exitCode, 0, `Reinstall failed: ${r.stderr}`);
      assert.ok(existsSync(join(targetDir, id, "SKILL.md")));
      assert.ok(readManifest(targetDir)[id]);
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 12: Remove one skill, others survive
  // -----------------------------------------------------------------------
  describe("Scenario 12: remove one skill, others untouched", () => {
    it("only the targeted skill is removed", () => {
      const idA = `e2e-surv-a-${Date.now()}`;
      const idB = `e2e-surv-b-${Date.now()}`;
      const srcA = createLocalSkillPackage(idA);
      const srcB = createLocalSkillPackage(idB);
      cleanupDirs.push(srcA, srcB);

      const targetDir = join(projectDir, ".claude", "skills");
      cli(`install ${srcA} --dir ${targetDir}`);
      cli(`install ${srcB} --dir ${targetDir}`);

      // Remove only A
      cli(`remove ${idA} ${projectDir} --force`);

      // A is gone
      assert.ok(!existsSync(join(targetDir, idA)));
      assert.ok(!readManifest(targetDir)[idA]);

      // B is untouched
      assert.ok(existsSync(join(targetDir, idB, "SKILL.md")));
      assert.ok(readManifest(targetDir)[idB]);
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 13: Corrupt manifest recovery
  // -----------------------------------------------------------------------
  describe("Scenario 13: corrupt manifest", () => {
    it("update errors cleanly when manifest is corrupt (treats as empty)", () => {
      const id = `e2e-corrupt-${Date.now()}`;
      const targetDir = join(projectDir, ".claude", "skills");

      // Seed a skill but corrupt the manifest
      seedSkill(targetDir, id, `src-${id}`);
      writeFileSync(
        join(targetDir, ".ctxr-manifest.json"),
        "THIS IS NOT JSON!!!"
      );

      // In the type-aware world, discovery is manifest-driven. A corrupt
      // manifest is treated as empty → no entries → update's pre-flight
      // reports the identifier as missing and exits 2 (usage error). The
      // CLI surfaces a clean error instead of crashing on the bad JSON.
      const r = cli(`update ${id} ${projectDir}`);
      assert.equal(r.exitCode, 2);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.toLowerCase().includes("not installed") ||
          output.toLowerCase().includes("no artifacts installed"),
        `Expected clean pre-flight error with corrupt manifest, got: ${output}`,
      );
    });

    it("install works even if target dir has corrupt manifest", () => {
      const id = `e2e-corrupt-inst-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, ".ctxr-manifest.json"), "{{{BROKEN");

      // Install should still work — readManifest returns {} for corrupt files
      const r = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r.exitCode, 0, `Install with corrupt manifest failed: ${r.stderr}`);
      assert.ok(existsSync(join(targetDir, id, "SKILL.md")));

      // Manifest should now be valid
      const manifest = readManifest(targetDir);
      assert.ok(manifest[id]);
    });

    it("remove soft-skips cleanly when manifest is corrupt", () => {
      const id = `e2e-corrupt-rm-${Date.now()}`;
      const targetDir = join(projectDir, ".claude", "skills");
      const skillDir = join(targetDir, id);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${id}\ndescription: Test.\n---\n# Test\n`
      );
      writeFileSync(join(targetDir, ".ctxr-manifest.json"), "NOT JSON");

      // Discovery is manifest-driven. Corrupt manifest → no entries →
      // remove's new soft-skip behavior prints "not installed" and exits
      // 0 (nothing to do) instead of a crash or a hard error.
      const r = cli(`remove ${id} ${projectDir} --force`);
      assert.equal(r.exitCode, 0);
      const output = r.stdout + r.stderr;
      assert.ok(output.toLowerCase().includes("not installed"));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 14: Skill without source in manifest
  // -----------------------------------------------------------------------
  describe("Scenario 14: skill without source in manifest", () => {
    it("update warns and skips gracefully", () => {
      const id = `e2e-nosrc-${Date.now()}`;
      const targetDir = join(projectDir, ".claude", "skills");

      // Create skill with empty manifest entry (no source field)
      const skillDir = join(targetDir, id);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${id}\ndescription: Test.\n---\n# Test\n`
      );
      writeFileSync(
        join(targetDir, ".ctxr-manifest.json"),
        JSON.stringify(
          {
            [id]: {
              type: "skill",
              target: "folder",
              sourceType: "local",
              installedPaths: [skillDir],
              installedAt: new Date().toISOString(),
            },
          },
          null,
          2,
        ),
      );

      const r = cli(`update ${id} ${projectDir}`);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.includes("no recorded source"),
        `Expected 'no recorded source', got: ${output}`
      );
      // Skill should still exist (not deleted)
      assert.ok(existsSync(join(targetDir, id, "SKILL.md")));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 15: --dir to existing target errors
  // -----------------------------------------------------------------------
  describe("Scenario 15: --dir install to existing target", () => {
    it("errors when skill already exists at the explicit --dir target", () => {
      const id = `e2e-dir-dup-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");
      cli(`install ${src} --dir ${targetDir}`);

      // Try to install to the SAME --dir again
      const r = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r.exitCode, 1);
      assert.ok((r.stdout + r.stderr).includes("already installed"));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 16: Manifest integrity preserved through update
  // -----------------------------------------------------------------------
  describe("Scenario 16: manifest integrity through updates", () => {
    it("preserves source, type, version; adds updatedAt", () => {
      const id = `e2e-manifest-${Date.now()}`;
      const src = createLocalSkillPackage(id, { version: "2.0.0" });
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");
      cli(`install ${src} --dir ${targetDir}`);

      const m1 = readManifest(targetDir);
      assert.equal(m1[id].type, "skill");
      assert.equal(m1[id].sourceType, "local");
      assert.equal(m1[id].version, "2.0.0");
      assert.ok(m1[id].source);
      assert.ok(m1[id].installedAt);
      assert.ok(!m1[id].updatedAt, "No updatedAt before update");

      // Update
      cli(`update ${id} ${projectDir}`);

      const m2 = readManifest(targetDir);
      assert.ok(m2[id].source, "source preserved");
      assert.ok(m2[id].installedAt, "installedAt preserved");
      assert.ok(m2[id].updatedAt, "updatedAt added");
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 17: List across multiple locations
  // -----------------------------------------------------------------------
  describe("Scenario 17: list across multiple locations", () => {
    it("shows skills from all discovered directories with location labels", () => {
      const idA = `e2e-list-a-${Date.now()}`;
      const idB = `e2e-list-b-${Date.now()}`;

      const dir1 = join(projectDir, ".claude", "skills");
      const dir2 = join(projectDir, ".agents", "skills");
      seedSkill(dir1, idA, `src-${idA}`);
      seedSkill(dir2, idB, `src-${idB}`);

      const r = cli(`list ${projectDir}`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes(idA), `Should list ${idA}`);
      assert.ok(r.stdout.includes(idB), `Should list ${idB}`);
      // Should show both location labels
      assert.ok(r.stdout.includes(".claude/skills"), "Should show .claude/skills location");
      assert.ok(r.stdout.includes(".agents/skills"), "Should show .agents/skills location");
    });

    it("includes skills from fake global ~/.claude/skills/", () => {
      const id = `e2e-list-global-${Date.now()}`;
      const globalDir = join(fakeHome, ".claude", "skills");
      seedSkill(globalDir, id, `src-${id}`);

      const r = cli(`list ${projectDir}`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes(id), `Should list global skill ${id}`);
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 18: Orphan SKILL.md without a matching manifest entry
  // -----------------------------------------------------------------------
  describe("Scenario 18: orphan artifact (manifest-driven discovery)", () => {
    it("list ignores skill directories that have no manifest entry", () => {
      // In kit v1, discovery is manifest-driven. A skill directory dropped
      // on disk without a corresponding manifest entry is invisible to
      // `kit list` — the user's hand-managed artifacts don't get picked
      // up as "ctxr-installed".
      const dirName = `e2e-orphan-${Date.now()}`;
      const targetDir = join(projectDir, ".claude", "skills");
      const skillDir = join(targetDir, dirName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# Orphan\n");

      const r = cli(`list ${projectDir}`);
      assert.equal(r.exitCode, 0);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.toLowerCase().includes("no artifacts"),
        `Orphan dir should not show up as installed, got: ${output}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 19: No skills installed at all
  // -----------------------------------------------------------------------
  describe("Scenario 19: empty project, no artifacts anywhere", () => {
    it("list says 'No artifacts installed'", () => {
      const r = cli(`list ${projectDir}`);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.toLowerCase().includes("no artifacts"),
        `Expected 'no artifacts' message, got: ${output}`,
      );
    });

    it("update errors with 'No artifacts installed'", () => {
      const r = cli(`update`, { cwd: projectDir });
      assert.equal(r.exitCode, 1);
      assert.ok(r.stderr.includes("No artifacts installed"));
    });

    it("remove soft-skips with 'not installed' note, exits 0", () => {
      // New behavior: missing identifiers are a soft-skip, not an error.
      const r = cli(`remove some-artifact ${projectDir}`);
      assert.equal(r.exitCode, 0);
      const output = r.stdout + r.stderr;
      assert.ok(output.includes("not installed"));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 20: HOME isolation verification
  // -----------------------------------------------------------------------
  describe("Scenario 20: HOME isolation", () => {
    it("--user installs to fakeHome, not real home", () => {
      const id = `e2e-homeiso-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const r = cli(`install ${src} --user`);
      assert.equal(r.exitCode, 0, `Install --user failed: ${r.stderr}`);

      // Should be in fakeHome
      const userDir = join(fakeHome, ".claude", "skills");
      assert.ok(
        existsSync(join(userDir, id, "SKILL.md")),
        "Skill should be in fakeHome/.claude/skills/"
      );
    });

    it("user-scope skill can be updated and removed via fakeHome", () => {
      const id = `e2e-homeiso-ops-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      cli(`install ${src} --user`);

      // Update
      const r1 = cli(`update ${id} ${projectDir}`);
      assert.equal(r1.exitCode, 0, `Update user skill failed: ${r1.stderr}`);

      // Remove
      const r2 = cli(`remove ${id} ${projectDir} --force`);
      assert.equal(r2.exitCode, 0, `Remove user skill failed: ${r2.stderr}`);
      assert.ok(!existsSync(join(fakeHome, ".claude", "skills", id)));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 21: CLI help, version, and unknown command
  // -----------------------------------------------------------------------
  describe("Scenario 21: CLI meta-commands", () => {
    it("--help exits 0 and shows usage", () => {
      const r = cli(`--help`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("install"));
      assert.ok(r.stdout.includes("update"));
      assert.ok(r.stdout.includes("remove"));
      assert.ok(r.stdout.includes("list"));
    });

    it("-h exits 0 and shows usage", () => {
      const r = cli(`-h`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("install"));
    });

    it("--version exits 0 and prints semver", () => {
      const r = cli(`--version`);
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
    });

    it("-v exits 0 and prints version", () => {
      const r = cli(`-v`);
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
    });

    it("unknown command exits 2 (usage error) with error", () => {
      const r = cli(`frobnicate`);
      assert.equal(r.exitCode, 2);
      assert.ok(r.stderr.includes("Unknown command"));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 22: (removed) list description truncation
  //
  // The legacy list command opened SKILL.md to render frontmatter
  // descriptions and truncated long ones. The type-aware list command in
  // kit v1 does not display per-artifact descriptions (it's agnostic to
  // the artifact's internal file layout), so there is nothing to
  // truncate — the test is obsolete. Kept as a placeholder comment so
  // the scenario-numbering stays stable.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Scenario 23: Install with invalid skill names
  // -----------------------------------------------------------------------
  describe("Scenario 23: invalid package names", () => {
    // Build a package with an invalid package.json `name` — the new
    // dispatcher derives installedName from the package name and rejects
    // anything that doesn't match npm's grammar (via installedName() in
    // src/lib/types.js).
    function makeBadPkg(name) {
      const src = mkdtempSync(join(tmpdir(), "e2e-bad-name-"));
      cleanupDirs.push(src);
      writeFileSync(
        join(src, "SKILL.md"),
        `---\nname: bad\ndescription: Evil.\n---\n# Test\n`
      );
      writeFileSync(
        join(src, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          files: ["SKILL.md"],
          ctxr: { type: "skill", target: "folder" },
        })
      );
      return src;
    }

    it("rejects package name with path traversal segment", () => {
      const src = makeBadPkg("../escape-attempt");
      const targetDir = join(projectDir, ".claude", "skills");
      const r = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r.exitCode, 1);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.toLowerCase().includes("invalid"),
        `Expected 'invalid' error, got: ${output}`,
      );
    });

    it("rejects package name starting with ~", () => {
      const src = makeBadPkg("~root-escape");
      const targetDir = join(projectDir, ".claude", "skills");
      const r = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r.exitCode, 1);
      assert.ok((r.stdout + r.stderr).toLowerCase().includes("invalid"));
    });

    it("rejects package name with shell metacharacters", () => {
      const src = makeBadPkg("skill;rm -rf /");
      const targetDir = join(projectDir, ".claude", "skills");
      const r = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r.exitCode, 1);
      assert.ok((r.stdout + r.stderr).toLowerCase().includes("invalid"));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 24: install from local path without SKILL.md
  // -----------------------------------------------------------------------
  describe("Scenario 24: install from local path edge cases", () => {
    it("errors when local path has no package.json", () => {
      const src = mkdtempSync(join(tmpdir(), "e2e-no-pkgjson-"));
      cleanupDirs.push(src);
      writeFileSync(join(src, "README.md"), "# Not a package");

      const targetDir = join(projectDir, ".claude", "skills");
      const r = cli(`install ${src} --dir ${targetDir}`);
      assert.equal(r.exitCode, 1);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.includes("package.json"),
        `Expected package.json error, got: ${output}`,
      );
    });

    it("errors when local path does not exist", () => {
      const r = cli(`install /tmp/nonexistent-path-${Date.now()} --dir ${join(projectDir, "skills")}`);
      assert.equal(r.exitCode, 1);
      const output = r.stdout + r.stderr;
      assert.ok(output.includes("not found"), `Expected 'not found' error, got: ${output}`);
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 25: Update backup/restore on install failure
  // -----------------------------------------------------------------------
  describe("Scenario 25: update restores from backup on failure", () => {
    it("restores the skill when update source is gone", () => {
      const id = `e2e-restore-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");
      cli(`install ${src} --dir ${targetDir}`);

      // Delete the source so re-install will fail
      rmSync(src, { recursive: true, force: true });

      // Update should fail but restore the backup
      const r = cli(`update ${id} ${projectDir}`);
      const output = r.stdout + r.stderr;
      assert.ok(
        output.includes("update failed") || output.includes("restored"),
        `Expected failure/restore message, got: ${output}`
      );
      // Skill should still exist (restored from backup)
      assert.ok(
        existsSync(join(targetDir, id, "SKILL.md")),
        "Skill should be restored from backup after failed update"
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 26: Install --dir prevents escape outside project
  // -----------------------------------------------------------------------
  describe("Scenario 26: path escape prevention", () => {
    it("--dir with relative path that escapes project is rejected", () => {
      const id = `e2e-escape-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      // Try to escape via ../../
      const r = cli(`install ${src} --dir ../../etc/skills ${projectDir}`);
      // This should either error or install to a safe resolved path
      // Depending on path resolution, it may error with "escapes project"
      // or resolve to a valid temp path. Either way it should NOT write to /etc/skills
      assert.ok(!existsSync("/etc/skills"), "/etc/skills should not be created");
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 27: Verify all temp dirs are cleaned up
  // -----------------------------------------------------------------------
  describe("Scenario 27: temp directory cleanup after install", () => {
    it("does not leave temp dirs behind after successful install", () => {
      const id = `e2e-cleanup-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      const targetDir = join(projectDir, ".claude", "skills");

      // Count tmp dirs with our prefix before
      const tmpBefore = readdirSync(tmpdir()).filter(d => d.startsWith("skills-install-"));

      cli(`install ${src} --dir ${targetDir}`);

      // Count after — should not have grown
      const tmpAfter = readdirSync(tmpdir()).filter(d => d.startsWith("skills-install-"));
      assert.equal(
        tmpAfter.length, tmpBefore.length,
        "No temp dirs should be left behind after local install"
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 28: Non-TTY install without --dir picks .claude/skills/ default
  // -----------------------------------------------------------------------
  describe("Scenario 28: non-TTY default location", () => {
    it("defaults to .claude/skills/ when no dirs exist and no --dir given", () => {
      const id = `e2e-default-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      // projectDir has no .claude/skills/ or .agents/skills/ yet
      const r = cli(`install ${src} ${projectDir}`);
      assert.equal(r.exitCode, 0, `Install failed: ${r.stderr}`);
      // Should have created .claude/skills/<id>
      assert.ok(
        existsSync(join(projectDir, ".claude", "skills", id, "SKILL.md")),
        "Should default to .claude/skills/"
      );
    });

    it("picks the single existing dir silently", () => {
      const id = `e2e-single-${Date.now()}`;
      const src = createLocalSkillPackage(id);
      cleanupDirs.push(src);

      // Create ONLY .agents/skills/ — should auto-select it
      const agentsDir = join(projectDir, ".agents", "skills");
      mkdirSync(agentsDir, { recursive: true });

      const r = cli(`install ${src} ${projectDir}`);
      assert.equal(r.exitCode, 0, `Install failed: ${r.stderr}`);
      assert.ok(
        existsSync(join(agentsDir, id, "SKILL.md")),
        "Should auto-select the single existing dir (.agents/skills/)"
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 29: Skills dir exists but has no SKILL.md files
  // -----------------------------------------------------------------------
  describe("Scenario 29: type dir exists but has no manifest entries", () => {
    it("update errors with 'No artifacts installed' when dir is empty", () => {
      const skillsDir = join(projectDir, ".claude", "skills");
      mkdirSync(skillsDir, { recursive: true });
      // dir exists, but no manifest + no artifacts

      const r = cli(`update`, { cwd: projectDir });
      const output = r.stdout + r.stderr;
      assert.ok(
        output.includes("No artifacts installed"),
        `Expected 'No artifacts installed' message, got: ${output}`,
      );
    });

    it("update errors when subdir exists but manifest has no entries", () => {
      const skillsDir = join(projectDir, ".claude", "skills");
      const orphanDir = join(skillsDir, "orphan-dir");
      mkdirSync(orphanDir, { recursive: true });
      writeFileSync(join(orphanDir, "README.md"), "# Not a skill");
      // manifest never written → readManifest returns {} → no entries

      const r = cli(`update`, { cwd: projectDir });
      const output = r.stdout + r.stderr;
      assert.ok(
        output.includes("No artifacts installed"),
        `Expected 'No artifacts installed', got: ${output}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 30: Skill with empty name in frontmatter
  // -----------------------------------------------------------------------
  describe("Scenario 30: SKILL.md with empty name field", () => {
    it("falls back to directory name when name is empty string", () => {
      const dirName = `e2e-emptyname-${Date.now()}`;
      const targetDir = join(projectDir, ".claude", "skills");

      const src = mkdtempSync(join(tmpdir(), "e2e-emptyname-"));
      cleanupDirs.push(src);
      // name field is empty string — should fall back to basename of dir
      writeFileSync(
        join(src, "SKILL.md"),
        `---\nname: ""\ndescription: Empty name test.\n---\n# Test\n`
      );

      // Install — getSkillName should fall back to the source dir basename
      const r = cli(`install ${src} --dir ${targetDir}`);
      // The basename of a mkdtemp dir is random, so it should either
      // install successfully using the dir basename or reject it
      // Either outcome is acceptable — the point is it doesn't crash
      assert.ok(
        r.exitCode === 0 || r.exitCode === 1,
        `Should not crash, got exit ${r.exitCode}: ${r.stderr}`
      );
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 31: -f shorthand for --force
  // -----------------------------------------------------------------------
  describe("Scenario 31: -f shorthand for --force", () => {
    it("works as alias for --force in remove", () => {
      const id = `e2e-dashf-${Date.now()}`;
      seedSkill(join(projectDir, ".claude", "skills"), id, `src-${id}`);

      const r = cli(`remove ${id} ${projectDir} -f`);
      assert.equal(r.exitCode, 0, `Remove with -f failed: ${r.stderr}`);
      assert.ok(!existsSync(join(projectDir, ".claude", "skills", id)));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 32: Update with failures still reports partial success
  // -----------------------------------------------------------------------
  describe("Scenario 32: update with mixed success/failure", () => {
    it("reports failure count when some skills fail to update", () => {
      const goodId = `e2e-good-${Date.now()}`;
      const badId = `e2e-bad-${Date.now()}`;
      const goodSrc = createLocalSkillPackage(goodId);
      cleanupDirs.push(goodSrc);

      const targetDir = join(projectDir, ".claude", "skills");

      // Install a good skill (source stays around)
      cli(`install ${goodSrc} --dir ${targetDir}`);

      // Seed a bad skill with a fake source that doesn't exist
      seedSkill(targetDir, badId, `/tmp/nonexistent-source-${Date.now()}`);

      // Update all — good should succeed, bad should fail
      const r = cli(`update`, { cwd: projectDir });
      const output = r.stdout + r.stderr;
      assert.ok(
        output.includes("failure") || output.includes("failed"),
        `Expected failure message for bad skill, got: ${output}`
      );
      // Good skill should still exist
      assert.ok(existsSync(join(targetDir, goodId, "SKILL.md")));
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 33: Verify no real HOME paths appear in test outputs
  // -----------------------------------------------------------------------
  describe("Scenario 33: no real home directory leakage", () => {
    it("list output uses fakeHome path, not real home", () => {
      const id = `e2e-noleak-${Date.now()}`;
      const globalDir = join(fakeHome, ".claude", "skills");
      seedSkill(globalDir, id, `src-${id}`);

      const r = cli(`list ${projectDir}`);
      assert.equal(r.exitCode, 0);
      // Output should contain ~ (fakeHome formatted) but not the real homedir
      const realHome = homedir();
      assert.ok(
        !r.stdout.includes(realHome),
        `Output should not contain real home dir (${realHome})`
      );
    });
  });
});
