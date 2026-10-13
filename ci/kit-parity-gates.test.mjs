import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOGIN_JOURNEYS,
  assertReservedContract,
  assertRouteContract,
  expectedMarkerFor,
  isAllowlistedHost,
  isCoveredByExecutedRun,
  isInJourneyScope,
  isManifestEnabled,
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
  const honoManifest = `{ method: "GET", path: "/events/past", enabled: false }`;
  assert.equal(isManifestEnabled(honoManifest, "/e/:key"), false);
  assert.equal(isManifestEnabled(honoManifest, "/profile"), false);
  const enabledManifest =
    `{ method: "GET", path: "/events/past", enabled: false },` +
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

test("an enabled login route fails instead of a quiet skip", () => {
  const silent = { write: () => {} };
  const honoJourneys = runUnitMode({
    stdout: silent,
    manifestSource: `{ method: "GET", path: "/events/past", enabled: false }`,
  });
  for (const journey of honoJourneys.filter((j) => j.name.startsWith("parity: "))) {
    assert.equal(journey.status, "skipped", journey.name);
  }
  const enabledJourneys = runUnitMode({
    stdout: silent,
    manifestSource:
      `{ method: "GET", path: "/events/past", enabled: false },` +
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
      `{ method: "GET", path: "/events/past", enabled: false },` +
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
      `{ method: "GET", path: "/events/past", enabled: false },` +
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
      manifestSource: `{ method: "GET", path: "/events/past", enabled: false }, ${route}`,
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
      `{ method: "GET", path: "/events/past", enabled: false },` +
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

test("every listed login route alone fails its own journey (no aggregate masking)", () => {
  const silent = { write: () => {} };
  for (const journey of LOGIN_JOURNEYS) {
    for (const route of journey.routes) {
      const manifestSource =
        `{ method: "GET", path: "/events/past", enabled: false },` +
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

test("enabled routes outside every journey scope fail via the catch-all", () => {
  const silent = { write: () => {} };
  for (const route of [
    `{ method: "GET", path: "/admin", enabled: true }`,
    `{ method: "GET", path: "/admin/featured", enabled: true }`,
    `{ method: "GET", path: "/admin/join-attempts", enabled: true }`,
    `{ method: "GET", path: "/admin/queue/failed/:id/preview", enabled: true }`,
    `{ method: "GET", path: "/events", enabled: true }`,
    `{ method: "GET", path: "/events/:key", enabled: true }`,
    `{ method: "GET", path: "/join", enabled: true }`,
    `{ method: "GET", path: "/", enabled: true }`,
    `{ method: "POST", path: "/events/past", enabled: true }`,
  ]) {
    const journeys = runUnitMode({
      stdout: silent,
      manifestSource: `{ method: "GET", path: "/events/past", enabled: false }, ${route}`,
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

test("executed-run coverage is GET/HEAD /events/past only", () => {
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
  assert.equal(isCoveredByExecutedRun({ method: "GET", path: "/events", enabled: true }), false);
  assert.equal(isCoveredByExecutedRun({ method: "GET", path: "/admin", enabled: true }), false);
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
