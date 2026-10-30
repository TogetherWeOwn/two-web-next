import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOGIN_JOURNEYS,
  PARITY_ROUTES,
  assertMembersContract,
  assertReservedContract,
  assertRouteContract,
  expectedMarkerFor,
  isAllowlistedHost,
  isCoveredByExecutedRun,
  isInJourneyScope,
  isManifestEnabled,
  parseManifestEntries,
  pathsMatchStructurally,
  runGate,
  runUnitMode,
  scrubSecrets,
  summarizeLedger,
  validatePreviewPair,
} from "./kit-parity-gates.mjs";

const scriptPath = fileURLToPath(new URL("./kit-parity-gates.mjs", import.meta.url));

function runScript({ env, stub }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-parity-gates-"));
  const stubPath = join(dir, "fetch-stub.mjs");
  writeFileSync(stubPath, stub);
  const childEnv = { ...process.env };
  delete childEnv.KIT_PREVIEW_URL;
  delete childEnv.HONO_PREVIEW_URL;
  Object.assign(childEnv, env);
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(stubPath).href, scriptPath],
    {
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
      cwd: join(scriptPath, "..", ".."),
    },
  );
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

const throwingFetchStub = `
globalThis.fetch = () => {
  throw new Error("kit-parity-gates: fetch must not run in misconfigured mode");
};
`;

test("exactly one preview URL exits 2 before any fetch", () => {
  for (const env of [
    { KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/" },
    { HONO_PREVIEW_URL: "https://next.togetherweown.com/" },
  ]) {
    const { status, output } = runScript({ env, stub: throwingFetchStub });
    assert.equal(status, 2, `expected exit 2, got ${status}\n${output}`);
    assert.match(output, /set both KIT_PREVIEW_URL and HONO_PREVIEW_URL/);
    assert.doesNotMatch(output, /fetch must not run/);
  }
});

test("non-allowlisted preview hosts exit 2 before any fetch", () => {
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://togetherweown.com/",
      HONO_PREVIEW_URL: "https://next.togetherweown.com/",
    },
    stub: throwingFetchStub,
  });
  assert.equal(status, 2, `expected exit 2, got ${status}\n${output}`);
  assert.match(output, /not staging-allowlisted/);
});

test("self-paired preview URLs exit 2 before any fetch", () => {
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://next.togetherweown.com/",
      HONO_PREVIEW_URL: "https://next.togetherweown.com/",
    },
    stub: throwingFetchStub,
  });
  assert.equal(status, 2, `expected exit 2, got ${status}\n${output}`);
  assert.match(output, /must differ/);
});

test("divergent preview sections exit 1 with the failing journey named", () => {
  const page = (key) =>
    `<html><head><link rel="canonical" href="https://x.invalid/">` +
    `<meta name="robots" content="noindex, follow"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"></nav><main id="main">` +
    `<section data-testid="past-events"><div data-testid="past-events-list">` +
    `<article data-event-key="${key}"></article></div></section></main>` +
    `<p>Welcome, guest</p><script src="/islands/past-events.js"></script></body></html>`;
  const stub = `
const page = ${page.toString()};
globalThis.fetch = async (input) => {
  const url = new URL(String(input.url ?? input));
  if (url.pathname === "/up") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const html = url.host === "kit.invalid.workers.dev" ? page("kit-only-key") : page("hono-only-key");
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
};
`;
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/",
      HONO_PREVIEW_URL: "https://hono.invalid.workers.dev/",
    },
    stub,
  });
  assert.equal(status, 1, `expected exit 1, got ${status}\n${output}`);
  assert.match(output, /sections match/);
});

test("allowlist admits staging and preview hosts only", () => {
  assert.equal(isAllowlistedHost("next.togetherweown.com"), true);
  assert.equal(isAllowlistedHost("two-web-next-kit-preview.5150.workers.dev"), true);
  assert.equal(isAllowlistedHost("togetherweown.com"), false);
  assert.equal(isAllowlistedHost("example.com"), false);
  assert.equal(isAllowlistedHost("next.togetherweown.com.evil.invalid"), false);
});

test("pair validation trims empty strings to unit mode", () => {
  assert.equal(validatePreviewPair("", "").mode, "unit");
  assert.equal(
    validatePreviewPair("https://a.workers.dev/", "https://b.workers.dev/").mode,
    "preview",
  );
});

test("expected marker follows the shipped manifest, not a hard-coded kit", () => {
  assert.equal(expectedMarkerFor('path: "/events/past", enabled: false', "/events/past"), null);
  assert.equal(expectedMarkerFor('path: "/events/past", enabled: true', "/events/past"), "kit");
  assert.equal(expectedMarkerFor('path: "/events/past", enabled: true', "/up"), null);
  assert.throws(() => expectedMarkerFor("no manifest here", "/events/past"), /cannot derive/);
});

test("expected marker derives the join owner from its own entry", () => {
  assert.equal(
    expectedMarkerFor('{ method: "GET", path: "/join", enabled: false }', "/join"),
    null,
  );
  assert.equal(
    expectedMarkerFor('{ method: "GET", path: "/join", enabled: true }', "/join"),
    "kit",
  );
  assert.equal(
    expectedMarkerFor('{ method: "GET", path: "/join", enabled: true }', "/join?next=%2Fevents"),
    "kit",
  );
  // A prefix entry (/join/discord) is not the /join entry: a parity route
  // with no manifest entry of its own fails closed, never quiet-Hono.
  assert.throws(
    () =>
      expectedMarkerFor(
        '{ method: "GET", path: "/events/past", enabled: false },' +
          ' { method: "GET", path: "/join/discord", enabled: false }',
        "/join",
      ),
    /cannot derive/,
  );
});

test("expected marker derives the recover owner from its own entry", () => {
  assert.equal(
    expectedMarkerFor('{ method: "GET", path: "/auth/recover", enabled: false }', "/auth/recover"),
    null,
  );
  assert.equal(
    expectedMarkerFor('{ method: "GET", path: "/auth/recover", enabled: true }', "/auth/recover"),
    "kit",
  );
  assert.equal(
    expectedMarkerFor(
      '{ method: "GET", path: "/auth/recover", enabled: true }',
      "/auth/recover?next=%2Fprofile",
    ),
    "kit",
  );
  // A prefix entry (/auth/discord) is not the /auth/recover entry: a parity
  // route with no manifest entry of its own fails closed, never quiet-Hono.
  assert.throws(
    () =>
      expectedMarkerFor(
        '{ method: "GET", path: "/join", enabled: false },' +
          ' { method: "GET", path: "/auth/discord", enabled: false }',
        "/auth/recover",
      ),
    /cannot derive/,
  );
});

test("secret scrubber hits token shapes and passes clean text", () => {
  assert.equal(scrubSecrets("hello X-TWO-QA-Auth world").length, 1);
  assert.equal(scrubSecrets("cookie __Host-two_session=abc").length, 1);
  assert.equal(scrubSecrets("Welcome, guest").length, 0);
});

