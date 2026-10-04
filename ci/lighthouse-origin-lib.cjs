"use strict";

// Lighthouse against a deployed origin for the production cutover watch.
//
// The budgets, mobile profile and routes live in ci/lighthouserc.cjs and only
// there: this module clones that config, drops the fixture server, and points
// the same routes at one allowlisted origin. It never copies or relaxes an
// assertion. Everything here is read-only: the only network calls are GETs.
const base = require("./lighthouserc.cjs");

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
  const paths = base.ci.collect.url.map((entry) => new URL(entry).pathname);
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

function eventPathsFromRss(xml) {
  const found = [];
  for (const [, link] of xml.matchAll(/<link>([^<]+)<\/link>/g)) {
    try {
      // Only the path is used: the host is always the validated origin.
      const path = new URL(link.trim()).pathname;
      if (EVENT_PATH.test(path)) found.push(path);
    } catch {
      // Not a URL (the channel link is, but guard anyway).
    }
  }
  return found;
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

/**
 * Finds one published event on the origin: /events.rss first, then the /events
 * list. Returns `{ path, source }`, or `{ path: null, reason }` when the origin
 * answers 200 but lists no event. A failing request throws: an origin that does
 * not answer is a watch finding, never a skip.
 */
async function discoverEventPath(origin, fetchImpl = fetch) {
  const root = requireAllowedOrigin(origin);
  const rss = eventPathsFromRss(await getText(root, "/events.rss", fetchImpl));
  if (rss[0]) return { path: rss[0], source: "/events.rss" };
  const listed = eventPathsFromListing(await getText(root, "/events", fetchImpl));
  if (listed[0]) return { path: listed[0], source: "/events" };
  return {
    path: null,
    reason: "no published event is listed in /events.rss or /events",
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

const pathnameOf = (value) => {
  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
};

/**
 * Per-route verdicts from the lhci output. `lhrs` are parsed lhr-*.json files,
 * `assertions` the parsed assertion-results.json (failed assertions only).
 * A route with no run is a fail, never a pass; the skipped event route is
 * reported as skipped with its reason.
 */
function summarizeRoutes({ origin, eventPath, skipReason, lhrs, assertions }) {
  const root = requireAllowedOrigin(origin);
  const paths = plannedPaths(eventPath);
  const finalToPath = new Map();
  const runsByPath = new Map();
  for (const lhr of lhrs) {
    const path = pathnameOf(lhr.requestedUrl);
    if (path == null) continue;
    runsByPath.set(path, [...(runsByPath.get(path) ?? []), lhr]);
    const finalPath = pathnameOf(lhr.finalUrl);
    if (finalPath != null) finalToPath.set(finalPath, path);
  }
  const failuresByPath = new Map();
  for (const failure of assertions) {
    const path = pathnameOf(failure.url);
    const key = runsByPath.has(path) ? path : (finalToPath.get(path) ?? path);
    failuresByPath.set(key, [...(failuresByPath.get(key) ?? []), failure]);
  }
  const rows = paths.map((path) => {
    const runs = runsByPath.get(path) ?? [];
    const failures = failuresByPath.get(path) ?? [];
    const errors = failures.filter((failure) => failure.level === "error");
    const medians = Object.fromEntries(
      METRICS.map(([id]) => [id, median(runs.map((lhr) => lhr.audits?.[id]?.numericValue))]),
    );
    const redirected = runs.find((lhr) => lhr.finalUrl && pathnameOf(lhr.finalUrl) !== path);
    const verdict =
      runs.length === 0 ? "fail" : errors.length ? "fail" : failures.length ? "warn" : "pass";
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
      note:
        runs.length === 0
          ? "no Lighthouse run completed"
          : redirected
            ? `redirected to ${redirected.finalUrl}`
            : "",
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
  buildConfig,
  configFromEnv,
  configuredPaths,
  discoverEventPath,
  plannedPaths,
  renderSummary,
  requireAllowedOrigin,
  summarizeRoutes,
};
