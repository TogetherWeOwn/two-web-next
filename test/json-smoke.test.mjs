import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  clearedCookieProblems,
  jsonSmoke,
  parseSetCookie,
  sessionCookieProblems,
  stripCloudflareSnippet,
} from "../bin/json-smoke.mjs";

// Loopback implementation of the PR #109 JSON contract plus the staging QA
// seam: same-origin POST login issuing the session and status cookies, guest
// 401 refusals, paging envelope, show shape, the cancelled 410 envelope, page
// view rotation, /auth/status and logout revocation. Never touches a Worker,
// database or external network. Secret-bearing values carry a marker
// so every test can prove they never reach the output.
//
// Pre-contract mode: until PR #109 deploys, the show route does not exist, so
// guests get the app's branded HTML 404 there and the collection has no
// `meta` paginator. Tests opt in via `preContract(result)`, which rewrites the
// guest-show and collection responses to that shape.
const TOKEN = "qa-token-never-log-this";
const SESSION = "session-never-log-this";
const ROTATED = "rotated-session-never-log-this";
const STATUS_VALUE = "status-probe-never-log-this";
const COOKIE_FLAGS = "Path=/; Max-Age=7200; Secure; HttpOnly; SameSite=Lax";
const sessionSetCookie = (value) => `__Host-two_session=${value}; ${COOKIE_FLAGS}`;
const statusSetCookie = `__Host-two_session_status=${STATUS_VALUE}; ${COOKIE_FLAGS}`;
const clearedSetCookies = [
  "__Host-two_session=; Max-Age=0; Path=/; Secure",
  "__Host-two_session_status=; Max-Age=0; Path=/; Secure",
];
// Cloudflare appends a challenge snippet carrying a per-request ray id, so two
// otherwise identical 404 bodies differ by exactly that block.
const notFoundPage = (ray) =>
  "<html><body><h1>We cannot find that page</h1><script>(function(){function c(){" +
  "var b=a.contentDocument||a.contentWindow.document;if(b){var d=b.createElement('script');" +
  `d.innerHTML="window.__CF$cv$params={r:'${ray.padStart(16, "0")}',t:'${Buffer.from(ray).toString("base64")}'};` +
  "var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';" +
  "document.getElementsByTagName('head')[0].appendChild(a);\";b.getElementsByTagName('head')[0].appendChild(d)}}" +
  "if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;" +
  "a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';" +
  "document.body.appendChild(a);if('loading'!==document.readyState)c();" +
  "else if(window.addEventListener)document.addEventListener('DOMContentLoaded',c);" +
  "else{var e=document.onreadystatechange||function(){};document.onreadystatechange=function(b){e(b);" +
  "'loading'!==document.readyState&&(document.onreadystatechange=e,c())}}}})();</script></body></html>";
const PUB_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const GONE_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

const pub = {
  event_key: PUB_KEY,
  title: "Game night",
  game: "Chess",
  description: "Bring a board.",
  starts_at: "2099-01-01T20:00:00.000Z",
  ends_at: "2099-01-01T22:00:00.000Z",
  timezone: "Europe/London",
  location: "Voice",
  capacity: 2,
  status: "published",
  rsvp_open: true,
  going_count: 2,
  waitlist_position: null,
};
const goneRow = { event_key: GONE_KEY, status: "cancelled" };
const goneBody = {
  reason: "event_cancelled",
  message: "This event was cancelled.",
  event_key: GONE_KEY,
  status: "cancelled",
};
const collection = {
  data: [pub, goneRow],
  page: 1,
  limit: 20,
  meta: { current_page: 1, per_page: 20, total: 2, last_page: 1 },
};

