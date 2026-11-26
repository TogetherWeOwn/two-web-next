import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyVersion, versionMismatch } from "../bin/version-check.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const UPLOADED = "2026-10-31T11:58:00.000Z";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchOf = (...responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next instanceof Error) throw next;
    return next();
  };
  return { fetchImpl, calls };
};
const quiet = { sleep: async () => {}, log: () => {} };

function chunkedVersion(byteLength) {
  const encoder = new TextEncoder();
  const payload = JSON.stringify({ sha: COMMIT, deployedAt: UPLOADED }).padEnd(byteLength);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 20)));
        controller.enqueue(encoder.encode(payload.slice(20)));
        controller.close();
      },
    }),
  );
}

test("versionMismatch accepts the expected commit with a past upload time", () => {
  assert.equal(versionMismatch({ sha: COMMIT, deployedAt: UPLOADED }, COMMIT, NOW), null);
});

test("versionMismatch names each way the body can fail", () => {
  const cases = [
    [null, /not a JSON object/],
    [[], /not a JSON object/],
    [{ sha: OTHER, deployedAt: UPLOADED }, new RegExp(`sha is ${OTHER}, expected ${COMMIT}`)],
    [{ sha: null, deployedAt: UPLOADED }, /sha is null/],
    [{ sha: COMMIT, deployedAt: null }, /deployedAt is not an ISO 8601 UTC timestamp/],
    [{ sha: COMMIT, deployedAt: "soon" }, /deployedAt is not an ISO 8601 UTC timestamp/],
    [{ sha: COMMIT, deployedAt: "2026" }, /deployedAt is not an ISO 8601 UTC timestamp/],
    [
      { sha: COMMIT, deployedAt: "Oct 31 2026 12:00 GMT" },
      /deployedAt is not an ISO 8601 UTC timestamp/,
    ],
    [{ sha: COMMIT, deployedAt: 1793448000000 }, /deployedAt is not an ISO 8601 UTC timestamp/],
    [{ sha: COMMIT, deployedAt: "2026-10-31T12:10:00.000Z" }, /in the future/],
  ];
  for (const [data, reason] of cases) assert.match(versionMismatch(data, COMMIT, NOW), reason);
});

test("verifyVersion reads /version without following redirects", async () => {
  const { fetchImpl, calls } = fetchOf(() => json({ sha: COMMIT, deployedAt: UPLOADED }));
  const data = await verifyVersion("https://next.example.test", COMMIT, { fetchImpl, ...quiet });
  assert.deepEqual(data, { sha: COMMIT, deployedAt: UPLOADED });
  assert.equal(calls[0].url, "https://next.example.test/version");
  assert.equal(calls[0].init.redirect, "manual");
});

test("verifyVersion retries a 404, a network error and an old commit, then passes", async () => {
  const { fetchImpl, calls } = fetchOf(
    () => json({ error: "not found" }, 404),
    new Error("network down"),
    () => json({ sha: OTHER, deployedAt: UPLOADED }),
    () => json({ sha: COMMIT, deployedAt: UPLOADED }),
  );
  await verifyVersion("https://next.example.test", COMMIT, { fetchImpl, attempts: 4, ...quiet });
  assert.equal(calls.length, 4);
});

test("verifyVersion accepts a complete body at the byte limit", async () => {
  const { fetchImpl } = fetchOf(() => chunkedVersion(4096));
  const data = await verifyVersion("https://next.example.test", COMMIT, { fetchImpl, ...quiet });
  assert.deepEqual(data, { sha: COMMIT, deployedAt: UPLOADED });
});

test("verifyVersion refuses one byte beyond the limit", async () => {
  const { fetchImpl } = fetchOf(() => chunkedVersion(4097));
  await assert.rejects(
    verifyVersion("https://next.example.test", COMMIT, { fetchImpl, attempts: 1, ...quiet }),
    /\/version response exceeds 4096 bytes/,
  );
});

