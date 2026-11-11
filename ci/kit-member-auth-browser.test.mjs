// Local Chromium acceptance, no DB or live auth. Run:
// node --import tsx --test ci/kit-member-auth-browser.test.mjs
// The combined implementation must wire this command into browser-enabled CI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, after, describe, test } from "node:test";
import { chromium } from "playwright";
import {
  BOARD,
  SELF,
  OTHER_PROFILE,
  kitMemberAuthFixture,
  memberAuthRenderers,
  restoredWriteCookie,
} from "../test/fixtures/kit-member-auth.ts";

let browser;
let render;
let scratch;
const evidence =
  process.env.KIT_MEMBER_AUTH_EVIDENCE_DIR ??
  (process.env.CI ? "artifacts/a11y/restored-write" : undefined);
const T0 = Date.UTC(2030, 0, 1);
before(async () => {
  scratch = await mkdtemp(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "kit-member-browser-",
    ),
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(scratch, "key.pem"),
      "-out",
      join(scratch, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  render = await memberAuthRenderers();
  // Trust only this fixture's ephemeral certificate so Chromium can exercise
  // its real HTTP cache, rather than disabling caching for a TLS error.
  const cert = new X509Certificate(await readFile(join(scratch, "cert.pem")));
  const spki = createHash("sha256")
    .update(cert.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  browser = await chromium.launch({
    headless: true,
    args: [
      `--ignore-certificate-errors-spki-list=${spki}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
    ],
  });
  if (evidence) await mkdir(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  render?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

// Instrumentation observes the real controller. It never installs TwoAuth or
// adds a controller tag to a document whose renderer omitted it.
const trace = () => {
  window.authTrace = { broadcasts: [], logoutPosts: 0, statusRequests: [] };
  if (window.BroadcastChannel) {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (value) {
      window.authTrace.broadcasts.push(value);
      sessionStorage.setItem(
        "auth-published",
        String(Number(sessionStorage.getItem("auth-published") || 0) + 1),
      );
      return post.call(this, value);
    };
  }
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (this === localStorage && key === "two:auth-recheck")
      setItem.call(
        sessionStorage,
        "auth-published",
        String(Number(sessionStorage.getItem("auth-published") || 0) + 1),
      );
    return setItem.call(this, key, value);
  };
  const original = window.fetch;
  window.fetch = function (input, init) {
    if (input === "/auth/status")
      window.authTrace.statusRequests.push({
        method: init?.method ?? "GET",
        body: init?.body ?? null,
      });
    if (input === "/logout") window.authTrace.logoutPosts++;
    return original.call(this, input, init);
  };
};

async function fixture(t, mode = "kit", storage = false, httpCache = false) {
  const f = kitMemberAuthFixture(render);
  const requests = [];
  const forbidden = [];
  const errors = [];
  const server = createServer(
    {
      key: await readFile(join(scratch, "key.pem")),
      cert: await readFile(join(scratch, "cert.pem")),
    },
    async (req, res) => {
      try {
        const url = new URL(req.url, f.env.APP_URL);
        if (
          /^\/islands\/[a-z-]+\.js$/.test(url.pathname) ||
          /^\/[a-z.-]+\.css$/.test(url.pathname) ||
          /^\/fonts\/[a-z0-9-]+\.woff2$/.test(url.pathname) ||
          url.pathname === "/logo.svg"
        ) {
          const body = await readFile(resolve("public", url.pathname.slice(1)));
          res.writeHead(200, {
            "content-type": url.pathname.endsWith(".js")
              ? "text/javascript"
              : url.pathname.endsWith(".woff2")
                ? "font/woff2"
                : url.pathname === "/logo.svg"
                  ? "image/svg+xml"
                  : "text/css",
          });
          return res.end(body);
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const path = url.pathname;
        let response;
        if (path === "/")
          response = new Response(
            "<!doctype html><title>Signed out destination</title><h1>Home</h1>",
            { headers: { "content-type": "text/html" } },
          );
        else if (path === "/auth/discord")
          // The guest bounce is observable, but no OAuth provider is contacted.
          response = new Response(
            "<!doctype html><title>Mock sign-in boundary</title><h1>Explicit sign-in required</h1>",
            { headers: { "content-type": "text/html" } },
          );
        else if (
          ["/auth/status", "/logout", "/auth/recover"].includes(path) ||
          path === "/profile" ||
          (mode === "kit" && (path === "/about" || path === "/faq")) ||
          path.startsWith("/members/") ||
          (mode === "kit" && path === BOARD)
        ) {
          response = await (mode === "reference" ? f.referenceRequest : f.request)(req.url, {
            method: req.method,
            headers: req.headers,
            ...(body ? { body } : {}),
          });
        } else {
          forbidden.push(path);
          response = new Response("Fixture refuses outbound navigation", { status: 404 });
        }
        requests.push({
          path,
          method: req.method,
          body,
          status: response.status,
          cookies: response.headers.getSetCookie(),
        });
        res.statusCode = response.status;
        for (const [name, value] of response.headers)
          if (name !== "set-cookie") res.setHeader(name, value);
        if (response.headers.getSetCookie().length)
          res.setHeader("set-cookie", response.headers.getSetCookie());
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        errors.push(error.message);
        res.writeHead(500);
        res.end("Fixture failure");
      }
    },
  );
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  f.env.APP_URL = `https://localhost:${server.address().port}`;
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
  context.setDefaultTimeout(5000);
  t.after(async () => {
    await context.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    assert.deepEqual(forbidden, [], "no live OAuth or unmodelled request is allowed");
    assert.deepEqual(errors, [], "fixture and page JavaScript must execute without errors");
  });
  // Playwright disables the HTTP cache while any route is installed, so the
  // warm-cache cases observe outbound requests instead of intercepting them.
  if (httpCache)
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== f.env.APP_URL) forbidden.push(url.origin + url.pathname);
    });
  else
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === f.env.APP_URL) return route.continue();
      forbidden.push(url.origin + url.pathname);
      return route.abort();
    });
  if (storage)
    await context.addInitScript(() => {
      window.BroadcastChannel = undefined;
    });
  await context.addInitScript(trace);
  const login = await f.login();
  const lineage = await f.sessions.statusHash(login.tokenHash);
  const equals = login.cookie.indexOf("=");
  await context.addCookies([
    {
      name: login.cookie.slice(0, equals),
      value: login.cookie.slice(equals + 1),
      url: f.env.APP_URL,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  async function page(path) {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: T0 });
    await page.goto(f.env.APP_URL + path);
    await page.clock.pauseAt(T0 + 1000);
    return page;
  }
  return { ...f, context, page, requests, lineage, mode };
}

async function mounted(page) {
  assert.equal(
    await page.locator('script[src="/islands/auth-status.js"]').count(),
    1,
    "real member SSR must supply exactly one controller",
  );
  assert.equal(
    await page.evaluate(() => typeof window.TwoAuth?.check),
    "function",
    "the shipped controller must execute",
  );
}
async function draft(page) {
  await page.getByRole("textbox", { name: /^Bio\b/ }).fill("Unsent member draft");
  await page.getByRole("textbox", { name: /^Games\b/ }).fill("Chess\nGo");
  await page.getByLabel("Timezone", { exact: true }).fill("UTC");
}
async function retained(page) {
  assert.equal(
    await page.getByRole("textbox", { name: /^Bio\b/ }).inputValue(),
    "Unsent member draft",
  );
  assert.equal(await page.getByRole("textbox", { name: /^Games\b/ }).inputValue(), "Chess\nGo");
  assert.equal(await page.getByLabel("Timezone", { exact: true }).inputValue(), "UTC");
}
const submit = (page) =>
  page.evaluate(() => document.querySelector('form[action="/logout"]').requestSubmit());
async function feedback(page, id) {
  const alert = page.getByTestId(id);
  assert.equal(await alert.count(), 1);
  assert.equal(await alert.getAttribute("role"), "alert");
  assert.match(await alert.innerText(), /try again|not confirmed/i);
  assert.equal(await page.locator('form[action="/logout"]').getAttribute("aria-busy"), null);
  assert.equal(await page.locator('form[action="/logout"] [type="submit"]').isEnabled(), true);
  assert.equal(await alert.evaluate((node) => node === document.activeElement), true);
}
async function screenshots(page, prefix) {
  if (!evidence) return;
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: join(evidence, `${prefix}-${width}.png`), fullPage: true });
  }
}

