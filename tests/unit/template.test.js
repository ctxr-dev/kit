import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyTemplate } from "../../src/lib/template.js";

// Access private functions by re-implementing the logic for testing,
// or test them through copyTemplate. Since interpolate and transformFilename
// aren't exported, we test them indirectly through copyTemplate.

describe("template engine", () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skills-test-template-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("copyTemplate — placeholder interpolation", () => {
    it("replaces {{var}} placeholders in file content", () => {
      const src = join(tmpDir, "src-interp");
      const dest = join(tmpDir, "dest-interp");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "test.md"), "Hello {{name}}, welcome to {{project}}.");

      copyTemplate(src, dest, { name: "Alice", project: "Skills" });

      const content = readFileSync(join(dest, "test.md"), "utf8");
      assert.equal(content, "Hello Alice, welcome to Skills.");
    });

    it("leaves unknown {{placeholders}} intact", () => {
      const src = join(tmpDir, "src-unknown");
      const dest = join(tmpDir, "dest-unknown");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "test.md"), "Hello {{name}}, {{unknown}} here.");

      copyTemplate(src, dest, { name: "Bob" });

      const content = readFileSync(join(dest, "test.md"), "utf8");
      assert.equal(content, "Hello Bob, {{unknown}} here.");
    });

    it("handles files with no placeholders", () => {
      const src = join(tmpDir, "src-noop");
      const dest = join(tmpDir, "dest-noop");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "plain.txt"), "No placeholders here.");

      copyTemplate(src, dest, { name: "ignored" });

      const content = readFileSync(join(dest, "plain.txt"), "utf8");
      assert.equal(content, "No placeholders here.");
    });

    it("handles empty files", () => {
      const src = join(tmpDir, "src-empty");
      const dest = join(tmpDir, "dest-empty");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "empty.txt"), "");

      copyTemplate(src, dest, {});

      const content = readFileSync(join(dest, "empty.txt"), "utf8");
      assert.equal(content, "");
    });

    it("replaces multiple occurrences of the same variable", () => {
      const src = join(tmpDir, "src-multi");
      const dest = join(tmpDir, "dest-multi");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "test.md"), "{{x}} and {{x}} again.");

      copyTemplate(src, dest, { x: "val" });

      const content = readFileSync(join(dest, "test.md"), "utf8");
      assert.equal(content, "val and val again.");
    });
  });

  describe("copyTemplate — filename transformations", () => {
    it("renames _gitignore to .gitignore", () => {
      const src = join(tmpDir, "src-dotfile");
      const dest = join(tmpDir, "dest-dotfile");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "_gitignore"), "node_modules/");

      copyTemplate(src, dest, {});

      const content = readFileSync(join(dest, ".gitignore"), "utf8");
      assert.equal(content, "node_modules/");
    });

    it("strips .tmpl extension", () => {
      const src = join(tmpDir, "src-tmpl");
      const dest = join(tmpDir, "dest-tmpl");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "package.json.tmpl"), '{"name": "{{name}}"}');

      copyTemplate(src, dest, { name: "test" });

      const content = readFileSync(join(dest, "package.json"), "utf8");
      assert.equal(content, '{"name": "test"}');
    });

    it("applies both _prefix and .tmpl stripping", () => {
      const src = join(tmpDir, "src-both");
      const dest = join(tmpDir, "dest-both");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "_env.tmpl"), "KEY={{val}}");

      copyTemplate(src, dest, { val: "secret" });

      const content = readFileSync(join(dest, ".env"), "utf8");
      assert.equal(content, "KEY=secret");
    });

    it("leaves normal filenames unchanged", () => {
      const src = join(tmpDir, "src-normal");
      const dest = join(tmpDir, "dest-normal");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "README.md"), "hi");

      copyTemplate(src, dest, {});

      const content = readFileSync(join(dest, "README.md"), "utf8");
      assert.equal(content, "hi");
    });
  });

  describe("copyTemplate — directory handling", () => {
    it("copies nested directory structures", () => {
      const src = join(tmpDir, "src-nested");
      const dest = join(tmpDir, "dest-nested");
      mkdirSync(join(src, "sub", "deep"), { recursive: true });
      writeFileSync(join(src, "root.md"), "root {{v}}");
      writeFileSync(join(src, "sub", "mid.md"), "mid {{v}}");
      writeFileSync(join(src, "sub", "deep", "leaf.md"), "leaf {{v}}");

      const created = copyTemplate(src, dest, { v: "!" });

      assert.equal(readFileSync(join(dest, "root.md"), "utf8"), "root !");
      assert.equal(readFileSync(join(dest, "sub", "mid.md"), "utf8"), "mid !");
      assert.equal(readFileSync(join(dest, "sub", "deep", "leaf.md"), "utf8"), "leaf !");
      assert.equal(created.length, 3);
    });

    it("returns list of created file paths relative to dest", () => {
      const src = join(tmpDir, "src-list");
      const dest = join(tmpDir, "dest-list");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "a.md"), "a");
      writeFileSync(join(src, "b.txt"), "b");

      const created = copyTemplate(src, dest, {});

      assert.ok(created.includes("a.md"));
      assert.ok(created.includes("b.txt"));
      assert.equal(created.length, 2);
    });
  });
});
