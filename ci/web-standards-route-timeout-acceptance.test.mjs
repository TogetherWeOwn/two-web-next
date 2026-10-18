import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Acceptance contract: bound web-standards route reads and retain timeout findings.
//
// At the base this was written against, ci/web-standards.mjs awaits fetch() and
// res.text() for each route with no deadline, and writes its summary only after
// every read finishes. A route that never sends headers or never finishes its
// body stalls the collector until the enclosing workflow times out, and no
// route-named finding or summary survives.
//
// Locked builder contract (this file is acceptance-owned; do not edit it to
// make an implementation pass):
// - ci/web-standards.mjs exports ROUTE_READ_TIMEOUT_MS: a finite, documented
//   per-route settlement deadline (1s-60s) covering headers AND body. It is a
//   total deadline, not an idle timer that a dripping body can keep resetting.
// - It exports fetchRoute(fetchImpl, url, { timeoutMs }) resolving to
//   { status, headers, html }. It passes an AbortSignal and redirect:"manual"
//   to fetchImpl, aborts on deadline, races the body read so a body that
//   ignores the signal still settles, best-effort cancels the response body,
//   and rejects with an Error whose code is "ROUTE_READ_TIMEOUT" on deadline.
//   Underlying promises that settle (or reject) after the deadline must not
//   hang the caller or surface as unhandled rejections, and error text must
//   not contain response body content.
// - It exports collectStandards({ base, routes, fetchImpl, timeoutMs })
//   resolving to { findings, links }. Routes are read in order; a timed-out or
//   rejected route read becomes one finding starting with "<path>:" (naming
//   the timeout for deadline failures) and later routes still run. Successful
//   routes keep today's status, header, HTML and internal-link behaviour via
//   the existing helpers. Per-route failures never throw out of the collector,
//   so main()'s existing summary write, failing exit and fixture-child
//   termination are reached after a route timeout.
// - main() must route its per-route reads through collectStandards, the module
//   must be import-safe (no fixture spawn or process.exit on import), and
//   --selftest behaviour is preserved.
// - Route list, --origin allowlist delegation and every existing finding stay
//   unchanged. Wire this file into the standards:selftest script so the
//   existing CI web-quality selftest step runs it.
//
// Hermetic only: injected fetch/Response doubles on loopback-shaped URLs.
// No network, no fixture worker, no deployed origin.

// The module historically ran main() on import unless --selftest was present;
// keep the import inert at the failing base too, so RED is a clean contract
// failure instead of a spawned fixture. The builder's import-safety guard
// makes this belt-and-braces.
if (!process.argv.includes("--selftest")) process.argv.push("--selftest");
const standards = await import("./web-standards.mjs");
const { collectStandards, fetchRoute, ROUTE_READ_TIMEOUT_MS } = standards;

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(`${repoRoot}ci/web-standards.mjs`, "utf8");
const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8"));

const GOOD_HTML =
  '<!doctype html><html lang="en"><head><title>T</title><meta name="viewport" content="w">' +
  '<meta name="description" content="A long enough description here"></head>' +
  '<body><h1>x</h1><a href="/about">about</a><a href="https://example.invalid/">ext</a></body></html>';
const GOOD_HEADERS = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const TIMEOUT_MS = 60;
const BOUND_MS = 3_000;

function okResponse(html = GOOD_HTML, headers = GOOD_HEADERS, status = 200) {
  return new Response(html, { status, headers });
}

async function expectTimeout(promise) {
  const started = Date.now();
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, "ROUTE_READ_TIMEOUT", `expected timeout code, got: ${err}`);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < BOUND_MS, `route read must settle within ${BOUND_MS}ms, took ${elapsed}ms`);
  return elapsed;
}

// --- Positive controls: these pass at the base and pin unchanged behaviour. ---

test("control: existing pure helpers keep their findings", () => {
  assert.deepEqual(standards.headerFindings("/", new Headers(GOOD_HEADERS)), []);
  assert.equal(standards.headerFindings("/", new Headers({})).length, 3);
  assert.deepEqual(standards.htmlFindings("/", GOOD_HTML), []);
  assert.deepEqual(standards.internalLinks(GOOD_HTML), ["/about"]);
});

