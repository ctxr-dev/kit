/**
 * kit list [path]
 *
 * List every installed artifact across every known `(type, dir)` pair.
 * Grouped by type, one section per type. Teams are listed last with their
 * member count. Reads the unified `.ctxr-manifest.json` at each location;
 * does not rely on Claude Code's own artifact discovery.
 *
 * Examples:
 *   kit list                 # list artifacts in current project
 *   kit list ./my-project    # list artifacts in specific project
 */

import { resolve, relative } from "node:path";
import { homedir } from "node:os";
import { listAllInstalled } from "../lib/discover.js";

function printUsage() {
  console.error(`
Usage: kit list [path]

List installed artifacts across every known project- and user-scope
location, grouped by type.

Arguments:
  path                      Project root to inspect (default: current dir)

Options:
  -h, --help                Show this help message
`);
}

function formatLocation(dir, projectPath) {
  const home = homedir();
  if (dir.startsWith(home)) return dir.replace(home, "~");
  const rel = relative(projectPath, dir);
  return rel && !rel.startsWith("..") ? rel : dir;
}

export default async function list(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  const projectPath = resolve(args[0] || ".");
  const groups = listAllInstalled(projectPath);

  if (groups.length === 0) {
    console.log("\nNo artifacts installed.");
    console.log("Use 'kit install <source>' to install one.\n");
    return;
  }

  // Aggregate by type across multiple dirs so the output is one section per
  // type, with the location shown per-entry when >1 location is in play.
  const byType = new Map();
  for (const { typeName, dir, entries } of groups) {
    if (!byType.has(typeName)) byType.set(typeName, []);
    for (const entry of entries) {
      byType.get(typeName).push({ dir, entry });
    }
  }

  let total = 0;

  for (const [typeName, items] of byType) {
    console.log(`\n  ${typeName} (${items.length}):`);
    for (const { dir, entry } of items) {
      const loc = formatLocation(dir, projectPath);
      const source = entry.source ? ` ← ${entry.source}` : "";
      const version = entry.version ? ` v${entry.version}` : "";
      const label = entry.target ? `[${entry.target}]` : "[meta]";
      const extra =
        entry.type === "team" && Array.isArray(entry.members)
          ? ` (${entry.members.length} member${entry.members.length === 1 ? "" : "s"})`
          : "";
      console.log(`    ${entry.installedName} ${label}${source}${version}${extra}`);
      console.log(`      at ${loc}`);
      total++;
    }
  }

  console.log(`\n  Total: ${total} artifact${total === 1 ? "" : "s"}\n`);
}
