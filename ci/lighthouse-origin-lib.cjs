"use strict";

// Lighthouse against a deployed origin for the production cutover watch.
//
// The budgets, mobile profile and routes live in ci/lighthouserc.cjs and only
// there: this module clones that config, drops the fixture server, and points
// the same routes at one allowlisted origin. It never copies or relaxes an
// assertion. Everything here is read-only: the only network calls are GETs.
const base = require("./lighthouserc.cjs");
const { sampleMatrix, assertionsByUrl } = require("./lighthouse-samples.cjs");

// Exact allowlist, like e2e/staging-guard.mjs: https, no port, no credentials,
// no path, query or hash. Anything else fails closed.
const ALLOWED_ORIGINS = Object.freeze([
  "https://next.togetherweown.com",
  "https://togetherweown.com",
  "https://www.togetherweown.com",
]);

// The one route ci/lighthouserc.cjs fills with a fixture event. Production keys
// are ULIDs; staging may also publish `seed-calendar-NN` demo keys.
const EVENT_PATH = /^\/e\/[A-Za-z0-9-]{1,64}$/;

const SERVER_KEYS = ["startServerCommand", "startServerReadyPattern", "startServerReadyTimeout"];
const DISCOVERY_TIMEOUT_MS = 15_000;

function requireAllowedOrigin(raw) {
  const refusal = `Lighthouse watch runs only against ${ALLOWED_ORIGINS.join(", ")}.`;
  let url;
  try {
    url = new URL(typeof raw === "string" ? raw : "");
  } catch {
    throw new Error(refusal);
  }
  // `new URL` hides an empty `?`/`#`, a default `:443`, letter case and
  // surrounding whitespace, so also require the raw text to be the origin.
  if (
    (raw !== url.origin && raw !== `${url.origin}/`) ||
    url.protocol !== "https:" ||
    !ALLOWED_ORIGINS.includes(url.origin) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(refusal);
  }
  return url.origin;
}

function requireEventPath(path) {
  if (typeof path !== "string" || !EVENT_PATH.test(path)) {
    throw new Error("Discovered event path must look like /e/<key>.");
  }
  return path;
}

/** The route paths of ci/lighthouserc.cjs, in order, with the event slot named. */
function configuredPaths() {
  const paths = base.ci.collect.url.map((entry) => {
    const url = new URL(entry);
    return url.pathname + url.search + url.hash;
  });
  if (paths.filter((path) => EVENT_PATH.test(path)).length !== 1) {
    throw new Error("ci/lighthouserc.cjs must list exactly one /e/<key> route.");
  }
  return paths;
}

/**
 * The paths to measure on the origin: ci/lighthouserc.cjs's routes with the
 * fixture event swapped for `eventPath`, or dropped when none was discovered.
 */
function plannedPaths(eventPath) {
  const paths = [];
  for (const path of configuredPaths()) {
    if (!EVENT_PATH.test(path)) paths.push(path);
    else if (eventPath != null) paths.push(requireEventPath(eventPath));
  }
  return paths;
}

function buildConfig({ origin, eventPath } = {}) {
  const root = requireAllowedOrigin(origin);
  // Deep clone: later edits (or lhci's own key rewriting) never reach the CI config.
  const ci = structuredClone(base.ci);
  for (const key of SERVER_KEYS) delete ci.collect[key];
  ci.collect.url = plannedPaths(eventPath).map((path) => `${root}${path}`);
  return { ci };
}

/** `lhci --config` entry: the origin and discovered event come from the runner's env. */
function configFromEnv(env = process.env) {
  return buildConfig({
    origin: env.LIGHTHOUSE_ORIGIN,
    eventPath: env.LIGHTHOUSE_EVENT_PATH || undefined,
  });
}

// Staging-journey fixtures publish transient events titled `Staging E2E ...`
// (e2e/staging/event-rsvp.spec.ts) and cancel them in `finally`. The feed
// lists only published rows under a 300-second public cache, so a fixture can
// be listed while live and be cancelled before Lighthouse navigates
// (discovered live, then measured 410). Feed items carry titles,
// so discovery filters that prefix with no extra request and no cache change.
// Thresholds, budgets and the fail-closed unmeasured-route verdict are untouched.
const STAGING_FIXTURE_TITLE_PREFIX = "Staging E2E ";

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isStagingFixtureTitle(title) {
  return typeof title === "string" && title.startsWith(STAGING_FIXTURE_TITLE_PREFIX);
}