test("reserved probes refuse the Kit marker", () => {
  const headers = { get: () => "kit" };
  assert.ok(assertReservedContract({ label: "t", status: 200, headers }).length > 0);
});

test("ledger verdicts never report a quiet green", () => {
  assert.equal(summarizeLedger([]).verdict, "empty");
  assert.equal(
    summarizeLedger([{ name: "a", status: "skipped", reason: "r" }]).verdict,
    "all-skipped",
  );
  assert.equal(summarizeLedger([{ name: "a", status: "failed", reason: "r" }]).verdict, "fail");
  assert.equal(summarizeLedger([{ name: "a", status: "passed", reason: null }]).verdict, "pass");
});

test("unit gate passes on the shipped manifest (no network)", async () => {
  const lines = [];
  const code = await runGate({
    env: {},
    stdout: { write: (text) => void lines.push(text) },
  });
  assert.equal(code, 0, `expected exit 0, got ${code}\n${lines.join("")}`);
  assert.ok(lines.some((line) => line.includes("mutant") || line.includes("Kit parity ledger")));
});

test("login journey ownership derives from the manifest", () => {
  const honoManifest = `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false }`;
  assert.equal(isManifestEnabled(honoManifest, "/e/:key"), false);
  assert.equal(isManifestEnabled(honoManifest, "/profile"), false);
  const enabledManifest =
    `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
    ` { method: "POST", path: "/e/:key/rsvp", enabled: true },` +
    ` { method: "GET", path: "/profile", enabled: true }`;
  assert.equal(isManifestEnabled(enabledManifest, "/e/:key/rsvp", "POST"), true);
  assert.equal(isManifestEnabled(enabledManifest, "/profile", "GET"), true);
  assert.equal(isManifestEnabled(enabledManifest, "/admin/events"), false);
  const disabledManifest = `{ method: "GET", path: "/profile", enabled: false }`;
  assert.equal(isManifestEnabled(disabledManifest, "/profile"), false);
});

test("manifest lookup is method-aware, order-independent, and fail-closed", () => {
  // Probe 2: GET disabled listed before POST enabled must not read as disabled.
  const mixedMethods =
    `{ method: "GET", path: "/e/:key", enabled: false },` +
    ` { method: "POST", path: "/e/:key", enabled: true }`;
  assert.equal(isManifestEnabled(mixedMethods, "/e/:key", "POST"), true);
  assert.equal(isManifestEnabled(mixedMethods, "/e/:key", "GET"), false);
  assert.equal(isManifestEnabled(mixedMethods, "/e/:key"), true);
  // Probe 3: field order never decides — enabled before path still counts.
  const reordered = `{ method: "GET", enabled: true, path: "/profile" }`;
  assert.equal(isManifestEnabled(reordered, "/profile", "GET"), true);
  // Unparseable entries throw like expectedMarkerFor, never read as disabled.
  assert.throws(
    () => isManifestEnabled(`{ method: "GET", path: "/profile" }`, "/profile", "GET"),
    /cannot parse ROUTE_MANIFEST/,
  );
  assert.throws(
    () => isManifestEnabled(`{ path: "/profile", enabled: true }`, "/profile"),
    /cannot parse ROUTE_MANIFEST/,
  );
});

test("nested reads objects never blind the manifest parser", () => {
  // Regression for the flat `\{[^{}]*\}` scan that missed every nested-reads
  // entry (/admin, /profile, /members/:user, /leaderboards/members) and let
  // an enabled member board ship on a green ledger with no run.
  const nestedEnabled =
    `{ method: "GET", path: "/leaderboards/members", enabled: true, ` +
    `reads: { resource: "leaderboard", action: "list", route: "leaderboards.members" } }`;
  const nestedDisabled =
    `{ method: "GET", path: "/admin", enabled: false, ` +
    `reads: { resource: "dashboard", action: "view", route: "admin.dashboard" } }`;
  assert.equal(parseManifestEntries(nestedEnabled).length, 1);
  assert.equal(parseManifestEntries(nestedEnabled)[0].path, "/leaderboards/members");
  assert.equal(isManifestEnabled(nestedEnabled, "/leaderboards/members", "GET"), true);
  assert.equal(isManifestEnabled(nestedDisabled, "/admin", "GET"), false);
  // Field order never decides, even with the nested object first or last.
  const reordered =
    `{ reads: { resource: "profile", action: "view", route: "profile" }, ` +
    `method: "GET", path: "/profile", enabled: true }`;
  assert.equal(isManifestEnabled(reordered, "/profile", "GET"), true);
  // A nested entry missing its flag still throws, never reads as disabled.
  assert.throws(
    () =>
      isManifestEnabled(
        `{ method: "GET", path: "/leaderboards/members", ` +
          `reads: { resource: "leaderboard", action: "list", route: "leaderboards.members" } }`,
        "/leaderboards/members",
        "GET",
      ),
    /cannot parse ROUTE_MANIFEST/,
  );
});

test("an enabled nested-reads member board is covered by the executed parity run", () => {
  // The parser still sees the nested-reads entry (the original blindness
  // regression), but the board now has executed runs — the unit contract
  // above, the authenticated preview journeys in PARITY_ROUTES and the
  // Playwright Hono-vs-Kit journey — so the catch-all no longer fails it.
  const silent = { write: () => {} };
  const journeys = runUnitMode({
    stdout: silent,
    manifestSource:
      `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
      ` { method: "GET", path: "/leaderboards/members", enabled: true, ` +
      `reads: { resource: "leaderboard", action: "list", route: "leaderboards.members" } }`,
  });
  assert.equal(isCoveredByExecutedRun({ method: "GET", path: "/leaderboards/members" }), true);
  assert.equal(summarizeLedger(journeys).verdict, "pass");
  const failed = journeys.filter((j) => j.status === "failed");
  assert.ok(
    !failed.some((j) => j.reason?.includes("/leaderboards/members")),
    "no failure may name the covered member board",
  );
});

