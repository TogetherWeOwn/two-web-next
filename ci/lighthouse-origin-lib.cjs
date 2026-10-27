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
// Transient-429 hardening: discovery shares the staging origin with the
// staging-journey browsers, so a feed or candidate-verification GET can be
// rate-limited while the origin is healthy. A 429 retries a bounded number
// of times with backoff honoring Retry-After. Alternate candidates/sources
// may recover coverage, but incomplete discovery never becomes a no-event
// skip. One elapsed/request budget covers the whole discovery operation.
const DISCOVERY_BUDGET_MS = 60_000;
const DISCOVERY_MAX_REQUESTS = 24;
const DISCOVERY_THROTTLE_RETRIES = 3;
const DISCOVERY_THROTTLE_BASE_DELAY_MS = 1000;
const DISCOVERY_THROTTLE_MAX_DELAY_MS = 10_000;
const DISCOVERY_THROTTLED = "DISCOVERY_THROTTLED";

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
// Cancelled events keep their feed row with a `Cancelled: ` title prefix
// (src/events/feeds.ts RSS_CANCELLED_TITLE_PREFIX), so a cancelled staging
// fixture reads `Cancelled: Staging E2E ...` and the bare fixture prefix
// misses it. Strip one `Cancelled: ` prefix before the fixture check so
// cancelled fixtures stay fixtures; genuine `Cancelled: ...` titles still
// verify live (404/410 tolerated) as before.
const CANCELLED_TITLE_PREFIX = "Cancelled: ";

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
  if (typeof title !== "string") return false;
  const rest = title.startsWith(CANCELLED_TITLE_PREFIX)
    ? title.slice(CANCELLED_TITLE_PREFIX.length)
    : title;
  return rest.startsWith(STAGING_FIXTURE_TITLE_PREFIX);
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

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response) {
  let value = null;
  try {
    const headers = response?.headers;
    if (headers == null) return null;
    if (typeof headers.get === "function") {
      value = headers.get("retry-after") ?? headers.get("Retry-After");
    } else if (typeof headers === "object") {
      value = headers["retry-after"] ?? headers["Retry-After"];
    }
  } catch {
    return null;
  }
  if (value == null) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    return Math.min(Number(text) * 1000, DISCOVERY_THROTTLE_MAX_DELAY_MS);
  }
  const when = Date.parse(text);
  if (!Number.isNaN(when)) {
    return Math.min(Math.max(when - Date.now(), 0), DISCOVERY_THROTTLE_MAX_DELAY_MS);
  }
  return null;
}

function throttleDelayMs(response, attempt) {
  return (
    retryAfterMs(response) ??
    Math.min(DISCOVERY_THROTTLE_BASE_DELAY_MS * 2 ** attempt, DISCOVERY_THROTTLE_MAX_DELAY_MS)
  );
}

function throttledError(origin, path) {
  const error = new Error(
    `GET ${origin}${path} returned 429 after ${DISCOVERY_THROTTLE_RETRIES + 1} attempts, throttled.`,
  );
  error.code = DISCOVERY_THROTTLED;
  return error;
}

function discoveryBudget(origin, fetchImpl, options) {
  const now = options.nowImpl ?? (() => performance.now());
  const deadline = now() + DISCOVERY_BUDGET_MS;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  let requests = 0;
  const exhausted = () =>
    Object.assign(
      new Error(
        `Event discovery incomplete: budget exhausted (${DISCOVERY_BUDGET_MS}ms or ${DISCOVERY_MAX_REQUESTS} GETs); retry when the origin is healthy.`,
      ),
      { code: "DISCOVERY_BUDGET_EXHAUSTED" },
    );
  const check = () => {
    if (now() >= deadline) throw exhausted();
  };
  return {
    check,
    async get(path) {
      check();
      if (requests >= DISCOVERY_MAX_REQUESTS) throw exhausted();
      requests += 1;
      // GET only, no credentials; redirects are findings, not followed. The
      // remaining overall deadline also aborts response-body consumption.
      const signal = AbortSignal.timeout(
        Math.max(1, Math.ceil(Math.min(DISCOVERY_TIMEOUT_MS, deadline - now()))),
      );
      try {
        const response = await fetchImpl(`${origin}${path}`, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": "two-web-next-watch-lighthouse" },
          signal,
        });
        check();
        return response;
      } catch (error) {
        check();
        throw error;
      }
    },
    async text(response) {
      const text = await response.text();
      check();
      return text;
    },
    async sleep(ms) {
      check();
      if (ms >= deadline - now()) throw exhausted();
      await sleepImpl(ms);
      check();
    },
  };
}

