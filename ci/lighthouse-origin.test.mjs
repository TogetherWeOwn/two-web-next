import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "./lighthouse-origin-run.mjs";
import { navigationMetadata } from "../test/lighthouse-navigation-fixtures.mjs";

// Offline selftest for the watch Lighthouse runner. No network and no browser:
// discovery runs against stub fetches and lhci against a stub launcher.
const require = createRequire(import.meta.url);
const lib = require("./lighthouse-origin-lib.cjs");
const base = require("./lighthouserc.cjs");

const STAGING = "https://next.togetherweown.com";
const APEX = "https://togetherweown.com";
const FIXTURE_PATH = "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_PATH = "/e/01JAAAAAAAAAAAAAAAAAAAAAAA";

test("the allowlist accepts exactly the three watch origins", () => {
  assert.deepEqual(lib.ALLOWED_ORIGINS, [STAGING, APEX, "https://www.togetherweown.com"]);
  for (const origin of lib.ALLOWED_ORIGINS) {
    assert.equal(lib.requireAllowedOrigin(origin), origin);
    assert.equal(lib.requireAllowedOrigin(`${origin}/`), origin);
  }
});

test("the allowlist rejects every other origin shape", () => {
  for (const bad of [
    undefined,
    null,
    42,
    "",
    "next.togetherweown.com",
    "http://next.togetherweown.com",
    "http://togetherweown.com",
    "https://togetherweown.com:443",
    "https://togetherweown.com:8443",
    "https://user@togetherweown.com",
    "https://user:pass@togetherweown.com",
    "https://togetherweown.com@evil.example",
    "https://togetherweown.com.evil.example",
    "https://evil.example/togetherweown.com",
    "https://evil.togetherweown.com",
    "https://api.togetherweown.com",
    "https://TogetherWeOwn.com",
    "https://togetherweown.com/events",
    "https://togetherweown.com//",
    "https://togetherweown.com?",
    "https://togetherweown.com/?x=1",
    "https://togetherweown.com#",
    "https://togetherweown.com/#top",
    " https://togetherweown.com",
    "https://togetherweown.com ",
    "http://127.0.0.1:8787",
    "https://localhost",
    "file:///etc/passwd",
  ]) {
    assert.throws(
      () => lib.requireAllowedOrigin(bad),
      /Lighthouse watch runs only against/,
      String(bad),
    );
  }
});

test("assertions and settings come from ci/lighthouserc.cjs unchanged", () => {
  for (const origin of lib.ALLOWED_ORIGINS) {
    const { ci } = lib.buildConfig({ origin, eventPath: EVENT_PATH });
    assert.deepEqual(ci.assert, base.ci.assert);
    assert.deepEqual(ci.upload, base.ci.upload);
    const { url: _origin, ...collect } = ci.collect;
    const { url: _fixture, ...fixtureCollect } = base.ci.collect;
    for (const key of lib.SERVER_KEYS) delete fixtureCollect[key];
    assert.deepEqual(collect, fixtureCollect);
    assert.deepEqual(Object.keys(ci).sort(), Object.keys(base.ci).sort());
  }
});

test("the fixture server is gone and the config shares nothing with the CI config", () => {
  const config = lib.buildConfig({ origin: STAGING, eventPath: EVENT_PATH });
  assert.ok("startServerCommand" in base.ci.collect, "the CI config still starts its fixture");
  for (const key of Object.keys(config.ci.collect)) assert.doesNotMatch(key, /^startServer/);
  assert.equal(config.ci.collect.startServerCommand, undefined);
  const before = structuredClone(base.ci);
  config.ci.assert.assertions["largest-contentful-paint"][1].maxNumericValue = 1e9;
  config.ci.collect.settings.throttling.rttMs = 0;
  assert.deepEqual(base.ci, before, "editing the clone must never reach ci/lighthouserc.cjs");
});

test("every measured URL is on the validated origin and the fixture event is replaced", () => {
  const fixture = base.ci.collect.url.map((entry) => new URL(entry).pathname);
  assert.ok(fixture.includes(FIXTURE_PATH));
  for (const origin of lib.ALLOWED_ORIGINS) {
    const { url } = lib.buildConfig({ origin, eventPath: EVENT_PATH }).ci.collect;
    assert.deepEqual(
      url,
      fixture.map((path) => `${origin}${path === FIXTURE_PATH ? EVENT_PATH : path}`),
    );
    for (const entry of url) assert.equal(new URL(entry).origin, origin);
    assert.ok(!url.some((entry) => entry.includes("01ARZ3NDEKTSV4RRFFQ69G5FAV")));
  }
});

test("with no discovered event the event route is dropped, not faked", () => {
  const { url } = lib.buildConfig({ origin: APEX }).ci.collect;
  assert.equal(url.length, base.ci.collect.url.length - 1);
  assert.ok(url.every((entry) => !/\/e\//.test(entry)));
});

test("a malformed event path or origin cannot reach the config", () => {
  for (const eventPath of [
    "/admin",
    "/e/",
    "/e/../admin",
    "/e/a/b",
    "/e/a?x=1",
    "https://evil.example/e/a",
  ]) {
    assert.throws(() => lib.buildConfig({ origin: STAGING, eventPath }), /event path/);
  }
  assert.throws(
    () => lib.buildConfig({ origin: "https://evil.example" }),
    /Lighthouse watch runs only/,
  );
  assert.throws(() => lib.buildConfig(), /Lighthouse watch runs only/);
});

function loadLhciConfig(env) {
  const run = spawnSync(
    process.execPath,
    ["-e", 'process.stdout.write(JSON.stringify(require("./ci/lighthouse-origin.cjs")))'],
    {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    },
  );
  return run;
}

test("ci/lighthouse-origin.cjs is the lhci config the runner hands over via env", () => {
  const ok = loadLhciConfig({ LIGHTHOUSE_ORIGIN: APEX, LIGHTHOUSE_EVENT_PATH: EVENT_PATH });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), lib.buildConfig({ origin: APEX, eventPath: EVENT_PATH }));

  const noEvent = loadLhciConfig({ LIGHTHOUSE_ORIGIN: APEX, LIGHTHOUSE_EVENT_PATH: "" });
  assert.equal(noEvent.status, 0, noEvent.stderr);
  assert.deepEqual(JSON.parse(noEvent.stdout), lib.buildConfig({ origin: APEX }));

  for (const env of [
    {},
    { LIGHTHOUSE_ORIGIN: "http://127.0.0.1:8787" },
    { LIGHTHOUSE_ORIGIN: "https://evil.example" },
  ]) {
    const refused = loadLhciConfig(env);
    assert.notEqual(refused.status, 0, JSON.stringify(env));
    assert.match(refused.stderr, /Lighthouse watch runs only against/);
  }
});

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const entry = routes[new URL(url).pathname];
    // An array replays one response per request (transient statuses), then
    // sticks on the last entry; a plain object answers every request alike.
    const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    const { status = 200, body = "", headers } = route ?? { status: 404 };
    return { status, headers, text: async () => body };
  };
  return { calls, fetchImpl };
}

