#!/usr/bin/env node
// Kit journey parity gates: status/header, semantic DOM/a11y,
// no-JS and account-chrome assertions that run identically against Hono and
// the built Kit Worker, with a loud ledger (unexecuted suites cannot be
// green) and secret scrubbing (no tokens/PII in artifacts).
//
// Two modes, one assertion set per parity route (docs/kit-parity-gates.md):
// - Unit mode (default, CI): hermetic. Validates the shipped ROUTE_MANIFEST,
//   proves every assertion helper passes on a good fixture AND fails on a
//   planted mutant (forced-failure proof), and emits a ledger. No database,
//   no browser, no network, no secrets.
// - Preview mode (KIT_PREVIEW_URL + HONO_PREVIEW_URL): fetches each parity
//   route from both deployed Workers and applies the same helpers.
//
// Exit codes: 0 pass, 1 journeys failed, 2 misconfigured (one-sided URLs,
// non-allowlisted hosts) or all-skipped/empty ledger.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sectionOf } from "./kit-section-contract.mjs";

export const PARITY_ROUTES = [
  { path: "/events/past", expectStatus: 200, expectMarker: "manifest" },
  { path: "/events/past?page=2", expectStatus: 200, expectMarker: "manifest" },
];

export const RESERVED_PROBES = [{ path: "/up", expectStatus: 200, expectMarker: null }];

// Staging-allowlisted preview hosts: the staging Worker and preview Workers
// only. Apex, production or arbitrary hosts are never a valid parity pair.
export function isAllowlistedHost(hostname) {
  if (hostname === "next.togetherweown.com") return true;
  return hostname.endsWith(".workers.dev");
}

export function validatePreviewPair(kitRaw, honoRaw) {
  const kit = (kitRaw ?? "").trim() || null;
  const hono = (honoRaw ?? "").trim() || null;
  if (Boolean(kit) !== Boolean(hono)) {
    return {
      ok: false,
      error:
        "kit-parity-gates: set both KIT_PREVIEW_URL and HONO_PREVIEW_URL, or neither (unit mode)",
    };
  }
  if (!kit && !hono) return { ok: true, mode: "unit" };
  const parsed = [];
  for (const [label, raw] of [
    ["KIT_PREVIEW_URL", kit],
    ["HONO_PREVIEW_URL", hono],
  ]) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: `kit-parity-gates: ${label} is not a valid URL` };
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.port !== ""
    ) {
      return {
        ok: false,
        error: `kit-parity-gates: ${label} must be an https origin without credentials, port, path, query or fragment`,
      };
    }
    if (!isAllowlistedHost(url.hostname)) {
      return {
        ok: false,
        error: `kit-parity-gates: ${label} host ${url.hostname} is not staging-allowlisted (next.togetherweown.com or *.workers.dev)`,
      };
    }
    parsed.push(url.origin);
  }
  if (parsed[0] === parsed[1]) {
    return {
      ok: false,
      error:
        "kit-parity-gates: KIT_PREVIEW_URL and HONO_PREVIEW_URL must differ (a self-pair proves nothing)",
    };
  }
  return { ok: true, mode: "preview", kitBase: parsed[0], honoBase: parsed[1] };
}

// Expected renderer derives from the shipped manifest, never a hard-coded
// "kit": with enabled:false the Kit Worker sends the route to honoFetch and
// never sets the marker — that is the rollback.
export function expectedMarkerFor(manifestSource, path) {
  const match = manifestSource.match(/path:\s*"\/events\/past"[^}]*enabled:\s*(true|false)/);
  if (!match)
    throw new Error("kit-parity-gates: cannot derive /events/past owner from ROUTE_MANIFEST");
  if (!path.startsWith("/events/past")) return null;
  return match[1] === "true" ? "kit" : null;
}