const membersPreviewStub = `
const archivePage =
  \`<html><head><link rel="canonical" href="https://x.invalid/"></head>\` +
  \`<body><a class="skip-link" href="#main">Skip</a>\` +
  \`<nav aria-label="Primary"></nav><main id="main">\` +
  \`<section data-testid="past-events"><div data-testid="past-events-list">\` +
  \`<article data-event-key="k1"></article></div></section></main>\` +
  \`<p>Welcome, guest</p><script src="/islands/past-events.js"></script></body></html>\`;
const membersPage =
  \`<html><head><link rel="canonical" href="https://next.togetherweown.com/leaderboards/members">\` +
  \`<meta name="robots" content="noindex, nofollow"></head>\` +
  \`<body><a class="skip-link" href="#main">Skip to content</a>\` +
  \`<nav aria-label="Primary"><a href="/">Home</a></nav>\` +
  \`<p><span class="who">QA Member</span> <button type="submit" class="link">Sign out</button></p>\` +
  \`<main id="main" class="events-page"><p class="strap">Members only</p>\` +
  \`<h1>Member leaderboard</h1>\` +
  \`<nav aria-label="Board scope"><ul><li><a href="/leaderboards/members" aria-current="page">Overall</a></li>\` +
  \`<li><a href="/leaderboards/members?scope=relative">Around you</a></li></ul></nav>\` +
  \`<form method="get" action="/leaderboards/members" aria-label="Filter the leaderboard">\` +
  \`<p><input id="board-season" name="season" type="text" value="all" /></p>\` +
  \`<p><input id="board-activity" name="activity" type="text" value="" /></p>\` +
  \`<p><button class="btn" type="submit">Show board</button></p></form>\` +
  \`<table><thead><tr><th scope="col">Rank</th><th scope="col">Member</th><th scope="col">Going</th></tr></thead>\` +
  \`<tbody><tr><td>1</td><th scope="row">QA Member</th><td>3</td></tr></tbody></table>\` +
  \`</main></body></html>\`;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input.url ?? input));
  const headers = init.headers ?? {};
  if (url.pathname === "/up") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/auth/qa/qa-member") {
    if (headers["x-two-qa-auth"] !== "test-token") return new Response("no", { status: 404 });
    return new Response(null, { status: 204, headers: { "set-cookie": "__Host-two_session=two_test; Path=/; HttpOnly" } });
  }
  if (url.pathname === "/leaderboards/members") {
    const cookie = headers.cookie ?? "";
    if (!cookie.includes("__Host-two_session=")) {
      return new Response("", { status: 302, headers: { location: "/auth/discord?next=%2Fleaderboards%2Fmembers", "cache-control": "private, no-store" } });
    }
    if (url.search.includes("season=bogus") || url.search.includes("scope=") && !url.search.includes("scope=relative") || url.search.includes("activity=chess")) {
      return new Response("Unknown", { status: 400, headers: { "content-type": "text/plain", "cache-control": "private, no-store" } });
    }
    return new Response(membersPage, { status: 200, headers: { "content-type": "text/html", "cache-control": "private, no-store", ...(url.hostname.startsWith("kit.") ? { "x-two-renderer": "kit" } : {}) } });
  }
  return new Response(archivePage, { status: 200, headers: { "content-type": "text/html" } });
};
`;

test("preview member-board journeys execute with a QA session and pass", () => {
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/",
      HONO_PREVIEW_URL: "https://hono.invalid.workers.dev/",
      KIT_PARITY_QA_TOKEN: "test-token",
    },
    stub: membersPreviewStub,
  });
  // The stub serves only the archive + member-board contracts, so other
  // routes fail in this run; the member journeys themselves must all pass.
  assert.match(output, /\[passed\] preview Kit \/leaderboards\/members: contract/);
  assert.match(output, /\[passed\] preview Hono \/leaderboards\/members: no Kit marker/);
  assert.doesNotMatch(output, /\[failed\] preview [^\n]*leaderboards\/members/);
  void status;
});

test("preview member-board journeys skip loud without a QA token", () => {
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/",
      HONO_PREVIEW_URL: "https://hono.invalid.workers.dev/",
      KIT_PARITY_QA_TOKEN: "",
    },
    stub: membersPreviewStub,
  });
  assert.match(output, /\[skipped\] preview [^\n]*leaderboards\/members[^\n]*KIT_PARITY_QA_TOKEN/);
  // The guest bounce needs no session and still executes; only the
  // authenticated board fetches skip.
  assert.doesNotMatch(output, /\[passed\] preview [^\n]*scope=relative: contract/);
  void status;
});

const joinAttemptsPreviewStub = `
const archivePage =
  \`<html><head><link rel="canonical" href="https://x.invalid/"></head>\` +
  \`<body><a class="skip-link" href="#main">Skip</a>\` +
  \`<nav aria-label="Primary"></nav><main id="main">\` +
  \`<section data-testid="past-events"><div data-testid="past-events-list">\` +
  \`<article data-event-key="k1"></article></div></section></main>\` +
  \`<p>Welcome, guest</p><script src="/islands/past-events.js"></script></body></html>\`;
const attemptsPage =
  \`<html><head><title>Join attempts — TWO admin</title></head>\` +
  \`<body><a class="skip-link" href="#main">Skip to content</a>\` +
  \`<header class="bar"><nav aria-label="Administration"></nav></header>\` +
  \`<main id="main"><section><h1>Join attempts</h1>\` +
  \`<p class="hint">Read-only. Last 90 days, newest first. Search is an exact Discord id or request id.</p>\` +
  \`<form method="get" action="/admin/join-attempts" class="filters">\` +
  \`<input id="q" name="q" type="search" value="" />\` +
  \`<select id="outcome" name="outcome"></select></form>\` +
  \`<div aria-label="Join attempts list"><table data-testid="join-attempts-table"><thead><tr>\` +
  \`<th scope="col">Outcome</th><th scope="col">Source</th><th scope="col">Discord id</th>\` +
  \`<th scope="col">Request id</th><th scope="col">Attempted (UTC)</th></tr></thead>\` +
  \`<tbody><tr><td data-testid="join-attempts-empty">No join attempts.</td></tr></tbody></table></div>\` +
  \`<nav aria-label="Join attempt pages"><span>Page 1</span></nav></section></main>\` +
  \`<footer>Together We Own · moderators only</footer></body></html>\`;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input.url ?? input));
  const headers = init.headers ?? {};
  if (url.pathname === "/up") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/auth/qa/qa-member" || url.pathname === "/auth/qa/qa-moderator") {
    if (headers["x-two-qa-auth"] !== "test-token") return new Response("no", { status: 404 });
    const kind = url.pathname.endsWith("qa-moderator") ? "mod" : "member";
    return new Response(null, { status: 204, headers: { "set-cookie": "__Host-two_session=two_" + kind + "; Path=/; HttpOnly" } });
  }
  if (url.pathname === "/admin/join-attempts" || url.pathname.startsWith("/admin/join-attempts/")) {
    const cookie = headers.cookie ?? "";
    if (!cookie.includes("__Host-two_session=")) {
      return new Response("", { status: 302, headers: { location: "/auth/discord?next=%2Fadmin%2Fjoin-attempts", "cache-control": "private, no-store" } });
    }
    if (cookie.includes("two_member")) {
      return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
    }
    if (url.pathname !== "/admin/join-attempts") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(attemptsPage, { status: 200, headers: { "content-type": "text/html", "cache-control": "private, no-store", ...(url.hostname.startsWith("kit.") ? { "x-two-renderer": "kit" } : {}) } });
  }
  return new Response(archivePage, { status: 200, headers: { "content-type": "text/html" } });
};
`;

test("preview join-attempts journeys execute with QA sessions and pass", () => {
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/",
      HONO_PREVIEW_URL: "https://hono.invalid.workers.dev/",
      KIT_PARITY_QA_TOKEN: "test-token",
    },
    stub: joinAttemptsPreviewStub,
  });
  // The stub serves only the archive + join-attempts contracts, so other
  // routes fail in this run; the join-attempts journeys must all pass.
  assert.match(output, /\[passed\] preview Kit \/admin\/join-attempts: contract/);
  assert.match(output, /\[passed\] preview Hono \/admin\/join-attempts: no Kit marker/);
  assert.doesNotMatch(output, /\[failed\] preview [^\n]*join-attempts/);
  void status;
});

