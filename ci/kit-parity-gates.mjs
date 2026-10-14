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

// Coverage: the executed parity runs are GET/HEAD /events/past, /join,
// /auth/recover and the four hot-zone paths via PARITY_ROUTES (unit contract
// + preview fetch). Any other enabled entry has no run covering it and must
// fail — the scopes below only choose the journey name for the failure
// message, never whether it fails.
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
  } else if (contract === "hotzones") {
    if (!/hot zone/i.test(html)) failures.push(`${label}: hot-zone heading present`);
    if (!html.includes("<table>")) failures.push(`${label}: 7x24 grid table present`);
    if (!html.includes('<meta name="robots" content="noindex, follow"'))
      failures.push(`${label}: hot-zones never index`);
    if (/discord_id|created_at/i.test(html))
      failures.push(`${label}: aggregate only, no per-attempt fields`);
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
  const joinMarker = expectedMarkerFor(manifestSource, "/join");
  const recoverMarker = expectedMarkerFor(manifestSource, "/auth/recover");
  stdout.write(
    `kit-parity-gates: manifest expects marker ${JSON.stringify(marker)} for /events/past, ` +
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
    `unavailable — the join button above still works.</p>`;
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
  // enabled entry no executed run covers (GET/HEAD /events/past, /join,
  // /auth/recover and the four hot-zone paths via PARITY_ROUTES): GET /admin, /events,
  // /join/discord, /join/callback and friends can never ship green with no
  // journey. (GET /join and GET /auth/recover themselves are covered.)
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
    const expected = {
      status: route.expectStatus,
      marker: expectedMarker,
      contract: route.contract ?? "archive",
      cache: route.cache ?? null,
    };
    const kitFailures = assertRouteContract({
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
    const honoFailures = assertRouteContract({
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