// Discovery never sleeps for real in tests: the recorded delays pin the
// backoff (Retry-After honored, exponential fallback) without waiting.
function recordSleeps(sleeps) {
  return { sleepImpl: async (ms) => void sleeps.push(ms) };
}

const rss = (...links) =>
  `<?xml version="1.0"?><rss><channel><link>${APEX}/events</link>${links
    .map((link) => `<item><link>${link}</link></item>`)
    .join("")}</channel></rss>`;

// Regression: the staging-journeys job publishes transient fixtures
// titled `Staging E2E ...` and cancels them in `finally`. One staging-quality
// run discovered such a fixture live in /events.rss and Lighthouse
// then measured a 410 (ERRORED_DOCUMENT_REQUEST, 0 runs). The
// feed carries per-item titles, so discovery can isolate fixtures without any
// extra request or any change to the 300-second RSS cache contract.
const rssItem = (link, title) =>
  `<item><title>${title}</title><link>${link}</link><guid isPermaLink="true">${link}</guid></item>`;

const rssWithTitles = (...items) =>
  `<?xml version="1.0"?><rss><channel><link>${APEX}/events</link>${items.join("")}</channel></rss>`;

const FIXTURE_EVENT_PATH = "/e/01M4VZ3F94VQ8AS2PF3GJWHERC";

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

// Regression: cancelled events keep their feed row with a `Cancelled: `
// title prefix (src/events/feeds.ts RSS_CANCELLED_TITLE_PREFIX), so a
// cancelled staging fixture reads `Cancelled: Staging E2E ...`. The bare
// fixture prefix missed those rows and every stale one became a
// verification GET until the origin throttled discovery with a 429.
// Cancelled fixtures are filtered by title before any request, like live
// fixtures; the 429 retry stays for genuinely transient throttles.
test("discovery skips cancelled staging fixtures by RSS title without requesting them", async () => {
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": {
      body: rssWithTitles(
        rssItem(`${APEX}${FIXTURE_EVENT_PATH}`, "Cancelled: Staging E2E RSVP 1760317553000"),
        rssItem(`${APEX}${EVENT_PATH}`, "Community game night"),
      ),
    },
    // The cancelled fixture page is gone (410): the title filter must skip
    // it before any liveness check, or every stale row costs a request.
    [FIXTURE_EVENT_PATH]: { status: 410, body: "<h1>Old fixture</h1>" },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.ok(
    calls.every((call) => !call.url.endsWith(FIXTURE_EVENT_PATH)),
    "a cancelled staging fixture must never be requested",
  );
});

test("discovery still verifies a genuinely cancelled event instead of title-filtering it", async () => {
  const CANCELLED_PATH = "/e/01JGGGGGGGGGGGGGGGGGGGGGGG";
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": {
      body: rssWithTitles(
        rssItem(`${APEX}${CANCELLED_PATH}`, "Cancelled: Community game night"),
        rssItem(`${APEX}${EVENT_PATH}`, "Spring tournament"),
      ),
    },
    // A real cancelled listing is not a fixture: it is verified live once,
    // tolerated as gone, and never counted as a fixture.
    [CANCELLED_PATH]: { status: 410, body: "<h1>Old meetup</h1>" },
    [EVENT_PATH]: { body: "<h1>Spring tournament</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.equal(
    calls.filter((call) => call.url.endsWith(CANCELLED_PATH)).length,
    1,
    "a genuine cancelled listing is verified once, then skipped as gone",
  );
});

test("discovery skips stale-cache 410 candidates and keeps real coverage", async () => {
  const GONE_PATH = "/e/01JBBBBBBBBBBBBBBBBBBBBBBB";
  const { fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${GONE_PATH}`, `${APEX}${EVENT_PATH}`) },
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

test("discovery skips 404 candidates and keeps real coverage", async () => {
  const GONE_PATH = "/e/01JCCCCCCCCCCCCCCCCCCCCCCC";
  const { fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${GONE_PATH}`, `${APEX}${EVENT_PATH}`) },
    // Unknown after the feed was cached: the route answers 404.
    [GONE_PATH]: { status: 404, body: "<h1>Missing meetup</h1>" },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
});

test("discovery fails closed on unhealthy candidate statuses", async () => {
  // 429 retries first; exhaustion must still fail if no alternate event verifies.
  for (const status of [500, 301]) {
    const { fetchImpl } = stubFetch({
      "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`) },
      [EVENT_PATH]: { status, body: "<h1>Community game night</h1>" },
    });
    await assert.rejects(
      () => lib.discoverEventPath(APEX, fetchImpl),
      new RegExp(`returned ${status}.*expected 200`),
      `status ${status} must throw, never measure`,
    );
  }
});

// Regression: four consecutive e2e-staging runs failed the mobile step in
// event discovery with `GET https://next.togetherweown.com/e/<key> returned
// 429` while the origin was healthy (same-SHA green-to-red). Discovery now
// retries a transient 429 with backoff honoring Retry-After instead of
// treating one throttled candidate as a dead origin.
test("discovery retries a transient 429 on candidate verification and recovers", async () => {
  const sleeps = [];
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`) },
    [EVENT_PATH]: [{ status: 429 }, { body: "<h1>Community game night</h1>" }],
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl, recordSleeps(sleeps)), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.equal(
    calls.filter((call) => call.url.endsWith(EVENT_PATH)).length,
    2,
    "one retry after the 429, then the 200 verifies",
  );
  assert.deepEqual(sleeps, [1000], "no Retry-After header: the 1s base backoff applies");
});

test("discovery honors Retry-After on 429 and skips a persistently throttled candidate", async () => {
  const THROTTLED_PATH = "/e/01JEEEEEEEEEEEEEEEEEEEEEEE";
  const sleeps = [];
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${THROTTLED_PATH}`, `${APEX}${EVENT_PATH}`) },
    [THROTTLED_PATH]: { status: 429, headers: { "retry-after": "2" } },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl, recordSleeps(sleeps)), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.deepEqual(sleeps, [2000, 2000, 2000], "each retry waits out the Retry-After window");
  assert.equal(
    calls.filter((call) => call.url.endsWith(THROTTLED_PATH)).length,
    lib.DISCOVERY_THROTTLE_RETRIES + 1,
    "the throttled candidate gets its bounded retries, then the next listing wins",
  );
});

