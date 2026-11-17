import assert from "node:assert/strict";
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertRouteEvidenceInputHashes,
  routeEvidenceInputHashes,
} from "./route-evidence-input-hashes.mjs";

test("synthetic reviewed input hashes bind file bytes and sort by path", () => {
  const root = mkdtempSync(join(tmpdir(), "route-inputs-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a"), "a");
    writeFileSync(join(root, "src", "b"), "b");
    const hashes = routeEvidenceInputHashes(root, ["src/b", "src/a"]);
    assert.deepEqual(
      hashes.map((entry) => entry.path),
      ["src/a", "src/b"],
    );
    assert.equal(
      hashes[0].sha256,
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
    assert.doesNotThrow(() =>
      assertRouteEvidenceInputHashes(root, ["src/b", "src/a"], hashes.toReversed()),
    );
    writeFileSync(join(root, "src", "a"), "changed");
    assert.throws(() => assertRouteEvidenceInputHashes(root, ["src/a", "src/b"], hashes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthetic hash comparison rejects missing, extra, duplicate and malformed records", () => {
  const root = mkdtempSync(join(tmpdir(), "route-inputs-"));
  try {
    writeFileSync(join(root, "a"), "data");
    writeFileSync(join(root, "b"), "other");
    const hashes = routeEvidenceInputHashes(root, ["a", "b"]);
    for (const supplied of [
      [],
      [...hashes, hashes[0]],
      [hashes[0], hashes[0]],
      [hashes[0], { ...hashes[1], path: "other" }],
      [hashes[0], { ...hashes[1], sha256: "A".repeat(64) }],
      [hashes[0], null],
    ]) {
      assert.throws(() => assertRouteEvidenceInputHashes(root, ["a", "b"], supplied));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthetic input list refuses missing, duplicate, aliased and escaping paths", () => {
  const root = mkdtempSync(join(tmpdir(), "route-inputs-"));
  try {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "file"), "data");
    symlinkSync(join(root, "file"), join(root, "alias"));
    symlinkSync(join(root, "dir"), join(root, "alias-dir"));
    writeFileSync(join(root, "dir", "file"), "data");
    for (const paths of [
      [],
      ["missing"],
      ["file", "file"],
      ["./file"],
      ["dir/../file"],
      ["../file"],
      ["alias"],
      ["alias-dir/file"],
      ["dir"],
      [root],
      ["dir\\file"],
    ]) {
      assert.throws(() => routeEvidenceInputHashes(root, paths));
    }
    linkSync(join(root, "file"), join(root, "hardlink"));
    assert.throws(() => routeEvidenceInputHashes(root, ["file"]));
    assert.throws(() => routeEvidenceInputHashes(root, ["hardlink"]));
    assert.throws(() => routeEvidenceInputHashes("relative", ["file"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