test("preview join-attempts journeys skip loud without a QA token", () => {
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/",
      HONO_PREVIEW_URL: "https://hono.invalid.workers.dev/",
      KIT_PARITY_QA_TOKEN: "",
    },
    stub: joinAttemptsPreviewStub,
  });
  assert.match(output, /\[skipped\] preview [^\n]*join-attempts[^\n]*KIT_PARITY_QA_TOKEN/);
  void status;
});

test("member-board contract passes a good fixture and fails planted mutants", () => {
  const goodHtml =
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
  const headers = {
    get: (name) => {
      if (name === "content-type") return "text/html; charset=UTF-8";
      if (name === "x-two-renderer") return null;
      if (name === "cache-control") return "private, no-store";
      return null;
    },
  };
  const expected = { status: 200, marker: null, cache: "private, no-store" };
  assert.equal(
    assertMembersContract({
      label: "unit/members-good",
      html: goodHtml,
      headers,
      status: 200,
      expected,
    }).length,
    0,
  );
  const mutants = [
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
  for (const [name, mutate, want] of mutants) {
    const failures = assertMembersContract({
      label: `unit/members-mutant-${name}`,
      html: mutate(goodHtml),
      headers: {
        get: (n) => {
          if (n === "content-type") return "text/html; charset=UTF-8";
          if (n === "x-two-renderer") return name === "wrong-renderer" ? "kit" : null;
          if (n === "cache-control")
            return name === "shared-cache" ? "public, max-age=300" : "private, no-store";
          return null;
        },
      },
      status: 200,
      expected: {
        ...expected,
        cache: name === "shared-cache" ? "public, max-age=300" : expected.cache,
      },
    });
    assert.ok(
      failures.some((f) => f.includes(want)),
      `member mutant ${name} did not trip "${want}" (got: ${failures.join("; ") || "no failures"})`,
    );
  }
});

test("static-leaf contracts pass good fixtures and fail planted mutants", () => {
  const shell = (path, inner) =>
    `<html><head><link rel="canonical" href="https://next.togetherweown.com${path}"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"><a href="/">Home</a></nav>` +
    `<main id="main"><section class="content-page">${inner}</section></main>` +
    `<p><span class="account-caption">Welcome, guest</span></p></body></html>`;
  const cases = [
    {
      contract: "about",
      path: "/about",
      html: shell(
        "/about",
        `<h1 id="about-heading">About Together We Own</h1>` +
          `<p class="strap">Est. 1998</p>` +
          `<dl data-testid="about-facts" class="facts"></dl>` +
          `<p><a class="btn" href="/join" data-testid="about-join">Join with Discord</a></p>`,
      ),
      mutants: [
        [
          "no-facts",
          (html) => html.replace('data-testid="about-facts"', 'data-testid="x"'),
          "leaf section about-facts present",
        ],
        [
          "hostile-join",
          (html) => html.replace('href="/join"', 'href="https://evil.test/"'),
          "join action stays same-origin /join",
        ],
      ],
    },
    {
      contract: "faq",
      path: "/faq",
      html: shell(
        "/faq",
        `<h1 id="faq-heading">Frequently asked questions</h1>` +
          `<p class="strap">New here? Start here</p>` +
          `<div data-testid="faq-list">` +
          `<section aria-labelledby="faq-getting-in"><h2 id="faq-getting-in">Getting in</h2></section></div>` +
          `<p><a class="btn" href="/join" data-testid="faq-join">Join with Discord</a></p>`,
      ),
      mutants: [
        [
          "no-list",
          (html) => html.replace('data-testid="faq-list"', 'data-testid="x"'),
          "leaf section faq-list present",
        ],
        [
          "no-first-group",
          (html) => html.replace(/<section aria-labelledby="faq-getting-in">.*?<\/section>/, ""),
          "first question group present",
        ],
      ],
    },
  ];
  for (const { contract, html, mutants } of cases) {
    const headers = {
      get: (name) => {
        if (name === "content-type") return "text/html; charset=UTF-8";
        if (name === "x-two-renderer") return "kit";
        if (name === "cache-control") return "public, max-age=3600";
        return null;
      },
    };
    const expected = { status: 200, marker: "kit", contract, cache: "public, max-age=3600" };
    assert.equal(
      assertRouteContract({
        label: `unit/leaves-${contract}-good`,
        html,
        headers,
        status: 200,
        expected,
      }).length,
      0,
    );
    for (const [name, mutate, want] of mutants) {
      const failures = assertRouteContract({
        label: `unit/leaves-${contract}-mutant-${name}`,
        html: mutate(html),
        headers,
        status: 200,
        expected,
      });
      assert.ok(
        failures.some((f) => f.includes(want)),
        `leaf mutant ${contract}/${name} did not trip "${want}" (got: ${failures.join("; ") || "no failures"})`,
      );
    }
  }
});

test("enabled static leaves are covered by the executed parity run", () => {
  // The catch-all no longer fails the leaves: PARITY_ROUTES carries their
  // contracts, so the shipped enabled entries are covered runs, and a
  // synthetic manifest with the leaves disabled keeps the leaf journeys out.
  assert.equal(isCoveredByExecutedRun({ method: "GET", path: "/about" }), true);
  assert.equal(isCoveredByExecutedRun({ method: "GET", path: "/faq" }), true);
  const silent = { write: () => {} };
  const heldJourneys = runUnitMode({
    stdout: silent,
    manifestSource:
      `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
      ` { method: "GET", path: "/about", enabled: false, reads: "public" },` +
      ` { method: "GET", path: "/faq", enabled: false, reads: "public" },`,
  });
  // The leaf unit journeys run against any manifest that lists the leaves
  // (the expected marker derives from it: null while held, kit once
  // enabled); the coverage catch-all only fails enabled entries, so the
  // held leaves stay quiet here.
  const failed = heldJourneys.filter((j) => j.status === "failed");
  assert.ok(
    !failed.some((j) => j.reason?.includes("/about") || j.reason?.includes("/faq")),
    "no failure may name the held leaves",
  );
});

test("an enabled login route fails instead of a quiet skip", () => {
  const silent = { write: () => {} };
  const honoJourneys = runUnitMode({
    stdout: silent,
    manifestSource: `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false }`,
  });
  for (const journey of honoJourneys.filter((j) => j.name.startsWith("parity: "))) {
    assert.equal(journey.status, "skipped", journey.name);
  }
  const enabledJourneys = runUnitMode({
    stdout: silent,
    manifestSource:
      `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
      ` { method: "POST", path: "/e/:key/rsvp", enabled: true },` +
      ` { method: "GET", path: "/profile", enabled: true }`,
  });
  const byName = new Map(enabledJourneys.map((j) => [j.name, j]));
  assert.equal(byName.get("parity: member RSVP going/withdraw (/e/:key)").status, "failed");
  assert.equal(byName.get("parity: member profile edit (/profile)").status, "failed");
  assert.equal(byName.get("parity: moderator publish/cancel (/admin/events)").status, "skipped");
  assert.equal(summarizeLedger(enabledJourneys).verdict, "fail");
});