test("an unparseable Retry-After falls back to exponential backoff", async () => {
  const THROTTLED_PATH = "/e/01JFFFFFFFFFFFFFFFFFFFFFFF";
  const sleeps = [];
  const { fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${THROTTLED_PATH}`, `${APEX}${EVENT_PATH}`) },
    [THROTTLED_PATH]: { status: 429, headers: { "retry-after": "soon" } },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl, recordSleeps(sleeps)), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("discovery fails, rather than skipping coverage, when every candidate is throttled", async () => {
  const sleeps = [];
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`) },
    [EVENT_PATH]: { status: 429 },
    // The listing still links the same throttled path: it must not be
    // re-requested or counted twice.
    "/events": { body: `<a href="${EVENT_PATH}">Community game night</a>` },
  });
  await assert.rejects(
    () => lib.discoverEventPath(APEX, fetchImpl, recordSleeps(sleeps)),
    (error) => {
      assert.equal(error.code, "DISCOVERY_THROTTLED");
      assert.match(error.message, /incomplete/);
      assert.match(error.message, /1 throttled \(429\) candidate\(s\)/);
      return true;
    },
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith(EVENT_PATH)).length,
    lib.DISCOVERY_THROTTLE_RETRIES + 1,
    "a throttled candidate is retried to its bound once, never twice",
  );
});

test("discovery retries a transient 429 on the feed and recovers", async () => {
  const sleeps = [];
  const { fetchImpl } = stubFetch({
    "/events.rss": [
      { status: 429, headers: new Map([["retry-after", "1"]]) },
      { body: rss(`${APEX}${EVENT_PATH}`) },
    ],
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl, recordSleeps(sleeps)), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.deepEqual(sleeps, [1000]);
});

test("a throttled feed falls through, but incomplete discovery never becomes a skip", async () => {
  const listed = stubFetch({
    "/events.rss": { status: 429 },
    "/events": { body: `<a href="${EVENT_PATH}">Community game night</a>` },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(
    await lib.discoverEventPath(APEX, listed.fetchImpl, recordSleeps([])),
    { path: EVENT_PATH, source: "/events" },
    "a throttled RSS feed must not hide a healthy /events listing",
  );
  assert.equal(listed.calls.filter((call) => call.url.endsWith("/events.rss")).length, 4);
  const both = stubFetch({ "/events.rss": { status: 429 }, "/events": { status: 429 } });
  const sleeps = [];
  await assert.rejects(
    () => lib.discoverEventPath(APEX, both.fetchImpl, recordSleeps(sleeps)),
    (error) => {
      assert.equal(error.code, "DISCOVERY_THROTTLED");
      assert.match(error.message, /incomplete/);
      assert.match(error.message, /\/events\.rss throttled \(429 after retries\)/);
      assert.match(error.message, /\/events throttled \(429 after retries\)/);
      return true;
    },
  );
  for (const path of ["/events.rss", "/events"]) {
    assert.equal(both.calls.filter((call) => new URL(call.url).pathname === path).length, 4);
  }
  assert.deepEqual(sleeps, [1000, 2000, 4000, 1000, 2000, 4000]);
});

test("Retry-After date and numeric boundaries use the fixed clock and ten-second cap", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-25T09:00:00Z"));
  for (const [header, expected] of [
    ["Sun, 25 Oct 2026 09:00:07 GMT", 7000],
    ["Sun, 25 Oct 2026 08:59:59 GMT", 0],
    ["Sun, 25 Oct 2026 09:01:00 GMT", 10000],
    ["0", 0],
    ["10", 10000],
    ["11", 10000],
    ["60", 10000],
    ["9999999999999999999999999999999999999999", 10000],
    [" 2 ", 2000],
  ]) {
    const sleeps = [];
    const { fetchImpl } = stubFetch({
      "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`) },
      [EVENT_PATH]: [
        { status: 429, headers: new Headers({ "retry-after": header }) },
        { body: "<h1>Community game night</h1>" },
      ],
    });
    assert.equal(
      (await lib.discoverEventPath(APEX, fetchImpl, recordSleeps(sleeps))).path,
      EVENT_PATH,
    );
    assert.deepEqual(sleeps, [expected], header);
  }
  for (const header of ["soon", "not-a-date", "?"]) {
    const sleeps = [];
    const { fetchImpl } = stubFetch({
      "/events.rss": [
        { status: 429, headers: { "retry-after": header } },
        { status: 429, headers: { "retry-after": header } },
        { status: 429, headers: { "retry-after": header } },
        { body: rss(`${APEX}${EVENT_PATH}`) },
      ],
      [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
    });
    assert.equal(
      (await lib.discoverEventPath(APEX, fetchImpl, recordSleeps(sleeps))).path,
      EVENT_PATH,
    );
    assert.deepEqual(sleeps, [1000, 2000, 4000], header);
  }
});

test("discovery shares one elapsed-time budget across all candidates", async () => {
  const paths = Array.from({ length: 100 }, (_, i) => `/e/community-${i}`);
  const sleeps = [];
  let now = 0;
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss(...paths.map((path) => `${APEX}${path}`)) },
    "/events": { body: "" },
    ...Object.fromEntries(
      paths.map((path) => [path, { status: 429, headers: { "retry-after": "10" } }]),
    ),
  });
  await assert.rejects(
    () =>
      lib.discoverEventPath(APEX, fetchImpl, {
        nowImpl: () => now,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      }),
    { code: "DISCOVERY_BUDGET_EXHAUSTED" },
  );
  assert.ok(now <= 60000, `elapsed ${now} exceeds one minute`);
  assert.ok(calls.length <= 24, `requests ${calls.length} exceed total cap`);
  assert.ok(sleeps.length > 0, "the deadline did not bypass retry recovery");
});