// Login-journey ownership derives from the shipped manifest, the same way
// expectedMarkerFor does for /events/past: no enabled entry is Hono-owned
// and ledgers as skipped; any enabled entry means the route is Kit-native,
// so an unexecuted skip would be a quiet green and the gate records a
// failure instead.
//
// Entries are parsed method-aware and field-order independent: every
// `{...}` block naming a path must also name its method and enabled flag,
// whatever the field order, or the gate throws (like expectedMarkerFor)
// instead of reading it as disabled. Matching is ANY-enabled, never
// first-match, so GET disabled listed before POST enabled still counts.
export function parseManifestEntries(manifestSource) {
  const entries = [];
  for (const match of manifestSource.matchAll(/\{[^{}]*\}/g)) {
    const block = match[0];
    // Only quoted-path blocks are manifest entries: this skips the
    // OwnedRoute interface (`path: string`) and prose comments mentioning
    // "path:", while still throwing on a real entry that omits a field.
    if (!/path:\s*"/.test(block)) continue;
    const method = block.match(/method:\s*"([^"]+)"/)?.[1];
    const path = block.match(/path:\s*"([^"]+)"/)?.[1];
    const enabled = block.match(/enabled:\s*(true|false)/)?.[1];
    if (method === undefined || path === undefined || enabled === undefined) {
      throw new Error(`kit-parity-gates: cannot parse ROUTE_MANIFEST entry ${block.slice(0, 120)}`);
    }
    entries.push({ method, path, enabled: enabled === "true" });
  }
  return entries;
}

// Structural path equality: the runtime router (src/route-ownership.ts
// matchPattern) treats any `:name` segment as a wildcard and routes on
// segment structure only, so the gate must too. `entry.path === path` as
// strings lets `{ method: "POST", path: "/e/:id/rsvp", enabled: true }`
// ship on a green ledger with no journey run.
export function pathsMatchStructurally(pattern, path) {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every(
    (part, i) => part.startsWith(":") || pathParts[i].startsWith(":") || part === pathParts[i],
  );
}

export function isManifestEnabled(manifestSource, path, method = null) {
  const entries = parseManifestEntries(manifestSource);
  const wanted = method?.toUpperCase() ?? null;
  return entries.some(
    (entry) =>
      pathsMatchStructurally(entry.path, path) &&
      (wanted === null || entry.method.toUpperCase() === wanted) &&
      entry.enabled,
  );
}

