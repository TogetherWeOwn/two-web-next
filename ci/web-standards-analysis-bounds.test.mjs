import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as standards from "./web-standards.mjs";

const base = "http://127.0.0.1:8787";
const good =
  '<!doctype html><html lang="en"><head><title>Fixture</title>' +
  '<meta name="viewport" content="width=device-width">' +
  '<meta name="description" content="A sufficiently long fixture description.">' +
  '</head><body><h1>Fixture</h1><a href="/about">About</a></body></html>';
const headers = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// A subprocess watchdog makes the test fail quickly even if a synchronous
// parser regression blocks Node's event loop and prevents its timers firing.
function boundedCollector(bodyExpression, expectedCode) {
  const script = new URL("./web-standards.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import {collectStandards, buildJsonReport} from ${JSON.stringify(script)};
const bad = ${bodyExpression};
const fetched = [];
const started = performance.now();
const collected = await collectStandards({
  base: ${JSON.stringify(base)}, routes: ['/large', '/later'], timeoutMs: 250,
  fetchImpl: async (url) => {
    fetched.push(url);
    return new Response(url.endsWith('/large') ? bad : ${JSON.stringify(good)}, {
      headers: ${JSON.stringify(headers)}
    });
  }
});
console.log(JSON.stringify({
  elapsedMs: performance.now() - started, fetched, links: [...collected.links],
  findings: collected.findings,
  report: buildJsonReport({routes: ['/large', '/later'], findings: collected.findingRecords})
}));`,
    ],
    { encoding: "utf8", timeout: 2_000, maxBuffer: 128 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, "collector must settle, not hit the subprocess watchdog");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.elapsedMs < 1_000, `bounded collection took ${output.elapsedMs}ms`);
  assert.deepEqual(output.fetched, [`${base}/large`, `${base}/later`]);
  assert.deepEqual(output.links, ["/about"], "later routes still contribute links");
  const finding = output.report.findings.find((f) => f.code === expectedCode);
  assert.ok(finding, `expected ${expectedCode}: ${JSON.stringify(output.report)}`);
  assert.equal(finding.routeId, "route-0");
  assert.ok(finding.next_action.length > 0);
  assert.ok(!output.findings.some((f) => f.startsWith("/later:")));
  assert.ok(!JSON.stringify(output).includes("UNTRUSTED_BODY_CANARY"));
}

test("HTML analysis bounds are fixed, without increasing the route deadline", () => {
  assert.equal(standards.MAX_HTML_BODY_BYTES, 1_048_576);
  assert.equal(standards.MAX_HTML_ELEMENTS, 10_000);
  assert.equal(standards.MAX_HTML_DEPTH, 256);
  assert.equal(standards.MAX_HTML_ATTRIBUTES_PER_TAG, 1_000);
  assert.equal(standards.ROUTE_READ_TIMEOUT_MS, 15_000);
});

test("a 200k-deep response becomes a route finding, not a synchronous parser stall", () => {
  boundedCollector(
    `'UNTRUSTED_BODY_CANARY' + '<div>'.repeat(200_000) + '</div>'.repeat(200_000)`,
    "HTML_TOO_LARGE",
  );
});

test("a deeply nested response below the byte cap still fails promptly", () => {
  boundedCollector(
    `'UNTRUSTED_BODY_CANARY' + '<div>'.repeat(40_000) + '</div>'.repeat(40_000)`,
    "HTML_TOO_COMPLEX",
  );
});

test("a flat element flood is bounded too", () => {
  boundedCollector(`'UNTRUSTED_BODY_CANARY' + '<b></b>'.repeat(15_000)`, "HTML_TOO_COMPLEX");
});

const attrs = (count) => Array.from({ length: count }, (_, i) => `a${i}`).join(" ");

test("a 180k-unique-attribute tag under the byte cap is rejected before the parser's quadratic scan", () => {
  boundedCollector(
    `'UNTRUSTED_BODY_CANARY<div ' + Array.from({length: 180_000}, (_, i) => 'a' + i.toString(36)).join(' ') + '>'`,
    "HTML_TOO_COMPLEX",
  );
});

test("attribute admission counts quoted, unquoted and valueless names exactly at the cap", () => {
  const html = (tag) => `<!doctype html><body>${tag}<a href="/about">x</a>`;
  const hrefs = (tag) => standards.internalLinks(html(tag));
  assert.deepEqual(hrefs(`<div ${attrs(1_000)}>`), ["/about"]);
  assert.throws(() => hrefs(`<div ${attrs(1_001)}>`), { code: "HTML_TOO_COMPLEX" });
  assert.throws(
    () => hrefs(`<div ${Array.from({ length: 1_001 }, (_, i) => `a${i}="v"`).join(" ")}>`),
    { code: "HTML_TOO_COMPLEX" },
  );
  assert.throws(
    () => hrefs(`<div ${Array.from({ length: 1_001 }, (_, i) => `a${i}=v${i}`).join(" ")}>`),
    { code: "HTML_TOO_COMPLEX" },
  );
  assert.throws(() => hrefs(`</div ${attrs(1_001)}>`), { code: "HTML_TOO_COMPLEX" });
  // Many tags with few attributes, '>' and '<' inside quoted values and comments
  // never count toward one tag's limit.
  assert.deepEqual(hrefs(`<i a b c></i>`.repeat(5_000)), ["/about"]);
  assert.deepEqual(hrefs(`<div title="a > b < c ${attrs(2_000)}">`), ["/about"]);
  assert.deepEqual(hrefs(`<!-- <div ${attrs(2_000)}> -->`), ["/about"]);
});

test("body admission counts streamed UTF-8 bytes and cancels without waiting for cleanup", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("€".repeat(400_000)));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  // Keep the test independent of the production deadline timer's unref policy.
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    await assert.rejects(
      standards.fetchRoute(
        async () => ({ status: 200, headers: new Headers(), body }),
        `${base}/oversize`,
        { timeoutMs: 250 },
      ),
      { code: "ROUTE_BODY_TOO_LARGE" },
    );
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("the exact byte cap is admitted; one more byte is rejected", async () => {
  const limit = 1_048_576;
  const accepted = await standards.fetchRoute(
    async () => new Response(" ".repeat(limit)),
    `${base}/boundary`,
  );
  assert.equal(accepted.html.length, limit);
  await assert.rejects(
    standards.fetchRoute(async () => new Response(" ".repeat(limit + 1)), `${base}/over`),
    { code: "ROUTE_BODY_TOO_LARGE" },
  );
});

test("link analysis uses the remaining fetch deadline, not a fresh parse budget", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => {
    if (clock >= 240) clock += 2;
    return clock;
  });
  const { findings, findingRecords, links } = await standards.collectStandards({
    base,
    routes: ["/spent-budget"],
    timeoutMs: 250,
    fetchImpl: async () => {
      clock = 240;
      return new Response(good, { headers });
    },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^\/spent-budget:.*timed out/i);
  assert.equal(findingRecords[0].code, "LINKS_TIMEOUT");
  assert.deepEqual([...links], [], "partial link analysis cannot become successful coverage");
});

test("a bare percent in a query is a valid link; only the pathname is decoded", () => {
  assert.deepEqual(standards.classifyHref("/events?q=100%", `${base}/`), {
    kind: "internal",
    target: "/events?q=100%",
  });
  assert.deepEqual(standards.classifyHref("/bad%E0%A4%A?q=1", `${base}/`), { kind: "malformed" });
  assert.equal(standards.linkResolves("/about?q=100%", [/^\/about$/]), true);
});