test("discovery shares one request budget across both sources even with no sleeps", async () => {
  const paths = Array.from({ length: 100 }, (_, i) => `/e/stale-${i}`);
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss(...paths.slice(0, 10).map((path) => `${APEX}${path}`)) },
    "/events": {
      body: paths
        .slice(10)
        .map((path) => `<a href="${path}">Old meetup</a>`)
        .join(""),
    },
    ...Object.fromEntries(paths.map((path) => [path, { status: 410 }])),
  });
  await assert.rejects(
    () =>
      lib.discoverEventPath(APEX, fetchImpl, {
        nowImpl: () => 0,
        ...recordSleeps([]),
      }),
    { code: "DISCOVERY_BUDGET_EXHAUSTED" },
  );
  assert.equal(calls.length, 24);
  assert.ok(calls.some((call) => new URL(call.url).pathname === "/events"));
});

test("a slow response cannot overrun the shared deadline and select an event", async () => {
  let now = 0;
  const calls = [];
  await assert.rejects(
    () =>
      lib.discoverEventPath(
        APEX,
        async (url, init) => {
          calls.push({ url, init });
          now += 35000;
          return { status: 200, text: async () => rss(`${APEX}${EVENT_PATH}`) };
        },
        { nowImpl: () => now },
      ),
    { code: "DISCOVERY_BUDGET_EXHAUSTED" },
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ init }) => init.signal instanceof AbortSignal));
});

// Native AbortSignal.timeout does not use node:test's mocked timers. Keep real
// AbortSignals, but schedule their aborts on the controlled timer queue.
async function withDiscoveryClock(t, elapsedBeforeRequest, run) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = elapsedBeforeRequest;
  let initialSample = true;
  const timeouts = [];
  const pending = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Discovery request timed out", "TimeoutError"));
    }, ms);
    timeouts.push({ ms, controller, timer });
    return controller.signal;
  });
  const clock = {
    timeouts,
    advance(ms) {
      now += ms;
      t.mock.timers.tick(ms);
    },
    start(fetchImpl) {
      const result = { settled: false };
      const done = lib
        .discoverEventPath(APEX, fetchImpl, {
          // The first sample starts the budget; later samples include a scheduler
          // delay before the first GET, without stalling an already-timed request.
          nowImpl: () => {
            if (initialSample) {
              initialSample = false;
              return 0;
            }
            return now;
          },
        })
        .then(
          (value) => Object.assign(result, { settled: true, value }),
          (error) => Object.assign(result, { settled: true, error }),
        );
      pending.push(done);
      return { result, done };
    },
  };
  try {
    await run(clock);
  } finally {
    now = 60000;
    for (const { controller, timer } of timeouts) {
      clearTimeout(timer);
      controller.abort(new DOMException("Test cleanup", "AbortError"));
    }
    await Promise.all(pending);
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
}

