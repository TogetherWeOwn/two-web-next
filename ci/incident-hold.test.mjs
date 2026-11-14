import assert from "node:assert/strict";
import { test } from "node:test";
import { heldProduction } from "./incident-hold.mjs";

const LIVE = "a".repeat(40);
const MAIN = "b".repeat(40);
const NOW = Date.parse("2026-11-08T12:00:00Z");
const comparison = (since = "2026-11-08T05:59:59Z") => ({
  status: "ahead",
  ahead_by: 3,
  total_commits: 3,
  behind_by: 0,
  base_commit: { sha: LIVE },
  merge_base_commit: { sha: LIVE },
  commits: [{ sha: MAIN, commit: { committer: { date: since } } }],
});

test("production age uses oldest unpromoted commit and strictly exceeds six hours", () => {
  const args = { liveSha: LIVE, mainSha: MAIN, nowMs: NOW };
  assert.equal(
    heldProduction({ ...args, comparison: comparison("2026-11-08T06:00:00Z") }).held,
    false,
  );
  const held = heldProduction({ ...args, comparison: comparison() });
  assert.equal(held.held, true);
  assert.equal(held.heldSince, "2026-11-08T05:59:59.000Z");
  assert.deepEqual(heldProduction({ ...args, mainSha: LIVE }), {
    held: false,
    heldSince: null,
    hours: 0,
  });
  for (const bad of [
    null,
    { ...comparison(), behind_by: 1 },
    { ...comparison(), base_commit: { sha: MAIN } },
    { ...comparison(), status: "diverged" },
    { ...comparison(), total_commits: 4 },
    comparison("2026-11-08T13:00:00Z"),
    comparison("not a date"),
  ]) {
    assert.throws(() => heldProduction({ ...args, comparison: bad }), /hold age/);
  }
});