function route(request, origin, state, options) {
  const url = new URL(request.url, origin);
  const presented = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("__Host-two_session="))
    ?.slice("__Host-two_session=".length);
  const authed = presented !== undefined && state.live.has(presented);
  const html = (status, body, headers = {}) => ({
    status,
    headers: { "content-type": "text/html; charset=UTF-8", ...headers },
    body,
  });
  const notFound = () => html(404, notFoundPage((++state.rays).toString(16)));
  if (request.method === "POST" && url.pathname === "/auth/qa/qa-member") {
    const ok = request.headers.origin === origin && request.headers["x-two-qa-auth"] === TOKEN;
    if (!ok) return ["qa-404", notFound()];
    state.live.add(SESSION);
    return [
      "login",
      {
        status: 204,
        headers: { "set-cookie": [sessionSetCookie(SESSION), statusSetCookie] },
        body: "",
      },
    ];
  }
  if (request.method === "POST" && url.pathname === "/logout") {
    if (request.headers.origin !== origin)
      return [
        "logout",
        {
          status: 403,
          headers: { "content-type": "application/json" },
          body: '{"error":"cross_origin"}',
        },
      ];
    if (options.revoke && presented !== undefined) state.live.delete(presented);
    return [
      "logout",
      { status: 303, headers: { location: "/", "set-cookie": clearedSetCookies }, body: "" },
    ];
  }
  if (request.method === "POST") return ["missing-404", notFound()];
  if (request.method !== "GET") return ["other", { status: 405, headers: {}, body: "" }];
  const json = (status, body) => ({
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
    body,
  });
  if (url.pathname === "/auth/status")
    return ["status", json(200, JSON.stringify({ authenticated: authed }))];
  if (url.pathname === "/") {
    if (authed && options.rotate) {
      // Every authenticated page view rotates: the old row is gone for replays.
      state.live.delete(presented);
      state.live.add(ROTATED);
      return [
        "home",
        html(200, "<html>home</html>", {
          "set-cookie": [sessionSetCookie(ROTATED), statusSetCookie],
        }),
      ];
    }
    return ["home", html(200, "<html>home</html>")];
  }
  if (!authed) {
    if (url.pathname === "/events.json")
      return ["guest-collection", json(401, '{"error":"unauthenticated"}')];
    if (url.pathname === `/events/${"0".repeat(26)}`)
      return ["guest-show", json(401, '{"error":"unauthenticated"}')];
    return ["other", { status: 500, headers: {}, body: "Unexpected request" }];
  }
  if (url.pathname === "/events.json" && url.search === "")
    return ["collection", json(200, JSON.stringify(collection))];
  if (url.pathname === "/events.json" && url.search === "?event_key=not-a-key") {
    return ["filter", json(422, '{"error":"invalid_event_key"}')];
  }
  if (url.pathname === "/events.json" && url.search === "?per_page=100")
    return ["gone-scan", json(200, JSON.stringify(collection))];
  if (url.pathname === `/events/${PUB_KEY}`)
    return ["show", json(200, JSON.stringify({ data: pub }))];
  if (url.pathname === `/events/${GONE_KEY}`)
    return ["gone-show", { ...json(410, JSON.stringify(goneBody)), status: 410 }];
  if (url.pathname === "/events/bad-key") return ["bad-key", json(404, '{"error":"not_found"}')];
  return ["other", { status: 500, headers: {}, body: "Unexpected request" }];
}

async function stub(
  t,
  change = () => {},
  { preContract = false, rotate = true, revoke = true } = {},
) {
  const requests = [];
  const state = { live: new Set(), rays: 0 };
  const timers = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      requests.push({
        method: request.method,
        path: request.url,
        origin: request.headers.origin,
        qa: request.headers["x-two-qa-auth"],
        cookie: request.headers.cookie,
      });
      const [id, result] = route(request, origin, state, { rotate, revoke });
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
      change(id, result, {
        originHeader: request.headers.origin,
        qaHeader: request.headers["x-two-qa-auth"],
        cookieHeader: request.headers.cookie,
        body,
      });
      const sendBody = () => {
        if (response.destroyed) return;
        if (result.body === null) response.flushHeaders();
        else response.end(result.body);
      };
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(result.status, result.headers);
        if (result.bodyDelayMs) {
          response.flushHeaders();
          later(sendBody, result.bodyDelayMs);
        } else sendBody();
      };
      if (result.delayMs) later(send, result.delayMs);
      else send();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, requests, state };
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
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, output };
}

