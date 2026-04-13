/**
 * cli.test.js
 *
 * Smoke-tests the CLI entry point at `src/cli.js`. The router itself is
 * tiny — these tests pin the things that would silently break user
 * muscle memory if regressed: `--help` / `-h` exit 0 and list every
 * command + every artifact type, `--version` / `-v` print the value from
 * package.json, no-args shows help, and unknown commands fail loudly with
 * the right binary name in the hint.
 *
 * We intentionally do NOT exercise per-subcommand argv parsing here —
 * those are owned by the integration tests for each command. The CLI is
 * a router; testing it like one keeps this file fast and the per-command
 * tests authoritative.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.js");
const PKG = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
);

function run(args = "") {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
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

describe("CLI entry point", () => {
  describe("--help", () => {
    it("exits 0", () => {
      const { exitCode } = run("--help");
      assert.equal(exitCode, 0);
    });

    it("shows all command names", () => {
      const { stdout } = run("--help");
      for (const cmd of [
        "validate",
        "install",
        "update",
        "remove",
        "list",
        "init",
        "info",
      ]) {
        assert.ok(stdout.includes(cmd), `help output should mention '${cmd}'`);
      }
    });

    it("lists every supported artifact type", () => {
      // Help text doubles as the discoverability surface for the type
      // taxonomy — if a new type lands without the help being updated,
      // users won't know it exists. Pin the matrix here.
      const { stdout } = run("--help");
      for (const t of ["skill", "agent", "command", "rule", "output-style", "team"]) {
        assert.ok(stdout.includes(t), `help output should mention type '${t}'`);
      }
    });

    it("uses 'kit' as the binary name in usage and examples", () => {
      const { stdout } = run("--help");
      assert.match(stdout, /Usage:\s+kit\s</);
      assert.match(stdout, /kit install /);
    });

    it("brands the tool as @ctxr/kit (not the legacy @ctxr-dev/skills)", () => {
      const { stdout } = run("--help");
      assert.match(stdout, /@ctxr\/kit/);
      assert.ok(
        !stdout.includes("@ctxr-dev/skills"),
        "help text must not reference the pre-rename package",
      );
      assert.ok(
        !stdout.includes("--global"),
        "help text must not advertise the deprecated --global flag",
      );
    });

    it("documents the --user global option", () => {
      const { stdout } = run("--help");
      assert.match(stdout, /--user/);
    });
  });

  describe("-h alias", () => {
    it("exits 0 and shows help", () => {
      const { exitCode, stdout } = run("-h");
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("validate"));
    });
  });

  describe("--version", () => {
    it("exits 0 and prints version from package.json", () => {
      const { exitCode, stdout } = run("--version");
      assert.equal(exitCode, 0);
      assert.ok(stdout.trim().includes(PKG.version));
    });
  });

  describe("-v alias", () => {
    it("exits 0 and prints version", () => {
      const { exitCode, stdout } = run("-v");
      assert.equal(exitCode, 0);
      assert.ok(stdout.trim().includes(PKG.version));
    });
  });

  describe("no arguments", () => {
    it("exits 0 and shows help", () => {
      const { exitCode, stdout } = run("");
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("validate"));
    });
  });

  describe("unknown command", () => {
    it("exits 2 (usage error) with error message", () => {
      // Exit code 2 per POSIX-ish convention: 0=success, 1=runtime failure,
      // 2=usage error. Scripts can distinguish "you typed it wrong" from
      // "the install actually failed."
      const { exitCode, stderr } = run("nonexistent");
      assert.equal(exitCode, 2);
      assert.ok(stderr.includes("Unknown command"));
    });

    it("hints at 'kit --help' (not the legacy 'skills --help')", () => {
      const { stderr } = run("nonexistent");
      assert.match(stderr, /kit --help/);
      assert.ok(
        !stderr.includes("skills --help"),
        "unknown-command hint must use the new binary name",
      );
    });
  });

  describe("uninstall alias", () => {
    it("is recognized as a routable command (does not error as 'Unknown command')", () => {
      // `uninstall` routes to `commands/remove.js`. With no args, remove
      // exits non-zero with its own usage/error — we only care that the
      // CLI router did NOT print 'Unknown command'.
      const { stderr } = run("uninstall");
      assert.ok(
        !stderr.includes("Unknown command"),
        "router should accept 'uninstall' as an alias for 'remove'",
      );
    });
  });
});
