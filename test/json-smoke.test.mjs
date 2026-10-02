import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { jsonSmoke } from "../bin/json-smoke.mjs";

// Loopback implementation of the PR #109 JSON contract plus the staging QA
// seam: same-origin POST login issuing a session cookie, guest 401 refusals,
// paging envelope, show shape and the cancelled 410 envelope. Never touches a
// Worker, database or external network. Secret-bearing values carry a marker
// so every test can prove they never reach the output.
//
// Pre-contract mode: until PR #109 deploys, the show route does not exist, so
// guests get the app's branded HTML 404 there and the collection has no
// `meta` paginator. Tests opt in via `preContract(result)`, which rewrites the
// guest-show and collection responses to that shape.
const TOKEN = "qa-token-never-log-this";
const SESSION = "session-never-log-this";
const PUB_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const GONE_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

const pub = {
  event_key: PUB_KEY, title: "Game night", game: "Chess", description: "Bring a board.",
  starts_at: "2099-01-01T20:00:00.000Z", ends_at: "2099-01-01T22:00:00.000Z",
  timezone: "Europe/London", location: "Voice", capacity: 2, status: "published",
  rsvp_open: true, going_count: 2, waitlist_position: null,
};
const goneRow = { event_key: GONE_KEY, status: "cancelled" };
const goneBody = {
  reason: "event_cancelled", message: "This event was cancelled.", event_key: GONE_KEY, status: "cancelled",
};
const collection = {
  data: [pub, goneRow], page: 1, limit: 20,
  meta: { current_page: 1, per_page: 20, total: 2, last_page: 1 },
};

function route(request, origin) {
  const url = new URL(request.url, origin);
  const authed = (request.headers.cookie ?? "").split(";").map((part) => part.trim())
    .includes(`__Host-two_session=${SESSION}`);
  if (request.method === "POST" && url.pathname === "/auth/qa/qa-member") {
    const ok = request.headers.origin === origin && request.headers["x-two-qa-auth"] === TOKEN;
    return ["login", ok
      ? { status: 204, headers: { "set-cookie": `__Host-two_session=${SESSION}; Path=/; Secure; HttpOnly` }, body: "" }
      : { status: 404, headers: { "content-type": "application/json" }, body: '{"error":"not_found"}' }];
  }
  if (request.method !== "GET") return ["other", { status: 405, headers: {}, body: "" }];
  const json = (status, body) => ({ status, headers: { "content-type": "application/json; charset=UTF-8" }, body });
  if (!authed) {
    if (url.pathname === "/events.json") return ["guest-collection", json(401, '{"error":"unauthenticated"}')];
    if (url.pathname === `/events/${"0".repeat(26)}`) return ["guest-show", json(401, '{"error":"unauthenticated"}')];
    return ["other", { status: 500, headers: {}, body: "Unexpected request" }];
  }
  if (url.pathname === "/events.json" && url.search === "") return ["collection", json(200, JSON.stringify(collection))];
  if (url.pathname === "/events.json" && url.search === "?event_key=not-a-key") {
    return ["filter", json(422, '{"error":"invalid_event_key"}')];
  }
  if (url.pathname === "/events.json" && url.search === "?per_page=100") return ["gone-scan", json(200, JSON.stringify(collection))];
  if (url.pathname === `/events/${PUB_KEY}`) return ["show", json(200, JSON.stringify({ data: pub }))];
  if (url.pathname === `/events/${GONE_KEY}`) return ["gone-show", { ...json(410, JSON.stringify(goneBody)), status: 410 }];
  if (url.pathname === "/events/bad-key") return ["bad-key", json(404, '{"error":"not_found"}')];
  return ["other", { status: 500, headers: {}, body: "Unexpected request" }];
}

