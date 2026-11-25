import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { chromium, expect } from "@playwright/test";
import postgres from "postgres";
import { fixtureSession } from "../kit-live-socket.mjs";
import { SESSION_COOKIE } from "../parity/fixture.mjs";

// Backends see the same synthetic cutover identity, so neither branch can
// fall through to preview ownership. Chromium stays on one loopback origin.
export const EMBER_FIXTURE_ORIGIN = "https://two-web-kit-cutover-proof-1-1.fixture.workers.dev";
export const EMBER_FIXTURE_GUILD = "900000000000001373";
const viewerId = "900000000000001374";
const viewer = "Synthetic Ember Viewer";
const documents = new Set(["/", "/events", "/join", "/members"]);
const joinPath = "/join?next=%2Fevents";

export function prepareEmberCutoverFixture(entry, worker) {
  return writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import worker from ${JSON.stringify(worker)};

// Reuse the parity fixture's upstream seams with an empty synthetic schedule
// and a disabled widget. No upstream HTTP transport is available to the Worker.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method === "GET" &&
      request.url === "https://discord.com/api/v10/guilds/${EMBER_FIXTURE_GUILD}/widget.json")
    return new Response(null, { status: 404 });
  throw new Error("Unexpected upstream request in the Ember cutover fixture");
};
const calendar = { upcoming: async () => [], lastReadFailed: () => false };

