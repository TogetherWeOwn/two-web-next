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

test("verifyVersion fails closed after the last attempt and names why", async () => {
  const { fetchImpl, calls } = fetchOf(() => json({ sha: OTHER, deployedAt: UPLOADED }));
  await assert.rejects(
    verifyVersion("https://next.example.test", COMMIT, { fetchImpl, ...quiet }),
    new RegExp(`sha is ${OTHER}, expected ${COMMIT}`),
  );
  assert.equal(calls.length, 3);
});