const NOTICE =
  "You signed in again. Your earlier changes were not saved. Review and submit them again.";
async function restoredShot(page, state, width) {
  if (evidence)
    await page.screenshot({
      path: join(evidence, `restored-write-${state}-${width}.png`),
      fullPage: true,
    });
}

// Named suite: the executed-count verifier admits only cases under this title.
describe("Kit member auth in Chromium", () => {
  for (const path of [BOARD, SELF, OTHER_PROFILE]) {
    test(`Kit ${path} emits and executes the single shipped controller`, async (t) => {
      const f = await fixture(t);
      const page = await f.page(path);
      if (path === SELF) await screenshots(page, "kit-baseline-self");
      await mounted(page);
      assert.equal(await page.evaluate(() => window.TwoAuth.check()), true);
      assert.equal(
        (await f.context.cookies()).filter((cookie) => cookie.name === "__Host-two_session_status")
          .length,
        1,
      );
    });
  }

  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    test(`Kit restored-write notice appears once, first in main, then is consumed at ${width}x${height}`, async (t) => {
      const f = await fixture(t);
      const page = await f.page(SELF);
      await page.setViewportSize({ width, height });
      const notice = page.getByTestId("auth-error");
      const url = f.env.APP_URL + SELF;
      await page.goto(url);
      assert.equal(await notice.count(), 0, "a clean visit shows no notice");
      await restoredShot(page, "clean", width);
      const [name, ...rest] = (await restoredWriteCookie()).split("=");
      await f.context.addCookies([
        {
          name,
          value: rest.join("="),
          url: f.env.APP_URL,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const navigation = await page.goto(url);
      assert.equal(await notice.count(), 1);
      assert.equal(await notice.getAttribute("role"), "status");
      assert.equal(await notice.innerText(), NOTICE);
      assert.equal(
        await notice.evaluate((node) => node === document.querySelector("main").firstElementChild),
        true,
      );
      assert.ok(
        (await navigation.headerValues("set-cookie")).some(
          (c) => c.startsWith(`${name}=`) && /Max-Age=0/i.test(c),
        ),
        "the released document consumes the cookie",
      );
      await restoredShot(page, "notice", width);
      await page.goto(url);
      assert.equal(await notice.count(), 0, "the notice is shown once");
      assert.equal((await f.context.cookies()).filter((c) => c.name === name).length, 0);
      await restoredShot(page, "consumed", width);
    });
  }

  // Public leaves are cacheable for an hour. A warm clean copy must never hide
  // the notice, and a fetch that discards its shell must never consume it.
  async function warmPublic(t, path) {
    const f = await fixture(t, "kit", false, true);
    await f.context.clearCookies(); // a session cookie would make the page uncacheable
    const page = await f.page(path);
    const link = (to) =>
      Promise.all([
        page.waitForNavigation(),
        page.evaluate((href) => {
          const a = document.createElement("a");
          a.href = href;
          document.body.append(a);
          a.click();
        }, to),
      ]).then(([response]) => response);
    const seen = (p) => f.requests.filter((r) => r.path === p).length;
    return { f, page, link, seen };
  }
  const restore = async (f) => {
    const [name, ...rest] = (await restoredWriteCookie()).split("=");
    await f.context.addCookies([
      {
        name,
        value: rest.join("="),
        url: f.env.APP_URL,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    return name;
  };
  for (const path of ["/about", "/faq"]) {
    test(`Kit clean ${path} warms the public cache, then a restored cookie navigation shows the notice once`, async (t) => {
      const { f, page, link, seen } = await warmPublic(t, path);
      const other = path === "/about" ? "/faq" : "/about";
      assert.equal(seen(path), 1);
      await link(other);
      const warm = seen(path);
      await link(path);
      assert.equal(seen(path), warm, "the clean second visit is served from the warm cache");
      assert.equal(await page.getByTestId("auth-error").count(), 0);
      await link(other);
      const name = await restore(f);
      const navigation = await link(path);
      assert.equal(seen(path), warm + 1, "the server saw the cookie-bearing navigation");
      const headers = navigation.headers();
      assert.match(headers["cache-control"], /no-store/);
      assert.match(headers.vary, /cookie/i);
      assert.equal(await page.getByTestId("auth-error").count(), 1);
      assert.equal(await page.getByTestId("auth-error").innerText(), NOTICE);
      assert.ok(
        (await navigation.headerValues("set-cookie")).some(
          (c) => c.startsWith(`${name}=`) && /Max-Age=0/i.test(c),
        ),
      );
      await page.setViewportSize({ width: 1280, height: 800 });
      await restoredShot(page, `public${path.replace("/", "-")}-notice`, 1280);
      await page.setViewportSize({ width: 390, height: 844 });
      await restoredShot(page, `public${path.replace("/", "-")}-notice`, 390);
      await link(other);
      await link(path);
      assert.equal(await page.getByTestId("auth-error").count(), 0, "the notice is shown once");
    });
  }

  test("Kit shell-discarding fetch with a restored cookie gets no notice and leaves it pending", async (t) => {
    const { f, page, link } = await warmPublic(t, "/about");
    const name = await restore(f);
    const body = await page.evaluate(() =>
      fetch("/about", { headers: { accept: "text/html" } }).then((r) => r.text()),
    );
    assert.equal(body.includes('data-testid="auth-error"'), false);
    assert.equal((await f.context.cookies()).filter((c) => c.name === name).length, 1);
    await link("/about");
    assert.equal(await page.getByTestId("auth-error").count(), 1);
  });

  // The Hono cases are healthy controls, not substitute evidence for Kit. Both
  // modes execute the same minified bytes; Kit must obtain them from its own SSR.
  for (const mode of ["reference", "kit"]) {
    test(`${mode}: focus/visibility and two-tab messages recheck read-only; 503 never invents logout`, async (t) => {
      const f = await fixture(t, mode);
      const a = await f.page(SELF);
      const b = await f.page(mode === "kit" ? BOARD : OTHER_PROFILE);
      await mounted(a);
      await mounted(b);
      await draft(a);
      assert.equal(await a.evaluate(() => window.TwoAuth.check()), true);
      const before = f.requests.filter((r) => r.path === "/auth/status").length;
      const status = a.waitForResponse((r) => new URL(r.url()).pathname === "/auth/status");
      await a.evaluate(() => {
        for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await a.clock.runFor(1100);
      await status;
      const burst = f.requests.filter((r) => r.path === "/auth/status").length - before;
      assert.ok(burst >= 1 && burst <= 2, `coalesced focus/visibility burst sent ${burst} probes`);
      const received = a.waitForResponse((r) => new URL(r.url()).pathname === "/auth/status");
      await b.evaluate(() => window.TwoAuth.notify());
      await a.waitForFunction(() => window.authTrace.statusRequests.length >= 2);
      await a.clock.runFor(1100);
      await received;
      // A response event means headers arrived, not that the controller consumed JSON.
      // Drain its in-flight check before installing the next fault response.
      assert.equal(await a.evaluate(() => window.TwoAuth.check()), true);
      for (const reply of [
        { status: 503, body: '{"authenticated":false}' },
        { status: 401, body: '{"authenticated":false}' },
        { status: 200, body: '{"authenticated":false,"extra":true}' },
        { status: 200, body: "not-json" },
      ]) {
        await a.route("**/auth/status", (route) =>
          route.fulfill({ ...reply, contentType: "application/json" }),
        );
        assert.equal(await a.evaluate(() => window.TwoAuth.check()), null);
        await a.unroute("**/auth/status");
        assert.equal(await a.getByTestId("profile-session-expired").count(), 0);
        await retained(a);
      }
      for (const request of f.requests.filter((r) => r.path === "/auth/status")) {
        assert.equal(request.method, "GET");
        assert.equal(request.body, "");
        assert.deepEqual(request.cookies, []);
      }
      assert.equal(f.profileState.writes, 0);
    });

    test(`${mode}: real revocation recovers the board/other tab but a dirty self draft vetoes replacement`, async (t) => {
      const f = await fixture(t, mode);
      const a = await f.page(SELF);
      const b = await f.page(mode === "kit" ? BOARD : OTHER_PROFILE);
      await mounted(a);
      await mounted(b);
      await draft(a);
      await f.sessions.revokeLineage(f.lineage);
      assert.equal(await a.evaluate(() => window.TwoAuth.check()), false);
      assert.equal(await a.getByTestId("profile-session-expired").count(), 1);
      assert.equal(new URL(a.url()).pathname, "/profile");
      await retained(a);
      await b.evaluate(() => {
        window.expiryCount = 0;
        window.addEventListener("two:session-expired", () => {
          window.expiryCount++;
          sessionStorage.setItem("expiry-seen", "yes");
        });
      });
      const navigation = b.waitForNavigation();
      await b.evaluate(() => {
        void window.TwoAuth.check();
      });
      await navigation;
      assert.equal(await b.evaluate(() => sessionStorage.getItem("expiry-seen")), "yes");
      assert.equal(await b.locator('form[action="/logout"]').count(), 0);
      assert.equal(f.profileState.writes, 0);
    });

    test(`${mode}: actual expiry is a recovery decision, not an outage or silent draft replacement`, async (t) => {
      const f = await fixture(t, mode);
      const page = await f.page(SELF);
      await mounted(page);
      await draft(page);
      f.clock.offset = 7_200_001;
      assert.equal(await page.evaluate(() => window.TwoAuth.check()), false);
      assert.equal(await page.getByTestId("profile-session-expired").count(), 1);
      await retained(page);
      assert.equal(new URL(page.url()).pathname, "/profile");
      assert.equal(f.profileState.writes, 0);
      f.clock.offset = 0;
    });

    test(`${mode}: successful logout broadcasts once and navigates; storage fallback rechecks a dirty peer`, async (t) => {
      for (const storage of [false, true]) {
        const f = await fixture(t, mode, storage);
        const a = await f.page(SELF);
        const b = await f.page(SELF);
        await mounted(a);
        await mounted(b);
        await draft(b);
        const before = f.requests.filter((r) => r.path === "/auth/status").length;
        await submit(a);
        await a.waitForURL(f.env.APP_URL + "/");
        const logout = f.requests.filter((r) => r.path === "/logout");
        assert.equal(logout.length, 1);
        assert.equal(logout[0].status, 303);
        await b.clock.runFor(1100);
        await b.waitForFunction(
          () => !!document.querySelector('[data-testid="profile-session-expired"]'),
        );
        await retained(b);
        assert.ok(f.requests.filter((r) => r.path === "/auth/status").length > before);
        assert.equal(await f.sessions.isActive(f.lineage), false);
        assert.equal(await a.evaluate(() => sessionStorage.getItem("auth-published")), "1");
      }
    });

    test(`${mode}: refused/uncertain/body-hung logout preserves drafts and never publishes success`, async (t) => {
      const f = await fixture(t, mode);
      const page = await f.page(SELF);
      await mounted(page);
      await draft(page);
      for (const outcome of [429, 503, 200, "body-hang", "network"]) {
        await page.evaluate((outcome) => {
          const original = window.fetch;
          window.restoreLogout = () => {
            window.fetch = original;
          };
          window.fetch = function (input, init) {
            if (input !== "/logout") return original.call(this, input, init);
            if (outcome === "network")
              return Promise.reject(new TypeError("fixture network failure"));
            if (outcome === "body-hang")
              return Promise.resolve(
                new Response(new ReadableStream({ start() {} }), { status: 200 }),
              );
            return Promise.resolve(new Response(null, { status: outcome }));
          };
        }, outcome);
        await submit(page);
        await page.waitForFunction(() => !!document.querySelector('[data-testid="logout-error"]'));
        await feedback(page, "logout-error");
        await retained(page);
        assert.equal(new URL(page.url()).pathname, "/profile");
        assert.deepEqual(await page.evaluate(() => window.authTrace.broadcasts), []);
        await page.evaluate(() => window.restoreLogout());
      }
      await screenshots(page, `${mode}-logout-refused`);
    });

    test(`${mode}: header hang settles at 10 seconds, deduplicates submits and ignores late success`, async (t) => {
      const f = await fixture(t, mode);
      const page = await f.page(SELF);
      await mounted(page);
      await draft(page);
      await page.evaluate(() => {
        const original = window.fetch;
        window.fetch = function (input, init) {
          if (input !== "/logout") return original.call(this, input, init);
          window.authTrace.logoutPosts++;
          return new Promise((done) => {
            window.releaseLogout = () => done(new Response(null, { status: 303 }));
          });
        };
      });
      await submit(page);
      await page.clock.runFor(9000);
      assert.equal(await page.locator('form[action="/logout"]').getAttribute("aria-busy"), "true");
      assert.equal(await page.getByTestId("logout-unconfirmed").count(), 0);
      await submit(page);
      await submit(page);
      assert.equal(await page.evaluate(() => window.authTrace.logoutPosts), 1);
      await page.clock.runFor(1000);
      await feedback(page, "logout-unconfirmed");
      await retained(page);
      assert.deepEqual(await page.evaluate(() => window.authTrace.broadcasts), []);
      await page.evaluate(() => window.releaseLogout());
      await page.clock.runFor(1000);
      assert.equal(new URL(page.url()).pathname, "/profile");
      await feedback(page, "logout-unconfirmed");
      await retained(page);
      assert.deepEqual(await page.evaluate(() => window.authTrace.broadcasts), []);
      await screenshots(page, `${mode}-logout-unconfirmed`);
    });
  }
});