test("enabling the real mutation routes fails every login journey", () => {
  const silent = { write: () => {} };
  const journeys = runUnitMode({
    stdout: silent,
    manifestSource:
      `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
      ` { method: "POST", path: "/e/:key/rsvp", enabled: true },` +
      ` { method: "PUT", path: "/events/:key/rsvp", enabled: true },` +
      ` { method: "PATCH", path: "/members/:user", enabled: true },` +
      ` { method: "POST", path: "/admin/events/:key", enabled: true }`,
  });
  const byName = new Map(journeys.map((j) => [j.name, j]));
  assert.equal(byName.get("parity: member RSVP going/withdraw (/e/:key)").status, "failed");
  assert.match(
    byName.get("parity: member RSVP going/withdraw (/e/:key)").reason,
    /POST \/e\/:key\/rsvp/,
  );
  assert.equal(byName.get("parity: member profile edit (/profile)").status, "failed");
  assert.equal(byName.get("parity: moderator publish/cancel (/admin/events)").status, "failed");
  assert.equal(summarizeLedger(journeys).verdict, "fail");
});

test("manifest matching ignores :param names like the runtime router", () => {
  assert.equal(pathsMatchStructurally("/e/:key/rsvp", "/e/:id/rsvp"), true);
  assert.equal(pathsMatchStructurally("/members/:user", "/members/:slug"), true);
  assert.equal(pathsMatchStructurally("/admin/events/:key", "/admin/events/:key/publish"), false);
  assert.equal(
    isManifestEnabled(
      `{ method: "POST", path: "/e/:id/rsvp", enabled: true }`,
      "/e/:key/rsvp",
      "POST",
    ),
    true,
  );
  assert.equal(
    isManifestEnabled(
      `{ method: "PATCH", path: "/members/:slug", enabled: true }`,
      "/members/:user",
      "PATCH",
    ),
    true,
  );
});

test("renamed :params still fail their login journey instead of a quiet skip", () => {
  const silent = { write: () => {} };
  const journeys = runUnitMode({
    stdout: silent,
    manifestSource:
      `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
      ` { method: "POST", path: "/e/:id/rsvp", enabled: true },` +
      ` { method: "PATCH", path: "/members/:slug", enabled: true }`,
  });
  const byName = new Map(journeys.map((j) => [j.name, j]));
  assert.equal(byName.get("parity: member RSVP going/withdraw (/e/:key)").status, "failed");
  assert.match(
    byName.get("parity: member RSVP going/withdraw (/e/:key)").reason,
    /POST \/e\/:id\/rsvp/,
  );
  assert.equal(byName.get("parity: member profile edit (/profile)").status, "failed");
  assert.match(
    byName.get("parity: member profile edit (/profile)").reason,
    /PATCH \/members\/:slug/,
  );
  assert.equal(byName.get("parity: moderator publish/cancel (/admin/events)").status, "skipped");
  assert.equal(summarizeLedger(journeys).verdict, "fail");
});

test("each admin publish/cancel action route fails the admin journey", () => {
  const silent = { write: () => {} };
  for (const route of [
    `{ method: "POST", path: "/admin/events/:key/publish", enabled: true }`,
    `{ method: "POST", path: "/admin/events/:key/cancel", enabled: true }`,
    `{ method: "POST", path: "/admin/events/:key/rsvp-pause", enabled: true }`,
    `{ method: "POST", path: "/admin/events/:key/rsvp-reopen", enabled: true }`,
    `{ method: "GET", path: "/admin/events/new", enabled: true }`,
    // Renamed :param must not escape the admin journey either.
    `{ method: "POST", path: "/admin/events/:id/publish", enabled: true }`,
  ]) {
    const journeys = runUnitMode({
      stdout: silent,
      manifestSource: `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false }, ${route}`,
    });
    const byName = new Map(journeys.map((j) => [j.name, j]));
    assert.equal(
      byName.get("parity: moderator publish/cancel (/admin/events)").status,
      "failed",
      route,
    );
    assert.equal(summarizeLedger(journeys).verdict, "fail", route);
  }
});

test("a future scoped route fails its journey even when never listed", () => {
  const silent = { write: () => {} };
  const journeys = runUnitMode({
    stdout: silent,
    manifestSource:
      `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
      ` { method: "POST", path: "/admin/events/:key/approve", enabled: true }`,
  });
  const byName = new Map(journeys.map((j) => [j.name, j]));
  assert.equal(byName.get("parity: moderator publish/cancel (/admin/events)").status, "failed");
  assert.match(
    byName.get("parity: moderator publish/cancel (/admin/events)").reason,
    /POST \/admin\/events\/:key\/approve/,
  );
  // The public archive never trips the RSVP scope.
  assert.equal(isInJourneyScope("rsvp", "/events/past"), false);
  assert.equal(isInJourneyScope("admin", "/admin/events/:key/approve"), true);
  assert.equal(isInJourneyScope("profile", "/members/:slug"), true);
});

test("preview Hono-only break fails with the Hono journey named", () => {
  const good = (key) =>
    `<html><head><link rel="canonical" href="https://x.invalid/">` +
    `<meta name="robots" content="noindex, follow"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"></nav><main id="main">` +
    `<section data-testid="past-events"><div data-testid="past-events-list">` +
    `<article data-event-key="${key}"></article></div></section></main>` +
    `<p>Welcome, guest</p><script src="/islands/past-events.js"></script></body></html>`;
  // Hono side lacks <main> and shows signed-in chrome: passes the old
  // status+marker-only check, fails the full assertRouteContract.
  const honoBroken = good("same-key")
    .replace(/<main id="main">/, '<div id="main">')
    .replace(/<\/main>/, "</div>")
    .replace("Welcome, guest", "Sign out");
  const stub = `
const good = ${good.toString()};
const honoBroken = ${JSON.stringify(honoBroken)};
globalThis.fetch = async (input) => {
  const url = new URL(String(input.url ?? input));
  if (url.pathname === "/up") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const html = url.host === "kit.invalid.workers.dev" ? good("same-key") : honoBroken;
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
};
`;
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/",
      HONO_PREVIEW_URL: "https://hono.invalid.workers.dev/",
    },
    stub,
  });
  assert.equal(status, 1, `expected exit 1, got ${status}\n${output}`);
  assert.match(output, /preview Hono/);
});