test("passes the full contract without leaking secrets", async (t) => {
  const { url, requests } = await stub(t);
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /json-smoke: 14 checks, 0 failed, 0 skipped/);
  for (const label of [
    "guest collection refusal",
    "guest show refusal",
    "QA login",
    "collection paging envelope",
    "malformed event_key filter",
    "JSON show",
    "cancelled show",
    "malformed show key",
    "session cookie flags",
    "status cookie flags",
    "session rotation replay",
    "logout revokes session",
    "logout clears cookies",
    "QA bad-token 404 matches missing route",
  ]) {
    assert.ok(result.output.includes(`PASS ${label}`), `${label}: ${result.output}`);
  }
  const login = requests.find((r) => r.path === "/auth/qa/qa-member");
  assert.equal(login?.method, "POST");
  assert.equal(login?.origin, url);
  assert.equal(login?.qa, TOKEN);
  assert.deepEqual(
    requests.filter((r) => r.method === "GET").map((r) => r.path),
    [
      "/events.json",
      `/events/${"0".repeat(26)}`,
      "/events.json",
      "/events.json?event_key=not-a-key",
      `/events/${PUB_KEY}`,
      "/events.json?per_page=100",
      `/events/${GONE_KEY}`,
      "/events/bad-key",
      "/",
      "/auth/status",
      "/auth/status",
      "/auth/status",
    ],
  );
  assert.deepEqual(
    requests.filter((r) => r.method === "POST").map((r) => r.path),
    ["/auth/qa/qa-member", "/logout", "/auth/qa/qa-member", "/auth/json-smoke-missing-route"],
  );
  // Replays prove the old token, not the live session: the session cookie goes
  // alone (never with the probe cookie, whose key survives rotation).
  const replays = requests.filter((r) => r.path === "/auth/status").map((r) => r.cookie);
  assert.deepEqual(replays, [
    `__Host-two_session=${SESSION}`,
    `__Host-two_session=${ROTATED}`,
    `__Host-two_session=${ROTATED}`,
  ]);
  const logout = requests.find((r) => r.path === "/logout");
  assert.equal(logout?.origin, url);
  assert.equal(logout?.cookie, `__Host-two_session=${ROTATED}`);
  const bad = requests.filter((r) => r.path === "/auth/qa/qa-member")[1];
  assert.notEqual(bad?.qa, TOKEN);
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

test("CLI passes against loopback and rejects bad input before requesting", async (t) => {
  const { url } = await stub(t);
  const ok = await cli([url]);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /json-smoke: 14 checks, 0 failed, 0 skipped/);
  assert.ok(!ok.output.includes("never-log-this"), ok.output);
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli([url], { QA_AUTH_TOKEN: "" })).code, 2);
  for (const target of [
    "https://togetherweown.com",
    "https://example.invalid",
    "file:///etc/passwd",
  ]) {
    const refused = await cli([target]);
    assert.equal(refused.code, 2, target);
    assert.match(refused.output, /staging-only|base-url must be/);
  }
});

test("wrong token fails the login and skips every authenticated check", async (t) => {
  const { url } = await stub(t);
  const result = await run(url, { token: "wrong-token" });
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL QA login: expected HTTP 204 with a session cookie; actual HTTP 404 without session cookie/,
  );
  assert.match(result.output, /json-smoke: 14 checks, 1 failed, 10 skipped/);
  for (const label of [
    "collection paging envelope",
    "malformed event_key filter",
    "JSON show",
    "cancelled show",
    "malformed show key",
    "session cookie flags",
    "status cookie flags",
    "session rotation replay",
    "logout revokes session",
    "logout clears cookies",
  ]) {
    assert.ok(result.output.includes(`SKIP ${label}: no QA session`), result.output);
  }
  assert.ok(!result.output.includes("wrong-token"), result.output);
});