async function stub(t, change = () => {}, { preContract = false } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      requests.push({ method: request.method, path: request.url, origin: request.headers.origin, qa: request.headers["x-two-qa-auth"] });
      const [id, result] = route(request, origin);
      if (preContract) {
        // The show route does not exist yet: branded HTML 404, and the
        // collection has no `meta` paginator (main's {data, page, limit}).
        if (id === "guest-show") {
          result.status = 404;
          result.headers = { "content-type": "text/html; charset=utf-8" };
          result.body = "<html>not found</html>";
        }
        if (id === "collection" || id === "gone-scan") {
          result.body = JSON.stringify({ data: [pub, goneRow], page: 1, limit: 20 });
        }
      }
      change(id, result, { originHeader: request.headers.origin, qaHeader: request.headers["x-two-qa-auth"], body });
      // A stalled route never answers; closeAllConnections() in t.after ends it.
      if (result.stall) return;
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function run(url, options = {}) {
  const output = [];
  const ok = await jsonSmoke(url, { token: TOKEN, log: (line) => output.push(line), ...options });
  return { ok, output: output.join("\n") };
}

async function cli(args, env = {}) {
  const child = spawn(process.execPath, ["bin/json-smoke.mjs", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, QA_AUTH_TOKEN: TOKEN, ...env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "exit");
  return { code, output };
}

test("passes the full contract without leaking secrets", async (t) => {
  const { url, requests } = await stub(t);
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /json-smoke: 8 checks, 0 failed, 0 skipped/);
  for (const label of ["guest collection refusal", "guest show refusal", "QA login", "collection paging envelope",
    "malformed event_key filter", "JSON show", "cancelled show", "malformed show key"]) {
    assert.ok(result.output.includes(`PASS ${label}`), `${label}: ${result.output}`);
  }
  const login = requests.find((r) => r.path === "/auth/qa/qa-member");
  assert.equal(login?.method, "POST");
  assert.equal(login?.origin, url);
  assert.equal(login?.qa, TOKEN);
  assert.deepEqual(requests.filter((r) => r.method === "GET").map((r) => r.path), [
    "/events.json", `/events/${"0".repeat(26)}`, "/events.json",
    "/events.json?event_key=not-a-key", `/events/${PUB_KEY}`, "/events.json?per_page=100",
    `/events/${GONE_KEY}`, "/events/bad-key",
  ]);
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

test("CLI passes against loopback and rejects bad input before requesting", async (t) => {
  const { url } = await stub(t);
  const ok = await cli([url]);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /json-smoke: 8 checks, 0 failed, 0 skipped/);
  assert.ok(!ok.output.includes("never-log-this"), ok.output);
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli([url], { QA_AUTH_TOKEN: "" })).code, 2);
  for (const target of ["https://togetherweown.com", "https://example.invalid", "file:///etc/passwd"]) {
    const refused = await cli([target]);
    assert.equal(refused.code, 2, target);
    assert.match(refused.output, /staging-only|base-url must be/);
  }
});

test("wrong token fails the login and skips every authenticated check", async (t) => {
  const { url } = await stub(t);
  const result = await run(url, { token: "wrong-token" });
  assert.equal(result.ok, false);
  assert.match(result.output, /FAIL QA login: expected HTTP 204 with a session cookie; actual HTTP 404 without session cookie/);
  assert.match(result.output, /json-smoke: 8 checks, 1 failed, 5 skipped/);
  for (const label of ["collection paging envelope", "malformed event_key filter", "JSON show", "cancelled show", "malformed show key"]) {
    assert.ok(result.output.includes(`SKIP ${label}: no QA session`), result.output);
  }
  assert.ok(!result.output.includes("wrong-token"), result.output);
});