test("preview events journey enforces the shipped cache TTL pattern", () => {
  const events = PARITY_ROUTES.find((route) => route.path === "/events");
  assert.ok(events?.cachePattern instanceof RegExp, "events route pins a cache pattern");
  const html =
    '<html><head><link rel="canonical" href="https://x.invalid/events">' +
    '<link rel="alternate" type="text/markdown" href="/events.md"></head>' +
    '<body><a class="skip-link" href="#main">Skip</a>' +
    '<nav aria-label="Primary"><a href="/events" aria-current="page">Events</a></nav>' +
    '<main id="main"><section data-testid="events-calendar" data-island="events-calendar">' +
    '<div data-testid="events-content"><div data-testid="events-list"></div></div>' +
    '<div role="group" aria-label="View"><button data-testid="events-view-list">L</button>' +
    '<button data-testid="events-view-calendar">C</button></div>' +
    '<form method="get" action="/events"><input type="search" name="q" data-testid="events-search"></form>' +
    '<a href="/events/past" data-testid="events-past-archive-link">Past</a>' +
    '<a href="webcal://x.invalid/events.ics" data-testid="events-subscribe">Sub</a>' +
    '</section></main><p>Welcome, guest</p><script src="/islands/events-calendar.js"></script></body></html>';
  const stub = `
const html = ${JSON.stringify(html)};
globalThis.fetch = async (input) => {
  const url = new URL(String(input.url ?? input));
  if (url.pathname === "/up") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/events") return new Response(html, { status: 200, headers: { "content-type": "text/html", "cache-control": "public, max-age=9999", vary: "Cookie, X-Two-Island", ...(url.host.startsWith("kit.") ? { "x-two-renderer": "kit" } : {}) } });
  return new Response("", { status: 404 });
};
`;
  const { status, output } = runScript({
    env: {
      KIT_PREVIEW_URL: "https://kit.invalid.workers.dev/",
      HONO_PREVIEW_URL: "https://hono.invalid.workers.dev/",
    },
    stub,
  });
  assert.equal(status, 1, `expected preview contract failure, got ${status}\\n${output}`);
  assert.match(output, /preview Kit \/events: contract.*cache-control.*does not match/);
});

test("every listed login route alone fails its own journey (no aggregate masking)", () => {
  const silent = { write: () => {} };
  for (const journey of LOGIN_JOURNEYS) {
    for (const route of journey.routes) {
      const manifestSource =
        `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
        ` { method: "${route.method}", path: "${route.path}", enabled: true }`;
      const journeys = runUnitMode({ stdout: silent, manifestSource });
      const byName = new Map(journeys.map((j) => [j.name, j]));
      const entry = byName.get(`parity: ${journey.name}`);
      assert.equal(
        entry.status,
        "failed",
        `${route.method} ${route.path} must fail ${journey.name}`,
      );
      assert.match(entry.reason, /no executed parity journey covers it/);
      assert.equal(summarizeLedger(journeys).verdict, "fail", `${route.method} ${route.path}`);
    }
  }
});

test("recovery contract proves the shared shell, safe retry hrefs and private no-store", () => {
  const headers = (cache) => ({
    get: (name) =>
      ({
        "content-type": "text/html",
        "x-two-renderer": null,
        "cache-control": cache,
      })[name] ?? null,
  });
  const shell = (retryHref, inviteHref, title, message) =>
    `<html><head></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"></nav><main id="main">` +
    `<section class="hero recovery-hero" aria-labelledby="recovery-heading">` +
    `<p class="strap">Let's get you back to the lobby</p>` +
    `<h1 id="recovery-heading">${title}</h1>` +
    `<p class="lead">${message}</p>` +
    `<p class="recovery-actions"><a class="btn" href="${retryHref}" data-testid="recovery-retry">Retry</a> ` +
    `<a href="${inviteHref}" data-testid="recovery-invite">Join with an invite link instead</a></p>` +
    `</section></main><p><span class="account-caption">Welcome, guest</span></p></body></html>`;
  const goodCases = [
    [
      "expired session",
      shell("/auth/discord?next=%2Fprofile", "/discord", "Your session expired", "Sign in again."),
    ],
    [
      "join denied",
      shell("/join/discord", "https://discord.gg/i", "Join cancelled", "You cancelled."),
    ],
  ];
  for (const [name, html] of goodCases) {
    const failures = assertRouteContract({
      label: `recover/${name}`,
      html,
      headers: headers("no-store, private"),
      status: 200,
      expected: { status: 200, marker: null, contract: "recovery", cache: "no-store, private" },
    });
    assert.equal(failures.length, 0, `${name}: ${failures.join("; ")}`);
  }
  // Forced-failure proof: a missing retry action, a hostile retry href, a
  // javascript: invite, a missing invite fallback and a shared-cacheable
  // recovery must all FAIL. A gate that cannot fail on a planted break
  // proves nothing.
  const good = goodCases[0][1];
  const mutants = [
    ["no-retry", (html) => html.replace('data-testid="recovery-retry"', 'data-testid="x"')],
    [
      "hostile-retry",
      (html) => html.replace('href="/auth/discord?next=%2Fprofile"', 'href="https://evil.test/"'),
    ],
    ["no-invite", (html) => html.replace('data-testid="recovery-invite"', 'data-testid="x"')],
    ["javascript-invite", (html) => html.replace('href="/discord"', 'href="javascript:alert(1)"')],
  ];
  for (const [name, mutate] of mutants) {
    const failures = assertRouteContract({
      label: `recover-mutant-${name}`,
      html: mutate(good),
      headers: headers("no-store, private"),
      status: 200,
      expected: { status: 200, marker: null, contract: "recovery", cache: "no-store, private" },
    });
    assert.ok(failures.length > 0, `${name} was NOT detected`);
  }
  // A shared-cacheable recovery fails however the expected cache is pinned:
  // recovery views carry per-visitor journey state and never go shared.
  const sharedFailures = assertRouteContract({
    label: "recover-mutant-shared-cache",
    html: good,
    headers: headers("public, max-age=60"),
    status: 200,
    expected: { status: 200, marker: null, contract: "recovery", cache: "public, max-age=60" },
  });
  assert.ok(sharedFailures.length > 0, "shared-cache recovery was NOT detected");
});

test("enabled routes outside every journey scope fail via the catch-all", () => {
  const silent = { write: () => {} };
  // GET /join, GET /events and the moderator join-attempts pair are covered
  // by the executed parity run (PARITY_ROUTES), so none belongs in this
  // uncovered list; /join/discord proves the funnel tail stays Hono-owned.
  for (const route of [
    `{ method: "GET", path: "/admin", enabled: true }`,
    `{ method: "GET", path: "/admin/featured", enabled: true }`,
    `{ method: "GET", path: "/admin/featured/:id", enabled: true }`,
    `{ method: "GET", path: "/admin/queue/failed/:id/preview", enabled: true }`,
    `{ method: "GET", path: "/events/:key", enabled: true }`,
    `{ method: "GET", path: "/join/discord", enabled: true }`,
    `{ method: "GET", path: "/", enabled: true }`,
    `{ method: "POST", path: "/events/past", enabled: true }`,
  ]) {
    const journeys = runUnitMode({
      stdout: silent,
      manifestSource: `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false }, ${route}`,
    });
    assert.equal(summarizeLedger(journeys).verdict, "fail", route);
    const failed = journeys.filter((j) => j.status === "failed");
    assert.ok(failed.length > 0, route);
    assert.ok(
      failed.some((j) => j.reason?.includes(route.match(/path: "([^"]+)"/)[1])),
      `${route} reason must name the entry`,
    );
  }
});

test("executed-run coverage is GET/HEAD /events/past, GET/HEAD /events, GET/HEAD /join and GET/HEAD /auth/recover", () => {
  assert.equal(
    isCoveredByExecutedRun({ method: "GET", path: "/events/past", enabled: true }),
    true,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "HEAD", path: "/events/past", enabled: true }),
    true,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "POST", path: "/events/past", enabled: true }),
    false,
  );
  assert.equal(isCoveredByExecutedRun({ method: "GET", path: "/events", enabled: true }), true);
  assert.equal(isCoveredByExecutedRun({ method: "HEAD", path: "/events", enabled: true }), true);
  assert.equal(isCoveredByExecutedRun({ method: "POST", path: "/events", enabled: true }), false);
  assert.equal(isCoveredByExecutedRun({ method: "GET", path: "/admin", enabled: true }), false);
  assert.equal(isCoveredByExecutedRun({ method: "GET", path: "/join", enabled: true }), true);
  assert.equal(isCoveredByExecutedRun({ method: "HEAD", path: "/join", enabled: true }), true);
  assert.equal(isCoveredByExecutedRun({ method: "POST", path: "/join", enabled: true }), false);
  assert.equal(
    isCoveredByExecutedRun({ method: "GET", path: "/join/discord", enabled: true }),
    false,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "GET", path: "/auth/recover", enabled: true }),
    true,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "HEAD", path: "/auth/recover", enabled: true }),
    true,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "POST", path: "/auth/recover", enabled: true }),
    false,
  );
});