for (const phase of ["fetch", "body"]) {
  test(`discovery aborts pending ${phase} with only 1000ms remaining`, async (t) => {
    await withDiscoveryClock(t, 58000, async (clock) => {
      const entered = Promise.withResolvers();
      const calls = [];
      let suppliedSignal;
      let aborted = false;
      const { result, done } = clock.start(async (url, { signal }) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path === "/events.rss") {
          return {
            status: 200,
            text: async () => {
              clock.advance(1000);
              return rss(`${APEX}${EVENT_PATH}`);
            },
          };
        }
        assert.equal(path, EVENT_PATH);
        suppliedSignal = signal;
        if (phase === "fetch") {
          return new Promise((_resolve, reject) => {
            const abort = () => {
              aborted = true;
              reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
            entered.resolve();
            if (signal.aborted) abort();
          });
        }
        return new Response(
          new ReadableStream(
            {
              start(controller) {
                const abort = () => {
                  aborted = true;
                  controller.error(signal.reason);
                };
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
              },
              pull() {
                // With no prefetch, pull proves text() is awaiting body bytes.
                entered.resolve();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200 },
        );
      });
      await entered.promise;
      assert.equal(suppliedSignal.aborted, false);
      assert.equal(result.settled, false);
      clock.advance(999);
      assert.equal(suppliedSignal.aborted, false);
      assert.equal(result.settled, false);
      clock.advance(1);
      assert.equal(aborted, true, `the supplied signal must interrupt pending ${phase}`);
      assert.equal(suppliedSignal.reason.name, "TimeoutError");
      await done;
      if (phase === "body") assert.equal(result.error, suppliedSignal.reason);
      else assert.equal(result.error?.code, "DISCOVERY_BUDGET_EXHAUSTED");
      assert.deepEqual(
        clock.timeouts.map(({ ms }) => ms),
        [2000, 1000],
      );
      assert.equal(result.value, undefined, "an aborted request cannot select an event");
      assert.deepEqual(calls, ["/events.rss", EVENT_PATH], "no fallback GET after expiry");
    });
  });
}

for (const [remaining, timeout] of [
  [60000, 15000],
  [15000, 15000],
  [14999.25, 15000],
  [1000, 1000],
  [1.25, 2],
  [0.25, 1],
]) {
  test(`discovery caps and rounds the request timeout with ${remaining}ms remaining`, async (t) => {
    await withDiscoveryClock(t, 60000 - remaining, async (clock) => {
      const calls = [];
      const { result, done } = clock.start(async (url, { signal }) => {
        calls.push(new URL(url).pathname);
        assert.equal(signal.aborted, false);
        return {
          status: 200,
          text: async () => rss(`${APEX}${EVENT_PATH}`),
        };
      });
      await done;
      assert.equal(result.error, undefined);
      assert.deepEqual(result.value, { path: EVENT_PATH, source: "/events.rss" });
      assert.deepEqual(calls, ["/events.rss", EVENT_PATH]);
      assert.deepEqual(
        clock.timeouts.map(({ ms }) => ms),
        [timeout, timeout],
      );
    });
  });
}

for (const elapsed of [60000, 60000.25]) {
  test(`discovery makes no GET when the first request starts at ${elapsed}ms`, async (t) => {
    await withDiscoveryClock(t, elapsed, async (clock) => {
      let requests = 0;
      const { result, done } = clock.start(async () => {
        requests += 1;
        return { status: 200, text: async () => rss(`${APEX}${EVENT_PATH}`) };
      });
      await done;
      assert.equal(result.error?.code, "DISCOVERY_BUDGET_EXHAUSTED");
      assert.equal(requests, 0);
      assert.equal(clock.timeouts.length, 0);
    });
  });
}

for (const elapsed of [60000, 60000.25]) {
  test(`discovery rejects an event whose body finishes at ${elapsed}ms`, async (t) => {
    await withDiscoveryClock(t, 59000, async (clock) => {
      const calls = [];
      let bodyCompleted = false;
      const { result, done } = clock.start(async (url) => {
        const path = new URL(url).pathname;
        calls.push(path);
        return {
          status: 200,
          text: async () => {
            if (path === EVENT_PATH) {
              // EOF wins the promise race, but its continuation resumes too late.
              clock.advance(elapsed - 59000);
              bodyCompleted = true;
              return "<h1>Community game night</h1>";
            }
            return rss(`${APEX}${EVENT_PATH}`);
          },
        };
      });
      await done;
      assert.equal(bodyCompleted, true);
      assert.equal(result.error?.code, "DISCOVERY_BUDGET_EXHAUSTED");
      assert.equal(result.value, undefined, "a completed body does not override the deadline");
      assert.deepEqual(calls, ["/events.rss", EVENT_PATH]);
    });
  });
}

test("the runner rejects persistent candidate or feed throttling before launching Lighthouse", async () => {
  for (const routes of [
    {
      "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`) },
      [EVENT_PATH]: { status: 429 },
      "/events": { body: `<a href="${EVENT_PATH}">Community game night</a>` },
    },
    { "/events.rss": { status: 429 }, "/events": { status: 429 } },
    { "/events.rss": { status: 429 }, "/events": { body: "" } },
  ]) {
    await withDir(async (dir) => {
      const { fetchImpl } = stubFetch(routes);
      let launched = 0;
      const code = await main([APEX], {
        fetchImpl,
        dir,
        log: () => {},
        discoveryOptions: recordSleeps([]),
        lhci: async (env) => {
          launched += 1;
          let n = 0;
          for (const path of lib.plannedPaths(env.LIGHTHOUSE_EVENT_PATH || undefined)) {
            for (let run = 0; run < base.ci.collect.numberOfRuns; run += 1) {
              await writeFile(
                join(dir, `lhr-${n++}.json`),
                JSON.stringify(lhr(path, [1000, 0, 100, 10, 800])),
              );
            }
          }
          await writeFile(join(dir, "assertion-results.json"), "[]");
          return { exitCode: 0, output: "" };
        },
      });
      assert.equal(code, 1);
      assert.equal(
        launched,
        0,
        "throttled evidence must not be replaced with a reduced route plan",
      );
      const summary = await readFile(join(dir, "watch-summary.md"), "utf8");
      assert.match(summary, /Event discovery failed.*incomplete.*throttled/);
      assert.doesNotMatch(summary, /Event route skipped/);
    });
  }
});

test("each exhausted 429 body is released before retrying or selecting an alternate", async () => {
  let cancelled = 0;
  let requests = 0;
  let sleeps = 0;
  const found = await lib.discoverEventPath(
    APEX,
    async (url) => {
      const path = new URL(url).pathname;
      requests += 1;
      if (path === "/events.rss" || path === "/e/throttled") {
        return {
          status: 429,
          body: {
            cancel: async () => {
              cancelled += 1;
            },
          },
        };
      }
      if (path === "/events")
        return {
          status: 200,
          text: async () => '<a href="/e/throttled">Throttled</a><a href="/e/healthy">Healthy</a>',
        };
      assert.equal(cancelled, 8);
      return { status: 200, text: async () => "<h1>Healthy</h1>" };
    },
    {
      sleepImpl: async () => {
        sleeps += 1;
        assert.equal(cancelled, requests - 1 + (sleeps <= 3 ? 1 : 0));
      },
    },
  );
  assert.equal(found.path, "/e/healthy");
  assert.equal(cancelled, 8);
  assert.equal(sleeps, 6);
});

test("discovery reports cancelled listings when only stale candidates remain", async () => {
  const GONE_PATH = "/e/01JDDDDDDDDDDDDDDDDDDDDDDD";
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${GONE_PATH}`) },
    [GONE_PATH]: { status: 410, body: "<h1>Old meetup</h1>" },
    // The listing still links the same stale path: it must not be
    // re-requested or counted twice.
    "/events": { body: `<a href="${GONE_PATH}">Old meetup</a>` },
  });
  const skipped = await lib.discoverEventPath(APEX, fetchImpl);
  assert.equal(skipped.path, null);
  assert.match(skipped.reason, /no published event is listed/);
  assert.match(skipped.reason, /1 cancelled\/stale listing\(s\)/);
  assert.equal(
    calls.filter((call) => call.url.endsWith(GONE_PATH)).length,
    1,
    "a stale candidate is verified once, never twice",
  );
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

test("discovery never re-requests a title-filtered fixture in the /events fallback", async () => {
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": {
      body: rssWithTitles(
        rssItem(`${APEX}${FIXTURE_EVENT_PATH}`, "Staging E2E RSVP 1760317553000"),
      ),
    },
    // The listing links the same fixture path, as the calendar card renders.
    // It is already rejected by title, so the fallback must skip it unseen.
    "/events": { body: `<a href="${FIXTURE_EVENT_PATH}">Staging E2E RSVP</a>` },
    [FIXTURE_EVENT_PATH]: {
      body: '<h1 data-waitlist-position="">Staging E2E RSVP 1760317553000</h1>',
    },
  });
  const skipped = await lib.discoverEventPath(APEX, fetchImpl);
  assert.equal(skipped.path, null);
  assert.match(skipped.reason, /1 staging fixture\(s\)/);
  assert.equal(
    calls.filter((call) => call.url.endsWith(FIXTURE_EVENT_PATH)).length,
    0,
    "a title-filtered fixture must never be requested, in either pass",
  );
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/events.rss", "/events"],
  );
});

test("discovery still filters an /events-only fixture by page content", async () => {
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss() },
    "/events": { body: `<a href="${FIXTURE_EVENT_PATH}">Staging E2E RSVP</a>` },
    [FIXTURE_EVENT_PATH]: {
      body: '<h1 data-waitlist-position="">Staging E2E RSVP 1760317553000</h1>',
    },
  });
  const skipped = await lib.discoverEventPath(APEX, fetchImpl);
  assert.equal(skipped.path, null);
  assert.match(skipped.reason, /1 staging fixture\(s\)/);
  assert.equal(
    calls.filter((call) => call.url.endsWith(FIXTURE_EVENT_PATH)).length,
    1,
    "an /events-only fixture is verified once, then skipped by its heading",
  );
});

test("a measured event route with no completed run still fails closed", async () => {
  const rows = lib.summarizeRoutes({
    origin: APEX,
    eventPath: EVENT_PATH,
    lhrs: [lhr("/", [1000, 0, 100, 10, 800])],
    assertions: [],
  });
  const event = rows.find((row) => row.path === EVENT_PATH);
  assert.equal(event.verdict, "fail");
  assert.equal(event.runs, 0);
  assert.match(event.note, /no Lighthouse run completed/);
});

test("discovery is GET-only and reads the first published event from the RSS feed", async () => {
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`, `${APEX}/e/01JBBBBBBBBBBBBBBBBBBBBBBB`) },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  // The first stable candidate is verified live before selection,
  // so a feed entry cached before a cancel is never measured.
  assert.deepEqual(
    calls.map((call) => [call.init.method, call.url, call.init.body, call.init.redirect]),
    [
      ["GET", `${APEX}/events.rss`, undefined, "manual"],
      ["GET", `${APEX}${EVENT_PATH}`, undefined, "manual"],
    ],
  );
});

