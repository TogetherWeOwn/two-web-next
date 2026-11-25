import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { PRODUCTION_APEX } from "../../src/http/robots.ts";
import { signedCookieHeader, verifySignedCookie } from "../../src/http/signed-cookie.ts";
import { OAUTH_CODE_STATE_MAX_LENGTH } from "../../src/oauth-code-state-length.ts";
import { QA_HEADER, STAGING_APP_URL } from "../../src/qa.ts";
import { SESSION_COOKIE } from "../../src/session-cookie.ts";

const statusName = "__Host-two_session_status";
const nextName = "__Host-two_login_next";
const expiredName = "__Host-two_expired_write";
const stateName = "__Host-two_oauth_state";
const callback = "/auth/discord/callback";
const joinStart = "/join/discord";
const joinCallback = "/join/callback";
const joinStateName = "__Host-two_join_state";
const joinSourceName = "__Host-two_join_source";
const joinNextName = "__Host-two_join_next";
const joinQuery = "next=%2Fevents&source=fixture";
const ray = "0123456789abcdef-LHR";
const cookiePair = (line) => line.split(";", 1)[0];

function cookie(response, name, age) {
  const matches = response.headers.getSetCookie().filter((line) => line.startsWith(`${name}=`));
  assert.equal(matches.length, 1, `one ${name} header`);
  const line = matches[0];
  assert.ok(line.endsWith(`; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`), name);
  return cookiePair(line);
}

function owns(response, status, kit) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("x-two-renderer"), kit ? "kit" : null);
  assert.equal(response.headers.get("x-request-id"), ray);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
}

async function assertNoJavaScript(origin) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    // Playwright routes only the first request in a redirect chain. Fetch
    // the real login start without following its outbound Location.
    await context.route(
      (url) => url.origin === origin && ["/auth/discord", joinStart].includes(url.pathname),
      async (route) => {
        const joining = new URL(route.request().url()).pathname === joinStart;
        const response = await route.fetch({ maxRedirects: 0 });
        assert.equal(response.status(), 302);
        const headers = response.headers();
        const url = new URL(headers.location);
        assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
        const redirect = new URL(url.searchParams.get("redirect_uri"));
        assert.equal(redirect.href, origin + (joining ? joinCallback : callback));
        redirect.search = new URLSearchParams({
          ...(joining ? { error: "access_denied" } : { code: "fixture-code" }),
          state: url.searchParams.get("state"),
        });
        await route.fulfill({ response, headers: { ...headers, location: redirect.href } });
      },
    );
    const page = await context.newPage();
    await page.goto(origin);
    const signedIn = page.waitForResponse((r) => new URL(r.url()).pathname === callback);
    await page.getByTestId("signin").click();
    assert.equal((await signedIn).headers()["x-two-renderer"], "kit");
    const signedOut = page.waitForResponse((r) => new URL(r.url()).pathname === "/logout");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const response = await signedOut;
    assert.equal(response.request().method(), "POST");
    assert.equal(response.status(), 303);
    assert.equal(response.headers()["x-two-renderer"], "kit");
    await page.getByTestId("signin").waitFor();
    await page.goto(`${origin}/join?${joinQuery}`);
    const recovered = page.waitForResponse((r) => new URL(r.url()).pathname === joinCallback);
    await page.getByTestId("join-oneclick").click();
    assert.equal((await recovered).headers()["x-two-renderer"], "kit");
    assert.equal(
      await page.getByTestId("recovery-retry").getAttribute("href"),
      `${joinStart}?${joinQuery}`,
    );
    await page.getByTestId("recovery-invite").waitFor();
  } finally {
    await browser.close();
  }
}