async function getText(origin, path, budget) {
  // Exhausted throttling falls through to another source, not to a pass.
  for (let attempt = 0; ; attempt += 1) {
    const response = await budget.get(path);
    if (response.status !== 429) {
      if (response.status !== 200) {
        throw new Error(`GET ${origin}${path} returned ${response.status}, expected 200.`);
      }
      return budget.text(response);
    }
    await response.body?.cancel();
    if (attempt >= DISCOVERY_THROTTLE_RETRIES) throw throttledError(origin, path);
    await budget.sleep(throttleDelayMs(response, attempt));
  }
}

function isStagingFixturePage(html) {
  return /<h1[^>]*>\s*Staging E2E /.test(html);
}

async function getCandidateAfterThrottle(path, budget) {
  // Try an alternate candidate after the fourth 429, within the shared budget.
  for (let attempt = 0; ; attempt += 1) {
    const response = await budget.get(path);
    if (response.status !== 429) return response;
    await response.body?.cancel();
    if (attempt >= DISCOVERY_THROTTLE_RETRIES) return response;
    await budget.sleep(throttleDelayMs(response, attempt));
  }
}

/**
 * First listed candidate whose page answers 200 with non-fixture content. A
 * 404/410 means the listing outlived the event (cancelled after the cached
 * feed was built): try the next listing. A 429 retries with backoff honoring
 * Retry-After, then another candidate may supply real coverage. Any other
 * status throws; exhausted throttling stays incomplete unless a pick succeeds.
 */