function eventItemsFromRss(xml) {
  const items = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = item.match(/<link>([^<]+)<\/link>/);
    if (!link) continue;
    let path;
    try {
      // Only the path is used: the host is always the validated origin.
      path = new URL(link[1].trim()).pathname;
    } catch {
      continue; // Not a URL (the channel link is, but guard anyway).
    }
    if (!EVENT_PATH.test(path)) continue;
    const title = item.match(/<title>([\s\S]*?)<\/title>/);
    items.push({ path, title: title ? decodeXmlEntities(title[1]) : "" });
  }
  return items;
}

function eventPathsFromListing(html) {
  const found = [];
  for (const [, path] of html.matchAll(/href="(\/e\/[A-Za-z0-9-]{1,64})"/g)) found.push(path);
  return found;
}

async function getText(origin, path, fetchImpl) {
  // GET only, no body, no credentials; a redirect is a finding, not followed.
  const response = await fetchImpl(`${origin}${path}`, {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": "two-web-next-watch-lighthouse" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`GET ${origin}${path} returned ${response.status}, expected 200.`);
  }
  return response.text();
}

function isStagingFixturePage(html) {
  return /<h1[^>]*>\s*Staging E2E /.test(html);
}

async function getCandidate(origin, path, fetchImpl) {
  // GET only, no credentials; a redirect is a finding, not followed.
  return fetchImpl(`${origin}${path}`, {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": "two-web-next-watch-lighthouse" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
}

/**
 * First listed candidate whose page answers 200 with non-fixture content. A
 * 404/410 means the listing outlived the event (cancelled after the cached
 * feed was built): try the next listing. Any other status throws: an origin
 * that does not answer stays a watch finding, never a skip.
 */
async function pickStableCandidate(origin, paths, fetchImpl, tally, seen) {
  for (const path of paths) {
    // Already rejected in an earlier pass (title filter, gone, fixture page):
    // skip without another request or a second tally count.
    if (seen?.has(path)) continue;
    const response = await getCandidate(origin, path, fetchImpl);
    if (response.status === 404 || response.status === 410) {
      tally.gone += 1;
      seen?.add(path);
      continue;
    }
    if (response.status !== 200) {
      throw new Error(`GET ${origin}${path} returned ${response.status}, expected 200.`);
    }
    if (isStagingFixturePage(await response.text())) {
      tally.fixtures += 1;
      seen?.add(path);
      continue;
    }
    return path;
  }
  return null;
}

/**
 * Finds one stable published event on the origin: /events.rss first, then the
 * /events list. Staging-journey fixtures are filtered by feed
 * title before any request; each remaining candidate is verified live so a
 * feed entry cached before a cancel is never measured. Returns `{ path,
 * source }`, or `{ path: null, reason }` when the origin answers 200 but
 * lists no stable event. A failing request throws: an origin that does not
 * answer is a watch finding, never a skip.
 */
async function discoverEventPath(origin, fetchImpl = fetch) {
  const root = requireAllowedOrigin(origin);
  const tally = { fixtures: 0, gone: 0 };
  // Paths rejected in the RSS pass are never re-requested in the /events
  // pass: the listing carries no titles, so without this the fallback would
  // fetch the same fixture or stale pages again and count them twice.
  const rejected = new Set();
  const items = eventItemsFromRss(await getText(root, "/events.rss", fetchImpl));
  const rssPaths = [];
  for (const item of items) {
    if (isStagingFixtureTitle(item.title)) {
      tally.fixtures += 1;
      rejected.add(item.path);
    } else rssPaths.push(item.path);
  }
  const rssPick = await pickStableCandidate(root, rssPaths, fetchImpl, tally, rejected);
  if (rssPick) return { path: rssPick, source: "/events.rss" };
  const listed = eventPathsFromListing(await getText(root, "/events", fetchImpl));
  const listedPick = await pickStableCandidate(root, listed, fetchImpl, tally, rejected);
  if (listedPick) return { path: listedPick, source: "/events" };
  const skipped = [];
  if (tally.fixtures > 0) skipped.push(`${tally.fixtures} staging fixture(s)`);
  if (tally.gone > 0) skipped.push(`${tally.gone} cancelled/stale listing(s)`);
  return {
    path: null,
    reason:
      "no published event is listed in /events.rss or /events" +
      (skipped.length ? ` (skipped ${skipped.join(", ")})` : ""),
  };
}

const METRICS = [
  ["largest-contentful-paint", "LCP ms"],
  ["cumulative-layout-shift", "CLS"],
  ["server-response-time", "Server ms"],
  ["total-blocking-time", "TBT ms"],
  ["first-contentful-paint", "FCP ms"],
];

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-route verdicts from the lhci output. `lhrs` are parsed lhr-*.json files,
 * `assertions` the parsed assertion-results.json (failed assertions only).
 * A route with no run is a fail, never a pass; the skipped event route is
 * reported as skipped with its reason.
 */
function summarizeRoutes({ origin, eventPath, skipReason, lhrs, assertions }) {
  const root = requireAllowedOrigin(origin);
  const collect = buildConfig({ origin, eventPath }).ci.collect;
  const matrix = sampleMatrix(lhrs, collect);
  const failuresByUrl = assertionsByUrl(matrix, assertions);
  const rows = matrix.rows.map(({ url, quota, runs }) => {
    const path = url.slice(root.length);
    const failures = failuresByUrl.get(url);
    const errors = failures.filter((failure) => failure.level === "error");
    const medians = Object.fromEntries(
      METRICS.map(([id]) => [id, median(runs.map((lhr) => lhr.audits?.[id]?.numericValue))]),
    );
    const redirected = runs.find((lhr) => lhr.finalUrl && lhr.finalUrl !== url);
    const verdict =
      runs.length < quota ? "fail" : errors.length ? "fail" : failures.length ? "warn" : "pass";
    return {
      path,
      url: `${root}${path}`,
      verdict,
      runs: runs.length,
      medians,
      failed: failures.map((failure) => ({
        audit: failure.auditId,
        level: failure.level,
        actual: failure.actual,
        expected: failure.expected,
      })),
      note: [
        runs.length < quota ? `${runs.length}/${quota} runs (incomplete collection)` : "",
        runs.length === 0 ? "no Lighthouse run completed" : "",
        redirected ? `redirected to ${redirected.finalUrl}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    };
  });
  if (eventPath == null) {
    rows.push({
      path: "/e/<key>",
      url: `${root}/e/<key>`,
      verdict: "skipped",
      runs: 0,
      medians: {},
      failed: [],
      note: skipReason ?? "no event discovered",
    });
  }
  return rows;
}

const cell = (value) =>
  value == null ? "-" : String(value >= 10 ? Math.round(value) : Number(value.toFixed(3)));

function renderSummary({ origin, eventPath, eventSource, rows }) {
  const lines = [
    "## Lighthouse watch run",
    "",
    `Origin: ${origin}`,
    `Event route: ${eventPath ? `${eventPath} (from ${eventSource})` : "skipped, see the table"}`,
    "",
    `| Route | Verdict | Runs | ${METRICS.map(([, label]) => label).join(" | ")} | Note |`,
    `| --- | --- | --- | ${METRICS.map(() => "---").join(" | ")} | --- |`,
  ];
  for (const row of rows) {
    const failed = row.failed.map((f) => `${f.audit} ${f.level} ${cell(f.actual)} > ${f.expected}`);
    const note = [row.note, ...failed].filter(Boolean).join("; ");
    lines.push(
      `| ${row.path} | ${row.verdict} | ${row.runs} | ${METRICS.map(([id]) => cell(row.medians[id])).join(" | ")} | ${note} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

module.exports = {
  ALLOWED_ORIGINS,
  EVENT_PATH,
  SERVER_KEYS,
  STAGING_FIXTURE_TITLE_PREFIX,
  buildConfig,
  configFromEnv,
  configuredPaths,
  discoverEventPath,
  eventItemsFromRss,
  isStagingFixtureTitle,
  plannedPaths,
  renderSummary,
  requireAllowedOrigin,
  summarizeRoutes,
};
