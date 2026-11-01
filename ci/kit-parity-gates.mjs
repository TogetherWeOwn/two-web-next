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
import { STAGING_ORIGIN } from "./operator-constants.mjs";

export const PARITY_ROUTES = [
  {
    path: "/events/past",
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "archive",
    compareSection: "past-events",
  },
  {
    path: "/events/past?page=2",
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "archive",
    compareSection: "past-events",
  },
  // GET /events only: POST /events and /events.json stay Hono-owned, so the
  // write and JSON contracts keep one authority. No byte section compare:
  // rows are live database reads (staging is often empty), so preview proves
  // the structural contract on both sides instead of equal bytes; the
  // hermetic calendar-parity and acceptance suites pin byte-identity from
  // the same model.
  {
    path: "/events",
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "events",
    cachePattern: /^public, max-age=(?:[1-9]|[1-5]\d|60)$/,
    compareSection: null,
  },
  // GET /join only: /join/discord + /join/callback stay Hono-owned, so the
  // funnel keeps one OAuth authority. No byte section compare: the widget
  // zone is environment-dependent (the guild id — and therefore facade vs
  // presence vs fallback — differs per worker), so preview proves the
  // structural contract on both sides instead of equal bytes.
  {
    path: "/join",
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "join",
    cache: ["public, max-age=60", "public, max-age=3600"],
    compareSection: null,
  },
  // GET /auth/recover only: the one-use journey writes stay Hono-owned, so
  // the cookie-setting controller keeps single OAuth authority. No byte
  // section compare: the retry href carries the caller's ?next= and the
  // Set-Cookie values differ per response, so preview proves the structural
  // contract on both sides instead of equal bytes.
  {
    path: "/auth/recover",
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "recovery",
    cache: "no-store, private",
    compareSection: null,
  },
  // Static public leaves: DB-free reads from the shared content modules,
  // Kit-owned with the same public 3600s cache as the Hono handlers
  // (csr=false, no hydration bundle). No byte section compare: the
  // frameworks serialize the shared sections differently, so preview proves
  // the structural contract (heading, strap, testids, same-origin join
  // action) on both sides instead of equal bytes.
  {
    path: "/about",
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "about",
    cache: "public, max-age=3600",
    compareSection: null,
  },
  {
    path: "/faq",
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "faq",
    cache: "public, max-age=3600",
    compareSection: null,
  },
  // Hot-zone heatmaps: public aggregates, Kit-owned with the same
  // reads as the Hono handlers. No byte section compare: the joins grid reads
  // live join_attempts/event rows, so Hono vs Kit bytes differ by design;
  // preview proves the structural contract on both sides instead. Concrete
  // signal paths only, matching the manifest (no :param pattern).
  ...["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"].map((path) => ({
    path,
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "hotzones",
    compareSection: null,
  })),
  // Member leaderboard: authenticated member view only, so the preview
  // journeys carry a QA session (auth: "member") or none (auth: "guest").
  // No byte section compare: rows are per-viewer, so preview proves the
  // structural contract on both sides instead. Admission answers (guest
  // 302, grammar 400s) pin status + no-board + secret scrub only; the 403
  // non-member arm cannot be minted by the QA seam (both QA identities are
  // members) and stays pinned hermetically.
  {
    path: "/leaderboards/members",
    label: "members guest bounce",
    expectStatus: 302,
    expectMarker: "manifest",
    contract: "members-admission",
    compareSection: null,
    auth: "guest",
  },
  ...[
    "/leaderboards/members",
    "/leaderboards/members?scope=relative",
    "/leaderboards/members?season=2026",
    "/leaderboards/members?activity=valheim",
  ].map((path) => ({
    path,
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "members",
    cache: "private, no-store",
    compareSection: null,
    auth: "member",
  })),
  ...[
    ["/leaderboards/members?season=bogus", "members bad season"],
    ["/leaderboards/members?scope=friends", "members deferred scope"],
    ["/leaderboards/members?activity=chess%21", "members bad activity"],
  ].map(([path, label]) => ({
    path,
    label,
    expectStatus: 400,
    expectMarker: "manifest",
    contract: "members-admission",
    compareSection: null,
    auth: "member",
  })),
  // Moderator join-attempts audit: moderator-only member data, so the
  // preview journeys carry a QA moderator session (auth: "moderator"), a
  // QA member session for the refusal (auth: "member"), or none (auth:
  // "guest"). No byte section compare: rows are live audit reads, so
  // preview proves the structural contract on both sides instead. The
  // detail journey pins a canonical missing id: no seeded attempt id is
  // stable on staging (the retention window prunes old rows), so the
  // served-detail contract is proven by the unit fixtures here and the
  // hermetic Kit suites, while preview pins the 404 admission on both
  // renderers so a missing row never leaks a detail page.
  {
    path: "/admin/join-attempts",
    label: "join-attempts guest bounce",
    expectStatus: 302,
    expectMarker: "manifest",
    contract: "join-attempts-admission",
    compareSection: null,
    auth: "guest",
  },
  {
    path: "/admin/join-attempts",
    label: "join-attempts member refusal",
    expectStatus: 403,
    expectMarker: "manifest",
    contract: "join-attempts-admission",
    compareSection: null,
    auth: "member",
  },
  {
    path: "/admin/join-attempts",
    expectStatus: 200,
    expectMarker: "manifest",
    contract: "join-attempts",
    cache: "private, no-store",
    compareSection: null,
    auth: "moderator",
  },
  {
    path: "/admin/join-attempts/999999",
    label: "join-attempt detail missing",
    expectStatus: 404,
    expectMarker: "manifest",
    contract: "join-attempts-admission",
    compareSection: null,
    auth: "moderator",
  },
];

export const RESERVED_PROBES = [{ path: "/up", expectStatus: 200, expectMarker: null }];

