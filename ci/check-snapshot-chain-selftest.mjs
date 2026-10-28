import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSnapshotChain } from "./check-snapshot-chain.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const ZERO = "00000000-0000-0000-0000-000000000000";

function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function journal(tags) {
  return JSON.stringify(
    {
      version: "7",
      dialect: "postgresql",
      entries: tags.map((tag, idx) => ({
        idx,
        version: "7",
        when: 1000 + idx,
        tag,
        breakpoints: true,
      })),
    },
    null,
    2,
  );
}

function snapshot(id, prevId) {
  return JSON.stringify({ id, prevId, version: "7" });
}

function fixture(t, tags, snapshots) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "snapshot-chain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "drizzle/meta/_journal.json", journal(tags));
  for (const [number, text] of Object.entries(snapshots)) {
    put(root, `drizzle/meta/${number}_snapshot.json`, text);
  }
  return root;
}

test("valid chain passes", (t) => {
  const root = fixture(
    t,
    ["1004_job-unique-locks", "1005_event-search-logs", "1006_rsvp-synced-at"],
    {
      1004: snapshot("id-1004", ZERO),
      1005: snapshot("id-1005", "id-1004"),
      1006: snapshot("id-1006", "id-1005"),
    },
  );
  assert.deepEqual(checkSnapshotChain(root), { entries: 3, snapshots: 3 });
});

test("empty journal fails", (t) => {
  const root = fixture(t, [], {});
  assert.throws(() => checkSnapshotChain(root), /journal has no entries/);
});

test("duplicate snapshot id fails", (t) => {
  const root = fixture(t, ["1004_job-unique-locks", "1005_event-search-logs"], {
    1004: snapshot("id-1004", ZERO),
    1005: snapshot("id-1004", "id-1004"),
  });
  assert.throws(() => checkSnapshotChain(root), /duplicate snapshot id.*1005_snapshot\.json/);
});

test("removed snapshot fails", (t) => {
  const root = fixture(
    t,
    ["1004_job-unique-locks", "1005_event-search-logs", "1006_rsvp-synced-at"],
    {
      1004: snapshot("id-1004", ZERO),
      1006: snapshot("id-1006", "id-1005"),
    },
  );
  assert.throws(() => checkSnapshotChain(root), /missing snapshot.*1005_event-search-logs/);
});

test("dangling prevId fails", (t) => {
  const root = fixture(
    t,
    ["1004_job-unique-locks", "1005_event-search-logs", "1006_rsvp-synced-at"],
    {
      1004: snapshot("id-1004", ZERO),
      1005: snapshot("id-1005", "id-1004"),
      1006: snapshot("id-1006", "id-9999"),
    },
  );
  assert.throws(() => checkSnapshotChain(root), /dangling prevId.*1006_snapshot\.json/);
});

test("non-zero genesis prevId fails", (t) => {
  const root = fixture(t, ["1004_job-unique-locks"], { 1004: snapshot("id-1004", "id-9999") });
  assert.throws(() => checkSnapshotChain(root), /genesis.*prevId/);
});

test("malformed journal tag fails", (t) => {
  const root = fixture(t, ["no-number-here"], {});
  assert.throws(() => checkSnapshotChain(root), /malformed tag/);
});

test("unparseable snapshot fails", (t) => {
  const root = fixture(t, ["1004_job-unique-locks"], { 1004: "{not json" });
  assert.throws(() => checkSnapshotChain(root), /unparseable snapshot chain file/);
});

test("live drizzle chain is contiguous", () => {
  const result = checkSnapshotChain(repoRoot);
  assert.equal(result.entries, result.snapshots);
  assert.ok(result.entries > 0);
});

test("live chain minus the 1005 snapshot fails", (t) => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "snapshot-chain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(repoRoot, "drizzle"), join(root, "drizzle"), { recursive: true });
  rmSync(join(root, "drizzle/meta/1005_snapshot.json"), { force: true });
  assert.throws(() => checkSnapshotChain(root), /missing snapshot.*1005_event-search-logs/);
});

test("CLI usage errors exit 2 with a usage line", () => {
  for (const args of [["--bogus"], ["unexpected", "args"]]) {
    const result = spawnSync(process.execPath, ["ci/check-snapshot-chain.mjs", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, `argv ${JSON.stringify(args)} must exit 2 (usage error)`);
    assert.match(result.stderr, /usage/i);
    assert.match(result.stderr, /check-snapshot-chain/);
    assert.equal(result.stdout, "");
  }
});

test("CLI success exits 0 on the live chain", () => {
  const result = spawnSync(process.execPath, ["ci/check-snapshot-chain.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /snapshot-chain: ok/);
});

test("CLI genuine failure exits 1", (t) => {
  // The CLI resolves its root from its own path, so a relocated copy checks
  // the fixture instead of the live tree.
  const root = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "snapshot-chain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "ci"), { recursive: true });
  cpSync(join(repoRoot, "ci/check-snapshot-chain.mjs"), join(root, "ci/check-snapshot-chain.mjs"));
  put(
    root,
    "drizzle/meta/_journal.json",
    journal(["1004_job-unique-locks", "1005_event-search-logs"]),
  );
  put(root, "drizzle/meta/1004_snapshot.json", snapshot("id-1004", ZERO));
  // No 1005 snapshot: the gate ran and found a broken chain.
  const result = spawnSync(process.execPath, ["ci/check-snapshot-chain.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing snapshot.*1005_event-search-logs/);
  assert.equal(result.stdout, "");
});