test("control: route list, origin allowlist delegation, summary and fixture cleanup stay in main", () => {
  assert.deepEqual(standards.paths, [
    "/",
    "/events",
    "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "/join",
    "/about",
    "/faq",
    "/rules",
    "/privacy",
  ]);
  assert.match(source, /requireAllowedOrigin/, "--origin must stay allowlist-checked");
  assert.match(source, /standards-summary\.md/, "summary file must still be written");
  assert.match(source, /process\.kill\(-child\.pid/, "fixture child must still be terminated");
  assert.match(
    source,
    /process\.exit\(findings\.length \? 1 : 0\)/,
    "failing exit must be retained",
  );
});

// --- The deadline contract. ---

test("exports a finite documented per-route deadline", () => {
  assert.equal(typeof ROUTE_READ_TIMEOUT_MS, "number", "ROUTE_READ_TIMEOUT_MS must be exported");
  assert.ok(Number.isFinite(ROUTE_READ_TIMEOUT_MS));
  assert.ok(
    ROUTE_READ_TIMEOUT_MS >= 1_000 && ROUTE_READ_TIMEOUT_MS <= 60_000,
    `deadline must be 1s-60s, got ${ROUTE_READ_TIMEOUT_MS}`,
  );
  const at = source.indexOf("ROUTE_READ_TIMEOUT_MS");
  assert.ok(at >= 0);
  assert.match(
    source.slice(Math.max(0, at - 400), at + 200),
    /deadline|timed? ?out/i,
    "deadline must be documented next to its definition",
  );
});

test("fetchRoute returns status, headers and html for a normal response", async () => {
  assert.equal(typeof fetchRoute, "function", "fetchRoute must be exported");
  let seenInit;
  const fetchImpl = async (_url, init) => {
    seenInit = init;
    return okResponse();
  };
  const out = await fetchRoute(fetchImpl, "http://127.0.0.1:8787/", { timeoutMs: 1_000 });
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("x-content-type-options"), "nosniff");
  assert.equal(out.html, GOOD_HTML);
  assert.equal(seenInit?.redirect, "manual", "existing redirect handling must be preserved");
  assert.ok(seenInit?.signal instanceof AbortSignal, "fetch must receive an AbortSignal");
  assert.equal(seenInit.signal.aborted, false);
});

test("fetchRoute times out when headers never arrive and aborts the request", async () => {
  let seenSignal;
  const fetchImpl = (_url, init) => {
    seenSignal = init?.signal;
    // Real fetch semantics: settles only via abort.
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  await expectTimeout(
    fetchRoute(fetchImpl, "http://127.0.0.1:8787/slow", { timeoutMs: TIMEOUT_MS }),
  );
  assert.equal(seenSignal?.aborted, true, "deadline must abort the in-flight fetch");
});

test("fetchRoute settles by deadline even when fetch ignores abort, and swallows its late rejection", async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const fetchImpl = () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("late network failure")), 200);
      });
    await expectTimeout(
      fetchRoute(fetchImpl, "http://127.0.0.1:8787/stuck", { timeoutMs: TIMEOUT_MS }),
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(unhandled, [], "late rejections must not surface as unhandled");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("fetchRoute times out a stalled body that ignores abort and cancels it without leaking body text", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("STALL-MARKER"));
      // Never close: a body that starts but never finishes.
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = async () => new Response(body, { status: 200, headers: GOOD_HEADERS });
  const started = Date.now();
  await assert.rejects(
    fetchRoute(fetchImpl, "http://127.0.0.1:8787/drip", { timeoutMs: TIMEOUT_MS }),
    (err) => {
      assert.equal(err?.code, "ROUTE_READ_TIMEOUT");
      assert.ok(
        !String(err?.message).includes("STALL-MARKER"),
        "errors must not leak body content",
      );
      return true;
    },
  );
  assert.ok(Date.now() - started < BOUND_MS, "stalled body must settle by the deadline");
  assert.equal(cancelled, true, "timed-out response body must be cancelled");
});