test("a transport failure on the QA login never prints the token or request headers", async (t) => {
  // TOG-13046: deploy.yml runs this probe on a public repo, so a dropped
  // connection must surface as an error name only.
  const server = createServer((request) => request.socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const result = await run(`http://127.0.0.1:${server.address().port}`);
  assert.equal(result.ok, false);
  assert.match(result.output, /FAIL QA login: expected HTTP response within timeout; actual \w+/);
  assert.ok(!result.output.includes(TOKEN), result.output);
  assert.ok(!/x-two-qa-auth|call log/i.test(result.output), result.output);
});

for (const [id, label] of [
  ["guest-collection", "guest collection refusal"],
  ["guest-show", "guest show refusal"],
  ["collection", "collection paging envelope"],
  ["filter", "malformed event_key filter"],
  ["show", "JSON show"],
  ["gone-show", "cancelled show"],
  ["bad-key", "malformed show key"],
  ["home", "session rotation replay"],
  ["logout", "logout revokes session"],
  ["qa-404", "QA bad-token 404 matches missing route"],
  ["missing-404", "QA bad-token 404 matches missing route"],
]) {
  test(`rejects HTTP 503 on ${label} and continues the remaining checks`, async (t) => {
    const { url, requests } = await stub(t, (routeId, result) => {
      if (routeId === id) {
        result.status = 503;
        result.body = "upstream fallback";
      }
    });
    const result = await run(url);
    assert.equal(result.ok, false);
    assert.ok(result.output.includes(`FAIL ${label}: expected`), result.output);
    assert.ok(!result.output.includes("upstream fallback"), result.output);
    assert.ok(requests.length >= 7, result.output);
  });
}

test("rejects a collection missing the meta paginator", async (t) => {
  const { url } = await stub(t, (id, result) => {
    if (id === "collection" || id === "gone-scan")
      result.body = JSON.stringify({ data: [pub], page: 1, limit: 20 });
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL collection paging envelope: expected HTTP 200 \{data, page, limit, meta/,
  );
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
  const empty = {
    data: [],
    page: 1,
    limit: 20,
    meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
  };
  const { url } = await stub(t, (id, result) => {
    if (id === "collection" || id === "gone-scan") result.body = JSON.stringify(empty);
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /json-smoke: 14 checks, 0 failed, 2 skipped/);
  assert.ok(result.output.includes("SKIP JSON show: staging has no events"), result.output);
  assert.ok(
    result.output.includes("SKIP cancelled show: no cancelled event on the first page"),
    result.output,
  );
});

test("accepts a staging page with no cancelled event", async (t) => {
  const published = { ...collection, data: [pub], meta: { ...collection.meta, total: 1 } };
  const { url } = await stub(t, (id, result) => {
    if (id === "gone-scan") result.body = JSON.stringify(published);
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /PASS JSON show/);
  assert.ok(
    result.output.includes("SKIP cancelled show: no cancelled event on the first page"),
    result.output,
  );
});

test("skips visibly while the show route is undeployed (PR #109 pending)", async (t) => {
  const { url } = await stub(t, () => {}, { preContract: true });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /json-smoke: 14 checks, 0 failed, 5 skipped/);
  for (const label of ["guest collection refusal", "QA login", "malformed event_key filter"]) {
    assert.ok(result.output.includes(`PASS ${label}`), `${label}: ${result.output}`);
  }
  for (const label of [
    "guest show refusal",
    "collection paging envelope",
    "JSON show",
    "cancelled show",
    "malformed show key",
  ]) {
    assert.ok(
      result.output.includes(
        `SKIP ${label}: event JSON contract not deployed yet (PR #109 pending)`,
      ),
      `${label}: ${result.output}`,
    );
  }
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

test("still fails a broken pre-contract collection instead of skipping", async (t) => {
  const { url } = await stub(
    t,
    (id, result) => {
      if (id === "collection") {
        result.status = 503;
        result.body = "upstream fallback";
      }
    },
    { preContract: true },
  );
  const result = await run(url);
  assert.equal(result.ok, false, result.output);
  assert.ok(
    result.output.includes(
      "FAIL collection paging envelope: expected HTTP 200 {data, page, limit} pre-contract envelope",
    ),
    result.output,
  );
  assert.ok(!result.output.includes("upstream fallback"), result.output);
});

test("bounds stalled responses", async (t) => {
  const { url } = await stub(t, (id, result) => {
    if (id === "guest-collection") result.body = null;
  });
  const result = await run(url, { timeoutMs: 150 });
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL guest collection refusal: expected HTTP response and body within timeout; actual (TimeoutError|AbortError)/,
  );
  assert.match(result.output, /PASS guest show refusal/);
});

const FLAG_EXPECTED =
  "__Host- prefix, Path=/, Secure, HttpOnly, SameSite=Lax, positive Max-Age, no Domain";

const FLAG_MUTATIONS = [
  ["Secure", (cookie) => cookie.replace("; Secure", "")],
  ["HttpOnly", (cookie) => cookie.replace("; HttpOnly", "")],
  ["SameSite=Lax", (cookie) => cookie.replace("SameSite=Lax", "SameSite=Strict")],
  ["positive Max-Age", (cookie) => cookie.replace("Max-Age=7200", "Max-Age=0")],
  ["positive Max-Age", (cookie) => cookie.replace("; Max-Age=7200", "")],
  ["Path=/", (cookie) => cookie.replace("Path=/;", "Path=/app;")],
  ["no Domain", (cookie) => `${cookie}; Domain=togetherweown.com`],
];

for (const [problem, mutate] of FLAG_MUTATIONS) {
  for (const [label, index] of [
    ["session cookie flags", 0],
    ["status cookie flags", 1],
  ]) {
    test(`fails ${label} when ${problem} is violated, naming the attribute only`, async (t) => {
      const { url } = await stub(t, (id, result) => {
        if (id === "login")
          result.headers["set-cookie"] = result.headers["set-cookie"].map((cookie, i) =>
            i === index ? mutate(cookie) : cookie,
          );
      });
      const result = await run(url);
      assert.equal(result.ok, false);
      assert.ok(
        result.output.includes(
          `FAIL ${label}: expected ${FLAG_EXPECTED}; actual violated ${problem}`,
        ),
        result.output,
      );
      const other =
        label === "session cookie flags" ? "status cookie flags" : "session cookie flags";
      assert.ok(result.output.includes(`PASS ${other}`), result.output);
      assert.ok(!result.output.includes("never-log-this"), result.output);
    });
  }
}

test("fails the status cookie flags when the login never issues the probe cookie", async (t) => {
  const { url } = await stub(t, (id, result) => {
    if (id === "login") result.headers["set-cookie"] = [sessionSetCookie(SESSION)];
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(
    result.output.includes(
      "FAIL status cookie flags: expected login Set-Cookie __Host-two_session_status; actual cookie not issued",
    ),
    result.output,
  );
  assert.ok(result.output.includes("PASS session cookie flags"), result.output);
});

test("fails rotation when the page view leaves the old cookie authenticating", async (t) => {
  const { url } = await stub(t, () => {}, { rotate: false });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(
    result.output.includes(
      "FAIL session rotation replay: expected old cookie unauthenticated and replacement authenticated on /auth/status; actual no replacement session cookie; no replacement status cookie; old cookie still authenticates",
    ),
    result.output,
  );
  // The unrotated cookie is still the live one, so logout is judged on its own.
  assert.ok(result.output.includes("PASS logout revokes session"), result.output);
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

test("fails rotation when the replacement cookie repeats the old value or lacks flags", async (t) => {
  for (const [change, problem] of [
    [
      (result) => {
        result.headers["set-cookie"] = [sessionSetCookie(SESSION), statusSetCookie];
      },
      "replacement cookie unchanged",
    ],
    [
      (result) => {
        result.headers["set-cookie"] = [
          sessionSetCookie(ROTATED).replace("; HttpOnly", ""),
          statusSetCookie,
        ];
      },
      "replacement cookie violated HttpOnly",
    ],
  ]) {
    const { url } = await stub(t, (id, result) => {
      if (id === "home" && result.headers["set-cookie"]) change(result);
    });
    const result = await run(url);
    assert.equal(result.ok, false, problem);
    assert.ok(result.output.includes(`FAIL session rotation replay: expected`), result.output);
    assert.ok(result.output.includes(problem), result.output);
    assert.ok(!result.output.includes("never-log-this"), result.output);
  }
});

test("a status-probe outage is never read as a revoked or rotated session", async (t) => {
  const { url } = await stub(t, (id, result) => {
    if (id === "status") {
      result.status = 503;
      result.body = '{"authenticated":false}';
    }
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(
    result.output.includes("FAIL session rotation replay") &&
      result.output.includes("old cookie status probe HTTP 503"),
    result.output,
  );
  assert.ok(
    result.output.includes("FAIL logout revokes session") &&
      result.output.includes("pre-logout cookie status probe HTTP 503"),
    result.output,
  );
});

test("fails logout when the server keeps the pre-logout session alive", async (t) => {
  const { url } = await stub(t, () => {}, { revoke: false });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(
    result.output.includes(
      "FAIL logout revokes session: expected HTTP 303 and the pre-logout cookie unauthenticated on /auth/status; actual pre-logout cookie still authenticates",
    ),
    result.output,
  );
  assert.ok(result.output.includes("PASS logout clears cookies"), result.output);
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

test("fails logout when it does not clear both cookies with Max-Age=0", async (t) => {
  for (const [cookies, problem] of [
    [[clearedSetCookies[0]], "status cookie not cleared"],
    [[clearedSetCookies[1]], "session cookie not cleared"],
    [
      ["__Host-two_session=leftover-never-log-this; Path=/; Secure", clearedSetCookies[1]],
      "session cookie violated empty value, Max-Age=0",
    ],
    [
      [clearedSetCookies[0], "__Host-two_session_status=; Path=/; Secure; Max-Age=60"],
      "status cookie violated Max-Age=0",
    ],
    [
      [clearedSetCookies[0], "__Host-two_session_status=; Max-Age=0; Secure"],
      "status cookie violated Path=/",
    ],
  ]) {
    const { url } = await stub(t, (id, result) => {
      if (id === "logout") result.headers["set-cookie"] = cookies;
    });
    const result = await run(url);
    assert.equal(result.ok, false, problem);
    assert.ok(result.output.includes(`FAIL logout clears cookies: expected`), result.output);
    assert.ok(result.output.includes(`actual ${problem}`), `${problem}: ${result.output}`);
    assert.ok(result.output.includes("PASS logout revokes session"), result.output);
    assert.ok(!result.output.includes("never-log-this"), result.output);
  }
});

test("fails logout that is refused for a cross-origin request", async (t) => {
  const { url } = await stub(t, (id, result) => {
    if (id === "logout") {
      result.status = 403;
      result.headers = { "content-type": "application/json" };
      result.body = '{"error":"cross_origin"}';
    }
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(result.output.includes("FAIL logout revokes session"), result.output);
  assert.ok(result.output.includes("logout HTTP 403"), result.output);
});

test("fails when the QA bad-token 404 differs from a missing-route 404", async (t) => {
  for (const [change, actual] of [
    [
      (result) => {
        result.headers = { "content-type": "application/json" };
        result.body = '{"error":"not_found"}';
      },
      "bodies differ (",
    ],
    [
      (result) => {
        result.status = 401;
      },
      "HTTP 401 vs HTTP 404",
    ],
    [
      (result) => {
        result.body = result.body.replace("We cannot find that page", "No such seam");
      },
      "bodies differ (",
    ],
  ]) {
    const { url } = await stub(t, (id, result) => {
      if (id === "qa-404") change(result);
    });
    const result = await run(url);
    assert.equal(result.ok, false, actual);
    assert.ok(
      result.output.includes(
        "FAIL QA bad-token 404 matches missing route: expected identical HTTP 404 status, content type and body (Cloudflare snippet excluded)",
      ),
      result.output,
    );
    assert.ok(result.output.includes(actual), `${actual}: ${result.output}`);
    assert.ok(!result.output.includes("No such seam"), result.output);
  }
});

test("a throttled bad-token probe fails the 404 parity check instead of skipping", async (t) => {
  const { url } = await stub(t, (id, result) => {
    if (id === "qa-404") {
      result.status = 429;
      result.headers = { "content-type": "application/json", "retry-after": "60" };
      result.body = '{"error":"too_many_requests"}';
    }
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(result.output.includes("actual HTTP 429 vs HTTP 404"), result.output);
});

for (const script of [
  "<script>window.qaSeamVisible=true;/* /cdn-cgi/ */</script>",
  "<script>window.__CF$cv$params={application:true};</script>",
  '<script src="/cdn-cgi/scripts/x.js"></script>',
]) {
  test(`404 parity preserves unrelated application script: ${script}`, async (t) => {
    const { url } = await stub(t, (id, result) => {
      if (id === "qa-404") result.body = result.body.replace("</body>", `${script}</body>`);
    });
    const result = await run(url);
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /FAIL QA bad-token 404 matches missing route/);
    assert.match(result.output, /bodies differ/);
    assert.ok(!result.output.includes("qaSeamVisible"), result.output);
  });
}

for (const [id, index, label] of [
  ["login", 0, "session cookie flags"],
  ["login", 1, "status cookie flags"],
  ["home", 0, "session rotation replay"],
  ["logout", 0, "logout clears cookies"],
  ["logout", 1, "logout clears cookies"],
]) {
  test(`rejects duplicate target cookie ${index} on ${id}`, async (t) => {
    const { url } = await stub(t, (routeId, result) => {
      if (routeId === id) {
        const cookies = result.headers["set-cookie"];
        const duplicate =
          id === "logout"
            ? cookies[index].replace("=;", "=leftover-never-log-this;")
            : cookies[index].replace("; HttpOnly", "");
        result.headers["set-cookie"] = [...cookies, duplicate];
      }
    });
    const result = await run(url);
    assert.equal(result.ok, false, result.output);
    assert.ok(result.output.includes(`FAIL ${label}:`), result.output);
    assert.match(result.output, /duplicate Set-Cookie/);
    assert.ok(!result.output.includes("never-log-this"), result.output);
  });
}

test("logout headers with a stalled body fail both logout checks", async (t) => {
  const { url, state } = await stub(t, (id, result) => {
    if (id === "logout") result.body = null;
  });
  const result = await run(url, { timeoutMs: 500 });
  assert.equal(result.ok, false, result.output);
  for (const label of ["logout revokes session", "logout clears cookies"]) {
    assert.ok(
      result.output.includes(`FAIL ${label}: expected HTTP 303 within timeout`),
      result.output,
    );
    assert.ok(!result.output.includes(`PASS ${label}`), result.output);
  }
  assert.match(result.output, /actual (TimeoutError|AbortError)/);
  assert.equal(state.live.has(ROTATED), false);
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

for (const [label, target, occurrence, stalled] of [
  ["page body timeout", "home", 1, true],
  ["old status 503", "status", 1, false],
  ["replacement status 503", "status", 2, false],
  ["old status body timeout", "status", 1, true],
  ["replacement status body timeout", "status", 2, true],
]) {
  test(`logout cleans up the issued replacement after ${label}`, async (t) => {
    let count = 0;
    const { url, requests, state } = await stub(t, (id, result) => {
      if (id === target && ++count === occurrence) {
        if (stalled) result.body = null;
        else {
          result.status = 503;
          result.body = '{"authenticated":false}';
        }
      }
    });
    const result = await run(url, { timeoutMs: 500 });
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /FAIL session rotation replay/);
    assert.match(result.output, /PASS logout revokes session/);
    assert.equal(
      requests.find((request) => request.path === "/logout")?.cookie,
      `__Host-two_session=${ROTATED}`,
    );
    assert.equal(state.live.has(ROTATED), false);
    assert.equal(state.live.size, 0);
    assert.ok(!result.output.includes("never-log-this"), result.output);
  });
}

for (const contentType of [
  "text/html; charset=iso-8859-1",
  'text/html; charset=UTF-8; profile="qa-only"',
]) {
  test(`404 parity retains content-type parameters: ${contentType}`, async (t) => {
    const { url } = await stub(t, (id, result) => {
      if (id === "qa-404") result.headers["content-type"] = contentType;
    });
    const result = await run(url);
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /FAIL QA bad-token 404 matches missing route/);
    assert.match(result.output, /content types differ/);
    assert.ok(!result.output.includes("qa-only"), result.output);
  });
}

test("Cloudflare normalization is exact and fails closed on lookalikes", () => {
  for (const page of [
    notFoundPage("abc123").replace("appendChild(a);", "appendChild(a);window.extra=true;"),
    notFoundPage("abc123").replace("r:'0000000000abc123'", "r:'not-a-ray'"),
    notFoundPage("abc123").replace("a.style.top=0", "a.style.top=1"),
  ]) {
    assert.equal(stripCloudflareSnippet(page), page);
  }
});

for (const [problem, mutate] of FLAG_MUTATIONS) {
  test(`rotation validates reissued status cookie: ${problem}`, async (t) => {
    const { url } = await stub(t, (id, response) => {
      if (id === "home") response.headers["set-cookie"][1] = mutate(statusSetCookie);
    });
    const result = await run(url);
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /FAIL session rotation replay/);
    assert.ok(
      result.output.includes(`replacement status cookie violated ${problem}`),
      result.output,
    );
    assert.ok(!result.output.includes("never-log-this"), result.output);
  });
}

for (const [cookies, problem] of [
  [[sessionSetCookie(ROTATED)], "no replacement status cookie"],
  [
    [sessionSetCookie(ROTATED), statusSetCookie.replace("__Host-", "")],
    "no replacement status cookie",
  ],
  [
    [sessionSetCookie(ROTATED), statusSetCookie.replace(STATUS_VALUE, "")],
    "empty replacement status cookie",
  ],
  [[sessionSetCookie(ROTATED), statusSetCookie, statusSetCookie], "duplicate Set-Cookie"],
]) {
  test(`rotation validates reissued status cookie: ${problem}`, async (t) => {
    const { url } = await stub(t, (id, response) => {
      if (id === "home") response.headers["set-cookie"] = cookies;
    });
    const result = await run(url);
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /FAIL session rotation replay/);
    assert.ok(result.output.includes(problem), result.output);
    assert.ok(!result.output.includes("never-log-this"), result.output);
  });
}

for (const occurrence of [1, 2, 3]) {
  for (const kind of ["session", "status"]) {
    test(`readonly status probe rejects ${kind} issuance on reply ${occurrence} and cleans up`, async (t) => {
      const next = "unexpected-session-never-log-this";
      let count = 0;
      const fixture = await stub(t, (id, response, { cookieHeader }) => {
        if (id === "status" && ++count === occurrence) {
          if (kind === "session") {
            fixture.state.live.delete(cookieHeader?.slice("__Host-two_session=".length));
            fixture.state.live.add(next);
          }
          response.headers["set-cookie"] = [
            kind === "session" ? sessionSetCookie(next) : statusSetCookie,
          ];
        }
      });
      const result = await run(fixture.url);
      assert.equal(result.ok, false, result.output);
      assert.match(
        result.output,
        /status probe (issued auth cookies|mutated authentication state)/,
      );
      assert.ok(!result.output.includes("PASS logout revokes session"), result.output);
      assert.equal(fixture.state.live.size, 0);
      for (const request of fixture.requests.filter((request) => request.path === "/auth/status")) {
        assert.ok(!request.cookie.includes("__Host-two_session_status"));
      }
      assert.ok(!result.output.includes("never-log-this"), result.output);
    });
  }
}

for (const revoke of [false, true]) {
  test(`status observer rotation cannot mask logout with revoke=${revoke}`, async (t) => {
    let rotations = 0;
    const fixture = await stub(
      t,
      (id, response, { cookieHeader }) => {
        if (id === "status" && JSON.parse(response.body).authenticated) {
          const next = `unexpected-${++rotations}-never-log-this`;
          fixture.state.live.delete(cookieHeader.slice("__Host-two_session=".length));
          fixture.state.live.add(next);
          response.headers["set-cookie"] = [sessionSetCookie(next)];
        }
      },
      { revoke },
    );
    const result = await run(fixture.url);
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /FAIL session rotation replay/);
    assert.match(result.output, /FAIL logout revokes session/);
    assert.ok(!result.output.includes("PASS logout revokes session"), result.output);
    assert.equal(fixture.state.live.size === 0, revoke);
    assert.ok(
      fixture.requests
        .filter((request) => request.path === "/logout")
        .some((request) => request.cookie === "__Host-two_session=unexpected-1-never-log-this"),
    );
    assert.ok(!result.output.includes("never-log-this"), result.output);
  });
}

for (const occurrence of [1, 2, 3]) {
  test(`status observer body timeout on reply ${occurrence} still cleans up issued bearers`, async (t) => {
    const next = "timeout-session-never-log-this";
    let count = 0;
    const fixture = await stub(t, (id, response) => {
      if (id === "status" && ++count === occurrence) {
        fixture.state.live.add(next);
        response.headers["set-cookie"] = [sessionSetCookie(next)];
        response.body = null;
      }
    });
    const result = await run(fixture.url, { timeoutMs: 500 });
    assert.equal(result.ok, false, result.output);
    assert.equal(fixture.state.live.size, 0);
    assert.ok(
      fixture.requests
        .filter((request) => request.path === "/logout")
        .some((request) => request.cookie === `__Host-two_session=${next}`),
    );
    assert.ok(!result.output.includes("PASS logout revokes session"), result.output);
    assert.ok(!result.output.includes("never-log-this"), result.output);
  });
}

test("status observer duplicate issuance retains every observed bearer for cleanup", async (t) => {
  const issued = ["duplicate-one-never-log-this", "duplicate-two-never-log-this"];
  let count = 0;
  const fixture = await stub(t, (id, response) => {
    if (id === "status" && ++count === 2) {
      for (const value of issued) fixture.state.live.add(value);
      response.headers["set-cookie"] = issued.map(sessionSetCookie);
    }
  });
  const result = await run(fixture.url);
  assert.equal(result.ok, false, result.output);
  assert.equal(fixture.state.live.size, 0);
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

test("status observer cleanup is bounded when many unexpected bearers are issued", async (t) => {
  let count = 0;
  const fixture = await stub(t, (id, response) => {
    if (id === "status" && ++count === 2) {
      const issued = Array.from({ length: 10 }, (_, i) => `overflow-${i}-never-log-this`);
      for (const value of issued) fixture.state.live.add(value);
      response.headers["set-cookie"] = issued.map(sessionSetCookie);
    }
  });
  const result = await run(fixture.url);
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /cleanup limit exceeded/);
  assert.ok(fixture.requests.filter((request) => request.path === "/logout").length <= 9);
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

for (const bodyDelayMs of [0, 50]) {
  test(`404 deadlines cover each fetch and body independently (body delay ${bodyDelayMs})`, async (t) => {
    const fixture = await stub(t, (id, response) => {
      if (id === "qa-404" || id === "missing-404") {
        response.delayMs = 300;
        response.bodyDelayMs = bodyDelayMs;
      }
    });
    for (const path of ["/auth/qa/qa-member", "/auth/json-smoke-missing-route"]) {
      const response = await fetch(new URL(path, fixture.url), {
        method: "POST",
        headers: { origin: fixture.url },
        signal: AbortSignal.timeout(500),
      });
      assert.equal(response.status, 404);
      await response.text();
    }
    const result = await run(fixture.url, { timeoutMs: 500 });
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /PASS QA bad-token 404 matches missing route/);
    assert.ok(!result.output.includes("never-log-this"), result.output);
  });
}

test("404 deadlines still reject a genuinely slow response body", async (t) => {
  const { url } = await stub(t, (id, response) => {
    if (id === "qa-404") response.bodyDelayMs = 750;
  });
  const result = await run(url, { timeoutMs: 500 });
  assert.equal(result.ok, false, result.output);
  assert.match(
    result.output,
    /FAIL QA bad-token 404 matches missing route.*(TimeoutError|AbortError)/,
  );
  assert.ok(!result.output.includes("never-log-this"), result.output);
});

test("cookie and snippet helpers handle real header and edge shapes", () => {
  const good = parseSetCookie(`${sessionSetCookie("value%3D%2Bx")}`);
  assert.equal(good?.name, "__Host-two_session");
  assert.equal(good?.value, "value%3D%2Bx");
  assert.deepEqual(sessionCookieProblems(good), []);
  // Attribute names are case-insensitive; the value may itself hold `=`.
  const shouty = parseSetCookie(
    "__Host-two_session=a=b; PATH=/; SECURE; HTTPONLY; SAMESITE=lax; MAX-AGE=7200",
  );
  assert.equal(shouty?.value, "a=b");
  assert.deepEqual(sessionCookieProblems(shouty), []);
  assert.deepEqual(sessionCookieProblems(parseSetCookie("two_session=a; Path=/; Secure")), [
    "__Host- prefix",
    "HttpOnly",
    "SameSite=Lax",
    "positive Max-Age",
  ]);
  assert.equal(parseSetCookie("garbage"), null);
  assert.deepEqual(clearedCookieProblems(parseSetCookie(clearedSetCookies[0])), []);

  const page = "<html><script>var keep=1;</script>" + notFoundPage("abc123") + "</html>";
  const stripped = stripCloudflareSnippet(page);
  assert.ok(stripped.includes("var keep=1"), stripped);
  assert.ok(!stripped.includes("abc123") && !stripped.includes("cdn-cgi"), stripped);
  assert.equal(
    stripCloudflareSnippet(notFoundPage("a".repeat(16))),
    stripCloudflareSnippet(notFoundPage("b".repeat(16))),
  );
  const external = '<script src="/cdn-cgi/scripts/x.js"></script><p>kept</p>';
  assert.equal(stripCloudflareSnippet(external), external);
});