export default {
  fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    const url = new URL(env.APP_URL);
    url.pathname = incoming.pathname;
    url.search = incoming.search;
    const navigation = new Request(url, request);
    navigation.headers.set("host", url.host);
    const bindings = { ...env, DISCORD_EVENTS: calendar };
    return withEnv(bindings, () => worker.fetch(navigation, bindings, ctx));
  },
};\n`,
  );
}

// Forward native HTTP headers without fetch() rewriting Sec-Fetch-Mode.
// Playwright request interception would disable Chromium's HTTP cache.
async function startBrowserProxy(kitOrigin) {
  let origin;
  let backend = kitOrigin;
  let eventReads = 0;
  const server = createServer((incoming, outgoing) => {
    const url = URL.parse(incoming.url, origin);
    const document = incoming.headers["sec-fetch-dest"] === "document";
    if (
      url?.origin !== origin ||
      incoming.method !== "GET" ||
      !(document ? documents.has(url.pathname) : /\.(?:css|svg|ico|png|woff2)$/.test(url.pathname))
    ) {
      outgoing.writeHead(403).end();
      return;
    }
    if (document && url.pathname === "/events") eventReads++;

    const target = new URL(backend);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = { ...incoming.headers, host: target.host };
    delete headers.connection;
    const upstream = request(target, { headers }, (response) => {
      if (response.headers.location) {
        // Never deliver a redirect that Chromium could follow to a new host.
        response.destroy();
        outgoing.writeHead(502).end();
        return;
      }
      const headers = { ...response.headers };
      delete headers.connection;
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      outgoing.writeHead(response.statusCode, headers);
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.setTimeout(10_000, () => upstream.destroy(new Error("Worker response timed out")));
    upstream.on("error", () => {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end();
    });
    outgoing.on("close", () => upstream.destroy());
    upstream.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    get eventReads() {
      return eventReads;
    },
    switchBackend(next) {
      backend = next;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function assertDocument(page, response, path, renderer, status = 200) {
  assert.ok(response, `missing navigation response for ${path}`);
  assert.equal(response.status(), status, path);
  assert.equal(await response.headerValue("x-two-renderer"), renderer, path);
  assert.match((await response.headerValue("content-type")) ?? "", /^text\/html\b/i, path);
  await expect(page).toHaveURL(path);
}

async function follow(page, link, path, renderer) {
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  assert.ok(href, `missing link to ${path}`);
  const target = new URL(path, page.url()).href;
  assert.equal(new URL(href, page.url()).href, target);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => response.request().isNavigationRequest() && response.url() === target,
    ),
    link.click(),
  ]);
  await assertDocument(page, response, path, renderer);
  return response;
}

async function assertEventsAudience(page, response, signedIn) {
  const cache = await response.headerValue("cache-control");
  if (signedIn) {
    assert.equal(cache, "private, no-store");
  } else {
    assert.match(cache ?? "", /^public, max-age=(?:[1-9]|[1-5]\d|60)$/);
    assert.equal(await response.headerValue("set-cookie"), null, "guest Events sets no cookie");
    assert.ok(!(await response.text()).includes(viewer), "guest Events does not expose the viewer");
  }
  const vary = (await response.headerValue("vary")) ?? "";
  assert.ok(
    vary
      .toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .includes("cookie"),
  );
  const account = page.getByRole("navigation", { name: "Account" });
  await expect(account.getByText(viewer, { exact: true })).toHaveCount(Number(signedIn));
  if (signedIn) await expect(account.getByRole("button", { name: "Sign out" })).toBeVisible();
  else await expect(account.getByRole("link", { name: "Sign in with Discord" })).toBeVisible();
}

function openEvents(page, renderer) {
  return follow(
    page,
    page.getByRole("banner").getByRole("link", { name: "Events", exact: true }),
    "/events",
    renderer,
  );
}

async function guestJourney(page, renderer) {
  await assertDocument(page, await page.goto("/"), "/", renderer);
  await expect(page.locator("h1#home-heading")).toBeVisible();
  const events = await openEvents(page, renderer);
  await expect(page.locator("h1#events-heading")).toBeVisible();
  await assertEventsAudience(page, events, false);
  await follow(
    page,
    page.locator(".schedule-heading").getByRole("link", { name: "Join the Discord", exact: true }),
    joinPath,
    renderer,
  );
  await expect(page.locator("h1#join-heading")).toBeVisible();
  const action = page.getByTestId("join-oneclick");
  await expect(action).toBeVisible();
  await expect(action).toHaveJSProperty(
    "href",
    new URL("/join/discord?next=%2Fevents", page.url()).href,
  );
  if (renderer === "kit")
    await expect(page.getByRole("heading", { name: "Join with one sign-in" })).toBeVisible();

  const directory = await page.goto("/members");
  await assertDocument(page, directory, "/members", null, 404);
  assert.equal(await directory.headerValue("set-cookie"), null, "/members sets no cookie");
  await expect(page.getByRole("heading", { name: "We cannot find that page" })).toBeVisible();
  await follow(page, page.getByTestId("error-home"), "/", renderer);
}

export async function verifyEmberCutoverJourney({
  kitOrigin,
  fallbackOrigin,
  databaseUrl,
  secret,
}) {
  const { ref, cookie } = await fixtureSession(secret);
  const proxy = await startBrowserProxy(kitOrigin);
  let browser;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    browser = await chromium.launch({
      args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
      // Route all browser traffic to the loopback listener. It permits only
      // fixture document and asset GETs and rejects CONNECT.
      proxy: { server: proxy.origin, bypass: "<-loopback>" },
    });
    const options = {
      baseURL: proxy.origin,
      javaScriptEnabled: false,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
    };
    const context = await browser.newContext(options);
    context.setDefaultTimeout(10_000);

    const page = await context.newPage();
    await guestJourney(page, "kit");
    console.log(
      "PASS installed Ember browser: Home to Events to Join and frozen directory recovery",
    );
    const warmReads = proxy.eventReads;
    assert.equal(warmReads, 1, "guest Events reached the installed Worker once");
    await assertEventsAudience(page, await openEvents(page, "kit"), false);
    assert.equal(proxy.eventReads, warmReads, "Chromium reused the cached guest Events document");
    await page.goto("/");

    // A signed-in non-member exposes a synthetic account label on both
    // renderers without adding a user or membership row.
    await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, expires_at, roles_checked_at)
      values (${ref}, ${ref}, ${viewerId}, ${viewer}, false, now() + interval '1 hour', now())`;
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: cookie.slice(SESSION_COOKIE.length + 1),
        domain: new URL(proxy.origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const signedKit = await openEvents(page, "kit");
    await assertEventsAudience(page, signedKit, true);
    assert.equal(proxy.eventReads, warmReads + 1, "session bypassed Chromium's guest cache");

    proxy.switchBackend(fallbackOrigin);
    const signedHono = await page.reload();
    await assertDocument(page, signedHono, "/events", null);
    await assertEventsAudience(page, signedHono, true);
    assert.equal(proxy.eventReads, warmReads + 2, "signed-in refresh reached Hono");
    await context.close();
    // A still-fresh public Kit document is eligible for reuse. A fresh guest
    // context proves the Hono documents independently of that cached entry.
    const guest = await browser.newContext(options);
    guest.setDefaultTimeout(10_000);
    await guestJourney(await guest.newPage(), null);
    console.log("PASS flag-off Hono browser fallback: same links and frozen directory recovery");
    console.log(
      "PASS cutover Events cache boundary: Chromium reused guest HTML; a session bypassed it and stayed private across fallback",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await proxy.close();
      } finally {
        try {
          await sql`delete from web_session_grace where status_hash = ${ref}`;
          await sql`delete from web_sessions where status_hash = ${ref}`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    }
  }
}