test("fetchRoute times out a dripping body: the deadline is total, not per-chunk idle", async () => {
  let dripTimer;
  const body = new ReadableStream({
    start(controller) {
      dripTimer = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode("x"));
        } catch {
          clearInterval(dripTimer);
        }
      }, 15);
    },
    cancel() {
      clearInterval(dripTimer);
    },
  });
  const fetchImpl = async () => new Response(body, { status: 200, headers: GOOD_HEADERS });
  try {
    await expectTimeout(
      fetchRoute(fetchImpl, "http://127.0.0.1:8787/drip", { timeoutMs: TIMEOUT_MS }),
    );
  } finally {
    clearInterval(dripTimer);
  }
});

// --- Collector behaviour: findings retained, later routes still checked. ---

test("collectStandards turns a route timeout into a route-named finding and continues", async () => {
  assert.equal(typeof collectStandards, "function", "collectStandards must be exported");
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push(url);
    if (url.endsWith("/slow")) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    if (url.endsWith("/bare")) return Promise.resolve(okResponse(GOOD_HTML, {}));
    return Promise.resolve(okResponse());
  };
  const started = Date.now();
  const { findings, links } = await collectStandards({
    base: "http://127.0.0.1:8787",
    routes: ["/slow", "/good", "/bare"],
    fetchImpl,
    timeoutMs: TIMEOUT_MS,
  });
  assert.ok(Date.now() - started < BOUND_MS, "collector must not stall on a timed-out route");
  assert.deepEqual(calls, [
    "http://127.0.0.1:8787/slow",
    "http://127.0.0.1:8787/good",
    "http://127.0.0.1:8787/bare",
  ]);
  const timeoutFindings = findings.filter((f) => f.startsWith("/slow:"));
  assert.equal(
    timeoutFindings.length,
    1,
    `expected one /slow finding, got: ${findings.join(" | ")}`,
  );
  assert.match(timeoutFindings[0], /timed? ?out/i, "timeout finding must name the timeout");
  assert.ok(
    !findings.some((f) => f.startsWith("/good:")),
    "a clean route must produce no findings",
  );
  assert.equal(
    findings.filter((f) => f.startsWith("/bare:")).length,
    3,
    "existing header findings must be preserved for later routes",
  );
  assert.deepEqual([...links].sort(), ["/about"], "internal links must still be collected");
});

test("collectStandards records a rejected route read as a finding and continues", async () => {
  const fetchImpl = (url) =>
    url.endsWith("/down")
      ? Promise.reject(new Error("connection refused"))
      : Promise.resolve(okResponse());
  const { findings, links } = await collectStandards({
    base: "http://127.0.0.1:8787",
    routes: ["/down", "/good"],
    fetchImpl,
    timeoutMs: 1_000,
  });
  assert.equal(findings.filter((f) => f.startsWith("/down:")).length, 1);
  assert.ok(!findings.some((f) => f.startsWith("/good:")));
  assert.deepEqual([...links], ["/about"]);
});

test("collectStandards preserves the non-200 status finding", async () => {
  const fetchImpl = async () => okResponse(GOOD_HTML, GOOD_HEADERS, 503);
  const { findings } = await collectStandards({
    base: "http://127.0.0.1:8787",
    routes: ["/sick"],
    fetchImpl,
    timeoutMs: 1_000,
  });
  assert.ok(findings.includes("/sick: status 503"), `got: ${findings.join(" | ")}`);
});

// --- Wiring. ---

test("main reads routes through collectStandards and this suite runs in standards:selftest", () => {
  const mainAt = source.indexOf("async function main");
  assert.ok(mainAt >= 0);
  assert.match(source.slice(mainAt), /collectStandards\(/, "main must use the bounded collector");
  assert.match(
    pkg.scripts["standards:selftest"] ?? "",
    /web-standards-route-timeout-acceptance\.test\.mjs/,
    "standards:selftest must run this acceptance file (CI already runs that script)",
  );
});
