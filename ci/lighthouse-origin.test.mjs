import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "./lighthouse-origin-run.mjs";

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

test("discovery is GET-only and reads the first published event from the RSS feed", async () => {
  const { calls, fetchImpl } = stubFetch({
    "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`, `${APEX}/e/01JBBBBBBBBBBBBBBBBBBBBBBB`) },
  });
  assert.deepEqual(await lib.discoverEventPath(APEX, fetchImpl), {
    path: EVENT_PATH,
    source: "/events.rss",
  });
  assert.deepEqual(
    calls.map((call) => [call.init.method, call.url, call.init.body, call.init.redirect]),
    [["GET", `${APEX}/events.rss`, undefined, "manual"]],
  );
});

test("discovery falls back to the /events list, then reports a skip with its reason", async () => {
  const listed = stubFetch({
    "/events.rss": { body: rss() },
    "/events": {
      body: `<a href="/e/seed-calendar-07">Seed</a><a href="/e/${EVENT_PATH.slice(3)}">x</a>`,
    },
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
  requestedUrl: `${APEX}${path}`,
  finalUrl: `${APEX}${finalPath}`,
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
      return 0;
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
    const { fetchImpl } = stubFetch({ "/events.rss": { body: rss(`${APEX}${EVENT_PATH}`) } });
    const crashed = await main([APEX], { fetchImpl, lhci: async () => 1, dir, log: () => {} });
    assert.equal(crashed, 1, "lhci exit code is propagated");
    const noRuns = await main([APEX], { fetchImpl, lhci: async () => 0, dir, log: () => {} });
    assert.equal(noRuns, 1, "a clean exit without any lhr result is not a pass");
    const down = stubFetch({ "/events.rss": { status: 503 } });
    let launched = false;
    const lines = [];
    const dead = await main([APEX], {
      fetchImpl: down.fetchImpl,
      lhci: async () => {
        launched = true;
        return 0;
      },
      dir,
      log: (l) => lines.push(l),
    });
    assert.equal(dead, 1);
    assert.equal(launched, false);
    assert.match(lines.join("\n"), /Event discovery failed, origin not healthy: .*503/);
    assert.deepEqual(
      await readdir(dir),
      ["watch-summary.md"],
      "a failure summary is still left for the artifact",
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
  assert.equal(scripts["lighthouse:origin:selftest"], "node --test ci/lighthouse-origin.test.mjs");
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
