import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLocalFixtureTitle,
  LOCAL_FIXTURE_TITLE_PREFIXES,
  LOCAL_SWEEP_STATUSES,
  sweepLocalFixturesDb,
} from "./local-fixture-sweep.mjs";

// Fake postgres.js client: records the interpolated statement, returns canned rows.
function fakeSql(rows) {
  const seen = [];
  const sql = (strings, ...values) => {
    seen.push(
      strings.reduce(
        (text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ""),
        "",
      ),
    );
    return Promise.resolve(rows);
  };
  return { sql, seen };
}

test("local sweep matches only its named fixture titles", () => {
  for (const prefix of LOCAL_FIXTURE_TITLE_PREFIXES) {
    assert.equal(isLocalFixtureTitle(`${prefix}fixture`), true);
  }
  // The seeded event and every other title stay live: the sweep must never
  // cancel the event the parity and perf steps read.
  for (const title of [
    "E2E Community Night",
    "E2E Waitlistish unrelated",
    "Staging E2E event",
    "E2E Filter",
    "",
  ]) {
    assert.equal(isLocalFixtureTitle(title), false, title);
  }
});

test("local sweep cancels live fixtures in one statement and returns their keys", async () => {
  const { sql, seen } = fakeSql([
    { event_key: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    { event_key: "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
  ]);
  const swept = await sweepLocalFixturesDb(sql);
  assert.deepEqual(swept, ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW"]);
  assert.equal(seen.length, 1);
  const statement = seen[0];
  assert.match(statement, /UPDATE events SET status = 'cancelled'/);
  assert.match(statement, /RETURNING event_key/);
  for (const status of LOCAL_SWEEP_STATUSES) {
    assert.ok(statement.includes(`'${status}'`), `sweeps status ${status}`);
  }
  for (const prefix of LOCAL_FIXTURE_TITLE_PREFIXES) {
    assert.ok(statement.includes(`title LIKE '${prefix}%'`), `sweeps prefix ${prefix}`);
  }
});

test("local sweep returns no keys when no fixture is live", async () => {
  const { sql, seen } = fakeSql([]);
  assert.deepEqual(await sweepLocalFixturesDb(sql), []);
  assert.equal(seen.length, 1);
});
