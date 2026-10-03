// Local-only browser proof: production Worker entry with the existing Memory
// fixture, intercepted Discord, synthetic bindings and a runner-owned runtime.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, Response } from "miniflare";

const require = createRequire(
  process.env.AUTH_BROWSER_TOOLS_DIR
    ? resolve(process.env.AUTH_BROWSER_TOOLS_DIR, "package.json")
    : import.meta.url,
);
const { chromium } = require("playwright");
const output = process.env.AUTH_BROWSER_OUTPUT_DIR;
assert.ok(output, "Set AUTH_BROWSER_OUTPUT_DIR to a run-owned evidence directory");
await mkdir(output, { recursive: true });
let mf;
let browser;
const calls = [];
const unexpected = [];
const checks = [];
const secret = "test-session-signing-key-at-least-32-bytes";
let cleanupPromise;
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    try {
      await browser?.close();
    } finally {
      await mf?.dispose();
    }
  })());
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

try {
  const bundle = await build({
    entryPoints: ["test/fixtures/auth-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      https: true,
      host: "127.0.0.1",
      port: 0,
      compatibilityDate: "2026-09-29",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        APP_URL: "https://127.0.0.1",
        DISCORD_CLIENT_ID: "test-client",
        DISCORD_CLIENT_SECRET: "test-client-secret",
        DISCORD_GUILD_ID: "326474832151838730",
        DISCORD_BOT_TOKEN: "test-bot-token",
        DISCORD_INVITE_URL: "https://discord.gg/test-invite",
        DISCORD_MODERATOR_ROLE_IDS: "",
        SESSION_SECRET: secret,
      },
      outboundService: async (request) => {
        const url = new URL(request.url);
        if (url.origin === "https://discord.com") {
          const path = url.pathname;
          if (path === "/api/v10/oauth2/token" && request.method === "POST") {
            calls.push("exchange");
            return Response.json({ access_token: "test-member-token" });
          }
          if (
            path === "/api/v10/users/@me" &&
            request.headers.get("authorization") === "Bearer test-member-token"
          ) {
            calls.push("identity");
            return Response.json({
              id: "42",
              username: "test-handle",
              global_name: "Browser Member",
              avatar: null,
            });
          }
          if (
            path === "/api/v10/guilds/326474832151838730/members/42" &&
            request.method === "PUT" &&
            request.headers.get("authorization") === "Bot test-bot-token" &&
            (await request.text()) === JSON.stringify({ access_token: "test-member-token" })
          ) {
            calls.push("join");
            return new Response(null, { status: 204 });
          }
        }
        unexpected.push("Worker network request");
        throw new Error("Unmocked network request forbidden by auth browser fixture");
      },
    }),
  );
  const origin = (await mf.ready).origin;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1100, height: 800 },
  });
  let original;
  let deny = false;
  let authorizations = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      // Playwright does not route every redirected hop. Replace the application's
      // authorization Location with mocked consent BEFORE any off-loopback hop.
      const response = await route.fetch({ maxRedirects: 0 });
      const headers = response.headers();
      if (headers.location?.startsWith("https://discord.com/oauth2/authorize?")) {
        authorizations++;
        const authorization = new URL(headers.location);
        const callback = new URL(authorization.searchParams.get("redirect_uri"));
        assert.equal(callback.origin, "https://127.0.0.1");
        const issued = response
          .headersArray()
          .filter((h) => h.name.toLowerCase() === "set-cookie")
          .map(({ value }) => {
            const pair = value.split(";")[0];
            const split = pair.indexOf("=");
            assert.ok(
              value.includes("Secure") &&
                value.includes("HttpOnly") &&
                value.includes("SameSite=Lax"),
            );
            return {
              name: pair.slice(0, split),
              value: pair.slice(split + 1),
              domain: "127.0.0.1",
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "Lax",
            };
          });
        const issuedNames = new Set(issued.map((c) => c.name));
        original = {
          cookies: [
            ...(await context.cookies(origin)).filter((c) => !issuedNames.has(c.name)),
            ...issued,
          ],
          path: `${callback.pathname}?state=${authorization.searchParams.get("state")}`,
        };
        headers.location = `${origin}${original.path}${deny ? "&error=access_denied" : "&code=test-code"}`;
      }
      return route.fulfill({ response, headers });
    }
    unexpected.push("Browser off-origin request");
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.locator('a[href="/auth/discord"]').first().click();
  await page.waitForURL(`${origin}/?n=already_member`, { timeout: 5000 }).catch(async (error) => {
    console.log({
      landingPath: new URL(page.url()).pathname,
      authorizations,
      calls,
      cookies: original?.cookies.map(({ name, secure, httpOnly }) => ({ name, secure, httpOnly })),
      unexpected,
    });
    throw error;
  });
  assert.ok((await page.textContent("body")).includes("Browser Member"));
  assert.deepEqual(calls, ["exchange", "identity", "join"]);
  checks.push(
    "Real browser sign-in CTA completes mocked OAuth and renders an authenticated landing",
  );

  for (const [flow, start] of [
    ["auth", "/auth/discord"],
    ["join", "/join/discord"],
  ]) {
    // The preceding replay deliberately leaves a guest. Establish a live
    // browser session again before proving join's signed-in re-entry.
    if (flow === "join") {
      await page.goto(`${origin}/auth/discord`);
      assert.ok((await page.textContent("body")).includes("Browser Member"));
    }
    const prior = (await context.cookies(origin)).find((c) => c.name === "__Host-two_session");
    assert.ok(prior && prior.secure && prior.httpOnly && prior.sameSite === "Lax");
    const before = calls.length;
    await page.goto(`${origin}${start}`);
    assert.ok((await page.textContent("body")).includes("Browser Member"));
    assert.equal(calls.length - before, 3);
    await page.screenshot({ path: resolve(output, `${flow}-success.png`), fullPage: true });
    const stale = await browser.newContext({ ignoreHTTPSErrors: true });
    await stale.route("**/*", (r) =>
      new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
    );
    await stale.addCookies([prior]);
    const stalePage = await stale.newPage();
    await stalePage.goto(origin);
    assert.ok(!(await stalePage.textContent("body")).includes("Browser Member"));
    await stale.close();
    checks.push(`${flow}: fresh signed-in re-entry revokes the supplied prior browser session`);

    await context.clearCookies();
    await context.addCookies(original.cookies);
    const count = calls.length;
    await page.goto(`${origin}${original.path}&code=test-code`);
    assert.equal(calls.length, count);
    assert.ok(!(await page.textContent("body")).includes("Browser Member"));
    if (flow === "join") assert.ok((await page.textContent("body")).includes("Join link expired"));
    else assert.equal(new URL(page.url()).searchParams.get("n"), "signin_failed");
    checks.push(
      `${flow}: ORIGINAL signed-cookie replay makes no exchange/join and cannot authenticate`,
    );
    await page.screenshot({ path: resolve(output, `${flow}-replay.png`), fullPage: true });
  }
  deny = true;
  const count = calls.length;
  await page.goto(`${origin}/join/discord`);
  assert.ok((await page.textContent("body")).includes("Join cancelled"));
  assert.equal(calls.length, count);
  checks.push("Join consent denial renders recovery without an upstream exchange");
  assert.deepEqual(unexpected, []);
  const result = {
    checks,
    authorizations,
    mockedCalls: calls,
    unexpectedRequests: unexpected.length,
    runtime: "local HTTPS Miniflare, production Worker entry, fixture-only Memory store",
    persistence: "separate isolated agent-testdb request tests",
    screenshots: ["auth-success.png", "auth-replay.png", "join-success.png", "join-replay.png"],
  };
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await cleanup();
}
