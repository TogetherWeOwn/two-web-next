// Backstop sweep for staging E2E event fixtures: list URL, row parsing and the
// leftover failure. Pure helpers only (no browser).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIXTURE_TITLE_PREFIX,
  SWEEP_MAX_PASSES,
  SWEEP_STATUSES,
  leftoverFixturesError,
  parseFixtureRows,
  sweepListPath,
} from "./fixture-sweep.mjs";

// Low-entropy ULID-shaped keys: a real-looking key trips the secret scan.
const KEY_A = `${"0".repeat(25)}1`;
const KEY_B = `${"0".repeat(25)}2`;

function row(key, title) {
  return `<tr><td><a href="/admin/events/${key}">${title}</a></td><td>published</td></tr>`;
}

test("the sweep covers both statuses a cancel still applies to", () => {
  assert.deepEqual([...SWEEP_STATUSES], ["published", "draft"]);
  assert.ok(SWEEP_MAX_PASSES >= 1 && SWEEP_MAX_PASSES <= 6, "passes stay bounded");
});

test("the list URL filters by prefix and status, newest start first", () => {
  const url = new URL(sweepListPath("published"), "https://example.invalid");
  assert.equal(url.pathname, "/admin/events");
  assert.equal(url.searchParams.get("q"), "Staging E2E");
  assert.equal(url.searchParams.get("status"), "published");
  assert.equal(url.searchParams.get("sort"), "starts_at");
  assert.equal(url.searchParams.get("order"), "desc");
});

test("rows keep only fixture titles and carry their event key", () => {
  const html = [
    `<a href="/admin/events/new" data-testid="new-event">New event</a>`,
    row(KEY_A, `${FIXTURE_TITLE_PREFIX}RSVP 1791100000000`),
    // The list search is a substring match, so a lookalike can come back.
    row(KEY_B, "Not a Staging E2E fixture"),
  ].join("\n");
  assert.deepEqual(parseFixtureRows(html), [
    { eventKey: KEY_A, title: `${FIXTURE_TITLE_PREFIX}RSVP 1791100000000` },
  ]);
});

test("a page with no fixture rows parses to an empty list", () => {
  assert.deepEqual(parseFixtureRows(`<td data-testid="events-empty">No events</td>`), []);
  assert.deepEqual(parseFixtureRows(""), []);
});

test("keys that are not ULID-shaped never match", () => {
  const html = row("not-a-ulid", `${FIXTURE_TITLE_PREFIX}Draft 1`);
  assert.deepEqual(parseFixtureRows(html), []);
});

test("the leftover failure names every key and the way to clear them", () => {
  const error = leftoverFixturesError([KEY_A, KEY_B]);
  assert.match(error.message, /left 2 live/);
  assert.ok(error.message.includes(KEY_A) && error.message.includes(KEY_B));
  assert.match(error.message, /\/admin\/events/);
});