for (const [id, label] of [
  ["guest-collection", "guest collection refusal"], ["guest-show", "guest show refusal"],
  ["collection", "collection paging envelope"], ["filter", "malformed event_key filter"],
  ["show", "JSON show"], ["gone-show", "cancelled show"], ["bad-key", "malformed show key"],
]) {
  test(`rejects HTTP 503 on ${label} and continues the remaining checks`, async (t) => {
    const { url, requests } = await stub(t, (routeId, result) => { if (routeId === id) { result.status = 503; result.body = "upstream fallback"; } });
    const result = await run(url);
    assert.equal(result.ok, false);
    assert.ok(result.output.includes(`FAIL ${label}: expected`), result.output);
    assert.ok(!result.output.includes("upstream fallback"), result.output);
    assert.ok(requests.length >= 7, result.output);
  });
}

test("rejects a collection missing the meta paginator", async (t) => {
  const { url } = await stub(t, (id, result) => {
    if (id === "collection" || id === "gone-scan") result.body = JSON.stringify({ data: [pub], page: 1, limit: 20 });
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(result.output, /FAIL collection paging envelope: expected HTTP 200 \{data, page, limit, meta/);
});

test("rejects a show missing contract keys or leaking the autoincrement id", async (t) => {
  for (const data of [
    { ...pub, waitlist_position: undefined },
    { ...pub, id: 7 },
  ]) {
    const { url } = await stub(t, (id, result) => {
      if (id === "show") result.body = JSON.stringify({ data });
    });
    const result = await run(url);
    assert.equal(result.ok, false, JSON.stringify(data));
    assert.match(result.output, /FAIL JSON show: expected 200 show .* with the contract keys/);
    assert.ok(!result.output.includes("never-log-this"), result.output);
  }
});

test("accepts an empty staging collection and skips fixture-dependent shows", async (t) => {
  const empty = { data: [], page: 1, limit: 20, meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 } };
  const { url } = await stub(t, (id, result) => {
    if (id === "collection" || id === "gone-scan") result.body = JSON.stringify(empty);
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /json-smoke: 8 checks, 0 failed, 2 skipped/);
  assert.ok(result.output.includes("SKIP JSON show: staging has no events"), result.output);
  assert.ok(result.output.includes("SKIP cancelled show: no cancelled event on the first page"), result.output);
});

test("accepts a staging page with no cancelled event", async (t) => {
  const published = { ...collection, data: [pub], meta: { ...collection.meta, total: 1 } };
  const { url } = await stub(t, (id, result) => {
    if (id === "gone-scan") result.body = JSON.stringify(published);
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /PASS JSON show/);
  assert.ok(result.output.includes("SKIP cancelled show: no cancelled event on the first page"), result.output);
});

test("skips visibly while the show route is undeployed (PR #109 pending)", async (t) => {
  const { url } = await stub(t, () => {}, { preContract: true });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /json-smoke: 8 checks, 0 failed, 5 skipped/);
  for (const label of ["guest collection refusal", "QA login", "malformed event_key filter"]) {
    assert.ok(result.output.includes(`PASS ${label}`), `${label}: ${result.output}`);
  }
  for (const label of ["guest show refusal", "collection paging envelope", "JSON show", "cancelled show", "malformed show key"]) {
    assert.ok(result.output.includes(`SKIP ${label}: event JSON contract not deployed yet (PR #109 pending)`), `${label}: ${result.output}`);
  }
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

test("still fails a broken pre-contract collection instead of skipping", async (t) => {
  const { url } = await stub(t, (id, result) => {
    if (id === "collection") { result.status = 503; result.body = "upstream fallback"; }
  }, { preContract: true });
  const result = await run(url);
  assert.equal(result.ok, false, result.output);
  assert.ok(result.output.includes("FAIL collection paging envelope: expected HTTP 200 {data, page, limit} pre-contract envelope"), result.output);
  assert.ok(!result.output.includes("upstream fallback"), result.output);
});

test("bounds stalled responses", async (t) => {
  const { url } = await stub(t, (id, result) => { if (id === "guest-collection") result.stall = true; });
  const result = await run(url, { timeoutMs: 150 });
  assert.equal(result.ok, false);
  assert.match(result.output, /FAIL guest collection refusal: expected HTTP response and body within timeout; actual (TimeoutError|AbortError)/);
});