test("discovery falls back to the /events list, then reports a skip with its reason", async () => {
  const listed = stubFetch({
    "/events.rss": { body: rss() },
    "/events": {
      body: `<a href="/e/seed-calendar-07">Seed</a><a href="/e/${EVENT_PATH.slice(3)}">x</a>`,
    },
    "/e/seed-calendar-07": { body: "<h1>Seed demo night</h1>" },
  });
  assert.deepEqual(await lib.discoverEventPath(STAGING, listed.fetchImpl), {
    path: "/e/seed-calendar-07",
    source: "/events",
  });
  assert.ok(listed.calls.every((call) => call.init.method === "GET"));

  const empty = stubFetch({
    "/events.rss": { body: rss() },
    "/events": { body: "<p>No events</p>" },
  });
  const skipped = await lib.discoverEventPath(STAGING, empty.fetchImpl);
  assert.equal(skipped.path, null);
  assert.match(skipped.reason, /no published event is listed/);
});

test("discovery ignores links that are not event pages and never leaves the origin", async () => {
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": {
      body: rss(
        `${APEX}/admin`,
        `${APEX}/e/../admin`,
        "https://evil.example/events/x",
        "not a url",
        `https://elsewhere.example${EVENT_PATH}`,
      ),
    },
    [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
  });
  // Only the pathname is kept: the host of a feed link is never visited.
  assert.deepEqual(await lib.discoverEventPath(STAGING, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.ok(calls.every((call) => call.url.startsWith(`${STAGING}/`)));
});

test("an origin that errors, redirects or is not allowlisted fails discovery instead of skipping", async () => {
  for (const status of [301, 302, 404, 500, 503]) {
    const { fetchImpl } = stubFetch({ "/events.rss": { status } });
    await assert.rejects(
      () => lib.discoverEventPath(APEX, fetchImpl),
      new RegExp(`returned ${status}`),
    );
  }
  const second = stubFetch({ "/events.rss": { body: rss() }, "/events": { status: 502 } });
  await assert.rejects(() => lib.discoverEventPath(APEX, second.fetchImpl), /returned 502/);
  const never = stubFetch({});
  await assert.rejects(
    () => lib.discoverEventPath("https://evil.example", never.fetchImpl),
    /runs only against/,
  );
  assert.equal(never.calls.length, 0, "a refused origin is never contacted");
});

const lhr = (path, values, finalPath = path) => ({
  ...navigationMetadata("mobile"),
  requestedUrl: `${APEX}${path}`,
  finalUrl: `${APEX}${finalPath}`,
  categories: { performance: { score: 1 } },
  audits: {
    "largest-contentful-paint": { numericValue: values[0] },
    "cumulative-layout-shift": { numericValue: values[1] },
    "server-response-time": { numericValue: values[2] },
    "total-blocking-time": { numericValue: values[3] },
    "first-contentful-paint": { numericValue: values[4] },
  },
});

test("per-route verdicts: pass, warn, fail, missing run and skipped event", () => {
  const paths = lib.plannedPaths(undefined);
  const lhrs = [];
  for (const path of paths.filter((entry) => entry !== "/about")) {
    for (const lcp of [1000, 1200, 1100]) lhrs.push(lhr(path, [lcp, 0, 100, 50, 900]));
  }
  const assertions = [
    {
      url: `${APEX}/events`,
      auditId: "largest-contentful-paint",
      level: "error",
      actual: 2500,
      expected: 2000,
    },
    {
      url: `${APEX}/join`,
      auditId: "total-blocking-time",
      level: "warn",
      actual: 400,
      expected: 300,
    },
  ];
  const rows = lib.summarizeRoutes({
    origin: APEX,
    eventPath: undefined,
    skipReason: "no published event is listed in /events.rss or /events",
    lhrs,
    assertions,
  });
  const verdicts = Object.fromEntries(rows.map((row) => [row.path, row.verdict]));
  assert.deepEqual(verdicts, {
    "/": "pass",
    "/events": "fail",
    "/join": "warn",
    "/about": "fail",
    "/faq": "pass",
    "/rules": "pass",
    "/privacy": "pass",
    "/e/<key>": "skipped",
  });
  assert.equal(rows.find((row) => row.path === "/").medians["largest-contentful-paint"], 1100);
  assert.match(rows.find((row) => row.path === "/about").note, /no Lighthouse run completed/);
  assert.match(rows.find((row) => row.path === "/e/<key>").note, /no published event is listed/);
  const text = lib.renderSummary({ origin: APEX, eventPath: undefined, rows });
  assert.match(text, /\| \/events \| fail \| 3 \|/);
  assert.match(text, /largest-contentful-paint error 2500 > 2000/);
});