export async function assertAuthParity(origin, secret, browser) {
  const request = (path, { flag = "true", cookies, headers, ...init } = {}) =>
    fetch(origin + path, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      ...init,
      headers: {
        "cf-ray": ray,
        "x-fixture-auth-flag": flag,
        ...(cookies ? { cookie: cookies } : {}),
        ...headers,
      },
    });
  const post = (path, { headers, body = "", ...init } = {}) =>
    request(path, {
      method: "POST",
      body,
      ...init,
      headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers },
    });
  const location = (response) => response.headers.get("location");
  const hits = (response, bucket) => Number(response.headers.get(`x-fixture-${bucket}-hits`));
  const exchanges = (response) => Number(response.headers.get("x-fixture-exchanges"));
  const start = async (flag) => {
    const response = await request("/auth/discord?next=%2Fevents", { flag });
    owns(response, 302, flag === "true");
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    const authorize = new URL(location(response));
    assert.equal(authorize.origin + authorize.pathname, "https://discord.com/oauth2/authorize");
    assert.equal(authorize.searchParams.get("redirect_uri"), origin + callback);
    const state = authorize.searchParams.get("state");
    assert.match(state, /^[0-9a-f-]{36}$/);
    const pair = cookie(response, stateName, 600);
    assert.ok((await verifySignedCookie(pair.slice(stateName.length + 1), secret)) === state);
    return {
      state,
      cookies: `${pair}; ${cookie(response, nextName, 600)}`,
      exchanges: exchanges(response),
    };
  };

  for (const flag of ["unset", "false", "TRUE", "true"]) {
    const response = await request("/auth/discord/redirect?next=%2Fevents&code=ignored", { flag });
    owns(response, 302, flag === "true");
    assert.equal(location(response), "/auth/discord?next=%2Fevents");
    assert.equal(response.headers.has("set-cookie"), false);
  }
  for (const [method, path] of [
    ["HEAD", "/logout"],
    ["GET", "/auth/status/"],
    ["GET", "/auth/%73tatus"],
    ["GET", "/auth/status/__data.json"],
    ["POST", "/auth/status"],
  ]) {
    const init = { method, headers: { origin } };
    const direct = await request(path, { ...init, flag: "false" });
    const enabled = await request(path, init);
    owns(enabled, direct.status, false);
    assert.equal(location(enabled), location(direct));
  }
  const foreign = await request("/auth/status", { headers: { "x-fixture-foreign-host": "1" } });
  owns(foreign, 404, false);
  const head = await request("/auth/status", { method: "HEAD" });
  owns(head, 200, true);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("vary"), "Cookie");

  // The untrusted signer and oversized value preserve the journey. A handoff
  // from Kit to Hono spends it once, including when both owners see the retry.
  const issued = await start("true");
  const query = new URLSearchParams({ state: issued.state, code: "fixture-code" });
  const wrong = await signedCookieHeader(stateName, issued.state, "fixture wrong signer");
  const stray = await request(`${callback}?${query}`, { cookies: cookiePair(wrong) });
  owns(stray, 302, true);
  assert.equal(location(stray), "/?n=signin_failed");
  assert.equal(stray.headers.has("set-cookie"), false);
  const oversized = await request(
    `${callback}?${new URLSearchParams({
      state: issued.state,
      code: "x".repeat(OAUTH_CODE_STATE_MAX_LENGTH + 1),
    })}`,
    { cookies: issued.cookies },
  );
  assert.equal(location(oversized), "/?n=signin_failed");
  assert.equal(oversized.headers.has("set-cookie"), false);
  assert.equal(hits(oversized, "login-callback"), hits(stray, "login-callback"));
  const success = await request(`${callback}?${query}`, { flag: "false", cookies: issued.cookies });
  owns(success, 302, false);
  assert.equal(location(success), "/events");
  assert.equal(exchanges(success), issued.exchanges + 1);
  cookie(success, stateName, 0);
  const bearer = cookie(success, SESSION_COOKIE, 7200);
  const statusKey = cookie(success, statusName, 7200);
  const replay = await request(`${callback}?${query}`, { cookies: issued.cookies });
  owns(replay, 302, true);
  assert.equal(location(replay), "/?n=signin_failed");
  assert.equal(replay.headers.has("set-cookie"), false);
  assert.equal(replay.headers.has("x-fixture-issued"), false);
  assert.equal(replay.headers.get("x-fixture-exchanges"), "1");

  const handoff = await start("unset");
  const denial = `${callback}?${new URLSearchParams({ state: handoff.state, error: "access_denied" })}`;
  const pending = cookiePair(await signedCookieHeader(expiredName, "pending|/events", secret));
  const denied = await request(denial, { cookies: `${handoff.cookies}; ${pending}` });
  owns(denied, 302, true);
  assert.equal(location(denied), "/?n=signin_denied");
  cookie(denied, stateName, 0);
  cookie(denied, nextName, 0);
  cookie(denied, expiredName, 0);
  assert.ok(!denied.headers.getSetCookie().some((line) => line.startsWith(`${SESSION_COOKIE}=`)));
  const reused = await request(denial, { flag: "false", cookies: handoff.cookies });
  assert.equal(location(reused), "/?n=signin_denied");
  assert.equal(reused.headers.has("set-cookie"), false);
  assert.equal(reused.headers.get("x-fixture-exchanges"), "1");

  const status = async (cookies, expected, flag = "true") => {
    const response = await request("/auth/status", { cookies, flag });
    owns(response, 200, flag === "true");
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(response.headers.has("set-cookie"), false);
    assert.deepEqual(await response.json(), { authenticated: expected });
  };
  await status(bearer, true);
  await status(statusKey, true, "false");

  const [first, sibling, other] = await (await post("/__fixture/auth-sessions")).json();
  for (const path of ["/logout", "/logout/everywhere"]) {
    // Native form requests get the same branded refusal. JSON callers keep
    // the correlated envelope and neither caller spends a logout hit.
    for (const accept of ["text/html", "application/json"]) {
      const headers = { origin: "https://foreign.example.test", accept };
      const direct = await post(path, { flag: "false", headers, cookies: first });
      const kit = await post(path, { headers, cookies: first });
      owns(kit, 403, true);
      assert.equal(kit.headers.get("vary"), "Accept");
      assert.equal(kit.headers.get("cache-control"), "no-store, private");
      assert.equal(kit.headers.has("set-cookie"), false);
      assert.equal(await kit.text(), await direct.text());
      assert.equal(hits(kit, "logout"), 0);
    }
    const large = await post(path, { body: "x".repeat(4097), cookies: first });
    owns(large, 413, true);
    assert.equal(large.headers.has("set-cookie"), false);
    assert.equal(hits(large, "logout"), 0);
  }

  const clear = (response) => {
    assert.equal(location(response), "/");
    cookie(response, SESSION_COOKIE, 0);
    cookie(response, statusName, 0);
    cookie(response, expiredName, 0);
  };
  const logoutAcrossOwners = async (bearer, statusKey, logoutFlag, callbackFlag) => {
    for (const pair of [bearer, statusKey]) await status(pair, true, logoutFlag);
    const logout = await post("/logout", { flag: logoutFlag, cookies: `${bearer}; ${statusKey}` });
    owns(logout, 303, logoutFlag === "true");
    clear(logout);
    // Resend the original cookies to the issuer. Deletion headers alone
    // would not prove that the shared session was revoked.
    for (const pair of [bearer, statusKey]) await status(pair, false, callbackFlag);
  };
  await logoutAcrossOwners(bearer, statusKey, "true", "false");
  await status(first, true);
  await status(sibling, true);
  const outage = await post("/logout/everywhere", {
    cookies: sibling,
    headers: { accept: "text/html", "x-fixture-revoke-outage": "1" },
  });
  owns(outage, 503, true);
  assert.match(outage.headers.get("content-type") ?? "", /text\/html/i);
  assert.equal(outage.headers.has("set-cookie"), false);
  await status(sibling, true);
  const all = await post("/logout/everywhere", { cookies: sibling });
  owns(all, 303, true);
  clear(all);
  assert.equal(hits(all, "logout"), 3);
  await status(first, false, "false");
  await status(sibling, false, "false");
  await status(other, true);

  // Complete the reverse flip with a real Kit-issued session and then use
  // Hono to revoke it. Replay the original Hono state before signing out.
  const reverse = await start("false");
  const reverseQuery = new URLSearchParams({ state: reverse.state, code: "fixture-code" });
  const kitSignIn = await request(`${callback}?${reverseQuery}`, { cookies: reverse.cookies });
  owns(kitSignIn, 302, true);
  assert.equal(location(kitSignIn), "/events");
  cookie(kitSignIn, stateName, 0);
  cookie(kitSignIn, nextName, 0);
  assert.equal(exchanges(kitSignIn), reverse.exchanges + 1);
  const honoReplay = await request(`${callback}?${reverseQuery}`, {
    flag: "false",
    cookies: reverse.cookies,
  });
  owns(honoReplay, 302, false);
  assert.equal(location(honoReplay), "/?n=signin_failed");
  assert.equal(honoReplay.headers.has("set-cookie"), false);
  assert.equal(honoReplay.headers.has("x-fixture-issued"), false);
  assert.equal(exchanges(honoReplay), exchanges(kitSignIn));
  await logoutAcrossOwners(
    cookie(kitSignIn, SESSION_COOKIE, 7200),
    cookie(kitSignIn, statusName, 7200),
    "false",
    "true",
  );
  console.log("PASS signed session and one-shot OAuth continuity across both auth owner flips");

  if (browser) {
    await assertNoJavaScript(origin);
    console.log(
      "PASS Kit auth native sign-in, sign-out and Join recovery with JavaScript disabled",
    );
  }

  const spent = await post("/logout", {
    flag: "false",
    headers: { "x-fixture-fill-logout-budget": "1", accept: "application/json" },
  });
  const limited = await post("/logout/everywhere", { headers: { accept: "application/json" } });
  owns(spent, 429, false);
  owns(limited, 429, true);
  assert.equal(limited.headers.get("retry-after"), "30");
  assert.equal(limited.headers.has("set-cookie"), false);
  assert.deepEqual(await limited.json(), await spent.json());
  await assertJoinParity(origin, secret, request, hits, location);
  await assertQaParity(request, post, hits);
  console.log(
    "PASS Kit auth ownership, OAuth handoff and replay, session status and logout refusals",
  );
}

