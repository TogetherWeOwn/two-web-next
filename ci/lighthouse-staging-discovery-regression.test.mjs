import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

// Failing-first regression coverage for the staging event-discovery skip
// (transient `Staging E2E ...` journey fixtures cancelled before Lighthouse
// navigates, then measured as a 410 with zero completed runs).
// Test files only: no source changes. Fixtures only, no network.
const require = createRequire(import.meta.url);
const lib = require("./lighthouse-origin-lib.cjs");

const APEX = "https://togetherweown.com";
const EVENT_PATH = "/e/01JAAAAAAAAAAAAAAAAAAAAAAA";
const FIXTURE_EVENT_PATH = "/e/01M4VZ3F94VQ8AS2PF3GJWHERC";

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes[new URL(url).pathname];
    const { status = 200, body = "" } = route ?? { status: 404 };
    return { status, text: async () => body };
  };
  return { calls, fetchImpl };
}

const rssItem = (link, title) =>
  `<item><title>${title}</title><link>${link}</link><guid isPermaLink="true">${link}</guid></item>`;

const rssWithTitles = (...items) =>
  `<?xml version="1.0"?><rss><channel><link>${APEX}/events</link>${items.join("")}</channel></rss>`;

test("discovery skips live staging fixtures by RSS title without requesting them", async () => {
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": {
      body: rssWithTitles(
        rssItem(`${APEX}${FIXTURE_EVENT_PATH}`, "Staging E2E RSVP 1760317553000"),
        rssItem(`${APEX}${EVENT_PATH}`, "Community game night"),
      ),
    },
    // The fixture is still live here (200): the title filter must skip it
    // before any liveness check, or the staging race reopens.
    [FIXTURE_EVENT_PATH]: { body: "<h1>Staging E2E RSVP 1760317553000</h1>" },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.ok(
    calls.every((call) => !call.url.endsWith(FIXTURE_EVENT_PATH)),
    "a staging fixture must never be requested, live or not",
  );
});

test("discovery skips stale-cache 410 candidates and keeps real coverage", async () => {
  const GONE_PATH = "/e/01JBBBBBBBBBBBBBBBBBBBBBBB";
  const { fetchImpl } = stubFetch({
    "/events.rss": {
      body: rssWithTitles(
        rssItem(`${APEX}${GONE_PATH}`, "Old meetup"),
        rssItem(`${APEX}${EVENT_PATH}`, "Community game night"),
      ),
    },
    // Cancelled after the feed was cached: the route answers 410, as
    // src/events/routes.tsx does for cancelled events.
    [GONE_PATH]: { status: 410, body: "<h1>Old meetup</h1>" },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
});

test("discovery skips when the feed lists only staging fixtures", async () => {
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": {
      body: rssWithTitles(
        rssItem(`${APEX}${FIXTURE_EVENT_PATH}`, "Staging E2E RSVP 1760317553000"),
      ),
    },
    "/events": { body: "<p>No events</p>" },
  });
  const skipped = await lib.discoverEventPath(APEX, fetchImpl);
  assert.equal(skipped.path, null);
  assert.match(skipped.reason, /no published event is listed/);
  assert.match(skipped.reason, /staging fixture/);
  assert.ok(
    calls.every((call) => !call.url.endsWith(FIXTURE_EVENT_PATH)),
    "a filtered fixture needs no verification request",
  );
});

test("real discoveries stay intact: the first stable published event is selected", async () => {
  const { fetchImpl } = stubFetch({
    "/events.rss": {
      body: rssWithTitles(rssItem(`${APEX}${EVENT_PATH}`, "Community game night")),
    },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
});