test("assertions are attributed through a redirect and the redirect is noted", () => {
  const rows = lib.summarizeRoutes({
    origin: APEX,
    eventPath: EVENT_PATH,
    lhrs: [lhr("/events", [900, 0, 90, 10, 800], "/events/")],
    assertions: [
      {
        url: `${APEX}/events/`,
        auditId: "server-response-time",
        level: "error",
        actual: 900,
        expected: 600,
      },
    ],
  });
  const events = rows.find((row) => row.path === "/events");
  assert.equal(events.verdict, "fail");
  assert.match(events.note, /redirected to .*\/events\//);
});

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "lh-origin-"));
  try {
    return await run(join(dir, ".lighthouseci"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the runner refuses bad arguments and origins before any network or lhci call", async () => {
  const { calls, fetchImpl } = stubFetch({});
  let launched = 0;
  const lhci = async () => ++launched;
  for (const argv of [
    [],
    ["a", "b"],
    ["http://127.0.0.1:8787"],
    ["https://evil.example"],
    ["https://togetherweown.com/events"],
  ]) {
    assert.equal(await main(argv, { fetchImpl, lhci, log: () => {} }), 2, JSON.stringify(argv));
  }
  assert.equal(calls.length, 0);
  assert.equal(launched, 0);
});

test("a skipped event route is recorded in the output and the run still measures the rest", async () => {
  await withDir(async (dir) => {
    const { fetchImpl } = stubFetch({ "/events.rss": { body: rss() }, "/events": { body: "" } });
    const lines = [];
    let seenEnv;
    const lhci = async (env) => {
      seenEnv = env;
      const paths = lib.plannedPaths(undefined);
      const { writeFile } = await import("node:fs/promises");
      let n = 0;
      for (const path of paths) {
        for (let run = 0; run < 3; run++) {
          await writeFile(
            join(dir, `lhr-${n++}.json`),
            JSON.stringify(lhr(path, [1000, 0, 100, 10, 800])),
          );
        }
      }
      await writeFile(join(dir, "assertion-results.json"), "[]");
      return { exitCode: 0, output: "" };
    };
    const code = await main([APEX], {
      env: { PATH: "x" },
      fetchImpl,
      lhci,
      dir,
      log: (l) => lines.push(l),
    });
    assert.equal(code, 0);
    assert.equal(seenEnv.LIGHTHOUSE_ORIGIN, APEX);
    assert.equal(seenEnv.LIGHTHOUSE_EVENT_PATH, "");
    assert.match(lines.join("\n"), /Event route skipped: no published event is listed/);
    const summary = await readFile(join(dir, "watch-summary.md"), "utf8");
    assert.match(summary, /\| \/e\/<key> \| skipped \| 0 \|/);
    const json = JSON.parse(await readFile(join(dir, "watch-summary.json"), "utf8"));
    assert.equal(json.eventPath, null);
    assert.match(json.skipReason, /no published event/);
    assert.ok(json.rows.filter((row) => row.verdict === "pass").length >= 4);
  });
});

test("failures are never a pass: a budget error, a crashed run and a dead origin all exit 1", async () => {
  await withDir(async (dir) => {
    const { fetchImpl } = stubFetch({
      "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`) },
      [EVENT_PATH]: { body: "<h1>Community game night</h1>" },
    });
    const crashed = await main([APEX], {
      fetchImpl,
      lhci: async () => ({ exitCode: 1, output: "boom" }),
      dir,
      log: () => {},
    });
    assert.equal(crashed, 1, "lhci exit code is propagated");
    const noRuns = await main([APEX], {
      fetchImpl,
      lhci: async () => ({ exitCode: 0, output: "" }),
      dir,
      log: () => {},
    });
    assert.equal(noRuns, 1, "a clean exit without any lhr result is not a pass");
    const down = stubFetch({ "/events.rss": { status: 503 } });
    let launched = false;
    const lines = [];
    const dead = await main([APEX], {
      fetchImpl: down.fetchImpl,
      lhci: async () => {
        launched = true;
        return { exitCode: 0, output: "" };
      },
      dir,
      log: (l) => lines.push(l),
    });
    assert.equal(dead, 1);
    assert.equal(launched, false);
    assert.match(lines.join("\n"), /Event discovery failed, origin not healthy: .*503/);
    assert.deepEqual(
      (await readdir(dir)).sort(),
      ["origin-collect.log", "watch-summary.md"],
      "a failure summary and the collect log are still left for the artifact",
    );
  });
});

test("the tooling issues GET requests only", async () => {
  for (const file of [
    "lighthouse-origin-lib.cjs",
    "lighthouse-origin-run.mjs",
    "lighthouse-origin.cjs",
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /method:\s*["'`](?!GET["'`])/i, `${file} sets a non-GET method`);
    assert.doesNotMatch(source, /\b(?:POST|PUT|PATCH|DELETE)\b/, `${file} mentions a write verb`);
    assert.doesNotMatch(source, /\bbody:/, `${file} sends a body`);
    assert.doesNotMatch(
      source,
      /\b(?:authorization|cookie|secrets?\.)/i,
      `${file} handles credentials`,
    );
  }
});

test("package.json wires the command and its selftest", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(scripts["lighthouse:origin"], "node ci/lighthouse-origin-run.mjs");
  assert.equal(
    scripts["lighthouse:origin:selftest"],
    "node --test ci/lighthouse-origin.test.mjs && node ci/lighthouse-origin-run.mjs --selftest",
  );
});

test("the workflow is dispatch-only, hosted, read-only, secret-free and pinned", async () => {
  const text = await readFile(
    new URL("../.github/workflows/watch-lighthouse.yml", import.meta.url),
    "utf8",
  );
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.match(code, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(
    code,
    /^ {2}(?:push|pull_request\w*|schedule|workflow_run|repository_dispatch):/m,
  );
  assert.match(code, /^permissions:\n {2}contents: read\n\n/m);
  assert.doesNotMatch(code, /^\s+\w+: write\b/m);
  assert.equal(
    [...code.matchAll(/^ {4}runs-on: (.*)$/gm)].map((m) => m[1]).join(),
    "ubuntu-latest",
  );
  assert.doesNotMatch(code, /secrets\.|environment:|blacksmith|larger|self-hosted|vars\./i);
  const options = [...code.matchAll(/^ {10}- (https:\/\/\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(options, lib.ALLOWED_ORIGINS);
  assert.match(code, /type: choice/);
  const uses = [...code.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
  assert.match(code, /persist-credentials: false/);
  assert.match(code, /npm run lighthouse:origin -- "\$ORIGIN"/);
  // The choice is passed through the environment, never interpolated into the script.
  assert.doesNotMatch(code, /run:[^\n]*\$\{\{/);
});

// The marginal band derives from ci/lighthouserc.cjs (single source): the
// budget itself is never copied into the retry logic.
test("the marginal band is (budget, budget * 1.1) from ci/lighthouserc.cjs", () => {
  assert.equal(lib.lcpBudget(), 2000);
  assert.equal(lib.marginalBandMax(), 2200);
  assert.equal(lib.MARGINAL_AUDIT, "largest-contentful-paint");
  assert.equal(lib.MARGINAL_PATH, "/");
  assert.equal(lib.MARGINAL_BAND_RATIO, 0.1);
});

function marginalFixture({
  lcpRuns = [1940, 2060, 2065],
  assertions = "marginal",
  skip = true,
} = {}) {
  const paths = skip ? lib.plannedPaths(undefined) : lib.plannedPaths(EVENT_PATH);
  const lhrs = [];
  for (const path of paths) {
    const values = path === "/" ? lcpRuns : [1000, 1100, 1050];
    for (const lcp of values) lhrs.push(lhr(path, [lcp, 0, 100, 50, 900]));
  }
  const marginal = [
    {
      url: `${APEX}/`,
      auditId: "largest-contentful-paint",
      level: "error",
      actual: 2060,
      expected: 2000,
    },
    {
      url: `${APEX}/`,
      auditId: "first-contentful-paint",
      level: "warn",
      actual: 1850,
      expected: 1800,
    },
    {
      url: `${APEX}/events`,
      auditId: "first-contentful-paint",
      level: "warn",
      actual: 1820,
      expected: 1800,
    },
  ];
  return {
    rows: lib.summarizeRoutes({
      origin: APEX,
      eventPath: skip ? undefined : EVENT_PATH,
      skipReason: skip ? "no published event is listed" : undefined,
      lhrs,
      assertions: assertions === "marginal" ? marginal : assertions,
    }),
    assertions: assertions === "marginal" ? marginal : assertions,
  };
}

test("rows carry every per-run sample for every route, including passes", () => {
  const { rows } = marginalFixture();
  const home = rows.find((row) => row.path === "/");
  assert.deepEqual(home.samples["largest-contentful-paint"], [1940, 2060, 2065]);
  assert.deepEqual(home.samples["server-response-time"], [100, 100, 100]);
  const pass = rows.find((row) => row.path === "/faq");
  assert.equal(pass.verdict, "pass");
  assert.deepEqual(pass.samples["largest-contentful-paint"], [1000, 1100, 1050]);
  const skipped = rows.find((row) => row.path === "/e/<key>");
  assert.equal(skipped.verdict, "skipped");
  assert.deepEqual(skipped.samples, {});
});

test("the summary renders per-sample values for all routes and an optional notice", () => {
  const { rows } = marginalFixture();
  const text = lib.renderSummary({ origin: APEX, eventPath: undefined, rows });
  assert.match(text, /### Per-sample values \(all routes, collection order\)/);
  assert.match(text, /\| \/ \| 1940, 2060, 2065 \|/);
  assert.match(text, /\| \/faq \| 1000, 1100, 1050 \|/);
  assert.match(text, /\| \/e\/<key> \| - \| - \| - \| - \| - \|/);
  assert.doesNotMatch(text, /gates on attempt 2/);
  const noticed = lib.renderSummary({
    origin: APEX,
    eventPath: undefined,
    rows,
    notice: "> Attempt 1 breached marginally; gates on attempt 2.",
  });
  assert.match(noticed, /> Attempt 1 breached marginally; gates on attempt 2\./);
});

test("a marginal / LCP breach with everything else pass/warn-only retries", () => {
  const { rows, assertions } = marginalFixture();
  assert.equal(rows.find((row) => row.path === "/").verdict, "fail");
  assert.equal(rows.find((row) => row.path === "/events").verdict, "warn");
  const marginal = lib.isMarginalLcpBreach({ rows, assertions });
  assert.equal(marginal.marginal, true);
  assert.equal(marginal.actual, 2060);
  assert.equal(marginal.budget, 2000);
  assert.equal(marginal.bandMax, 2200);
  assert.match(marginal.reason, /only error is \/ LCP 2060 within \(2000, 2200\)/);
});

test("anything outside the marginal shape fails closed to no retry", () => {
  const check = (assertions, mutateRows, pattern) => {
    const { rows } = marginalFixture({ assertions });
    const result = lib.isMarginalLcpBreach({
      rows: mutateRows ? mutateRows(rows) : rows,
      assertions,
    });
    assert.equal(result.marginal, false);
    assert.match(result.reason, pattern);
  };
  const lcpError = (actual, url = `${APEX}/`) => ({
    url,
    auditId: "largest-contentful-paint",
    level: "error",
    actual,
    expected: 2000,
  });
  // Band edges: strictly inside (budget, bandMax), exclusive both ends.
  check([lcpError(2500)], null, /outside the marginal band/);
  check([lcpError(2200)], null, /outside the marginal band/);
  check([lcpError(2000)], null, /outside the marginal band/);
  check([lcpError(Number.NaN)], null, /outside the marginal band/);
  // A non-LCP error on `/` (e.g. a dragged-down performance category) vetoes.
  check(
    [
      lcpError(2060),
      {
        url: `${APEX}/`,
        auditId: "server-response-time",
        level: "error",
        actual: 900,
        expected: 600,
      },
    ],
    null,
    /non-LCP error/,
  );
  // An error on any other route vetoes.
  check(
    [
      lcpError(2060),
      {
        url: `${APEX}/events`,
        auditId: "server-response-time",
        level: "error",
        actual: 900,
        expected: 600,
      },
    ],
    null,
    /\/events is fail, not pass\/warn-only/,
  );
  // Unreadable assertion evidence vetoes.
  check(
    [{ level: "error", auditId: "unreadable-assertion-results", readError: true }],
    null,
    /unreadable/,
  );
  // No error at all is not a breach to retry.
  check([], null, /no error-level/);
  // An error attributed to no planned row hides from the table: veto.
  check([lcpError(2060), lcpError(2500, `${APEX}/ghost`)], null, /unattributed/);
  // Incomplete runs veto, even with the LCP error in the band.
  check(
    [lcpError(2060)],
    (rows) => {
      const short = structuredClone(rows);
      short.find((row) => row.path === "/about").verdict = "fail";
      short.find((row) => row.path === "/about").note = "0/3 runs (incomplete collection)";
      return short;
    },
    /\/about is fail, not pass\/warn-only/,
  );
  // A skipped row anywhere but the event slot vetoes.
  check(
    [lcpError(2060)],
    (rows) => {
      const skipped = structuredClone(rows);
      skipped.find((row) => row.path === "/faq").verdict = "skipped";
      return skipped;
    },
    /unexpected skipped row/,
  );
});