test("executed-run coverage includes the moderator join-attempts pair via its numeric detail instance", () => {
  assert.equal(
    isCoveredByExecutedRun({ method: "GET", path: "/admin/join-attempts", enabled: true }),
    true,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "HEAD", path: "/admin/join-attempts", enabled: true }),
    true,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "POST", path: "/admin/join-attempts", enabled: true }),
    false,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "GET", path: "/admin/join-attempts/:id", enabled: true }),
    true,
  );
  // A renamed :param is the same pattern family to the runtime router, so
  // the numeric instance still covers it; a static sibling never does.
  assert.equal(
    isCoveredByExecutedRun({
      method: "GET",
      path: "/admin/join-attempts/:attemptId",
      enabled: true,
    }),
    true,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "GET", path: "/events/:key", enabled: true }),
    false,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "GET", path: "/admin/featured/:id", enabled: true }),
    false,
  );
  assert.equal(
    isCoveredByExecutedRun({ method: "POST", path: "/admin/join-attempts/:id", enabled: true }),
    false,
  );
});

test("an enabled nested-reads join-attempts pair is covered by the executed parity run", () => {
  const silent = { write: () => {} };
  const journeys = runUnitMode({
    stdout: silent,
    manifestSource:
      `{ method: "GET", path: "/events/past", enabled: false }, { method: "GET", path: "/events", enabled: false }, { method: "GET", path: "/join", enabled: false }, { method: "GET", path: "/auth/recover", enabled: false },` +
      ` { method: "GET", path: "/admin/join-attempts", enabled: true, ` +
      `reads: { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" } },` +
      ` { method: "GET", path: "/admin/join-attempts/:id", enabled: true, ` +
      `reads: { resource: "join_attempts", action: "view", route: "admin.join-attempts.show" } }`,
  });
  assert.equal(summarizeLedger(journeys).verdict, "pass");
  const failed = journeys.filter((j) => j.status === "failed");
  assert.ok(
    !failed.some((j) => j.reason?.includes("/admin/join-attempts")),
    "no failure may name the covered join-attempts pair",
  );
});

test("route contract detects a planted break", () => {
  const headers = {
    get: (name) => ({ "content-type": "text/html", "x-two-renderer": null })[name] ?? null,
  };
  const good = assertRouteContract({
    label: "t",
    html: `<html><head><link rel="canonical" href="x"><meta name="robots" content="noindex, follow"></head><body><a class="skip-link" href="#main">s</a><nav aria-label="Primary"></nav><main><section data-testid="past-events"></section></main><p>Welcome, guest</p><script src="/islands/past-events.js"></script></body></html>`,
    headers,
    status: 200,
    expected: { status: 200, marker: null },
  });
  assert.equal(good.length, 0, good.join("; "));
  const bad = assertRouteContract({
    label: "t",
    html: `<html><head></head><body></body></html>`,
    headers,
    status: 200,
    expected: { status: 200, marker: null },
  });
  assert.ok(bad.length > 0);
});

test("join contract proves every widget state, the flash view and hostile next", () => {
  const headers = (cache) => ({
    get: (name) =>
      ({
        "content-type": "text/html",
        "x-two-renderer": null,
        "cache-control": cache,
        vary: "Cookie",
      })[name] ?? null,
  });
  const shell = (inner) =>
    `<html><head><link rel="canonical" href="https://x.invalid/join"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"></nav><main id="main">` +
    `<section class="join-layout" aria-labelledby="join-heading">` +
    `<div class="join-panel"><h1 id="join-heading">Join</h1>` +
    `<p class="join-actions"><a href="/join/discord" data-testid="join-oneclick">Join</a> ` +
    `<a href="https://discord.gg/i" data-testid="join-invite">Invite</a></p></div>` +
    `<div class="join-preview">${inner}</div></section></main>` +
    `<p>Welcome, guest</p></body></html>`;
  const facade =
    `<div class="strap"><a href="https://discord.com/widget?id=1&theme=dark" ` +
    `referrerpolicy="no-referrer" data-join-widget data-testid="join-widget-load">Show</a>` +
    `<script src="/islands/join-widget.js" defer></script></div>`;
  const presence =
    `<section data-testid="join-widget-presence"><p data-testid="join-widget-online">` +
    `<strong>42</strong> members online</p></section>` +
    facade;
  const fallback =
    `<p class="strap" data-testid="join-widget-fallback">Live server preview is ` +
    `unavailable — the join button above still works.</p>`;
  const goodCases = [
    ["cold facade", shell(facade), "public, max-age=3600"],
    ["warm presence", shell(presence), "public, max-age=60"],
    ["fallback", shell(fallback), "public, max-age=3600"],
  ];
  for (const [name, html, cache] of goodCases) {
    const failures = assertRouteContract({
      label: `join/${name}`,
      html,
      headers: headers(cache),
      status: 200,
      expected: { status: 200, marker: null, contract: "join", cache },
    });
    assert.equal(failures.length, 0, `${name}: ${failures.join("; ")}`);
  }
  // The flash view renders the banner exactly once and answers private.
  const flashed = shell(facade).replace(
    '<section class="join-layout"',
    '<p class="notice" role="status" data-testid="join-result">You are in.</p>' +
      '<section class="join-layout"',
  );
  const flashFailures = assertRouteContract({
    label: "join/flash",
    html: flashed,
    headers: headers("private, no-store"),
    status: 200,
    expected: { status: 200, marker: null, contract: "join", cache: "private, no-store" },
  });
  assert.equal(flashFailures.length, 0, flashFailures.join("; "));
  // A flash view served shared-cacheable is a privacy break, not a pass.
  const sharedFlash = assertRouteContract({
    label: "join/flash-shared-cache",
    html: flashed,
    headers: headers("public, max-age=3600"),
    status: 200,
    expected: { status: 200, marker: null, contract: "join", cache: "private, no-store" },
  });
  assert.ok(sharedFlash.length > 0, "shared-cache flash must fail");
  const mutants = [
    ["no-oneclick", (html) => html.replace('data-testid="join-oneclick"', 'data-testid="x"')],
    // Facade and fallback together: the page shows exactly one widget zone.
    ["both-zones", (html) => html.replace("</div></section>", `</div>${fallback}</section>`)],
    // Presence without its facade link: the live frame has no click target.
    ["presence-without-facade", (html) => html.replace(facade, "")],
    // A hostile next must leave no trace in the one-click href.
    [
      "hostile-next",
      (html) =>
        html.replace('href="/join/discord"', 'href="/join/discord?next=https%3A%2F%2Fevil.test"'),
    ],
  ];
  for (const [name, mutate] of mutants) {
    const failures = assertRouteContract({
      label: `join/mutant-${name}`,
      html: mutate(shell(facade)),
      headers: headers("public, max-age=3600"),
      status: 200,
      expected: { status: 200, marker: null, contract: "join", cache: "public, max-age=3600" },
    });
    assert.ok(failures.length > 0, `join mutant ${name} was NOT detected`);
  }
});

