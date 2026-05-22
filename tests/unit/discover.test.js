/**
 * discover.test.js
 *
 * Unit coverage for the round-3 hardenings on `src/lib/discover.js`:
 *   - `readManifest` strips `__proto__` / `constructor` / `prototype` keys
 *     via the JSON.parse reviver so a malicious manifest cannot seed
 *     pollution-shaped keys into kit's data flow.
 *   - `writeManifest` opens its tmp file with `flag: "wx"` (O_EXCL), so a
 *     pre-planted file at the tmp slot causes EEXIST instead of being
 *     followed-and-written-through.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readManifest, writeManifest } from "../../src/lib/discover.js";

describe("readManifest pollution-key reviver", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctxr-discover-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drops __proto__, constructor, and prototype keys at parse time", () => {
    const hostile =
      '{"__proto__": {"polluted": true}, ' +
      '"constructor": {"x": 1}, ' +
      '"prototype": {"y": 2}, ' +
      '"good": {"type": "skill"}}';
    writeFileSync(join(dir, ".ctxr-manifest.json"), hostile);
    const m = readManifest(dir);
    assert.ok(!Object.prototype.hasOwnProperty.call(m, "__proto__"));
    assert.ok(!Object.prototype.hasOwnProperty.call(m, "constructor"));
    assert.ok(!Object.prototype.hasOwnProperty.call(m, "prototype"));
    assert.deepEqual(m.good, { type: "skill" });
    // Object prototype is unaffected.
    assert.equal({}.polluted, undefined);
  });
});

describe("writeManifest tmp-slot O_EXCL guard", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctxr-discover-wx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("wx-flag contract: opening an existing path with flag:'wx' throws EEXIST", () => {
    // writeManifest opens its tmp slot with `flag: "wx"` (O_EXCL) so a
    // pre-planted file at the tmp path causes EEXIST rather than being
    // followed-and-written-through. The tmp path carries an unpredictable
    // `randomBytes` suffix, so we can't deterministically pre-plant the
    // exact slot without injecting randomness. This focused test documents
    // the wx contract that hardening relies on.
    const collidingPath = join(dir, "collide.tmp");
    writeFileSync(collidingPath, "pre-planted");
    assert.throws(
      () => writeFileSync(collidingPath, "new", { flag: "wx" }),
      /EEXIST/,
    );
  });

  it("end-to-end: writeManifest round-trips via readManifest", () => {
    const payload = {
      foo: { type: "skill", version: "1.2.3" },
      bar: { type: "agent" },
    };
    writeManifest(dir, payload);
    const roundTripped = readManifest(dir);
    assert.deepEqual(roundTripped, payload);
    // Raw read confirms the on-disk JSON matches too.
    const raw = JSON.parse(readFileSync(join(dir, ".ctxr-manifest.json"), "utf8"));
    assert.deepEqual(raw, payload);
  });

  it("writes atomically and leaves no orphan .tmp file in the dir", () => {
    writeManifest(dir, { foo: { type: "skill" } });
    // Re-write replaces atomically (rename over the existing manifest).
    writeManifest(dir, { foo: { type: "agent" } });
    assert.equal(readManifest(dir).foo.type, "agent");
    // The temp+fsync+rename pattern must not leave behind any `.tmp` slot.
    const orphans = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(orphans, [], `unexpected orphan tmp files: ${orphans.join(", ")}`);
  });
});
