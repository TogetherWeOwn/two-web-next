// Local-only real browser proof. No database, remote bindings or Discord traffic.
// Routing/cookie APIs: https://playwright.dev/docs/network
// https://playwright.dev/docs/api/class-browsercontext#browser-context-add-cookies
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const directory = await mkdtemp(join(tmpdir(), "auth-browser-"));
const originalFetch = globalThis.fetch;
let browser;
let server;
let release;
try {
  await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
  const output = join(directory, "fixture.mjs");
  await build({
    entryPoints: ["test/fixtures/session-recovery.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const { recoveryFixture, fixtureDiscord, MEMBER } = await import(pathToFileURL(output).href);
  const f = recoveryFixture();
  globalThis.fetch = fixtureDiscord;
  let holdHome = false;
  let held;
  let heldResolve;
  let statusCalls = 0;
  let patchCalls = 0;
  // Generated test-only loopback certificate; never trusts a remote environment.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    async (req, res) => {
      try {
        const path = new URL(req.url, f.env.APP_URL).pathname;
        if (/^\/islands\/[a-z-]+\.js$/.test(path) || /^\/[a-z.-]+\.css$/.test(path)) {
          const body = await readFile(resolve("public", path.slice(1)));
          res.writeHead(200, {
            "content-type": path.endsWith(".js") ? "text/javascript" : "text/css",
          });
          return res.end(body);
        }
        if (path === "/auth/status") statusCalls++;
        if (req.method === "PATCH") patchCalls++;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const response = await f.request(req.url, {
          method: req.method,
          headers: req.headers,
          ...(body ? { body } : {}),
        });
        const destination = response.headers.get("location");
        if (destination && new URL(destination, f.env.APP_URL).origin !== f.env.APP_URL) {
          // Defense in depth: no external redirect ever reaches a browser request.
          // Only the non-following local API fetch below can inspect the OAuth 302.
          assert.equal(path, "/auth/discord");
          assert.equal(req.headers["x-fixture-stopped-redirect"], "1");
        }
        // Application rotation has committed, but no HTTP headers/cookie delivered yet.
        if (path === "/" && holdHome) {
          holdHome = false;
          heldResolve();
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        res.statusCode = response.status;
        for (const [name, value] of response.headers)
          if (name !== "set-cookie") res.setHeader(name, value);
        if (response.headers.getSetCookie().length)
          res.setHeader("set-cookie", response.headers.getSetCookie());
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end("Local fixture failure");
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  f.env.APP_URL = `https://localhost:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: true });
  context.setDefaultTimeout(8000);
  context.setDefaultNavigationTimeout(12000);
  const forbidden = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    // Playwright routes intercept only the first URL in a redirect chain.
    // Stop the local OAuth start's 302 before the browser can follow it externally.
    if (url.origin === f.env.APP_URL && url.pathname === "/auth/discord") {
      const response = await route.fetch({
        maxRedirects: 0,
        headers: { ...route.request().headers(), "x-fixture-stopped-redirect": "1" },
      });
      assert.equal(response.status(), 302);
      const authorize = new URL(response.headers().location);
      assert.equal(authorize.origin + authorize.pathname, "https://discord.com/oauth2/authorize");
      const callback = new URL("/auth/discord/callback", f.env.APP_URL);
      callback.searchParams.set("state", authorize.searchParams.get("state"));
      callback.searchParams.set("code", "fixture-code");
      return route.fulfill({
        response,
        status: 200,
        contentType: "text/html",
        body: `<html lang="en"><title>Mock authorization</title><a href="${callback.href.replaceAll("&", "&amp;")}">Complete mocked authorization</a></html>`,
      });
    }
    if (url.origin === f.env.APP_URL) return route.continue();
    forbidden.push(url.origin + url.pathname);
    return route.abort();
  });
  async function login() {
    const result = await f.login();
    const equals = result.cookie.indexOf("=");
    await context.addCookies([
      {
        name: result.cookie.slice(0, equals),
        value: result.cookie.slice(equals + 1),
        url: f.env.APP_URL,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    return result;
  }
  const a = await context.newPage();
  const b = await context.newPage();
  const errors = [];
  for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
  const url = (path) => f.env.APP_URL + path;

  // Two tabs share genuine signed Secure/__Host cookies on the loopback runtime.
  const initial = await login();
  await a.goto(url("/"));
  await b.goto(url("/"));
  await b.waitForFunction(() => !!window.TwoAuth);
  assert.equal(await b.locator('[data-testid="auth-tab-sync"]').count(), 1);
  assert.equal(await b.evaluate(() => window.TwoAuth.check()), true);
  assert.ok(
    (await context.cookies()).some(
      (c) => c.name === "__Host-two_session_status" && c.secure && c.httpOnly,
    ),
  );
  for (const mock of [
    { status: 503, contentType: "application/json", body: '{"authenticated":false}' },
    {
      status: 200,
      contentType: "application/json",
      body: '{"authenticated":false,"user":"forbidden"}',
    },
    { status: 200, contentType: "application/json", body: "not-json" },
  ]) {
    await b.route("**/auth/status", (route) => route.fulfill(mock));
    assert.equal(await b.evaluate(() => window.TwoAuth.check()), null);
    assert.equal(await b.locator('form[action="/logout"]').count(), 1);
    await b.unroute("**/auth/status");
  }
  await b.route("**/auth/status", (route) => route.abort());
  assert.equal(await b.evaluate(() => window.TwoAuth.check()), null);
  await b.unroute("**/auth/status");
  console.log("PASS outages, network failure and malformed status cannot assert logout");

  // Focus/visibility bursts coalesce and storage fallback always rechecks authority.
  const beforeBurst = statusCalls;
  await b.evaluate(() => {
    for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await b.waitForTimeout(1250);
  assert.ok(statusCalls - beforeBurst <= 2);
  assert.ok(statusCalls > beforeBurst);

  held = new Promise((resolve) => {
    heldResolve = resolve;
  });
  holdHome = true;
  const navigation = a.goto(url("/"));
  let heldTimer;
  try {
    await Promise.race([
      held,
      new Promise((_, reject) => {
        heldTimer = setTimeout(
          () => reject(new Error("Rotation response was not held within 8s")),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(heldTimer);
  }
  try {
    assert.equal(await f.sessions.get(initial.tokenHash), null);
    assert.equal(await b.evaluate(() => window.TwoAuth.check()), true);
    assert.equal(await b.locator('form[action="/logout"]').count(), 1);
  } finally {
    release();
    release = null;
  }
  await navigation;
  console.log("PASS two-tab delayed rotation-cookie probe: no false logout, no old-token grace");

  // Refused logout keeps the editor and its in-memory draft; retry is explicit.
  await a.goto(url("/profile?edit=1"));
  await a.waitForFunction(() => !!window.TwoAuth);
  await a.evaluate(() => {
    window.logoutNotifications = 0;
    const original = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message) {
      if (message === "recheck") window.logoutNotifications++;
      return original.call(this, message);
    };
  });
  const logoutForm = a.getByTestId("profile-signout");
  const logoutButton = logoutForm.getByRole("button", { name: "Sign out", exact: true });
  let refusedLogoutPosts = 0;
  for (const width of [360, 1280]) {
    await a.setViewportSize({ width, height: 900 });
    for (const failure of [429, 503, "network"]) {
      let releaseLogout;
      let intercepted;
      const requested = new Promise((resolve) => {
        intercepted = resolve;
      });
      await a.route("**/logout", async (route) => {
        assert.equal(route.request().method(), "POST");
        refusedLogoutPosts++;
        await new Promise((resolve) => {
          releaseLogout = resolve;
          intercepted();
        });
        if (failure === "network") return route.abort();
        return route.fulfill({ status: failure, body: "Local refused logout" });
      });
      try {
        const draft = `Unsaved logout draft ${width}/${failure}`;
        await a.getByRole("textbox", { name: /^Bio\b/ }).fill(draft);
        await a.getByRole("textbox", { name: /^Games\b/ }).fill("Go\nChess");
        await a.getByLabel("Timezone", { exact: true }).fill("UTC");
        const before = refusedLogoutPosts;
        await logoutButton.click();
        await requested;
        assert.equal(await logoutButton.isDisabled(), true);
        assert.equal(await logoutForm.getAttribute("aria-busy"), "true");
        assert.equal(await a.getByTestId("logout-error").count(), 0);
        await logoutForm.evaluate((form) => {
          for (let i = 0; i < 3; i++) form.requestSubmit();
        });
        assert.equal(refusedLogoutPosts - before, 1);
        releaseLogout();
        const failureNotice = a.getByTestId("logout-error");
        await failureNotice.waitFor();
        assert.equal(await failureNotice.getAttribute("role"), "alert");
        assert.equal(await failureNotice.evaluate((el) => el === document.activeElement), true);
        assert.match(await failureNotice.innerText(), /try again/i);
        assert.equal(await logoutButton.isDisabled(), false);
        assert.equal(await logoutForm.getAttribute("aria-busy"), null);
        assert.equal(a.url(), url("/profile?edit=1"));
        assert.equal(await a.getByRole("textbox", { name: /^Bio\b/ }).inputValue(), draft);
        assert.equal(await a.getByRole("textbox", { name: /^Games\b/ }).inputValue(), "Go\nChess");
        assert.equal(await a.getByLabel("Timezone", { exact: true }).inputValue(), "UTC");
        assert.equal(await a.evaluate(() => window.TwoAuth.check()), true);
        assert.equal(await a.evaluate(() => window.logoutNotifications), 0);
        assert.equal(refusedLogoutPosts - before, 1);
        assert.equal(f.state.writes, 0);
        assert.equal(f.profiles.rows.get(MEMBER).bio, "Accepted bio");
        assert.equal(
          await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        assert.equal((await new AxeBuilder({ page: a }).analyze()).violations.length, 0);
        await mkdir(resolve("artifacts/session-recovery"), { recursive: true });
        await a.screenshot({
          path: `artifacts/session-recovery/logout-${failure}-${width}.png`,
          fullPage: true,
        });
      } finally {
        releaseLogout?.();
        await a.unrouteAll({ behavior: "wait" });
      }
    }
  }
  console.log(
    "PASS refused/network logout draft retention, accessible explicit retry and no duplicates",
  );

  // Successful retry from the editor still revokes the session and notifies the other tab.
  await logoutButton.focus();
  await a.keyboard.press("Enter");
  await a.waitForURL(url("/"));
  await b.waitForFunction(
    () => !window.TwoAuth && !!document.querySelector('a[href="/auth/discord"]'),
  );
  assert.equal(await b.locator('form[action="/logout"]').count(), 0);
  console.log("PASS two-tab logout synchronization to guest render");

  // A failed expired save preserves all three draft fields; no automatic/double retry.
  const expired = await login();
  const profileResponse = await a.goto(url("/profile?edit=1"));
  assert.equal(profileResponse.status(), 200);
  assert.equal(a.url(), url("/profile?edit=1"), await a.locator("body").innerText());
  assert.equal(await a.locator('[name="bio"]').count(), 1, await a.locator("body").innerText());
  await a.getByRole("textbox", { name: /^Bio\b/ }).fill("Unsaved draft");
  await a.getByRole("textbox", { name: /^Games\b/ }).fill("Go\nChess");
  await a.getByLabel("Timezone", { exact: true }).fill("UTC");
  const row = await f.sessions.get(expired.tokenHash);
  await f.sessions.create({ ...row, tokenHash: expired.tokenHash, expiresAt: new Date(0) });
  const beforePatch = patchCalls;
  await a.getByRole("button", { name: "Save", exact: true }).click();
  const notice = a.getByTestId("profile-session-expired");
  await notice.waitFor();
  assert.equal(await notice.getAttribute("role"), "alert");
  assert.equal(await notice.evaluate((el) => el === document.activeElement), true);
  assert.equal(await a.getByRole("textbox", { name: /^Bio\b/ }).inputValue(), "Unsaved draft");
  assert.equal(await a.getByRole("textbox", { name: /^Games\b/ }).inputValue(), "Go\nChess");
  assert.equal(await a.getByLabel("Timezone", { exact: true }).inputValue(), "UTC");
  await mkdir(resolve("artifacts/session-recovery"), { recursive: true });
  await a.screenshot({ path: "artifacts/session-recovery/expired-draft.png", fullPage: true });
  await a.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(patchCalls - beforePatch, 1);
  assert.equal(f.state.writes, 0);
  assert.equal(f.profiles.rows.get(MEMBER).bio, "Accepted bio");
  await a.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await notice.count(), 0);
  assert.equal(await a.getByRole("textbox", { name: /^Bio\b/ }).inputValue(), "Accepted bio");
  assert.equal(await a.getByRole("textbox", { name: /^Games\b/ }).inputValue(), "Chess");
  assert.equal(await a.getByLabel("Timezone", { exact: true }).inputValue(), "Europe/London");
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await notice.waitFor();
  console.log("PASS expired save draft retention, explicit reset and no duplicate retry");

  const link = notice.getByRole("link", { name: "Log in with Discord" });
  assert.equal(await link.getAttribute("href"), "/auth/recover?next=%2Fprofile%3Fedit%3D1");
  await link.focus();
  assert.equal(await link.evaluate((el) => el === document.activeElement), true);
  await a.keyboard.press("Enter");
  await a.waitForURL(url("/auth/recover?next=%2Fprofile%3Fedit%3D1"));
  assert.equal((await new AxeBuilder({ page: a }).analyze()).violations.length, 0);
  const retry = a.getByTestId("recovery-retry");
  await retry.focus();
  await a.keyboard.press("Enter");
  await a.getByRole("link", { name: "Complete mocked authorization" }).click();
  await a.waitForURL(url("/profile?edit=1"));
  await a.getByTestId("auth-error").waitFor();
  assert.equal(await a.getByTestId("auth-error").getAttribute("role"), "status");
  await a.screenshot({ path: "artifacts/session-recovery/post-login-banner.png", fullPage: true });
  assert.equal(await a.getByRole("textbox", { name: /^Bio\b/ }).inputValue(), "Accepted bio");
  await a.reload();
  assert.equal(await a.getByTestId("auth-error").count(), 0);
  assert.equal(f.state.writes, 0);
  console.log(
    "PASS keyboard-accessible recovery, mocked OAuth original-page return and one-shot banner",
  );

  // Revoked profile tab vetoes a background navigation and keeps its draft reachable.
  const revoked = await login();
  await b.goto(url("/profile"));
  await b.getByRole("textbox", { name: /^Bio\b/ }).fill("Revoked-tab draft");
  await f.sessions.revoke(revoked.tokenHash);
  await b.bringToFront();
  await b.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await b.getByTestId("profile-session-expired").waitFor();
  assert.equal(await b.evaluate(() => window.TwoAuth.check()), false);
  assert.equal(await b.getByRole("textbox", { name: /^Bio\b/ }).inputValue(), "Revoked-tab draft");
  assert.equal(b.url(), url("/profile"));
  console.log("PASS revoked profile focus/visibility veto preserves in-memory fields");

  // Exercise the cross-tab storage transport with BroadcastChannel unavailable.
  for (const page of [a, b])
    await page.addInitScript(() => {
      window.BroadcastChannel = undefined;
    });
  await login();
  await a.goto(url("/"));
  await b.goto(url("/profile"));
  await b.getByRole("textbox", { name: /^Bio\b/ }).fill("Storage fallback draft");
  const beforeFallback = statusCalls;
  await a.locator('form[action="/logout"] button').click();
  await b.getByTestId("profile-session-expired").waitFor();
  assert.equal(
    await b.getByRole("textbox", { name: /^Bio\b/ }).inputValue(),
    "Storage fallback draft",
  );
  assert.ok(statusCalls > beforeFallback);
  assert.match(await b.evaluate(() => localStorage.getItem("two:auth-recheck")), /^\d+$/);
  assert.equal(f.state.writes, 0);
  console.log("PASS bounded cross-tab storage fallback with draft-preserving expiry");
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
  await writeFile(
    "artifacts/session-recovery/result.json",
    JSON.stringify(
      {
        result: "PASS",
        runtime: "local HTTPS loopback",
        outbound: "mocked OAuth; external redirects blocked",
        checks: [
          "non-authoritative errors",
          "rotation-cookie race",
          "refused/network logout draft retention and accessible retry at 360/1280",
          "no duplicate logout or failure notification to other tabs",
          "successful editor logout retry and broadcast logout",
          "expired draft and explicit reset",
          "keyboard recovery and one-shot banner",
          "focus/visibility revocation",
          "storage fallback",
        ],
        unauthorizedWrites: f.state.writes,
      },
      null,
      2,
    ) + "\n",
  );
  await context.close();
} finally {
  release?.();
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