test("events contract proves the calendar island, search form, archive link and flash privacy", () => {
  const headers = (cache) => ({
    get: (name) =>
      ({
        "content-type": "text/html",
        "x-two-renderer": null,
        "cache-control": cache,
        vary: "Cookie, X-Two-Island",
      })[name] ?? null,
  });
  const shell = (inner) =>
    `<html><head><link rel="canonical" href="https://x.invalid/events">` +
    `<link rel="alternate" type="text/markdown" href="/events.md"></head>` +
    `<body><a class="skip-link" href="#main">Skip</a>` +
    `<nav aria-label="Primary"><a href="/events" aria-current="page">Events</a></nav>` +
    `<main id="main"><section data-testid="events-calendar" data-island="events-calendar">` +
    `<div data-testid="events-content"><div data-testid="events-list">${inner}</div></div>` +
    `<div role="group" aria-label="View"><button data-testid="events-view-list">L</button>` +
    `<button data-testid="events-view-calendar">C</button></div>` +
    `<form method="get" action="/events"><input type="search" name="q" data-testid="events-search">` +
    `</form><a href="/events/past" data-testid="events-past-archive-link">Past</a>` +
    `<a href="webcal://x.invalid/events.ics" data-testid="events-subscribe">Sub</a>` +
    `</section></main><p>Welcome, guest</p>` +
    `<script src="/islands/events-calendar.js"></script></body></html>`;
  const eventsRoute = PARITY_ROUTES.find((route) => route.path === "/events");
  assert.ok(eventsRoute?.cachePattern instanceof RegExp, "events route pins a cache pattern");
  const good = assertRouteContract({
    label: "events/good",
    html: shell(""),
    headers: headers("public, max-age=60"),
    status: 200,
    expected: {
      status: 200,
      marker: null,
      contract: eventsRoute.contract,
      cachePattern: eventsRoute.cachePattern,
    },
  });
  assert.equal(good.length, 0, good.join("; "));
  const ttlExpectation = {
    status: 200,
    marker: null,
    contract: eventsRoute.contract,
    cachePattern: eventsRoute.cachePattern,
  };
  assert.equal(
    assertRouteContract({
      label: "events/remaining-cache-ttl",
      html: shell(""),
      headers: headers("public, max-age=59"),
      status: 200,
      expected: ttlExpectation,
    }).length,
    0,
    "remaining public cache TTL is valid",
  );
  for (const privateCache of ["private, no-store", "no-store, private"]) {
    assert.ok(
      assertRouteContract({
        label: `events/mutant-private-cache-${privateCache}`,
        html: shell(""),
        headers: headers(privateCache),
        status: 200,
        expected: ttlExpectation,
      }).some((failure) => failure.includes("cache-control")),
      `${privateCache} must not satisfy the guest cache contract`,
    );
  }
  // A flash view served shared-cacheable is a privacy break, not a pass.
  const flashed = shell("").replace(
    '<section data-testid="events-calendar"',
    '<p class="notice" role="status" data-testid="join-result">You are in.</p>' +
      '<section data-testid="events-calendar"',
  );
  const sharedFlash = assertRouteContract({
    label: "events/flash-shared-cache",
    html: flashed,
    headers: headers("public, max-age=60"),
    status: 200,
    expected: { status: 200, marker: null, contract: "events", cache: "public, max-age=60" },
  });
  assert.ok(sharedFlash.length > 0, "shared-cache flash must fail");
  // The same flashed view answers private with no failure.
  const privateFlash = assertRouteContract({
    label: "events/flash-private",
    html: flashed,
    headers: headers("private, no-store"),
    status: 200,
    expected: { status: 200, marker: null, contract: "events", cache: "private, no-store" },
  });
  assert.equal(privateFlash.length, 0, privateFlash.join("; "));
  const mutants = [
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
    ["no-subscribe", (html) => html.replace('data-testid="events-subscribe"', 'data-testid="x"')],
    ["no-markdown", (html) => html.replace('href="/events.md"', 'href="/x.md"')],
    // The <link rel="canonical"> element itself must name /events: nav and
    // form `/events"` substrings alone never satisfy it, so a canonical at
    // the archive or the site root must FAIL.
    [
      "canonical-archive-target",
      (html) =>
        html.replace(
          '<link rel="canonical" href="https://x.invalid/events">',
          '<link rel="canonical" href="https://x.invalid/events/past">',
        ),
    ],
    [
      "canonical-root-target",
      (html) =>
        html.replace(
          '<link rel="canonical" href="https://x.invalid/events">',
          '<link rel="canonical" href="https://x.invalid/">',
        ),
    ],
  ];
  for (const [name, mutate] of mutants) {
    const failures = assertRouteContract({
      label: `events/mutant-${name}`,
      html: mutate(shell("")),
      headers: headers("public, max-age=60"),
      status: 200,
      expected: { status: 200, marker: null, contract: "events", cache: "public, max-age=60" },
    });
    assert.ok(failures.length > 0, `events mutant ${name} was NOT detected`);
  }
  // Vary pins both tokens: full and island-fragment representations share the
  // URL and differ by X-Two-Island, so dropping either token must FAIL.
  for (const [name, vary] of [
    ["vary-cookie-only", "Cookie"],
    ["vary-island-only", "X-Two-Island"],
  ]) {
    const failures = assertRouteContract({
      label: `events/mutant-${name}`,
      html: shell(""),
      headers: {
        get: (header) =>
          ({
            "content-type": "text/html",
            "x-two-renderer": null,
            "cache-control": "public, max-age=60",
            vary,
          })[header] ?? null,
      },
      status: 200,
      expected: { status: 200, marker: null, contract: "events", cache: "public, max-age=60" },
    });
    assert.ok(failures.length > 0, `events mutant ${name} was NOT detected`);
  }
});