test("verifyVersion refuses an empty HTTP 200 response", async () => {
  for (const body of [null, ""]) {
    const { fetchImpl } = fetchOf(() => new Response(body));
    await assert.rejects(
      verifyVersion("https://next.example.test", COMMIT, { fetchImpl, attempts: 1, ...quiet }),
      /request failed \(SyntaxError\)/,
    );
  }
});

test("verifyVersion cancels an oversized stream before reaching EOF", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode(`{"sha":"${COMMIT}","deployedAt":"${UPLOADED}","extra":"`),
    encoder.encode("é".repeat(2048)),
    encoder.encode('"}'),
  ];
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
        throw new Error("synthetic cleanup failure");
      },
    },
    { highWaterMark: 0 },
  );
  const { fetchImpl } = fetchOf(() => new Response(body));

  await assert.rejects(
    verifyVersion("https://next.example.test", COMMIT, { fetchImpl, attempts: 1, ...quiet }),
    /\/version response exceeds 4096 bytes/,
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("verifyVersion refuses malformed JSON even after a complete matching object", async () => {
  const exact = JSON.stringify({ sha: COMMIT, deployedAt: UPLOADED });
  const { fetchImpl } = fetchOf(() => new Response(`${exact}{`));
  await assert.rejects(
    verifyVersion("https://next.example.test", COMMIT, { fetchImpl, attempts: 1, ...quiet }),
    /request failed \(SyntaxError\)/,
  );
});

test("verifyVersion refuses malformed UTF-8 in otherwise matching JSON", async () => {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ sha: COMMIT, deployedAt: UPLOADED, extra: "x" }),
  );
  encoded[encoded.length - 3] = 0xff;
  const { fetchImpl } = fetchOf(() => new Response(encoded));
  await assert.rejects(
    verifyVersion("https://next.example.test", COMMIT, { fetchImpl, attempts: 1, ...quiet }),
    /request failed \(TypeError\)/,
  );
});

test("verifyVersion discards unread redirects and retries refused bodies before passing", async () => {
  let pulls = 0;
  let cancels = 0;
  const redirectBody = new ReadableStream(
    {
      pull() {
        pulls++;
      },
      cancel() {
        cancels++;
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const exact = { sha: COMMIT, deployedAt: UPLOADED };
  const { fetchImpl, calls } = fetchOf(
    () => new Response(redirectBody, { status: 302, headers: { location: "https://other.test" } }),
    () => json({ ...exact, extra: "x".repeat(4096) }),
    () => new Response("{"),
    () => json(exact),
  );
  const delays = [];
  const logs = [];
  const data = await verifyVersion("https://next.example.test", COMMIT, {
    fetchImpl,
    attempts: 4,
    sleep: async (ms) => delays.push(ms),
    log: (message) => logs.push(message),
  });

  assert.equal(pulls, 0);
  assert.equal(cancels, 1);
  assert.deepEqual(data, exact);
  assert.deepEqual(delays, [5000, 5000, 5000]);
  assert.deepEqual(logs, [
    "version attempt 1/4: /version answered HTTP 302",
    "version attempt 2/4: /version response exceeds 4096 bytes",
    "version attempt 3/4: request failed (SyntaxError)",
  ]);
  assert.equal(calls.length, 4);
  for (const { url, init } of calls) {
    assert.equal(url, "https://next.example.test/version");
    assert.equal(init.redirect, "manual");
  }
});

test("verifyVersion fails closed after the last attempt and names why", async () => {
  const { fetchImpl, calls } = fetchOf(() => json({ sha: OTHER, deployedAt: UPLOADED }));
  await assert.rejects(
    verifyVersion("https://next.example.test", COMMIT, { fetchImpl, ...quiet }),
    new RegExp(`sha is ${OTHER}, expected ${COMMIT}`),
  );
  assert.equal(calls.length, 3);
});
