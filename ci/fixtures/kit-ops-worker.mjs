import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { withEnv } from "cloudflare:workers";
import { STAGING_APP_URL } from "../../src/qa.ts";
import { withThrottleTx } from "../../test/helpers/throttle-tx-double.ts";
import { healthSql } from "../../test/helpers/up.ts";

const csp = "/csp-reports";
const alert = "/__probe/alert";
const requestId = "0123456789abcdef-IAD";
const probeId = "12345678-1234-4234-8234-123456789abc";
const token = "ops-fixture-only-".repeat(2);
const report = JSON.stringify({ "csp-report": { "script-sample": "synthetic" } });
const wireHeaders = [
  "allow",
  "cache-control",
  "content-type",
  "content-security-policy",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "location",
  "permissions-policy",
  "referrer-policy",
  "reporting-endpoints",
  "retry-after",
  "vary",
  "x-content-type-options",
  "x-frame-options",
  "x-robots-tag",
  "x-two-origin",
];

async function verifyOps(inner, env, ctx) {
  const counts = { violations: 0, malformed: 0, oversized: 0, failed: 0, alerts: 0, outbound: 0 };
  const original = {
    warn: console.warn,
    error: console.error,
    log: console.log,
    fetch,
    random: Math.random,
  };
  let draw = 0.5;
  let queued = 0;
  let hits = 0;
  let reads = 0;
  const ip = "192.0.2.68";
  const sql = withThrottleTx(async (strings, bucket) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)")) {
      assert.ok(bucket === `alert-probe:${ip}`, "unexpected throttle bucket");
      reads++;
      return [{ n: hits, wait: 30 }];
    }
    if (query.includes("INSERT INTO web_throttle_hits")) hits++;
    return [];
  });
  const queue = {
    async send(envelope) {
      assert.ok(isDeepStrictEqual(envelope, { kind: "alert-probe", probeId }), "probe envelope");
      queued++;
    },
  };
  const bindings = {
    ...env,
    APP_URL: STAGING_APP_URL,
    DATABASE_URL: undefined,
    QA_AUTH_TOKEN: token,
    INTERNAL_ACTION_QUEUE: queue,
    THROTTLE_STORE: async () => sql,
  };

  const send = async (path, method, flag, status, kit, options = {}) => {
    const url = new URL(path, STAGING_APP_URL);
    const request = new Request(url, {
      method,
      headers: {
        "cf-ray": requestId,
        "cf-connecting-ip": ip,
        host: url.host,
        accept: "application/json",
        origin: STAGING_APP_URL,
        ...options.headers,
      },
      body: options.body?.(),
      duplex: "half",
    });
    const active = { ...bindings, KIT_ROUTE_OPS: flag, ...options.bindings };
    const response = await withEnv(active, () => inner.fetch(request, active, ctx));
    const label = `${method} ${path} (${options.label ?? flag ?? "unset"})`;
    assert.equal(response.status, status, label);
    assert.equal(response.headers.get("x-two-renderer"), kit ? "kit" : null, label);
    assert.equal(response.headers.get("x-request-id") === requestId, true, label);
    assert.equal(response.headers.has("set-cookie"), false, label);
    const body = await response.text();
    if (method === "HEAD" || status === 204) assert.equal(body.length, 0, label);
    return { body, headers: wireHeaders.map((name) => [name, response.headers.get(name)]) };
  };

  const pair = async (path, method, status, kit, options = {}) => {
    // Kit runs first so a missing alert cannot be hidden by Hono's isolate mute.
    const enabled = await send(path, method, "true", status, kit, options);
    const off = await send(path, method, undefined, status, false, options);
    for (const [index, [header, value]] of enabled.headers.entries()) {
      assert.ok(value === off.headers[index][1], `${method} ${path} ${header} parity`);
    }
    assert.ok(enabled.body === off.body, `${method} ${path} body parity`);
    return enabled.body;
  };

  // Never forward fixture diagnostics or perform outbound requests. Capture only
  // counts, and assert on payload shape in memory without printing actual fields.
  Math.random = () => draw;
  globalThis.fetch = async () => {
    counts.outbound++;
    throw new Error("Unexpected outbound ops fixture request");
  };
  console.log = () => {};
  console.warn = (event, fields) => {
    if (event === "csp.report.violation") {
      assert.ok(
        isDeepStrictEqual(fields, {
          blocked_uri: null,
          violated_directive: null,
          document_uri: null,
          source_file: null,
          line_number: null,
        }),
        "CSP report shape",
      );
      counts.violations++;
    } else if (event === "csp.report.malformed") {
      assert.ok(isDeepStrictEqual(fields, { bytes: 1 }), "malformed report diagnostics");
      counts.malformed++;
    } else if (event === "csp.report.dropped_oversize") {
      assert.ok(isDeepStrictEqual(fields, { bytes: 8193 }), "oversized report diagnostics");
      counts.oversized++;
    } else if (event === "csp.report.sink_failed") {
      counts.failed++;
    }
  };
  console.error = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      assert.fail("Expected structured alert diagnostics");
    }
    assert.ok(
      event.event === "error.alert" &&
        event.fingerprint === "AlertProbeError@/__probe/alert" &&
        event.request_id === requestId &&
        event.method === "POST" &&
        event.probeId === probeId &&
        !("message" in event) &&
        !("stack" in event) &&
        queued === 1,
      "synthetic request alert follows queue acceptance with registered correlation",
    );
    counts.alerts++;
  };

  try {
    const healthy = { bindings: { QUEUE_DEPTH_STORE: healthSql() } };
    const health = JSON.parse(await pair("/up", "GET", 200, true, healthy));
    assert.equal(health.pending_migrations, 0);
    await pair("/up", "HEAD", 200, true, healthy);
    await pair("/up", "GET", 503, true);
    await pair("/version?fixture=1", "GET", 200, true);
    await pair("/version", "HEAD", 200, true);
    await send("/version", "GET", "false", 200, false);
    await send("/version", "GET", "TRUE", 200, false);

    for (const [path, method, alias, encoded, aliasStatus] of [
      [csp, "POST", "/csp-reports/", "/%63sp-reports", 204],
      [alert, "POST", "/__probe/alert/", "/__probe/%61lert", 404],
      ["/up", "GET", "/up/", "/%75p", 503],
      ["/version", "GET", "/version/", "/%76ersion", 200],
    ]) {
      await pair(alias, method, 404, false);
      await pair(encoded, method, aliasStatus, false);
      await pair(`${path}/__data.json`, "GET", 404, false);
      await pair(path, method === "GET" ? "POST" : "HEAD", 404, false);
      await pair(path, method, 404, false, { headers: { host: "foreign.example.test" } });
    }
    await pair("/admin/ops-overrides", "POST", 405, false);

    const cspCase = (label, body, rate, headers = {}) =>
      pair(csp, "POST", 204, true, {
        label,
        body,
        bindings: { CSP_REPORT_SAMPLE_RATE: rate },
        headers: {
          origin: "https://foreign.example.test",
          "content-type": "application/csp-report",
          ...headers,
        },
      });
    await cspCase("sample at boundary", () => report, "0.5");
    assert.equal(counts.violations, 2);
    draw = 0.51;
    await cspCase("sample above boundary", () => report, "0.5");
    await cspCase("disabled sampling", () => report, "0");
    assert.equal(counts.violations, 2);
    await cspCase("malformed", () => "{", "1");
    await cspCase("declared oversize", () => "x".repeat(8193), "0", { "content-length": "8193" });
    let cancelled = 0;
    const stream = (chunk, close) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk));
          if (close) controller.close();
        },
        cancel() {
          cancelled++;
        },
      });
    await cspCase("streamed oversize", () => stream("x".repeat(8193), true), "1");
    await cspCase("body deadline", () => stream(report, false), "1");
    assert.equal(cancelled, 2, "each owner cancels the stalled body");

    const qa = { "x-two-qa-auth": token, "x-two-alert-probe": probeId };
    let pulls = 0;
    const unread = () =>
      new ReadableStream(
        {
          pull(controller) {
            pulls++;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    const over = () => stream("x".repeat(4097), true);
    const probe = (status, options = {}) => pair(alert, "POST", status, true, options);
    const absent = await probe(404, { label: "absent token", body: unread });
    const wrong = await probe(404, { headers: { "x-two-qa-auth": "synthetic-wrong" }, body: over });
    assert.ok(absent === wrong, "QA refusal gives no token oracle");
    await probe(404, { headers: qa, bindings: { QA_AUTH_TOKEN: undefined } });
    for (const accept of ["application/json", "text/html"])
      await probe(403, {
        headers: { ...qa, accept, origin: "https://foreign.example.test" },
        body: unread,
      });
    assert.equal(pulls, 0, "origin and absent-token refusals leave the upload unread");
    await probe(413, { headers: qa, body: over });
    assert.equal(reads, 0, "origin, QA and cap refusals precede the throttle");
    hits = 10;
    await probe(429, { headers: qa });
    assert.equal(reads, 2);
    hits = 0;
    await probe(400, { headers: { ...qa, "x-two-alert-probe": "invalid" } });
    await probe(503, { headers: qa, bindings: { INTERNAL_ACTION_QUEUE: undefined } });
    assert.equal(hits, 4, "only cap-admitted probes spend throttle budget");
    assert.equal(queued, 0, "all refusals precede queue sends");
    await probe(500, { headers: qa, body: () => stream("x".repeat(4096), true) });
    assert.equal(hits, 6);
    assert.equal(queued, 2, "each accepted probe sends one synthetic job");
    assert.deepEqual(counts, {
      violations: 2,
      malformed: 2,
      oversized: 4,
      failed: 0,
      alerts: 1,
      outbound: 0,
    });
    return { ...counts, queued };
  } finally {
    console.warn = original.warn;
    console.error = original.error;
    console.log = original.log;
    globalThis.fetch = original.fetch;
    Math.random = original.random;
  }
}

export function opsFixtureWorker(inner, probePath) {
  return {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === probePath)
        return Response.json(await verifyOps(inner, env, ctx));
      return inner.fetch(request, env, ctx);
    },
  };
}