// Staging-allowlisted preview hosts: the staging Worker and preview Workers
// only. Apex, production or arbitrary hosts are never a valid parity pair.
const STAGING_HOST = new URL(STAGING_ORIGIN).hostname;
export function isAllowlistedHost(hostname) {
  if (hostname === STAGING_HOST) return true;
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
        error: `kit-parity-gates: ${label} host ${url.hostname} is not staging-allowlisted (${STAGING_HOST} or *.workers.dev)`,
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
// never sets the marker — that is the rollback. Derived per queried path
// (query stripped: /events/past?page=2 follows its page), field-order
// independent like parseManifestEntries.
export function expectedMarkerFor(manifestSource, path) {
  const base = path.split(/[?#]/)[0];
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match =
    manifestSource.match(new RegExp(`path:\\s*"${escaped}"[^}]*enabled:\\s*(true|false)`)) ??
    manifestSource.match(new RegExp(`enabled:\\s*(true|false)[^}]*path:\\s*"${escaped}"`));
  if (match) return match[1] === "true" ? "kit" : null;
  // A concrete instance of a `:param` entry (/admin/join-attempts/999999 for
  // /admin/join-attempts/:id) derives from its pattern entry, structurally
  // like the runtime router: the literal scan above cannot see it.
  const structural = parseManifestEntries(manifestSource).find(
    (entry) => entry.method.toUpperCase() === "GET" && pathsMatchStructurally(entry.path, base),
  );
  if (structural) return structural.enabled ? "kit" : null;
  // A parity route with no manifest entry is a gate bug, never a quiet Hono:
  // fail closed so a dropped entry cannot ship as "expected Hono".
  if (PARITY_ROUTES.some((route) => route.path.split(/[?#]/)[0] === base)) {
    throw new Error(`kit-parity-gates: cannot derive ${base} owner from ROUTE_MANIFEST`);
  }
  return null;
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
//
// Blocks are extracted brace-aware: a `reads: { ... }` nested object no
// longer truncates the entry (a flat `\{[^{}]*\}` scan went blind on every
// nested-reads route — /admin, /profile, /members/:user,
// /leaderboards/members — and let an enabled member board ship on a green
// ledger with no run). Strings and comments never contribute braces.
export function parseManifestEntries(manifestSource) {
  const entries = [];
  const len = manifestSource.length;
  let i = 0;
  while (i < len) {
    if (manifestSource[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let j = i;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let end = -1;
    while (j < len) {
      const ch = manifestSource[j];
      const nxt = j + 1 < len ? manifestSource[j + 1] : "";
      if (lineComment) {
        if (ch === "\n") lineComment = false;
        j += 1;
        continue;
      }
      if (blockComment) {
        if (ch === "*" && nxt === "/") {
          blockComment = false;
          j += 2;
          continue;
        }
        j += 1;
        continue;
      }
      if (quote !== null) {
        if (escaped) {
          escaped = false;
          j += 1;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          j += 1;
          continue;
        }
        if (ch === quote) quote = null;
        j += 1;
        continue;
      }
      if (ch === "/" && nxt === "/") {
        lineComment = true;
        j += 2;
        continue;
      }
      if (ch === "/" && nxt === "*") {
        blockComment = true;
        j += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        j += 1;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
      j += 1;
    }
    if (end === -1) break;
    const block = manifestSource.slice(i, end + 1);
    i = end + 1;
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

// Coverage: the executed parity runs are GET/HEAD /events/past, GET/HEAD
// /events, /join, /auth/recover, the four hot-zone paths,
// /leaderboards/members and the moderator /admin/join-attempts pair via
// PARITY_ROUTES (unit contract + preview fetch,
// with the member-board journey also running authenticated in the Playwright
// Hono-vs-Kit journey). Any other enabled
// entry has no run covering it and must
// fail — the scopes below only choose the journey name for the failure
// message, never whether it fails.
export function isCoveredByExecutedRun(entry) {
  const method = entry.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const base = entry.path.split(/[?#]/)[0];
  const routeBases = PARITY_ROUTES.map((route) => route.path.split(/[?#]/)[0]);
  if (!base.includes(":")) return routeBases.some((routeBase) => base === routeBase);
  // A `:param` pattern family (e.g. GET /events/:key) is never covered by a
  // static sibling run (/events/past owns its own handler): only a concrete
  // parity instance of the pattern itself covers it, and only when every
  // `:param` position carries a numeric id segment — an id instance of the
  // pattern handler, never a static word that names a different page.
  const patternParts = base.split("/");
  return routeBases.some((routeBase) => {
    if (!pathsMatchStructurally(base, routeBase)) return false;
    const routeParts = routeBase.split("/");
    return patternParts.every(
      (part, i) => !part.startsWith(":") || /^\d+$/.test(routeParts[i] ?? ""),
    );
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
  const contract = expected.contract ?? "archive";
  // Transient outcome pages ship no canonical link on either renderer (unlike
  // the archive/landing contracts), so only those require one here.
  if (contract !== "recovery" && !html.includes('<link rel="canonical"'))
    failures.push(`${label}: one canonical URL`);
  if (contract === "archive") {
    if (!html.includes('data-testid="past-events"'))
      failures.push(`${label}: archive section testid present (no-JS content)`);
    if (!html.includes('<meta name="robots" content="noindex, follow"'))
      failures.push(`${label}: archive never indexes`);
    if (!html.includes('<script src="/islands/past-events.js"'))
      failures.push(`${label}: shared island binder`);
  } else if (contract === "join") {
    failures.push(...assertJoinContract(label, html, get, expected));
  } else if (contract === "recovery") {
    failures.push(...assertRecoveryContract(label, html, get, expected));
  } else if (contract === "about") {
    failures.push(...assertAboutContract(label, html, get, expected));
  } else if (contract === "faq") {
    failures.push(...assertFaqContract(label, html, get, expected));
  } else if (contract === "hotzones") {
    if (!/hot zone/i.test(html)) failures.push(`${label}: hot-zone heading present`);
    if (!html.includes("<table>")) failures.push(`${label}: 7x24 grid table present`);
    if (!html.includes('<meta name="robots" content="noindex, follow"'))
      failures.push(`${label}: hot-zones never index`);
    if (/discord_id|created_at/i.test(html))
      failures.push(`${label}: aggregate only, no per-attempt fields`);
  } else if (contract === "events") {
    failures.push(...assertEventsContract(label, html, get, expected));
  } else {
    failures.push(`${label}: unknown contract ${JSON.stringify(contract)}`);
  }
  if (html.includes("Cross-site POST form submissions"))
    failures.push(`${label}: bare Kit CSRF text (must be the hardened gate)`);
  // Account chrome: the public archive and the join landing are guest-only.
  if (!html.includes("Welcome, guest")) failures.push(`${label}: guest account chrome`);
  if (html.includes("Sign out")) failures.push(`${label}: guest page must not show Sign out`);
  const secretHits = scrubSecrets(html);
  if (secretHits.length)
    failures.push(`${label}: secret-shaped content in HTML (${secretHits.length} patterns)`);
  return failures;
}

// The one-click href must be the bare start or carry a safe same-origin next.
// Mirrors safeNext (src/join/service.ts) minus the control-byte check: an
// HTML attribute value cannot smuggle a header-breaking byte past the
// serializer, so the redirect guard (single leading slash, no scheme,
// no backslash) is the check that matters here.
function joinOneClickHrefOk(href) {
  if (href === "/join/discord") return true;
  const prefix = "/join/discord?next=";
  if (!href.startsWith(prefix)) return false;
  let next;
  try {
    next = decodeURIComponent(href.slice(prefix.length));
  } catch {
    return false;
  }
  return (
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.includes("\\") &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(next)
  );
}

function oneClickHrefOf(html) {
  const match =
    html.match(/data-testid="join-oneclick"[^>]*href="([^"]+)"/) ??
    html.match(/href="([^"]+)"[^>]*data-testid="join-oneclick"/);
  return match ? match[1] : null;
}

// Join landing contract (src/screens/join.tsx): the funnel keeps its actions,
// URLs and testids on every renderer, the widget zone shows exactly one
// state (cold facade link, warm presence + facade link, or static fallback),
// and the flash view is private. The presence block renders aggregates only —
// member names never reach this logged-out page (privacy policy v2).
function assertJoinContract(label, html, get, expected) {
  const failures = [];
  // Cache acceptance: public 3600 only without a flash, otherwise
  // private/no-store. Vary stays on every variant: the representation depends
  // on the flash cookie even when the view has nothing to consume.
  if (expected.cache !== undefined && expected.cache !== null) {
    const actual = get("cache-control") ?? "";
    const allowed = Array.isArray(expected.cache) ? expected.cache : [expected.cache];
    if (!allowed.includes(actual))
      failures.push(
        `${label}: cache-control ${JSON.stringify(actual)} not in ${allowed.join(" | ")}`,
      );
  }
  const vary = get("vary") ?? "";
  if (!/cookie/i.test(vary)) failures.push(`${label}: Vary stays on every variant`);
  if (!html.includes('class="join-layout"'))
    failures.push(`${label}: join two-column layout present (no-JS content)`);
  if (!html.includes('data-testid="join-oneclick"'))
    failures.push(`${label}: one-click action present`);
  if (!html.includes('data-testid="join-invite"'))
    failures.push(`${label}: invite fallback action present`);
  const href = oneClickHrefOf(html);
  if (href === null) failures.push(`${label}: one-click href readable`);
  else if (!joinOneClickHrefOk(href))
    failures.push(`${label}: hostile next leaves no trace in the one-click href`);
  const hasLoad = html.includes('data-testid="join-widget-load"');
  const hasFallback = html.includes('data-testid="join-widget-fallback"');
  const hasPresence = html.includes('data-testid="join-widget-presence"');
  // Exactly one zone: the facade link and the static fallback never co-render,
  // and presence rides the facade link (the live frame needs its click target).
  if (hasLoad === hasFallback)
    failures.push(`${label}: exactly one widget zone (facade link xor fallback)`);
  if (hasPresence && !hasLoad)
    failures.push(`${label}: presence never renders without its facade link`);
  if (hasLoad && !html.includes('<script src="/islands/join-widget.js"'))
    failures.push(`${label}: facade zone carries the shared island binder`);
  if (!hasLoad && html.includes('<script src="/islands/join-widget.js"'))
    failures.push(`${label}: fallback zone ships no island script`);
  if (html.includes("<iframe")) failures.push(`${label}: no iframe before a visitor click`);
  if (html.includes('data-testid="join-widget-members"'))
    failures.push(`${label}: no member names on the logged-out page`);
  if (!/\/join"/.test(html)) failures.push(`${label}: canonical points at /join`);
  // Flash privacy invariant, independent of the expected-cache pin: a view
  // carrying the one-shot banner is viewer-specific and never shared-cacheable.
  const cacheActual = get("cache-control") ?? "";
  const hasFlash = html.includes('data-testid="join-result"');
  if (hasFlash && cacheActual !== "private, no-store")
    failures.push(`${label}: flash view answers private, no-store`);
  if (!hasFlash && cacheActual === "private, no-store")
    failures.push(`${label}: flash-free view keeps its shared-cache TTL`);
  return failures;
}

// Events-list contract (src/events/pages-calendar-screen.tsx via
// src/kit-events-html.tsx): the native endpoint renders the Hono calendar
// screen, so the island identity, view toggles, search form, archive and
// subscribe links and markdown alternate ride both renderers. Rows are live
// reads (staging is often empty), so cards are never required here — the
// hermetic calendar-parity and acceptance suites pin seeded rows. Cache
// acceptance: public 60 only without a flash, session or search, otherwise
// private/no-store; Vary stays on every variant. A flashed view is
// viewer-specific and never shared-cacheable.
function assertEventsContract(label, html, get, expected) {
  const failures = [];
  const cacheActual = get("cache-control") ?? "";
  if (expected.cachePattern instanceof RegExp) {
    if (!expected.cachePattern.test(cacheActual))
      failures.push(
        `${label}: cache-control ${JSON.stringify(cacheActual)} does not match ${expected.cachePattern}`,
      );
  } else if (expected.cache !== undefined && expected.cache !== null) {
    const allowed = Array.isArray(expected.cache) ? expected.cache : [expected.cache];
    if (!allowed.includes(cacheActual))
      failures.push(
        `${label}: cache-control ${JSON.stringify(cacheActual)} not in ${allowed.join(" | ")}`,
      );
  }
  const varyTokens = new Set(
    (get("vary") ?? "").split(",").map((token) => token.trim().toLowerCase()),
  );
  if (!varyTokens.has("cookie")) failures.push(`${label}: Vary stays on every variant`);
  if (!varyTokens.has("x-two-island"))
    failures.push(
      `${label}: Vary distinguishes full vs island-fragment representations (Cookie, X-Two-Island)`,
    );
  if (!html.includes('data-island="events-calendar"'))
    failures.push(`${label}: calendar island identity present (no-JS content)`);
  if (!html.includes('data-testid="events-calendar"'))
    failures.push(`${label}: calendar section testid present (no-JS content)`);
  if (!html.includes('data-testid="events-list"'))
    failures.push(`${label}: list section testid present (no-JS content)`);
  if (!html.includes('data-testid="events-content"'))
    failures.push(`${label}: content section testid present (no-JS content)`);
  if (!html.includes('data-testid="events-view-list"'))
    failures.push(`${label}: list view toggle present`);
  if (!html.includes('data-testid="events-view-calendar"'))
    failures.push(`${label}: calendar view toggle present`);
  if (!html.includes('data-testid="events-search"'))
    failures.push(`${label}: search control present`);
  if (!html.includes('<form method="get" action="/events"'))
    failures.push(`${label}: search stays a GET form (no-JS fallback)`);
  if (!html.includes('name="q"')) failures.push(`${label}: search field keeps its query name`);
  if (
    !/<a\b(?=[^>]*\bdata-testid="events-past-archive-link")(?=[^>]*\bhref="\/events\/past")[^>]*>/.test(
      html,
    )
  )
    failures.push(`${label}: past-archive link present`);
  const canonicalHref = html.match(
    /<link\b(?=[^>]*\brel="canonical")(?=[^>]*\bhref="([^"]+)")[^>]*>/,
  )?.[1];
  const subscribeHref = html.match(
    /<a\b(?=[^>]*\bdata-testid="events-subscribe")(?=[^>]*\bhref="([^"]+)")[^>]*>/,
  )?.[1];
  let subscribeMatchesCanonicalHost = false;
  try {
    const canonicalUrl = canonicalHref ? new URL(canonicalHref) : null;
    const subscribeUrl = subscribeHref ? new URL(subscribeHref) : null;
    subscribeMatchesCanonicalHost =
      canonicalUrl !== null &&
      subscribeUrl !== null &&
      subscribeUrl.protocol === "webcal:" &&
      subscribeUrl.host === canonicalUrl.host &&
      subscribeUrl.pathname === "/events.ics" &&
      subscribeUrl.search === "" &&
      subscribeUrl.hash === "";
  } catch {
    subscribeMatchesCanonicalHost = false;
  }
  if (!subscribeMatchesCanonicalHost) failures.push(`${label}: subscribe action present`);
  if (!html.includes('<script src="/islands/events-calendar.js"'))
    failures.push(`${label}: shared island binder`);
  if (!html.includes('href="/events.md"')) failures.push(`${label}: markdown alternate present`);
  if (
    !/<link\b(?=[^>]*\brel="canonical")(?=[^>]*\bhref="https?:\/\/[^/"]+\/events")[^>]*>/.test(html)
  )
    failures.push(`${label}: canonical points at /events`);
  // Flash privacy invariant, independent of the expected-cache pin: a view
  // carrying the one-shot banner is viewer-specific and never shared-cacheable.
  // Only this direction is pinned — a flash-free member view is legitimately
  // private, so the reverse would false-fail signed-in renders.
  if (html.includes('data-testid="join-result"') && cacheActual !== "private, no-store")
    failures.push(`${label}: flash view answers private, no-store`);
  return failures;
}

// The retry href must be a bare OAuth start or carry a safe same-origin
// next. Mirrors safeNext (src/join/service.ts) minus the control-byte check:
// an HTML attribute value cannot smuggle a header-breaking byte past the
// serializer, so the redirect guard (single leading slash, no scheme,
// no backslash) is the check that matters here.
function recoveryRetryHrefOk(href) {
  for (const prefix of ["/join/discord", "/auth/discord"]) {
    if (href === prefix) return true;
    if (href.startsWith(`${prefix}?next=`)) {
      let next;
      try {
        next = decodeURIComponent(href.slice(prefix.length + "?next=".length));
      } catch {
        return false;
      }
      return (
        next.startsWith("/") &&
        !next.startsWith("//") &&
        !next.includes("\\") &&
        !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(next)
      );
    }
  }
  return false;
}

function recoveryHrefOf(html, testid) {
  const match =
    html.match(new RegExp(`data-testid="${testid}"[^>]*href="([^"]+)"`)) ??
    html.match(new RegExp(`href="([^"]+)"[^>]*data-testid="${testid}"`));
  return match ? match[1] : null;
}

// Recovery outcome contract (src/screens/recovery.tsx): every recovery
// outcome — expired session, denied consent, expired link, provider outage —
// carries the same shell on every renderer (hero chrome, heading, lead
// message, retry button + invite fallback with stable testids), ships no
// JavaScript, and always answers private, no-store: recovery views set and
// clear per-visitor journey cookies, so a shared-cacheable recovery is a
// privacy break however the expected cache is pinned. The invite fallback is
// a configured absolute invite or a same-origin path, never a script URL.
function assertRecoveryContract(label, html, get, expected) {
  const failures = [];
  if (expected.cache !== undefined && expected.cache !== null) {
    const actual = get("cache-control") ?? "";
    const allowed = Array.isArray(expected.cache) ? expected.cache : [expected.cache];
    if (!allowed.includes(actual))
      failures.push(
        `${label}: cache-control ${JSON.stringify(actual)} not in ${allowed.join(" | ")}`,
      );
  }
  const cacheActual = get("cache-control") ?? "";
  if (cacheActual !== "no-store, private")
    failures.push(`${label}: recovery answers private, no-store (per-visitor journey state)`);
  if (!html.includes('class="hero recovery-hero"'))
    failures.push(`${label}: recovery hero chrome present (no-JS content)`);
  // Apostrophe-free: Hono JSX escapes it, Svelte renders it raw.
  if (!html.includes("get you back to the lobby"))
    failures.push(`${label}: recovery strap present`);
  if (!html.includes('<h1 id="recovery-heading">'))
    failures.push(`${label}: recovery heading present`);
  if (!html.includes('data-testid="recovery-retry"'))
    failures.push(`${label}: retry action present`);
  if (!html.includes('data-testid="recovery-invite"'))
    failures.push(`${label}: invite fallback action present`);
  const retry = recoveryHrefOf(html, "recovery-retry");
  if (retry === null) failures.push(`${label}: retry href readable`);
  else if (!recoveryRetryHrefOk(retry))
    failures.push(`${label}: hostile next leaves no trace in the retry href`);
  const invite = recoveryHrefOf(html, "recovery-invite");
  if (invite === null) failures.push(`${label}: invite href readable`);
  else if (/^\s*javascript:/i.test(invite) || /^\s*data:/i.test(invite))
    failures.push(`${label}: invite fallback is never a script URL`);
  else if (!(invite.startsWith("/") && !invite.startsWith("//")) && !/^https:\/\//.test(invite))
    failures.push(`${label}: invite fallback is a safe destination`);
  if (html.includes("<script")) failures.push(`${label}: recovery ships no JavaScript`);
  if (html.includes("<iframe")) failures.push(`${label}: no iframe on the recovery page`);
  return failures;
}

// Static-leaf contracts (src/screens/about.tsx, src/screens/faq.tsx and
// their Kit twins web/src/routes/about/, web/src/routes/faq/): DB-free
// public reads from the shared content modules, csr=false so the contract
// is in the raw fetch body. Both renderers share the Leaf shell — one h1
// the content nav labels, the strap and lead, the fact/question testids
// and the join action — with the public 3600s cache both handlers set.
// The join action stays same-origin (/join): a leaf must never carry a
// hostile outbound href.
function leafJoinHrefOf(html, testid) {
  const match =
    html.match(new RegExp(`href="([^"]+)"[^>]*data-testid="${testid}"`)) ??
    html.match(new RegExp(`data-testid="${testid}"[^>]*href="([^"]+)"`));
  return match ? match[1] : null;
}

function assertLeafContract(label, html, get, expected, leaf) {
  const failures = [];
  if (expected.cache !== undefined && expected.cache !== null) {
    const actual = get("cache-control") ?? "";
    const allowed = Array.isArray(expected.cache) ? expected.cache : [expected.cache];
    if (!allowed.includes(actual))
      failures.push(
        `${label}: cache-control ${JSON.stringify(actual)} not in ${allowed.join(" | ")}`,
      );
  }
  const cacheActual = get("cache-control") ?? "";
  if (cacheActual !== "public, max-age=3600")
    failures.push(`${label}: leaf keeps the shared public cache contract`);
  if (!html.includes(`<h1 id="${leaf.headingId}">${leaf.heading}</h1>`))
    failures.push(`${label}: leaf heading present`);
  if (!html.includes(`<p class="strap">${leaf.strap}</p>`))
    failures.push(`${label}: leaf strap present`);
  for (const testid of leaf.testids) {
    if (!html.includes(`data-testid="${testid}"`))
      failures.push(`${label}: leaf section ${testid} present (no-JS content)`);
  }
  const join = leafJoinHrefOf(html, leaf.joinTestid);
  if (join === null) failures.push(`${label}: join action readable`);
  else if (join !== "/join") failures.push(`${label}: join action stays same-origin /join`);
  for (const extra of leaf.extras ?? []) {
    if (!html.includes(extra[0])) failures.push(`${label}: ${extra[1]}`);
  }
  if (html.includes("<script")) failures.push(`${label}: leaf ships no JavaScript`);
  if (html.includes("<iframe")) failures.push(`${label}: no iframe on the leaf page`);
  return failures;
}

function assertAboutContract(label, html, get, expected) {
  return assertLeafContract(label, html, get, expected, {
    headingId: "about-heading",
    heading: "About Together We Own",
    strap: "Est. 1998",
    testids: ["about-facts"],
    joinTestid: "about-join",
    extras: [],
  });
}

function assertFaqContract(label, html, get, expected) {
  return assertLeafContract(label, html, get, expected, {
    headingId: "faq-heading",
    heading: "Frequently asked questions",
    strap: "New here? Start here",
    testids: ["faq-list"],
    joinTestid: "faq-join",
    // The first question group proves the shared FAQ source renders, not an
    // empty shell around the join action.
    extras: [[`id="faq-getting-in"`, "first question group present"]],
  });
}

// Member-board contract (src/leaderboards/pages.tsx + Kit +page.svelte):
// authenticated member view only — Hono memberGate then season/scope/activity
// grammar (400 before any read), Kit load mirrors the order; both answer
// private, no-store with noindex, nofollow. Rank + display name + count only.
export function assertMembersContract({ label, html, headers, status, expected }) {
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
  if (countMatches(html, /<main(?:\s|>)/gi) !== 1) failures.push(`${label}: exactly one <main>`);
  if (!html.includes('class="skip-link" href="#main"'))
    failures.push(`${label}: skip link targets #main`);
  if (!html.includes('aria-label="Primary"'))
    failures.push(`${label}: primary nav has an accessible name`);
  if (!/<link\b[^>]*\brel="canonical"[^>]*\/leaderboards\/members[^>]*>/.test(html))
    failures.push(`${label}: canonical points at /leaderboards/members`);
  if (!html.includes('<meta name="robots" content="noindex, nofollow"'))
    failures.push(`${label}: member board never indexes`);
  if (!html.includes("<h1>Member leaderboard</h1>"))
    failures.push(`${label}: member-board heading present`);
  if (!html.includes("Members only")) failures.push(`${label}: members-only strap present`);
  if (!html.includes('aria-label="Board scope"'))
    failures.push(`${label}: board scope nav present`);
  if (!html.includes("Overall") || !html.includes("Around you"))
    failures.push(`${label}: overall + relative scope links present`);
  if (!html.includes('aria-label="Filter the leaderboard"'))
    failures.push(`${label}: board filter form present`);
  if (!html.includes('name="season"') || !html.includes('name="activity"'))
    failures.push(`${label}: season + activity inputs present`);
  const hasTable = /<table[\s>]/.test(html);
  const hasEmptyStatus =
    html.includes("Nobody is ranked for this season and game yet.") ||
    html.includes("You are not ranked for this season and game yet.") ||
    html.includes("Rankings are temporarily unavailable.");
  if (!hasTable && !hasEmptyStatus) failures.push(`${label}: board table or empty status present`);
  if (hasTable) {
    if (!html.includes('<th scope="col">Rank</th>')) failures.push(`${label}: rank column present`);
    if (!html.includes('<th scope="col">Member</th>'))
      failures.push(`${label}: member column present`);
    if (!html.includes('<th scope="col">Going</th>'))
      failures.push(`${label}: going column present`);
    const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
    if (tbody.includes('href="/members/'))
      failures.push(`${label}: board rows never link to profiles`);
  }
  if (/discord_id|created_at/i.test(html))
    failures.push(`${label}: rank rows only, no per-attempt fields`);
  // Authenticated member chrome only: a guest banner on this page is a leak.
  if (!html.includes("Sign out")) failures.push(`${label}: member account chrome`);
  if (html.includes("Welcome, guest"))
    failures.push(`${label}: member page must not show guest chrome`);
  if (html.includes("Cross-site POST form submissions"))
    failures.push(`${label}: bare Kit CSRF text (must be the hardened gate)`);
  // Privacy invariant, independent of the expected-cache pin: the board carries
  // per-viewer rows, so a shared-cacheable board is a privacy break however
  // the expectation is pinned.
  if (expected.cache !== undefined && expected.cache !== null) {
    const actual = get("cache-control") ?? "";
    const allowed = Array.isArray(expected.cache) ? expected.cache : [expected.cache];
    if (!allowed.includes(actual))
      failures.push(
        `${label}: cache-control ${JSON.stringify(actual)} not in ${allowed.join(" | ")}`,
      );
  }
  const cacheActual = get("cache-control") ?? "";
  if (cacheActual !== "private, no-store")
    failures.push(`${label}: member board answers private, no-store`);
  const secretHits = scrubSecrets(html);
  if (secretHits.length)
    failures.push(`${label}: secret-shaped content in HTML (${secretHits.length} patterns)`);
  return failures;
}

// Member-board admission contract: the gate and grammar answers that never
// serve a board. Status is exact, a guest bounce lands on the Discord
// sign-in, no board heading leaks, and the body stays secret-free. Renderer
// marker and cache pins live on the served-board contract instead: error
// and redirect answers are decorated differently per framework.
export function assertMembersAdmission({ label, html, headers, status, expected }) {
  const failures = [];
  const get = (name) => headers.get?.(name) ?? headers[name.toLowerCase()] ?? null;
  if (status !== expected.status)
    failures.push(`${label}: status ${status} !== ${expected.status}`);
  if (expected.status === 302) {
    const location = get("location") ?? "";
    if (!location.includes("/auth/discord"))
      failures.push(
        `${label}: guest bounce lands on /auth/discord (got ${JSON.stringify(location)})`,
      );
  }
  if (html.includes("<h1>Member leaderboard</h1>"))
    failures.push(`${label}: admission answer never serves the board`);
  const secretHits = scrubSecrets(html);
  if (secretHits.length)
    failures.push(`${label}: secret-shaped content in HTML (${secretHits.length} patterns)`);
  return failures;
}

// Moderator join-attempts contracts: the audit list and detail share one
// markup contract on both renderers (src/admin/pages/join-attempts.tsx and
// web/src/routes/admin/join-attempts/**): admin chrome (Administration nav,
// no canonical, no guest chrome), private no-store, the exact-search filter
// form, the accessible scroll region with five scoped columns, and the
// outcome/source/time/trace detail with safe back navigation. Trace
// identifiers are moderator-only member data, so a shared-cacheable or
// guest-chromed answer is a privacy break however the expectation is pinned.
// The raw provider/token payload never renders: only the recorded
// outcome/source/request-id/discord-id fields appear, so OAuth-shaped field
// names in the HTML fail here.
function adminPageFailures({ label, html, headers, status, expected }) {
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
  if (countMatches(html, /<main(?:\s|>)/gi) !== 1) failures.push(`${label}: exactly one <main>`);
  if (!html.includes('class="skip-link" href="#main"'))
    failures.push(`${label}: skip link targets #main`);
  if (!html.includes('aria-label="Administration"'))
    failures.push(`${label}: administration nav has an accessible name`);
  if (!html.includes("moderators only")) failures.push(`${label}: moderator footer present`);
  // Admin pages carry no account chrome on either renderer: a guest banner
  // or a canonical URL on this surface is a shell mix-up.
  if (html.includes("Welcome, guest"))
    failures.push(`${label}: admin page must not show guest chrome`);
  if (html.includes('<link rel="canonical"'))
    failures.push(`${label}: admin page carries no canonical URL`);
  if (html.includes("Cross-site POST form submissions"))
    failures.push(`${label}: bare Kit CSRF text (must be the hardened gate)`);
  if (/access_token|refresh_token|error_description/i.test(html))
    failures.push(`${label}: recorded fields only, no raw provider payload`);
  const cacheActual = get("cache-control") ?? "";
  if (cacheActual !== "private, no-store")
    failures.push(`${label}: admin page answers private, no-store`);
  const secretHits = scrubSecrets(html);
  if (secretHits.length)
    failures.push(`${label}: secret-shaped content in HTML (${secretHits.length} patterns)`);
  return failures;
}

export function assertJoinAttemptsContract({ label, html, headers, status, expected }) {
  const failures = adminPageFailures({ label, html, headers, status, expected });
  if (status !== expected.status) return failures;
  if (!/<h1[^>]*>Join attempts<\/h1>/.test(html))
    failures.push(`${label}: join-attempts heading present`);
  if (!html.includes("Search is an exact Discord id or"))
    failures.push(`${label}: exact-search hint present`);
  if (!html.includes('<form method="get" action="/admin/join-attempts" class="filters">'))
    failures.push(`${label}: filter form posts back to the list as GET`);
  if (!html.includes('id="q" name="q" type="search"'))
    failures.push(`${label}: exact-search input present`);
  if (!html.includes('id="outcome" name="outcome"'))
    failures.push(`${label}: outcome filter present`);
  if (!html.includes('aria-label="Join attempts list"'))
    failures.push(`${label}: labelled scroll region present`);
  if (!html.includes('data-testid="join-attempts-table"'))
    failures.push(`${label}: attempts table present`);
  for (const column of ["Outcome", "Source", "Discord id", "Request id", "Attempted"]) {
    if (!html.includes(`<th scope="col">${column}</th>`))
      failures.push(`${label}: ${column} column present`);
  }
  const hasRowLink = /href="\/admin\/join-attempts\/\d+"/.test(html);
  const hasEmpty = html.includes('data-testid="join-attempts-empty"');
  if (!hasRowLink && !hasEmpty) failures.push(`${label}: attempt rows or empty state present`);
  if (!html.includes('aria-label="Join attempt pages"'))
    failures.push(`${label}: paging nav present`);
  return failures;
}

export function assertJoinAttemptDetailContract({ label, html, headers, status, expected }) {
  const failures = adminPageFailures({ label, html, headers, status, expected });
  if (status !== expected.status) return failures;
  if (!/<h1[^>]*>Join attempt \d+<\/h1>/.test(html))
    failures.push(`${label}: join-attempt heading present`);
  if (!html.includes('<a href="/admin/join-attempts">Back to join attempts</a>'))
    failures.push(`${label}: back navigation targets the list`);
  if (!html.includes("<h2>Outcome</h2>")) failures.push(`${label}: outcome section present`);
  if (!html.includes("<h2>Trace</h2>")) failures.push(`${label}: trace section present`);
  for (const term of ["Outcome", "Source", "Attempted at (UTC)", "Request ID", "Discord ID"]) {
    if (!html.includes(`<dt>${term}</dt>`)) failures.push(`${label}: ${term} term present`);
  }
  if (!/<time datetime="[^"]+">/.test(html))
    failures.push(`${label}: attempted-at instant present`);
  return failures;
}

// Join-attempts admission contract: the answers that never serve an audit
// row (guest bounce, non-moderator refusal, missing detail). Status is
// exact, a guest bounce lands on the Discord sign-in, no list or detail
// markup leaks, and the body stays secret-free. Renderer marker and cache
// pins live on the served-page contracts instead: error and redirect
// answers are decorated differently per framework.
export function assertJoinAttemptsAdmission({ label, html, headers, status, expected }) {
  const failures = [];
  const get = (name) => headers.get?.(name) ?? headers[name.toLowerCase()] ?? null;
  if (status !== expected.status)
    failures.push(`${label}: status ${status} !== ${expected.status}`);
  if (expected.status === 302) {
    const location = get("location") ?? "";
    if (!location.includes("/auth/discord"))
      failures.push(
        `${label}: guest bounce lands on /auth/discord (got ${JSON.stringify(location)})`,
      );
  }
  if (html.includes('data-testid="join-attempts-table"'))
    failures.push(`${label}: admission answer never serves the list`);
  if (/<h1[^>]*>Join attempt \d+<\/h1>/.test(html))
    failures.push(`${label}: admission answer never serves the detail`);
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
  const eventsMarker = expectedMarkerFor(manifestSource, "/events");
  const joinMarker = expectedMarkerFor(manifestSource, "/join");
  const recoverMarker = expectedMarkerFor(manifestSource, "/auth/recover");
  stdout.write(
    `kit-parity-gates: manifest expects marker ${JSON.stringify(marker)} for /events/past, ` +
      `${JSON.stringify(eventsMarker)} for /events, ` +
      `${JSON.stringify(joinMarker)} for /join, ` +
      `${JSON.stringify(recoverMarker)} for /auth/recover\n`,
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

  // Join landing fixtures: one per widget state plus the one-shot flash view.
  // The flash view is the privacy pin: a consumed flash answers private, so a
  // guest can never read another member's banner from a shared cache.
  const joinShell = (inner) =>
    `<html><head><link rel="canonical" href="https://next.togetherweown.com/join"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"><a href="/">Home</a></nav>` +
    `<main id="main"><section class="join-layout" aria-labelledby="join-heading">` +
    `<div class="join-panel"><h1 id="join-heading">Join Together We Own</h1>` +
    `<p class="join-actions"><a class="btn" href="/join/discord" data-testid="join-oneclick">` +
    `Join with Discord</a> ` +
    `<a href="https://discord.gg/invite" data-testid="join-invite">` +
    `Join with an invite link instead</a></p></div>` +
    `<div class="join-preview">${inner}</div></section></main>` +
    `<p><span class="account-caption">Welcome, guest</span></p></body></html>`;
  const joinFacade =
    `<div class="strap"><p>Discord's live server preview loads only when you ask for it.</p>` +
    `<a class="btn" href="https://discord.com/widget?id=326474832151838730&theme=dark" ` +
    `referrerpolicy="no-referrer" data-join-widget data-testid="join-widget-load">` +
    `Show live server preview</a><script src="/islands/join-widget.js" defer></script></div>`;
  const joinPresence =
    `<section aria-labelledby="discord-presence-heading" data-testid="join-widget-presence">` +
    `<h2 id="discord-presence-heading">In Together We Own now</h2>` +
    `<p data-testid="join-widget-online"><strong>42</strong> members online</p>` +
    `<p><a href="https://discord.gg/widget-invite" data-testid="join-widget-invite">` +
    `Join with an invite link</a></p><h3>Voice and stage channels</h3>` +
    `<ul data-testid="join-widget-channels"><li>stage-night</li></ul></section>` +
    joinFacade;
  const joinFallback =
    `<p class="strap" data-testid="join-widget-fallback">Live server preview is ` +
    `unavailable — Join with Discord still works.</p>`;
  const joinCases = [
    ["unit/join cold facade", joinShell(joinFacade), "public, max-age=3600"],
    ["unit/join warm presence", joinShell(joinPresence), "public, max-age=60"],
    ["unit/join fallback", joinShell(joinFallback), "public, max-age=3600"],
  ];
  for (const [name, html, cache] of joinCases) {
    const failures = assertRouteContract({
      label: name,
      html,
      headers: headerMap({
        "content-type": "text/html",
        "x-two-renderer": joinMarker,
        "cache-control": cache,
        vary: "Cookie",
      }),
      status: 200,
      expected: { status: 200, marker: joinMarker, contract: "join", cache },
    });
    push(
      `unit: ${name} passes`,
      failures.length === 0 ? "passed" : "failed",
      failures.join("; ") || null,
    );
  }
  // Flash view: the banner renders once and the response goes private.
  const joinFlashed = joinShell(joinFacade).replace(
    '<section class="join-layout"',
    '<p class="notice" role="status" data-testid="join-result">You are in.</p>' +
      '<section class="join-layout"',
  );
  const flashFailures = assertRouteContract({
    label: "unit/join flash",
    html: joinFlashed,
    headers: headerMap({
      "content-type": "text/html",
      "x-two-renderer": joinMarker,
      "cache-control": "private, no-store",
      vary: "Cookie",
    }),
    status: 200,
    expected: { status: 200, marker: joinMarker, contract: "join", cache: "private, no-store" },
  });
  push(
    "unit: join flash renders once and goes private",
    flashFailures.length === 0 ? "passed" : "failed",
    flashFailures.join("; ") || null,
  );
  // Join forced-failure proof: facade + fallback together, presence without
  // its facade link, a missing one-click action, and a hostile next must all
  // FAIL. A gate that cannot fail on a planted break proves nothing.
  const joinMutants = [
    ["both-zones", (html) => html.replace("</div></section>", `</div>${joinFallback}</section>`)],
    ["presence-without-facade", (html) => html.replace(joinFacade, "")],
    ["no-oneclick", (html) => html.replace('data-testid="join-oneclick"', 'data-testid="x"')],
    [
      "hostile-next",
      (html) =>
        html.replace('href="/join/discord"', 'href="/join/discord?next=https%3A%2F%2Fevil.test"'),
    ],
    // A flashed view served shared-cacheable: the privacy invariant fails it
    // however the expected cache is pinned.
    ["shared-cache-flash", () => joinFlashed],
  ];
  for (const [name, mutate] of joinMutants) {
    const failures = assertRouteContract({
      label: `unit/join-mutant-${name}`,
      html: mutate(joinShell(joinFacade)),
      headers: headerMap({
        "content-type": "text/html",
        "x-two-renderer": joinMarker,
        "cache-control": "public, max-age=3600",
        vary: "Cookie",
      }),
      status: 200,
      expected: {
        status: 200,
        marker: joinMarker,
        contract: "join",
        cache: "public, max-age=3600",
      },
    });
    push(
      `unit: join mutant ${name} fails`,
      failures.length > 0 ? "passed" : "failed",
      failures.length > 0 ? null : "mutant was NOT detected",
    );
  }

  // Events-list fixture: the guest flash-free render both renderers serve —
  // island identity, view toggles, search form, archive + subscribe links,
  // markdown alternate and the events canonical. Rows are live reads, so the
  // fixture carries no cards; seeded rows are pinned hermetically instead
  // (test/kit-events-calendar-parity.test.ts, acceptance journey).
  const eventsShell = (inner) =>
    `<html><head><link rel="canonical" href="https://next.togetherweown.com/events">` +
    `<link rel="alternate" type="text/markdown" href="/events.md"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"><a href="/events" aria-current="page">Events</a></nav>` +
    `<main id="main" class="events-page"><section data-testid="events-calendar" data-island="events-calendar">` +
    `<div data-testid="events-content"><div data-testid="events-list">${inner}</div></div>` +
    `<div role="group" aria-label="View"><button data-testid="events-view-list">List</button>` +
    `<button data-testid="events-view-calendar">Calendar</button></div>` +
    `<form method="get" action="/events"><input type="search" name="q" data-testid="events-search">` +
    `<button type="submit">Search</button></form>` +
    `<a href="/events/past" data-testid="events-past-archive-link">Past events</a>` +
    `<a href="webcal://next.togetherweown.com/events.ics" data-testid="events-subscribe">Subscribe</a>` +
    `</section></main><p>Welcome, guest</p>` +
    `<script src="/islands/events-calendar.js"></script></body></html>`;
  const eventsFailures = assertRouteContract({
    label: "unit/events guest list",
    html: eventsShell(""),
    headers: headerMap({
      "content-type": "text/html",
      "x-two-renderer": eventsMarker,
      "cache-control": "public, max-age=60",
      vary: "Cookie, X-Two-Island",
    }),
    status: 200,
    expected: {
      status: 200,
      marker: eventsMarker,
      contract: "events",
      cachePattern: /^public, max-age=(?:[1-9]|[1-5]\d|60)$/,
    },
  });
  push(
    "unit: events guest list passes",
    eventsFailures.length === 0 ? "passed" : "failed",
    eventsFailures.join("; ") || null,
  );
  // Events forced-failure proof: a missing island binder, a GET form turned
  // into a POST, a dropped archive link, a canonical pointing at the archive
  // or the site root, a Vary missing either token and a flashed view served
  // shared-cacheable must all FAIL. A gate that cannot fail on a planted
  // break proves nothing.
  const eventsMutants = [
    [
      "no-island-binder",
      (html) =>
        html.replace('<script src="/islands/events-calendar.js"', '<script src="/islands/x.js"'),
    ],
    [
      "post-search-form",
      (html) =>
        html.replace('<form method="get" action="/events"', '<form method="post" action="/events"'),
    ],
    [
      "no-archive-link",
      (html) => html.replace('data-testid="events-past-archive-link"', 'data-testid="x"'),
    ],
    ["archive-wrong-destination", (html) => html.replace('href="/events/past"', 'href="/events"')],
    [
      "archive-suffixed-destination",
      (html) => html.replace('href="/events/past"', 'href="/events/past-extra"'),
    ],
    [
      "subscribe-wrong-destination",
      (html) =>
        html.replace('href="webcal://next.togetherweown.com/events.ics"', 'href="/events.ics"'),
    ],
    [
      "subscribe-wrong-host",
      (html) =>
        html.replace(
          'href="webcal://next.togetherweown.com/events.ics"',
          'href="webcal://evil.example/events.ics"',
        ),
    ],
    // A canonical pointing at the archive (or the site root) must FAIL: the
    // <link rel="canonical"> element itself has to name /events, so nav and
    // form `/events"` substrings alone never satisfy it.
    [
      "canonical-archive-target",
      (html) =>
        html.replace(
          '<link rel="canonical" href="https://next.togetherweown.com/events">',
          '<link rel="canonical" href="https://next.togetherweown.com/events/past">',
        ),
    ],
    [
      "canonical-root-target",
      (html) =>
        html.replace(
          '<link rel="canonical" href="https://next.togetherweown.com/events">',
          '<link rel="canonical" href="https://next.togetherweown.com/">',
        ),
    ],
    [
      "canonical-suffixed-target",
      (html) =>
        html.replace(
          '<link rel="canonical" href="https://next.togetherweown.com/events">',
          '<link rel="canonical" href="https://next.togetherweown.com/events-extra">',
        ),
    ],
    // A flashed view served shared-cacheable: the privacy invariant fails it
    // however the expected cache is pinned.
    [
      "shared-cache-flash",
      (html) =>
        html.replace(
          '<section data-testid="events-calendar"',
          '<p class="notice" role="status" data-testid="join-result">You are in.</p><section data-testid="events-calendar"',
        ),
    ],
  ];
  for (const [name, mutate] of eventsMutants) {
    const failures = assertRouteContract({
      label: `unit/events-mutant-${name}`,
      html: mutate(eventsShell("")),
      headers: headerMap({
        "content-type": "text/html",
        "x-two-renderer": eventsMarker,
        "cache-control": "public, max-age=60",
        vary: "Cookie, X-Two-Island",
      }),
      status: 200,
      expected: {
        status: 200,
        marker: eventsMarker,
        contract: "events",
        cache: "public, max-age=60",
      },
    });
    push(
      `unit: events mutant ${name} fails`,
      failures.length > 0 ? "passed" : "failed",
      failures.length > 0 ? null : "mutant was NOT detected",
    );
  }
  // Vary forced-failure proof: full and island-fragment representations share
  // the URL and differ by X-Two-Island (src/kit-events.ts sets
  // `Cookie, X-Two-Island`), so dropping either token must FAIL.
  for (const [name, vary] of [
    ["vary-cookie-only", "Cookie"],
    ["vary-island-only", "X-Two-Island"],
    ["vary-cookie-substring-only", "X-Cookie, X-Two-Island"],
  ]) {
    const failures = assertRouteContract({
      label: `unit/events-mutant-${name}`,
      html: eventsShell(""),
      headers: headerMap({
        "content-type": "text/html",
        "x-two-renderer": eventsMarker,
        "cache-control": "public, max-age=60",
        vary,
      }),
      status: 200,
      expected: {
        status: 200,
        marker: eventsMarker,
        contract: "events",
        cache: "public, max-age=60",
      },
    });
    push(
      `unit: events mutant ${name} fails`,
      failures.length > 0 ? "passed" : "failed",
      failures.length > 0 ? null : "mutant was NOT detected",
    );
  }

  // Recovery outcome fixtures: one per entry point (expired session via GET
  // /auth/recover, denied consent via /join/callback). Both carry the shared
  // shell and answer private, no-store — recovery views set and clear
  // per-visitor journey cookies, so a shared-cacheable recovery is a privacy
  // break however the expected cache is pinned.
  const recoverShell = (retryHref, inviteHref, title, message) =>
    `<html><head></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"><a href="/">Home</a></nav>` +
    `<main id="main"><section class="hero recovery-hero" aria-labelledby="recovery-heading">` +
    `<div class="hero-detail hero-detail-left" aria-hidden="true"></div>` +
    `<p class="strap">Let's get you back to the lobby</p>` +
    `<h1 id="recovery-heading">${title}</h1>` +
    `<p class="lead">${message}</p>` +
    `<p class="recovery-actions"><a class="btn" href="${retryHref}" data-testid="recovery-retry">` +
    `Retry</a> ` +
    `<a href="${inviteHref}" data-testid="recovery-invite">` +
    `Join with an invite link instead</a></p></section></main>` +
    `<p><span class="account-caption">Welcome, guest</span></p></body></html>`;
  const recoverCases = [
    [
      "unit/recover expired session",
      recoverShell(
        "/auth/discord?next=%2Fprofile",
        "/discord",
        "Your session expired",
        "Your earlier changes were not saved.",
      ),
    ],
    [
      "unit/recover join denied",
      recoverShell(
        "/join/discord",
        "https://discord.gg/invite",
        "Join cancelled",
        "You cancelled the Discord approval.",
      ),
    ],
  ];
  for (const [name, html] of recoverCases) {
    const failures = assertRouteContract({
      label: name,
      html,
      headers: headerMap({
        "content-type": "text/html",
        "x-two-renderer": recoverMarker,
        "cache-control": "no-store, private",
      }),
      status: 200,
      expected: {
        status: 200,
        marker: recoverMarker,
        contract: "recovery",
        cache: "no-store, private",
      },
    });
    push(
      `unit: ${name} passes`,
      failures.length === 0 ? "passed" : "failed",
      failures.join("; ") || null,
    );
  }
  // Recovery forced-failure proof: a missing retry action, a hostile retry
  // href, a missing invite fallback, a script-URL invite and a
  // shared-cacheable recovery must all FAIL. A gate that cannot fail on a
  // planted break proves nothing.
  const recoverGood = recoverCases[0][1];
  const recoverMutants = [
    ["no-retry", (html) => html.replace('data-testid="recovery-retry"', 'data-testid="x"')],
    [
      "hostile-retry",
      (html) => html.replace('href="/auth/discord?next=%2Fprofile"', 'href="https://evil.test/"'),
    ],
    ["no-invite", (html) => html.replace('data-testid="recovery-invite"', 'data-testid="x"')],
    ["javascript-invite", (html) => html.replace('href="/discord"', 'href="javascript:alert(1)"')],
    // A shared-cacheable recovery fails however the expected cache is
    // pinned (the privacy invariant, like the join flash pin).
    ["shared-cache", (html) => html],
  ];
  for (const [name, mutate] of recoverMutants) {
    const failures = assertRouteContract({
      label: `unit/recover-mutant-${name}`,
      html: mutate(recoverGood),
      headers: headerMap({
        "content-type": "text/html",
        "x-two-renderer": recoverMarker,
        "cache-control": name === "shared-cache" ? "public, max-age=60" : "no-store, private",
        vary: "Cookie",
      }),
      status: 200,
      expected: {
        status: 200,
        marker: recoverMarker,
        contract: "recovery",
        cache: name === "shared-cache" ? "public, max-age=60" : "no-store, private",
      },
    });
    push(
      `unit: recover mutant ${name} fails`,
      failures.length > 0 ? "passed" : "failed",
      failures.length > 0 ? null : "mutant was NOT detected",
    );
  }

  // Member-board fixtures: authenticated member view only. The expected
  // marker derives from the shipped manifest (null today, "kit" after
  // enablement) and these unit journeys prove the assertion set passes on a
  // good fixture AND fails on planted breaks. Admission (302/400), the audit
  // row and the live Hono-vs-Kit fetch are executed by the preview journeys
  // in PARITY_ROUTES and the Playwright kit-parity journey, not unit work.
  const membersMarker = isManifestEnabled(manifestSource, "/leaderboards/members", "GET")
    ? "kit"
    : null;
  const membersGood =
    `<html><head><link rel="canonical" href="https://next.togetherweown.com/leaderboards/members">` +
    `<meta name="robots" content="noindex, nofollow"></head>` +
    `<body><a class="skip-link" href="#main">Skip to content</a>` +
    `<nav aria-label="Primary"><a href="/">Home</a></nav>` +
    `<p><span class="who">Rick</span> <button type="submit" class="link">Sign out</button></p>` +
    `<main id="main" class="events-page"><p class="strap">Members only</p>` +
    `<h1>Member leaderboard</h1>` +
    `<nav aria-label="Board scope"><ul><li><a href="/leaderboards/members" aria-current="page">Overall</a></li>` +
    `<li><a href="/leaderboards/members?scope=relative">Around you</a></li></ul></nav>` +
    `<form method="get" action="/leaderboards/members" aria-label="Filter the leaderboard">` +
    `<p><label for="board-season">Season (all, 2026, 2026-09 or 2026-Q3)</label> ` +
    `<input id="board-season" name="season" type="text" value="all" /></p>` +
    `<p><label for="board-activity">Game (blank for every game)</label> ` +
    `<input id="board-activity" name="activity" type="text" value="" /></p>` +
    `<p><button class="btn" type="submit">Show board</button></p></form>` +
    `<table class="member-board-table"><caption>Going counts, season all, every game</caption>` +
    `<thead><tr><th scope="col">Rank</th><th scope="col">Member</th><th scope="col">Going</th></tr></thead>` +
    `<tbody><tr><td>1</td><th scope="row">Rick</th><td>3</td></tr></tbody></table>` +
    `</main></body></html>`;
  const membersFailures = assertMembersContract({
    label: "unit/members board",
    html: membersGood,
    headers: headerMap({
      "content-type": "text/html; charset=UTF-8",
      "x-two-renderer": membersMarker,
      "cache-control": "private, no-store",
    }),
    status: 200,
    expected: { status: 200, marker: membersMarker, cache: "private, no-store" },
  });
  push(
    "unit: members board renders for a member",
    membersFailures.length === 0 ? "passed" : "failed",
    membersFailures.join("; ") || null,
  );
  // Each mutant trips exactly one contract check, pinned by failure label:
  // a mutant that trips a neighbouring check (or none) fails its journey.
  // guest-chrome keeps "Sign out" so only the guest-chrome leak check trips;
  // no-canonical and canonical-wrong-target pin the <link rel="canonical">
  // element match (form action and scope links alone must not satisfy it).
  const membersMutants = [
    [
      "guest-chrome",
      (html) => html.replace("</main>", "<p>Welcome, guest</p></main>"),
      "member page must not show guest chrome",
    ],
    ["shared-cache", (html) => html, "member board answers private, no-store"],
    [
      "no-table-no-status",
      (html) => html.replace(/<table[^>]*>[\s\S]*<\/table>/, ""),
      "board table or empty status present",
    ],
    [
      "follow-index",
      (html) => html.replace('content="noindex, nofollow"', 'content="index, follow"'),
      "member board never indexes",
    ],
    ["per-attempt-field", (html) => `${html}<!-- discord_id -->`, "no per-attempt fields"],
    [
      "profile-link",
      (html) =>
        html.replace(
          '<th scope="row">Rick</th>',
          '<th scope="row"><a href="/members/rick">Rick</a></th>',
        ),
      "board rows never link to profiles",
    ],
    [
      "no-canonical",
      (html) => html.replace(/<link rel="canonical"[^>]*>/, ""),
      "canonical points at /leaderboards/members",
    ],
    [
      "canonical-wrong-target",
      (html) =>
        html.replace(
          /<link rel="canonical"[^>]*>/,
          '<link rel="canonical" href="https://next.togetherweown.com/events">',
        ),
      "canonical points at /leaderboards/members",
    ],
    ["wrong-renderer", (html) => html, "renderer marker"],
  ];
  for (const [name, mutate, want] of membersMutants) {
    const failures = assertMembersContract({
      label: `unit/members-mutant-${name}`,
      html: mutate(membersGood),
      headers: headerMap({
        "content-type": "text/html; charset=UTF-8",
        "x-two-renderer":
          name === "wrong-renderer" ? (membersMarker === "kit" ? null : "kit") : membersMarker,
        "cache-control": name === "shared-cache" ? "public, max-age=300" : "private, no-store",
      }),
      status: 200,
      expected: {
        status: 200,
        marker: membersMarker,
        cache: name === "shared-cache" ? "public, max-age=300" : "private, no-store",
      },
    });
    const pinned = failures.some((f) => f.includes(want));
    push(
      `unit: members mutant ${name} fails`,
      pinned ? "passed" : "failed",
      pinned
        ? null
        : `mutant did not trip "${want}" (got: ${failures.join("; ") || "no failures"})`,
    );
  }

  // Join-attempts fixtures: moderator-only audit views. The expected
  // marker derives from the shipped manifest and these unit journeys prove
  // the assertion sets pass on good fixtures AND fail on planted breaks.
  // Admission answers (guest 302, member 403, missing detail 404), the
  // audit row and the live Hono-vs-Kit fetch are executed by the preview
  // journeys in PARITY_ROUTES; the served detail is pinned here because no
  // seeded attempt id is stable on staging.
  const joinAttemptsMarker = isManifestEnabled(manifestSource, "/admin/join-attempts", "GET")
    ? "kit"
    : null;
  const adminShellOpen =
    `<html><head><title>Join attempts — TWO admin</title></head>` +
    `<body><a class="skip-link" href="#main">Skip to content</a>` +
    `<header class="bar"><a class="brand" href="/admin">TWO admin</a>` +
    `<nav aria-label="Administration"><a href="/admin/join-attempts">Join attempts</a></nav></header>`;
  const adminShellClose = `<footer>Together We Own · moderators only</footer></body></html>`;
  const joinAttemptsGood =
    adminShellOpen +
    `<main id="main"><section><h1>Join attempts</h1>` +
    `<p class="hint">Read-only. Last 90 days, newest first. Search is an exact Discord id or request id.</p>` +
    `<form method="get" action="/admin/join-attempts" class="filters">` +
    `<div class="field"><label for="q">Discord id or request id</label>` +
    `<input id="q" name="q" type="search" value="" /></div>` +
    `<div class="field"><label for="outcome">Outcome</label>` +
    `<select id="outcome" name="outcome"><option value="">All</option></select></div>` +
    `<div class="field"><button type="submit" class="btn">Filter</button></div></form>` +
    `<div class="admin-table-scroll" role="region" aria-label="Join attempts list" data-testid="join-attempts-table-scroll">` +
    `<table class="admin-table" data-testid="join-attempts-table"><thead><tr>` +
    `<th scope="col">Outcome</th><th scope="col">Source</th><th scope="col">Discord id</th>` +
    `<th scope="col">Request id</th><th scope="col">Attempted</th></tr></thead>` +
    `<tbody><tr><td><a href="/admin/join-attempts/7" aria-label="View join attempt 7: added">added</a></td>` +
    `<td>join</td><td>100000000000000201</td><td>req-7</td><td>2026-10-01T00:00:00.000Z</td></tr></tbody></table></div>` +
    `<nav aria-label="Join attempt pages" class="actions"><span>Page 1</span></nav>` +
    `</section></main>` +
    adminShellClose;
  const joinAttemptsFailures = assertJoinAttemptsContract({
    label: "unit/join-attempts list",
    html: joinAttemptsGood,
    headers: headerMap({
      "content-type": "text/html; charset=UTF-8",
      "x-two-renderer": joinAttemptsMarker,
      "cache-control": "private, no-store",
    }),
    status: 200,
    expected: { status: 200, marker: joinAttemptsMarker, cache: "private, no-store" },
  });
  push(
    "unit: join-attempts list renders for a moderator",
    joinAttemptsFailures.length === 0 ? "passed" : "failed",
    joinAttemptsFailures.join("; ") || null,
  );
  const joinAttemptsMutants = [
    [
      "guest-chrome",
      (html) => html.replace("</main>", "<p>Welcome, guest</p></main>"),
      "admin page must not show guest chrome",
    ],
    ["shared-cache", (html) => html, "admin page answers private, no-store"],
    [
      "no-table-no-empty",
      (html) => html.replace(/<table[^>]*>[\s\S]*<\/table>/, ""),
      "attempts table present",
    ],
    ["provider-payload", (html) => `${html}<!-- access_token -->`, "no raw provider payload"],
    [
      "canonical",
      (html) =>
        html.replace(
          "</title>",
          '</title><link rel="canonical" href="https://next.togetherweown.com/admin/join-attempts">',
        ),
      "admin page carries no canonical URL",
    ],
    ["wrong-renderer", (html) => html, "renderer marker"],
  ];
  for (const [name, mutate, want] of joinAttemptsMutants) {
    const failures = assertJoinAttemptsContract({
      label: `unit/join-attempts-mutant-${name}`,
      html: mutate(joinAttemptsGood),
      headers: headerMap({
        "content-type": "text/html; charset=UTF-8",
        "x-two-renderer":
          name === "wrong-renderer"
            ? joinAttemptsMarker === "kit"
              ? null
              : "kit"
            : joinAttemptsMarker,
        "cache-control": name === "shared-cache" ? "public, max-age=300" : "private, no-store",
      }),
      status: 200,
      expected: { status: 200, marker: joinAttemptsMarker, cache: "private, no-store" },
    });
    const pinned = failures.some((f) => f.includes(want));
    push(
      `unit: join-attempts mutant ${name} fails`,
      pinned ? "passed" : "failed",
      pinned
        ? null
        : `mutant did not trip "${want}" (got: ${failures.join("; ") || "no failures"})`,
    );
  }
  const joinAttemptDetailMarker = isManifestEnabled(
    manifestSource,
    "/admin/join-attempts/:id",
    "GET",
  )
    ? "kit"
    : null;
  const joinAttemptDetailGood =
    adminShellOpen +
    `<main id="main"><section><p><a href="/admin/join-attempts">Back to join attempts</a></p>` +
    `<h1>Join attempt 7</h1>` +
    `<p class="hint">Read-only. Attempted at and trace identifiers are shown as recorded.</p>` +
    `<h2>Outcome</h2><dl><dt>Outcome</dt><dd>added</dd><dt>Source</dt><dd>—</dd>` +
    `<dt>Attempted at (UTC)</dt><dd><time datetime="2026-10-01T00:00:00.000Z">2026-10-01T00:00:00.000Z</time></dd></dl>` +
    `<h2>Trace</h2><dl><dt>Request ID</dt><dd>req-7</dd><dt>Discord ID</dt><dd>100000000000000201</dd></dl>` +
    `</section></main>` +
    adminShellClose;
  const joinAttemptDetailFailures = assertJoinAttemptDetailContract({
    label: "unit/join-attempt detail",
    html: joinAttemptDetailGood,
    headers: headerMap({
      "content-type": "text/html; charset=UTF-8",
      "x-two-renderer": joinAttemptDetailMarker,
      "cache-control": "private, no-store",
    }),
    status: 200,
    expected: { status: 200, marker: joinAttemptDetailMarker, cache: "private, no-store" },
  });
  push(
    "unit: join-attempt detail renders for a moderator",
    joinAttemptDetailFailures.length === 0 ? "passed" : "failed",
    joinAttemptDetailFailures.join("; ") || null,
  );
  const joinAttemptDetailMutants = [
    [
      "no-back-link",
      (html) => html.replace('<a href="/admin/join-attempts">Back to join attempts</a>', ""),
      "back navigation targets the list",
    ],
    [
      "no-trace",
      (html) => html.replace(/<h2>Trace<\/h2>[\s\S]*<\/dl>/, ""),
      "trace section present",
    ],
    ["shared-cache", (html) => html, "admin page answers private, no-store"],
    ["wrong-renderer", (html) => html, "renderer marker"],
  ];
  for (const [name, mutate, want] of joinAttemptDetailMutants) {
    const failures = assertJoinAttemptDetailContract({
      label: `unit/join-attempt-detail-mutant-${name}`,
      html: mutate(joinAttemptDetailGood),
      headers: headerMap({
        "content-type": "text/html; charset=UTF-8",
        "x-two-renderer":
          name === "wrong-renderer"
            ? joinAttemptDetailMarker === "kit"
              ? null
              : "kit"
            : joinAttemptDetailMarker,
        "cache-control": name === "shared-cache" ? "public, max-age=300" : "private, no-store",
      }),
      status: 200,
      expected: { status: 200, marker: joinAttemptDetailMarker, cache: "private, no-store" },
    });
    const pinned = failures.some((f) => f.includes(want));
    push(
      `unit: join-attempt detail mutant ${name} fails`,
      pinned ? "passed" : "failed",
      pinned
        ? null
        : `mutant did not trip "${want}" (got: ${failures.join("; ") || "no failures"})`,
    );
  }

  // Hot-zone fixtures: the four Kit-owned heatmaps get the same executed
  // unit contract as /join and /auth/recover, so an enabled hot-zone route
  // is covered by a run that actually exercises its contract branch — a
  // missing grid table, heading, noindex or a per-attempt field leak must
  // fail here, not only in a preview fetch CI never makes.
  // Partial synthetic manifests in the gate's own tests exercise other
  // scopes and carry no hot-zone entry; the shipped manifest lists all
  // four, and there the journeys below always run.
  const hotzonesListed = parseManifestEntries(manifestSource).some(
    (entry) => entry.path === "/hotzones",
  );
  const hotzoneMarker = hotzonesListed ? expectedMarkerFor(manifestSource, "/hotzones") : null;
  const hotzoneShell =
    `<html><head><link rel="canonical" href="https://next.togetherweown.com/hotzones">` +
    `<meta name="robots" content="noindex, follow"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"><a href="/">Home</a></nav>` +
    `<main id="main"><h1>Hot zones</h1>` +
    `<table><caption>Join activity</caption></table></main>` +
    `<p><span class="account-caption">Welcome, guest</span></p></body></html>`;
  if (hotzonesListed) {
    const hotzoneFailures = assertRouteContract({
      label: "unit/hotzones",
      html: hotzoneShell,
      headers: headerMap({
        "content-type": "text/html",
        "x-two-renderer": hotzoneMarker,
        "cache-control": "public, max-age=300",
      }),
      status: 200,
      expected: { status: 200, marker: hotzoneMarker, contract: "hotzones" },
    });
    push(
      "unit: hotzones good fixture passes",
      hotzoneFailures.length === 0 ? "passed" : "failed",
      hotzoneFailures.join("; ") || null,
    );
    const hotzoneMutants = [
      ["no-table", (html) => html.replace("<table>", "<div>").replace("</table>", "</div>")],
      ["no-heading", (html) => html.replace("Hot zones", "Activity")],
      ["indexable", (html) => html.replace('<meta name="robots" content="noindex, follow">', "")],
      ["per-attempt-leak", (html) => `${html}<p>discord_id: 123</p>`],
    ];
    for (const [name, mutate] of hotzoneMutants) {
      const failures = assertRouteContract({
        label: `unit/hotzones-mutant-${name}`,
        html: mutate(hotzoneShell),
        headers: headerMap({
          "content-type": "text/html",
          "x-two-renderer": hotzoneMarker,
          "cache-control": "public, max-age=300",
        }),
        status: 200,
        expected: { status: 200, marker: hotzoneMarker, contract: "hotzones" },
      });
      push(
        `unit: hotzones mutant ${name} fails`,
        failures.length > 0 ? "passed" : "failed",
        failures.length > 0 ? null : "mutant was NOT detected",
      );
    }
  }

  // Static-leaf fixtures: the two Kit-owned leaves get the same executed
  // unit contract as the other parity routes, so an enabled leaf is covered
  // by a run that actually exercises its contract branch — a missing facts
  // list, join action or heading, a hostile join href, a missing first
  // question group or a wrong cache TTL must fail here, not only in a
  // preview fetch CI may never make.
  const leavesListed = parseManifestEntries(manifestSource).some(
    (entry) => entry.path === "/about" || entry.path === "/faq",
  );
  const leafShell = (path, inner) =>
    `<html><head><link rel="canonical" href="https://next.togetherweown.com${path}"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"><a href="/">Home</a></nav>` +
    `<main id="main"><nav class="content-nav" aria-label="Community information"></nav>` +
    `<section class="content-page">${inner}</section></main>` +
    `<p><span class="account-caption">Welcome, guest</span></p></body></html>`;
  const leafCases = [
    [
      "about",
      "/about",
      leafShell(
        "/about",
        `<h1 id="about-heading">About Together We Own</h1>` +
          `<p class="strap">Est. 1998</p><p class="lead">An adult gaming community</p>` +
          `<dl data-testid="about-facts" class="facts"></dl>` +
          `<p><a class="btn" href="/join" data-testid="about-join">Join with Discord</a></p>`,
      ),
      [
        ["no-facts", (html) => html.replace('data-testid="about-facts"', 'data-testid="x"')],
        ["no-join", (html) => html.replace('data-testid="about-join"', 'data-testid="x"')],
        ["wrong-heading", (html) => html.replace("About Together We Own", "About Us")],
        ["hostile-join", (html) => html.replace('href="/join"', 'href="https://evil.test/"')],
      ],
    ],
    [
      "faq",
      "/faq",
      leafShell(
        "/faq",
        `<h1 id="faq-heading">Frequently asked questions</h1>` +
          `<p class="strap">New here? Start here</p><p class="lead">Short answers</p>` +
          `<div data-testid="faq-list">` +
          `<section aria-labelledby="faq-getting-in"><h2 id="faq-getting-in">Getting in</h2></section></div>` +
          `<p><a class="btn" href="/join" data-testid="faq-join">Join with Discord</a></p>`,
      ),
      [
        ["no-list", (html) => html.replace('data-testid="faq-list"', 'data-testid="x"')],
        ["no-join", (html) => html.replace('data-testid="faq-join"', 'data-testid="x"')],
        ["wrong-heading", (html) => html.replace("Frequently asked questions", "Questions")],
        ["hostile-join", (html) => html.replace('href="/join"', 'href="https://evil.test/"')],
        [
          "no-first-group",
          (html) => html.replace(/<section aria-labelledby="faq-getting-in">.*?<\/section>/, ""),
        ],
      ],
    ],
  ];
  if (leavesListed) {
    for (const [contract, path, shell, mutants] of leafCases) {
      const leafMarker = expectedMarkerFor(manifestSource, path);
      const leafFailures = assertRouteContract({
        label: `unit/leaves ${path}`,
        html: shell,
        headers: headerMap({
          "content-type": "text/html",
          "x-two-renderer": leafMarker,
          "cache-control": "public, max-age=3600",
        }),
        status: 200,
        expected: { status: 200, marker: leafMarker, contract, cache: "public, max-age=3600" },
      });
      push(
        `unit: leaves ${path} good fixture passes`,
        leafFailures.length === 0 ? "passed" : "failed",
        leafFailures.join("; ") || null,
      );
      for (const [name, mutate] of mutants) {
        const failures = assertRouteContract({
          label: `unit/leaves-mutant-${contract}-${name}`,
          html: mutate(shell),
          headers: headerMap({
            "content-type": "text/html",
            "x-two-renderer": leafMarker,
            "cache-control": "public, max-age=3600",
          }),
          status: 200,
          expected: { status: 200, marker: leafMarker, contract, cache: "public, max-age=3600" },
        });
        push(
          `unit: leaves mutant ${contract} ${name} fails`,
          failures.length > 0 ? "passed" : "failed",
          failures.length > 0 ? null : "mutant was NOT detected",
        );
      }
      // A shared-cacheable leaf served private must fail however the
      // expected cache is pinned (the inverse of the join-flash pin: the
      // leaf contract is public by design, and going private would break
      // the shared-cache TTL both handlers set).
      const privateFailures = assertRouteContract({
        label: `unit/leaves-mutant-${contract}-private-cache`,
        html: shell,
        headers: headerMap({
          "content-type": "text/html",
          "x-two-renderer": leafMarker,
          "cache-control": "private, no-store",
        }),
        status: 200,
        expected: { status: 200, marker: leafMarker, contract, cache: "private, no-store" },
      });
      push(
        `unit: leaves mutant ${contract} private-cache fails`,
        privateFailures.length > 0 ? "passed" : "failed",
        privateFailures.length > 0 ? null : "mutant was NOT detected",
      );
    }
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
  // enabled entry no executed run covers (GET/HEAD /events/past, GET/HEAD
  // /events, /join, /auth/recover and the four hot-zone paths via
  // PARITY_ROUTES): GET /admin, /join/discord, /join/callback and friends can
  // never ship green with no journey. (GET /join, GET /events and GET
  // /auth/recover themselves are covered.)
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
  { stdout = process.stdout, fetchImpl = fetch, qaToken = null } = {},
) {
  const manifestSource = readFileSync(
    new URL("../src/route-ownership.ts", import.meta.url),
    "utf8",
  );
  const journeys = [];
  // Authenticated journeys share one QA login per base (the qa-login
  // throttle is per-minute), issued lazily and replayed as a Cookie header.
  // The token and cookie values never reach the ledger: reasons name only
  // the host and the HTTP status, and every journey body is secret-scrubbed
  // by its contract helper.
  const qaCookies = new Map();
  async function qaCookieFor(base, identity) {
    const cacheKey = `${identity}:${base}`;
    if (qaCookies.has(cacheKey)) return qaCookies.get(cacheKey);
    let result;
    try {
      const res = await fetchImpl(new URL(`/auth/qa/qa-${identity}`, base), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { "x-two-qa-auth": qaToken, origin: base },
      });
      const setCookie =
        res.headers.getSetCookie?.().join("\n") ?? res.headers.get("set-cookie") ?? "";
      const session = setCookie
        .split("\n")
        .map((line) => line.split(";")[0])
        .find((line) => line?.startsWith("__Host-two_session="));
      result =
        res.status === 204 && session
          ? { cookie: session }
          : {
              unavailable: `QA login answered ${res.status} on ${new URL(base).host} (staging QA seam unavailable or token rejected)`,
            };
    } catch (error) {
      result = {
        unavailable: `QA login failed on ${new URL(base).host}: ${String(error?.message ?? error).slice(0, 120)}`,
      };
    }
    qaCookies.set(cacheKey, result);
    return result;
  }
  for (const route of PARITY_ROUTES) {
    const routeName = route.label ?? route.path;
    const expectedMarker =
      route.expectMarker === "manifest"
        ? expectedMarkerFor(manifestSource, route.path)
        : route.expectMarker;
    let kitRes;
    let honoRes;
    let headersFor = () => undefined;
    if (route.auth === "member" || route.auth === "moderator") {
      if (!qaToken) {
        journeys.push({
          name: `preview ${routeName}: authenticated fetch`,
          status: "skipped",
          reason: `authenticated preview journey needs KIT_PARITY_QA_TOKEN (the staging QA token); unset, so no ${route.auth} fetch was executed`,
        });
        continue;
      }
      const [kitLogin, honoLogin] = await Promise.all(
        [kitBase, honoBase].map((base) => qaCookieFor(base, route.auth)),
      );
      const unavailable = [kitLogin, honoLogin].find((login) => login.unavailable);
      if (unavailable) {
        journeys.push({
          name: `preview ${routeName}: authenticated fetch`,
          status: "skipped",
          reason: unavailable.unavailable,
        });
        continue;
      }
      const cookies = [kitLogin.cookie, honoLogin.cookie];
      headersFor = (index) => ({ cookie: cookies[index] });
    }
    try {
      [kitRes, honoRes] = await Promise.all(
        [kitBase, honoBase].map((base, index) =>
          fetchImpl(new URL(route.path, base), {
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
            headers: headersFor(index),
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
    const kitHtml = kitRes.status === route.expectStatus ? await kitRes.text() : "";
    const honoHtml = honoRes.status === route.expectStatus ? await honoRes.text() : "";
    const expected = {
      status: route.expectStatus,
      marker: expectedMarker,
      contract: route.contract ?? "archive",
      cache: route.cache ?? null,
      cachePattern: route.cachePattern,
    };
    const assertContract =
      route.contract === "members"
        ? assertMembersContract
        : route.contract === "members-admission"
          ? assertMembersAdmission
          : route.contract === "join-attempts"
            ? assertJoinAttemptsContract
            : route.contract === "join-attempts-admission"
              ? assertJoinAttemptsAdmission
              : assertRouteContract;
    const kitFailures = assertContract({
      label: `preview Kit ${route.path}`,
      html: kitHtml,
      headers: kitRes.headers,
      status: kitRes.status,
      expected,
    });
    journeys.push({
      name: `preview Kit ${route.path}: contract`,
      status: kitFailures.length ? "failed" : "passed",
      reason: kitFailures.join("; ").slice(0, 200) || null,
    });
    // The Hono side runs the same contract helpers (expected marker null):
    // a Hono-side regression outside the section would otherwise go
    // unflagged in preview mode.
    const honoFailures = assertContract({
      label: `preview Hono ${route.path}`,
      html: honoHtml,
      headers: honoRes.headers,
      status: honoRes.status,
      expected: { ...expected, marker: null },
    });
    journeys.push({
      name: `preview Hono ${route.path}: no Kit marker`,
      status: honoFailures.length ? "failed" : "passed",
      reason: honoFailures.join("; ").slice(0, 200) || null,
    });
    if (kitRes.status === 200 && honoRes.status === 200) {
      // A null compareSection is a loud skip with a reason, never a quiet
      // green: some routes (join's environment-dependent widget zone) prove
      // structure on both sides instead of equal bytes.
      if (route.compareSection === null || route.compareSection === undefined) {
        journeys.push({
          name: `preview ${route.path}: sections match`,
          status: "skipped",
          reason:
            "no byte section compare (environment-dependent content differs per worker); structural contract asserted instead",
        });
        continue;
      }
      // Framework-tolerant comparison (ci/kit-section-contract.mjs): raw
      // bytes always differ (hydration markers, boolean attributes, `>`
      // escaping), so compare the normalized contract, not the bytes.
      let same = false;
      let reason = "section HTML differs";
      try {
        same =
          sectionOf(kitHtml, route.compareSection) === sectionOf(honoHtml, route.compareSection);
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
      ? await runPreviewMode(pair.kitBase, pair.honoBase, {
          stdout,
          fetchImpl,
          qaToken: env.KIT_PARITY_QA_TOKEN?.trim() || null,
        })
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