async function assertJoinParity(origin, secret, request, hits, location) {
  const overlong = "x".repeat(OAUTH_CODE_STATE_MAX_LENGTH + 1);
  for (const [method, path] of [
    ["POST", joinStart],
    ["GET", `${joinCallback}/?code=${overlong}`],
    ["GET", `/join/%63allback?code=${overlong}`],
    ["GET", `${joinCallback}/__data.json`],
  ]) {
    const init = { method, headers: { origin } };
    const hono = await request(path, { ...init, flag: "false" });
    const enabled = await request(path, init);
    owns(enabled, hono.status, false);
    assert.equal(location(enabled)?.split("?")[0], location(hono)?.split("?")[0]);
    assert.equal(enabled.headers.has("set-cookie"), false);
  }
  const production = await request(`${joinCallback}?code=${overlong}`, {
    flag: "unset",
    headers: { "x-fixture-auth-app": "production" },
  });
  owns(production, 200, false);
  assert.equal(production.headers.has("set-cookie"), false);
  for (const flag of ["unset", "true"]) {
    const document = await request(`/join?${joinQuery}`, { flag });
    owns(document, 200, true);
    assert.match(await document.text(), /data-testid="join-oneclick"/);
  }
  const foreign = await request(joinStart, { headers: { "x-fixture-foreign-host": "1" } });
  owns(foreign, 404, false);
  assert.equal(foreign.headers.has("set-cookie"), false);
  const head = await request(joinCallback, { method: "HEAD" });
  owns(head, 200, true);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.has("set-cookie"), false);

  let last;
  for (const flag of ["unset", "true"]) {
    const start = await request(`${joinStart}?${joinQuery}`, { flag });
    owns(start, 302, flag === "true");
    assert.equal(start.headers.get("cache-control"), "no-store, private");
    const authorize = new URL(location(start));
    assert.equal(authorize.origin + authorize.pathname, "https://discord.com/oauth2/authorize");
    assert.equal(authorize.searchParams.get("redirect_uri"), origin + joinCallback);
    assert.equal(authorize.searchParams.get("scope"), "identify guilds.join");
    const state = authorize.searchParams.get("state");
    const values = [
      [joinStateName, state],
      [joinNextName, "/events"],
      [joinSourceName, "fixture"],
    ];
    const jar = [];
    for (const [name, value] of values) {
      const pair = cookie(start, name, 600);
      assert.equal(await verifySignedCookie(pair.slice(name.length + 1), secret), value);
      jar.push(pair);
    }
    const cookies = jar.join("; ");
    const callbackUrl = `${joinCallback}?${new URLSearchParams({ state, code: "fixture-code" })}`;
    const oversized = await request(
      `${joinCallback}?${new URLSearchParams({
        state,
        code: overlong,
      })}`,
      { cookies },
    );
    owns(oversized, 200, true);
    assert.equal(oversized.headers.has("set-cookie"), false);
    assert.equal(hits(oversized, "join"), hits(start, "join"));
    assert.match(await oversized.text(), /Join link expired/);
    const response = await request(callbackUrl, {
      flag: flag === "true" ? "false" : "true",
      cookies,
    });
    owns(response, 302, flag !== "true");
    assert.equal(location(response), "/events");
    assert.equal(hits(response, "join"), hits(start, "join") + 1);
    for (const [name] of values) cookie(response, name, 0);
    cookie(response, SESSION_COOKIE, 7200);
    cookie(response, statusName, 7200);
    cookie(response, "__Host-two_join_result", 600);
    assert.equal(
      Number(response.headers.get("x-fixture-exchanges")),
      Number(start.headers.get("x-fixture-exchanges")) + 1,
    );
    assert.equal(
      Number(response.headers.get("x-fixture-join-attempts")),
      Number(start.headers.get("x-fixture-join-attempts")) + 1,
    );
    last = { callbackUrl, cookies, response };
  }
  const replay = await request(last.callbackUrl, { cookies: last.cookies });
  owns(replay, 200, true);
  assert.equal(replay.headers.get("cache-control"), "no-store, private");
  assert.equal(replay.headers.has("set-cookie"), false);
  assert.equal(
    replay.headers.get("x-fixture-exchanges"),
    last.response.headers.get("x-fixture-exchanges"),
  );
  assert.equal(
    replay.headers.get("x-fixture-join-attempts"),
    last.response.headers.get("x-fixture-join-attempts"),
  );
  assert.match(await replay.text(), /data-testid="recovery-retry"/);
  console.log("PASS Kit Join OAuth ownership, signed cookies, cross-owner handoff and replay");
}