async function pickStableCandidate(origin, paths, budget, tally, seen) {
  for (const path of paths) {
    budget.check();
    // Already rejected in an earlier pass (title filter, gone, fixture page):
    // skip without another request or a second tally count.
    if (seen?.has(path)) continue;
    const response = await getCandidateAfterThrottle(path, budget);
    if (response.status === 429) {
      tally.throttled += 1;
      seen?.add(path);
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      tally.gone += 1;
      seen?.add(path);
      continue;
    }
    if (response.status !== 200) {
      throw new Error(`GET ${origin}${path} returned ${response.status}, expected 200.`);
    }
    if (isStagingFixturePage(await budget.text(response))) {
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
 * lists no stable event. A 429 retries with backoff honoring Retry-After.
 * If no alternate event verifies, exhausted throttling or the shared budget
 * throws: incomplete discovery must not shrink the quality gate's route plan.
 */
async function discoverEventPath(origin, fetchImpl = fetch, options = {}) {
  const root = requireAllowedOrigin(origin);
  const budget = discoveryBudget(root, fetchImpl, options);
  const tally = { fixtures: 0, gone: 0, throttled: 0 };
  // Paths rejected in the RSS pass are never re-requested in the /events
  // pass: the listing carries no titles, so without this the fallback would
  // fetch the same fixture or stale pages again and count them twice.
  const rejected = new Set();
  // A throttled source can fall through to a healthy alternate. Remember
  // incomplete reads so they cannot masquerade as a legitimate empty feed.
  const throttledSources = [];
  let items = [];
  try {
    items = eventItemsFromRss(await getText(root, "/events.rss", budget));
  } catch (error) {
    if (error?.code !== DISCOVERY_THROTTLED) throw error;
    throttledSources.push("/events.rss");
  }
  const rssPaths = [];
  for (const item of items) {
    budget.check();
    if (isStagingFixtureTitle(item.title)) {
      tally.fixtures += 1;
      rejected.add(item.path);
    } else rssPaths.push(item.path);
  }
  const rssPick = await pickStableCandidate(root, rssPaths, budget, tally, rejected);
  if (rssPick) return { path: rssPick, source: "/events.rss" };
  let listed = [];
  try {
    listed = eventPathsFromListing(await getText(root, "/events", budget));
  } catch (error) {
    if (error?.code !== DISCOVERY_THROTTLED) throw error;
    throttledSources.push("/events");
  }
  const listedPick = await pickStableCandidate(root, listed, budget, tally, rejected);
  if (listedPick) return { path: listedPick, source: "/events" };
  const skipped = [];
  if (tally.fixtures > 0) skipped.push(`${tally.fixtures} staging fixture(s)`);
  if (tally.gone > 0) skipped.push(`${tally.gone} cancelled/stale listing(s)`);
  if (tally.throttled > 0) skipped.push(`${tally.throttled} throttled (429) candidate(s)`);
  for (const source of throttledSources) skipped.push(`${source} throttled (429 after retries)`);
  budget.check();
  if (tally.throttled > 0 || throttledSources.length > 0) {
    throw Object.assign(
      new Error(
        `Event discovery incomplete: ${skipped.join(", ")}; no stable event verified. Retry when throttling clears.`,
      ),
      { code: DISCOVERY_THROTTLED },
    );
  }
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

// Marginal-breach retry band for the staging-quality mobile LCP gate
// (measurement-variance hardening). When the origin collect is complete and
// the ONLY error-level assertion is `/` largest-contentful-paint within a
// narrow band over budget, the runner retries the whole collect once and
// gates on the retry, preserving both tables. A systematic regression fails
// twice and stays red. The band derives from the budget in
// ci/lighthouserc.cjs (single source; never copied here): strictly between
// the budget and budget * (1 + MARGINAL_BAND_RATIO) — currently (2000, 2200).
// Budgets themselves are untouched.
const MARGINAL_BAND_RATIO = 0.1;
const MARGINAL_AUDIT = "largest-contentful-paint";
const MARGINAL_PATH = "/";

function lcpBudget() {
  const max = base.ci.assert.assertions?.[MARGINAL_AUDIT]?.[1]?.maxNumericValue;
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error("ci/lighthouserc.cjs must define a positive largest-contentful-paint budget.");
  }
  return max;
}

function marginalBandMax(budget = lcpBudget()) {
  return budget * (1 + MARGINAL_BAND_RATIO);
}

/**
 * True when a full-evidence breach qualifies for one bounded retry: the only
 * error-level failure is `/` LCP strictly inside (budget, bandMax) and every
 * other route is pass/warn-only (the skipped event row excepted). Complete
 * evidence is a precondition the caller checks via the sample matrix. Any
 * read error, incomplete run, non-LCP error (including a dragged-down
 * categories:performance error on `/`), far-over LCP, or unattributed error
 * fails closed to "not marginal" — the gate stays red without a retry.
 */
function isMarginalLcpBreach({ rows, assertions, budget = lcpBudget() }) {
  const bandMax = budget * (1 + MARGINAL_BAND_RATIO);
  const no = (reason) => ({ marginal: false, reason, budget, bandMax, actual: null });
  if (!Array.isArray(rows) || !Array.isArray(assertions)) {
    return no("missing rows or assertions");
  }
  if (assertions.some((failure) => failure?.readError)) {
    return no("unreadable assertion evidence");
  }
  const errors = assertions.filter((failure) => failure?.level === "error");
  if (errors.length === 0) return no("no error-level assertion to retry");
  const home = rows.find((row) => row.path === MARGINAL_PATH);
  if (!home) return no("no / row");
  if (home.verdict !== "fail") return no("/ did not fail");
  if (home.runs < 1 || /incomplete collection|no Lighthouse run completed/.test(home.note ?? "")) {
    return no("/ has incomplete runs");
  }
  const homeErrors = (home.failed ?? []).filter((failure) => failure.level === "error");
  if (homeErrors.length === 0) return no("/ has no error-level failure");
  if (homeErrors.some((failure) => failure.audit !== MARGINAL_AUDIT)) {
    return no("/ has a non-LCP error");
  }
  for (const failure of homeErrors) {
    if (!Number.isFinite(failure.actual) || failure.actual <= budget || failure.actual >= bandMax) {
      return no(
        `/ LCP ${String(failure.actual)} outside the marginal band (${budget}, ${bandMax})`,
      );
    }
  }
  for (const row of rows) {
    if (row.path === MARGINAL_PATH) continue;
    if (row.verdict === "skipped") {
      if (row.path !== "/e/<key>") return no(`unexpected skipped row ${row.path}`);
      continue;
    }
    if (row.verdict !== "pass" && row.verdict !== "warn") {
      return no(`${row.path} is ${row.verdict}, not pass/warn-only`);
    }
    if ((row.failed ?? []).some((failure) => failure.level === "error")) {
      return no(`${row.path} has an error-level failure`);
    }
  }
  // No hidden errors: every raw error-level assertion must surface in the
  // rows (a fan-out duplicate would only add rows, which are already
  // constrained above; fewer row errors than raw errors means one hid).
  const rowErrors = rows
    .flatMap((row) => row.failed ?? [])
    .filter((failure) => failure.level === "error").length;
  if (rowErrors < errors.length) return no("unattributed error-level assertion");
  const actual = homeErrors[0].actual;
  return {
    marginal: true,
    reason: `only error is / LCP ${actual} within (${budget}, ${bandMax})`,
    budget,
    bandMax,
    actual,
  };
}

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
    // Every per-run value, for every route — including passes. LHCI logs `all
    // values` only for warn/fail assertions and the desktop step clears the
    // mobile per-run LHRs, so without this the next variance investigation is
    // blind on pass runs. Collection order; null where an audit is missing.
    const samples = Object.fromEntries(
      METRICS.map(([id]) => [id, runs.map((lhr) => lhr.audits?.[id]?.numericValue ?? null)]),
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
      samples,
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
      samples: {},
      failed: [],
      note: skipReason ?? "no event discovered",
    });
  }
  return rows;
}

