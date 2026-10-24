import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
    const route = routes[new URL(url).pathname];
    const { status = 200, body = "" } = route ?? { status: 404 };
    return { status, text: async () => body };
  };
  return { calls, fetchImpl };
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
  for (const status of [500, 429, 301]) {
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