async function assertQaParity(request, post, hits) {
  const qa = "/auth/qa/qa-member";
  const credential = "synthetic-qa-proof".repeat(2);
  const qaHeaders = {
    origin: STAGING_APP_URL,
    "x-fixture-auth-app": "staging",
    "x-fixture-qa-config": credential,
    [QA_HEADER]: credential,
  };
  const unknown = await post("/auth/qa/unknown", { headers: qaHeaders });
  owns(unknown, 404, true);
  const refusal = await unknown.text();
  const production = { "x-fixture-auth-app": "production", origin: `https://${PRODUCTION_APEX}` };
  for (const [flag, headers, status, kit] of [
    ["true", { [QA_HEADER]: "wrong" }, 404, true],
    ["true", { [QA_HEADER]: "" }, 404, true],
    ["true", { "x-fixture-qa-config": "" }, 404, true],
    ["false", { [QA_HEADER]: "wrong" }, 404, false],
    ["true", production, 404, false],
    ["false", production, 404, false],
    ["true", { "x-fixture-foreign-host": "1" }, 404, false],
    [
      "true",
      { origin: "https://foreign.example.test", "sec-fetch-site": "same-origin" },
      403,
      true,
    ],
  ]) {
    const response = await post(qa, { flag, headers: { ...qaHeaders, ...headers } });
    owns(response, status, kit);
    if (status === 404) assert.equal(await response.text(), refusal);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(response.headers.has("x-fixture-issued"), false);
    assert.equal(hits(response, "qa-login"), 0);
  }
  for (const [method, path] of [
    ["GET", qa],
    ["HEAD", qa],
    ["POST", `${qa}/`],
    ["POST", `${qa}/__data.json`],
    ["POST", "/auth/qa/%71a-member"],
  ]) {
    const headers = { ...qaHeaders, [QA_HEADER]: "wrong" };
    const direct = await request(path, { method, headers, flag: "unset" });
    const enabled = await request(path, { method, headers });
    owns(enabled, direct.status, false);
    assert.equal(enabled.headers.has("set-cookie"), false);
    assert.equal(hits(enabled, "qa-login"), 0);
  }
  const oversized = await post(qa, { headers: qaHeaders, body: "x".repeat(4097) });
  owns(oversized, 413, true);
  assert.equal(hits(oversized, "qa-login"), 0);
  assert.equal(oversized.headers.has("set-cookie"), false);
  for (const [path, flag, issued, count] of [
    [qa, "unset", "900000000000001396:true:false", 1],
    ["/auth/qa/qa-moderator", "true", "900000000000001397:true:true", 2],
  ]) {
    const response = await post(path, { flag, headers: qaHeaders });
    owns(response, 204, flag === "true");
    assert.equal(response.headers.get("x-fixture-issued"), issued);
    assert.equal(hits(response, "qa-login"), count);
    const bearer = cookie(response, SESSION_COOKIE, 7200);
    cookie(response, statusName, 7200);
    assert.equal(await response.text(), "");
    const status = await request("/auth/status", {
      cookies: bearer,
      flag: "false",
      headers: qaHeaders,
    });
    assert.deepEqual(await status.json(), { authenticated: true });
  }
  console.log("PASS Kit staging QA ownership, guarded session issuance and production refusal");
}