// Coverage: the only executed parity run today is GET/HEAD /events/past via
// PARITY_ROUTES (unit contract + preview fetch). Any other enabled entry has
// no run covering it and must fail — the scopes below only choose the journey
// name for the failure message, never whether it fails.
export function isCoveredByExecutedRun(entry) {
  const method = entry.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const base = entry.path.split(/[?#]/)[0];
  // A `:param` pattern family (e.g. GET /events/:key) is never covered by the
  // single concrete /events/past run — it owns sibling paths with no run.
  if (base.includes(":")) return false;
  return PARITY_ROUTES.some((route) => {
    const routeBase = route.path.split(/[?#]/)[0];
    return base === routeBase;
  });
}

// Journey ownership scopes: every enabled manifest entry under one of these
// prefixes means Kit owns traffic in that journey's area, even when the
// entry is a route the explicit lists below never named (a newly added Hono
// route, a legacy redirect, a future action). Prefixes are static so `:param`
// renames cannot escape them; the `/events/` arm pins the `/rsvp` suffix so
// the public archive `/events/past` never trips the RSVP journey.
export function isInJourneyScope(scope, entryPath) {
  if (scope === "rsvp") {
    if (entryPath === "/e" || entryPath.startsWith("/e/")) return true;
    const parts = entryPath.split("/");
    if (parts.length === 4 && parts[1] === "events" && parts[3] === "rsvp") return true;
    return false;
  }
  if (scope === "admin") {
    return entryPath === "/admin/events" || entryPath.startsWith("/admin/events/");
  }
  if (scope === "profile") {
    if (entryPath === "/profile" || entryPath.startsWith("/profile/")) return true;
    return entryPath === "/members" || entryPath.startsWith("/members/");
  }
  return false;
}

// Each login journey lists the REAL method+path pairs it exercises — the
// read pages plus the mutation routes — never a bare page literal:
// - RSVP: GET /e/:key (detail page), POST /e/:key/rsvp (form override),
//   PUT + DELETE /events/:key/rsvp (src/events/routes-rsvp.tsx:115-125)
// - Admin: GET + POST /admin/events, GET /admin/events/new,
//   GET + POST /admin/events/:key, POST /admin/events/:key/publish,
//   /cancel, /rsvp-pause, /rsvp-reopen (src/admin/routes.tsx:306-471; each
//   action is its own route, not the :key POST family)
// - Profile: GET /profile (own read), GET /members/:user (other read),
//   PATCH + POST /members/:user
//   (src/profiles/routes-reads.tsx:36-37, routes-writes.tsx:140-142)
export const LOGIN_JOURNEYS = [
  {
    name: "member RSVP going/withdraw (/e/:key)",
    scope: "rsvp",
    routes: [
      { method: "GET", path: "/e/:key" },
      { method: "POST", path: "/e/:key/rsvp" },
      { method: "PUT", path: "/events/:key/rsvp" },
      { method: "DELETE", path: "/events/:key/rsvp" },
    ],
  },
  {
    name: "moderator publish/cancel (/admin/events)",
    scope: "admin",
    routes: [
      { method: "GET", path: "/admin/events" },
      { method: "POST", path: "/admin/events" },
      { method: "GET", path: "/admin/events/new" },
      { method: "GET", path: "/admin/events/:key" },
      { method: "POST", path: "/admin/events/:key" },
      { method: "POST", path: "/admin/events/:key/publish" },
      { method: "POST", path: "/admin/events/:key/cancel" },
      { method: "POST", path: "/admin/events/:key/rsvp-pause" },
      { method: "POST", path: "/admin/events/:key/rsvp-reopen" },
    ],
  },
  {
    name: "member profile edit (/profile)",
    scope: "profile",
    routes: [
      { method: "GET", path: "/profile" },
      { method: "GET", path: "/members/:user" },
      { method: "PATCH", path: "/members/:user" },
      { method: "POST", path: "/members/:user" },
    ],
  },
];

const SECRET_PATTERNS = [
  /X-TWO-QA-Auth/i,
  /__Host-two_session\s*=/,
  /Bearer\s+[A-Za-z0-9._-]+/,
  /DISCORD_BOT_TOKEN/i,
  /discord\s+bot\s+token\s*[:=]/i,
];

export function scrubSecrets(text) {
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) hits.push(String(pattern));
  }
  return hits;
}

function countMatches(html, pattern) {
  return [...html.matchAll(pattern)].length;
}

// One assertion set per route response. Returns an array of failure labels
// (empty = pass). Pure: no I/O, no network.
export function assertRouteContract({ label, html, headers, status, expected }) {
  const failures = [];
  const get = (name) => headers.get?.(name) ?? headers[name.toLowerCase()] ?? null;
  if (status !== expected.status) {
    failures.push(`${label}: status ${status} !== ${expected.status}`);
    return failures;
  }
  const contentType = get("content-type") ?? "";
  if (!/text\/html/.test(contentType))
    failures.push(`${label}: content-type ${contentType} is not HTML`);
  const marker = get("x-two-renderer");
  if (marker !== expected.marker) {
    failures.push(
      `${label}: renderer marker ${JSON.stringify(marker)} !== ${JSON.stringify(expected.marker)}`,
    );
  }
  if (expected.marker === null && marker !== null) {
    failures.push(`${label}: Hono-owned route must not carry the Kit marker`);
  }
  // Semantic DOM/a11y contract (component snapshots stay unit-fast; this is
  // the runtime proof).
  if (countMatches(html, /<main(?:\s|>)/gi) !== 1) failures.push(`${label}: exactly one <main>`);
  if (!html.includes('class="skip-link" href="#main"'))
    failures.push(`${label}: skip link targets #main`);
  if (!html.includes('aria-label="Primary"'))
    failures.push(`${label}: primary nav has an accessible name`);
  if (!html.includes('<link rel="canonical"')) failures.push(`${label}: one canonical URL`);
  if (!html.includes('data-testid="past-events"'))
    failures.push(`${label}: archive section testid present (no-JS content)`);
  if (!html.includes('<meta name="robots" content="noindex, follow"'))
    failures.push(`${label}: archive never indexes`);
  if (!html.includes('<script src="/islands/past-events.js"'))
    failures.push(`${label}: shared island binder`);
  if (html.includes("Cross-site POST form submissions"))
    failures.push(`${label}: bare Kit CSRF text (must be the hardened gate)`);
  // Account chrome: the public archive is guest-only.
  if (!html.includes("Welcome, guest")) failures.push(`${label}: guest account chrome`);
  if (html.includes("Sign out")) failures.push(`${label}: guest page must not show Sign out`);
  const secretHits = scrubSecrets(html);
  if (secretHits.length)
    failures.push(`${label}: secret-shaped content in HTML (${secretHits.length} patterns)`);
  return failures;
}

export function assertReservedContract({ label, status, headers }) {
  const failures = [];
  const get = (name) => headers.get?.(name) ?? headers[name.toLowerCase()] ?? null;
  if (status !== 200) failures.push(`${label}: status ${status} !== 200`);
  if (get("x-two-renderer") !== null)
    failures.push(`${label}: reserved path must not carry the Kit marker`);
  return failures;
}

function goodFixture() {
  return (
    `<html><head><link rel="canonical" href="https://next.togetherweown.com/events/past">` +
    `<meta name="robots" content="noindex, follow"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"><a href="/events" aria-current="page">Events</a></nav>` +
    `<main id="main" class="events-page"><section data-testid="past-events">` +
    `<div data-testid="past-events-list"><article data-event-key="k1"></article></div>` +
    `</section></main><p>Welcome, guest</p>` +
    `<script src="/islands/past-events.js"></script></body></html>`
  );
}

function headerMap(entries) {
  return { get: (name) => entries[name.toLowerCase()] ?? null };
}

export function runUnitMode({ stdout = process.stdout, manifestSource: manifestOverride } = {}) {
  const journeys = [];
  const push = (name, status, reason = null) => journeys.push({ name, status, reason });
  const manifestSource =
    manifestOverride ?? readFileSync(new URL("../src/route-ownership.ts", import.meta.url), "utf8");
  const marker = expectedMarkerFor(manifestSource, "/events/past");
  stdout.write(
    `kit-parity-gates: manifest expects marker ${JSON.stringify(marker)} for /events/past\n`,
  );

  // Positive control: the good fixture passes every helper.
  const goodFailures = assertRouteContract({
    label: "unit/good-fixture",
    html: goodFixture(),
    headers: headerMap({ "content-type": "text/html", "x-two-renderer": marker }),
    status: 200,
    expected: { status: 200, marker },
  });
  push(
    "unit: good fixture passes",
    goodFailures.length === 0 ? "passed" : "failed",
    goodFailures.join("; ") || null,
  );

  // Forced-failure proof: each planted mutant must FAIL its helper. A gate
  // that cannot fail on a planted break proves nothing.
  const mutants = [
    [
      "no-main",
      (html) => html.replace(/<main id="main"/, '<div id="main"').replace(/<\/main>/, "</div>"),
    ],
    [
      "no-skip-link",
      (html) => html.replace('class="skip-link" href="#main"', 'class="skip-link" href="#other"'),
    ],
    ["no-canonical", (html) => html.replace('<link rel="canonical"', '<link rel="alternate"')],
    ["signed-in-chrome", (html) => html.replace("Welcome, guest", "Sign out")],
    ["bare-csrf-text", (html) => `${html}Cross-site POST form submissions`],
    ["secret-leak", (html) => `${html}<meta name="x" content="Bearer abc.def.ghi">`],
  ];
  for (const [name, mutate] of mutants) {
    const failures = assertRouteContract({
      label: `unit/mutant-${name}`,
      html: mutate(goodFixture()),
      headers: headerMap({ "content-type": "text/html", "x-two-renderer": marker }),
      status: 200,
      expected: { status: 200, marker },
    });
    push(
      `unit: mutant ${name} fails`,
      failures.length > 0 ? "passed" : "failed",
      failures.length > 0 ? null : "mutant was NOT detected",
    );
  }

  // Wrong-marker mutant: Hono-owned route carrying the Kit marker must fail.
  const markerFailures = assertRouteContract({
    label: "unit/mutant-marker",
    html: goodFixture(),
    headers: headerMap({
      "content-type": "text/html",
      "x-two-renderer": marker === null ? "kit" : null,
    }),
    status: 200,
    expected: { status: 200, marker },
  });
  push(
    "unit: wrong renderer marker fails",
    markerFailures.length > 0 ? "passed" : "failed",
    markerFailures.length > 0 ? null : "marker mismatch was NOT detected",
  );

  // Reserved probes never carry the marker.
  const reservedFailures = assertReservedContract({
    label: "unit/reserved-/up",
    status: 200,
    headers: headerMap({}),
  });
  push(
    "unit: reserved /up has no Kit marker",
    reservedFailures.length === 0 ? "passed" : "failed",
    reservedFailures.join("; ") || null,
  );

  // Seeded roles: member chrome fragment is distinguishable from guest chrome.
  const memberChrome = `<strong data-testid="explicit-account-chrome">Signed in as a member</strong>`;
  push(
    "unit: member chrome fragment is explicit (not guest)",
    memberChrome.includes("explicit-account-chrome") && !memberChrome.includes("Welcome, guest")
      ? "passed"
      : "failed",
  );

  // Login journeys stay Hono-only until their routes migrate. A Hono-owned
  // route ledgers as skipped WITH a reason — loud and countable, never a
  // quiet green. The moment the manifest enables a route, the skip becomes a
  // failure (no executed parity journey covers it yet), so the first
  // Kit-native member route can never ship on a green ledger with no run.
  // Coverage is scope-first: ANY enabled entry under the journey's scope
  // fails it, even when the entry is a route the explicit list never named
  // (renamed :param, new action, legacy redirect). The explicit list names
  // the known routes for a precise reason; the scope is the fail-closed net.
  // Explicit ownership goes through isManifestEnabled — the same structural,
  // method-aware primitive its tests pin — so those tests guard the real gate
  // path instead of a parallel matcher. A final catch-all fails any other
  // enabled entry no executed run covers (today only GET/HEAD /events/past
  // via PARITY_ROUTES): GET /admin, /events, /join, / and friends can never
  // ship green with no journey.
  const manifestEntries = parseManifestEntries(manifestSource);
  for (const { name, routes, scope } of LOGIN_JOURNEYS) {
    const enabledInScope = manifestEntries.filter(
      (entry) => entry.enabled && isInJourneyScope(scope, entry.path),
    );
    if (enabledInScope.length > 0) {
      const listed = enabledInScope.map((entry) => `${entry.method} ${entry.path}`).join(", ");
      const explicitHits = routes.filter((route) =>
        isManifestEnabled(manifestSource, route.path, route.method),
      );
      const coverage =
        explicitHits.length > 0
          ? `known route${explicitHits.length > 1 ? "s" : ""}`
          : "scoped route";
      push(
        `parity: ${name}`,
        "failed",
        `route Kit-native (ROUTE_MANIFEST enabled:true for ${listed}; ${coverage}) but no executed parity journey covers it`,
      );
    } else {
      push(`parity: ${name}`, "skipped", "route not Kit-native (ROUTE_MANIFEST enabled:false)");
    }
  }

  const outOfScopeUncovered = manifestEntries.filter(
    (entry) =>
      entry.enabled &&
      !isCoveredByExecutedRun(entry) &&
      !["rsvp", "admin", "profile"].some((scope) => isInJourneyScope(scope, entry.path)),
  );
  for (const entry of outOfScopeUncovered) {
    push(
      `parity: uncovered Kit-native route (${entry.method} ${entry.path})`,
      "failed",
      `route Kit-native (ROUTE_MANIFEST enabled:true for ${entry.method} ${entry.path}) but no executed parity journey covers it`,
    );
  }

  return journeys;
}

export function summarizeLedger(journeys) {
  const counts = {
    total: journeys.length,
    passed: journeys.filter((j) => j.status === "passed").length,
    failed: journeys.filter((j) => j.status === "failed").length,
    skipped: journeys.filter((j) => j.status === "skipped").length,
  };
  let verdict = "pass";
  if (counts.total === 0) verdict = "empty";
  else if (counts.failed > 0) verdict = "fail";
  else if (counts.passed === 0) verdict = "all-skipped";
  return { version: 1, counts, journeys, verdict };
}

export function formatLedgerMarkdown(summary) {
  const lines = [
    "## Kit parity ledger",
    "",
    `Verdict: **${summary.verdict}** — ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped, ${summary.counts.total} total.`,
    "",
    "| Journey | Status | Reason |",
    "| --- | --- | --- |",
  ];
  for (const journey of summary.journeys) {
    const cells = [journey.name, journey.status, journey.reason ?? "—"].map((cell) =>
      String(cell).replace(/\\/g, "\\\\").replace(/\|/g, "\\|"),
    );
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function writeLedger(
  summary,
  { stdout = process.stdout, stepSummaryPath = process.env.GITHUB_STEP_SUMMARY } = {},
) {
  mkdirSync(resolve("test-results"), { recursive: true });
  writeFileSync(
    resolve("test-results/kit-parity-ledger.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  const md = formatLedgerMarkdown(summary);
  writeFileSync(resolve("test-results/kit-parity-ledger.md"), `${md}\n`);
  stdout.write(
    `Kit parity ledger: ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped, ${summary.counts.total} total (verdict: ${summary.verdict}).\n`,
  );
  for (const journey of summary.journeys) {
    stdout.write(
      ` - [${journey.status}] ${journey.name}${journey.reason ? ` — ${journey.reason}` : ""}\n`,
    );
  }
  if (stepSummaryPath) {
    try {
      appendFileSync(resolve(stepSummaryPath), `\n${md}\n`);
    } catch {
      // Step summaries are best-effort outside Actions.
    }
  }
  const ledgerText = JSON.stringify(summary);
  const secretHits = scrubSecrets(ledgerText);
  if (secretHits.length) {
    stdout.write(
      `kit-parity-gates: secret-shaped content in ledger (${secretHits.length} patterns) — failing.\n`,
    );
    return 1;
  }
  if (summary.verdict === "empty" || summary.verdict === "all-skipped") return 2;
  if (summary.verdict === "fail") return 1;
  return 0;
}

async function runPreviewMode(
  kitBase,
  honoBase,
  { stdout = process.stdout, fetchImpl = fetch } = {},
) {
  const manifestSource = readFileSync(
    new URL("../src/route-ownership.ts", import.meta.url),
    "utf8",
  );
  const journeys = [];
  for (const route of PARITY_ROUTES) {
    const expectedMarker =
      route.expectMarker === "manifest"
        ? expectedMarkerFor(manifestSource, route.path)
        : route.expectMarker;
    let kitRes;
    let honoRes;
    try {
      [kitRes, honoRes] = await Promise.all(
        [kitBase, honoBase].map((base) =>
          fetchImpl(new URL(route.path, base), {
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          }),
        ),
      );
    } catch (error) {
      journeys.push({
        name: `preview: ${route.path} fetch`,
        status: "failed",
        reason: String(error?.message ?? error).slice(0, 200),
      });
      continue;
    }
    const kitHtml = kitRes.status === 200 ? await kitRes.text() : "";
    const honoHtml = honoRes.status === 200 ? await honoRes.text() : "";
    const kitFailures = assertRouteContract({
      label: `preview Kit ${route.path}`,
      html: kitHtml,
      headers: kitRes.headers,
      status: kitRes.status,
      expected: { status: route.expectStatus, marker: expectedMarker },
    });
    journeys.push({
      name: `preview Kit ${route.path}: contract`,
      status: kitFailures.length ? "failed" : "passed",
      reason: kitFailures.join("; ").slice(0, 200) || null,
    });
    // The Hono side runs the same contract helpers (expected marker null):
    // a Hono-side regression outside the section would otherwise go
    // unflagged in preview mode.
    const honoFailures = assertRouteContract({
      label: `preview Hono ${route.path}`,
      html: honoHtml,
      headers: honoRes.headers,
      status: honoRes.status,
      expected: { status: route.expectStatus, marker: null },
    });
    journeys.push({
      name: `preview Hono ${route.path}: no Kit marker`,
      status: honoFailures.length ? "failed" : "passed",
      reason: honoFailures.join("; ").slice(0, 200) || null,
    });
    if (kitRes.status === 200 && honoRes.status === 200) {
      // Framework-tolerant comparison (ci/kit-section-contract.mjs): raw
      // bytes always differ (hydration markers, boolean attributes, `>`
      // escaping), so compare the normalized contract, not the bytes.
      let same = false;
      let reason = "section HTML differs";
      try {
        same = sectionOf(kitHtml, "past-events") === sectionOf(honoHtml, "past-events");
        if (same) reason = null;
      } catch (error) {
        reason = String(error?.message ?? error).slice(0, 200);
      }
      journeys.push({
        name: `preview ${route.path}: sections match`,
        status: same ? "passed" : "failed",
        reason,
      });
    }
  }
  for (const probe of RESERVED_PROBES) {
    let res;
    try {
      res = await fetchImpl(new URL(probe.path, kitBase), {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      journeys.push({
        name: `preview reserved ${probe.path} fetch`,
        status: "failed",
        reason: String(error?.message ?? error).slice(0, 200),
      });
      continue;
    }
    const failures = assertReservedContract({
      label: `preview reserved ${probe.path}`,
      status: res.status,
      headers: res.headers,
    });
    journeys.push({
      name: `preview reserved ${probe.path}: no Kit marker`,
      status: failures.length ? "failed" : "passed",
      reason: failures.join("; ").slice(0, 200) || null,
    });
  }
  return journeys;
}

export async function runGate({
  env = process.env,
  stdout = process.stdout,
  fetchImpl = fetch,
} = {}) {
  const pair = validatePreviewPair(env.KIT_PREVIEW_URL, env.HONO_PREVIEW_URL);
  if (!pair.ok) {
    stdout.write(`${pair.error}\n`);
    return 2;
  }
  const journeys =
    pair.mode === "preview"
      ? await runPreviewMode(pair.kitBase, pair.honoBase, { stdout, fetchImpl })
      : runUnitMode({ stdout });
  return writeLedger(summarizeLedger(journeys), { stdout });
}

function selftest() {
  let count = 0;
  const check = (name, condition) => {
    if (!condition) throw new Error(`selftest FAIL: ${name}`);
    count += 1;
    console.log(`PASS ${name}`);
  };
  // Pairing + allowlist.
  check("neither URL is unit mode", validatePreviewPair("", "").mode === "unit");
  check(
    "one-sided kit exits before fetch",
    validatePreviewPair("https://a.workers.dev/", "").ok === false,
  );
  check(
    "one-sided hono exits before fetch",
    validatePreviewPair("", "https://b.workers.dev/").ok === false,
  );
  check(
    "http rejected",
    validatePreviewPair("http://a.workers.dev/", "https://b.workers.dev/").ok === false,
  );
  check(
    "apex rejected",
    validatePreviewPair("https://togetherweown.com/", "https://next.togetherweown.com/").ok ===
      false,
  );
  check(
    "staging + preview pair ok",
    validatePreviewPair(
      "https://two-web-next-kit-preview.5150.workers.dev/",
      "https://next.togetherweown.com/",
    ).mode === "preview",
  );
  check(
    "self-pair rejected",
    validatePreviewPair("https://next.togetherweown.com/", "https://next.togetherweown.com/").ok ===
      false,
  );
  check(
    "path rejected",
    validatePreviewPair("https://a.workers.dev/events", "https://next.togetherweown.com/").ok ===
      false,
  );
  // Ledger verdicts mirror the staging gate: quiet green is impossible.
  check("empty ledger verdict", summarizeLedger([]).verdict === "empty");
  check(
    "all-skipped verdict",
    summarizeLedger([{ name: "a", status: "skipped", reason: "r" }]).verdict === "all-skipped",
  );
  check(
    "fail verdict",
    summarizeLedger([{ name: "a", status: "failed", reason: "r" }]).verdict === "fail",
  );
  // Secret scrub.
  check("token hit", scrubSecrets("X-TWO-QA-Auth: abc").length === 1);
  check("clean text", scrubSecrets("Welcome, guest").length === 0);
  console.log(`kit-parity-gates selftest: ${count} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  if (args.length === 1 && args[0] === "--selftest") {
    process.exitCode = selftest();
  } else if (args.length === 0) {
    runGate().then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(`kit-parity-gates: ${error?.message ?? error}`);
        process.exitCode = 1;
      },
    );
  } else {
    console.error("Usage: node ci/kit-parity-gates.mjs [--selftest]");
    process.exitCode = 2;
  }
}