const cell = (value) =>
  value == null ? "-" : String(value >= 10 ? Math.round(value) : Number(value.toFixed(3)));

function renderSummary({ origin, eventPath, eventSource, rows, notice }) {
  const lines = [
    "## Lighthouse watch run",
    "",
    `Origin: ${origin}`,
    `Event route: ${eventPath ? `${eventPath} (from ${eventSource})` : "skipped, see the table"}`,
    "",
  ];
  if (notice) lines.push(notice, "");
  lines.push(
    `| Route | Verdict | Runs | ${METRICS.map(([, label]) => label).join(" | ")} | Note |`,
    `| --- | --- | --- | ${METRICS.map(() => "---").join(" | ")} | --- |`,
  );
  for (const row of rows) {
    const failed = row.failed.map((f) => `${f.audit} ${f.level} ${cell(f.actual)} > ${f.expected}`);
    const note = [row.note, ...failed].filter(Boolean).join("; ");
    lines.push(
      `| ${row.path} | ${row.verdict} | ${row.runs} | ${METRICS.map(([id]) => cell(row.medians[id])).join(" | ")} | ${note} |`,
    );
  }
  lines.push(
    "",
    "### Per-sample values (all routes, collection order)",
    "",
    `| Route | ${METRICS.map(([, label]) => label).join(" | ")} |`,
    `| --- | ${METRICS.map(() => "---").join(" | ")} |`,
  );
  for (const row of rows) {
    lines.push(
      `| ${row.path} | ${METRICS.map(([id]) => {
        const values = row.samples?.[id];
        if (!Array.isArray(values) || values.length === 0) return "-";
        return values.map(cell).join(", ");
      }).join(" | ")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

module.exports = {
  ALLOWED_ORIGINS,
  DISCOVERY_THROTTLE_RETRIES,
  EVENT_PATH,
  MARGINAL_AUDIT,
  MARGINAL_BAND_RATIO,
  MARGINAL_PATH,
  SERVER_KEYS,
  STAGING_FIXTURE_TITLE_PREFIX,
  buildConfig,
  configFromEnv,
  configuredPaths,
  discoverEventPath,
  eventItemsFromRss,
  isMarginalLcpBreach,
  isStagingFixtureTitle,
  lcpBudget,
  marginalBandMax,
  plannedPaths,
  renderSummary,
  requireAllowedOrigin,
  summarizeRoutes,
};
