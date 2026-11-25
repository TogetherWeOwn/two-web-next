import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import postgres from "postgres";
import { fixtureSession } from "../kit-live-socket.mjs";
import { SESSION_COOKIE } from "../parity/fixture.mjs";

// The browser sees the same HTTPS origin before and after the fixture switch.
// Only the loopback transport changes. The cutover guard recognizes this
// synthetic identity, so neither branch can fall through to preview ownership.
export const EMBER_FIXTURE_ORIGIN = "https://two-web-kit-cutover-proof-1-1.fixture.workers.dev";
export const EMBER_FIXTURE_GUILD = "900000000000001373";
const viewerId = "900000000000001374";
const viewer = "Synthetic Ember Viewer";
const documents = new Set(["/", "/events", "/join", "/members"]);
const assets = new Set(["font", "image", "stylesheet"]);
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

async function assertDocument(page, response, path, renderer, status = 200) {
  assert.ok(response, `missing navigation response for ${path}`);
  assert.equal(response.status(), status, path);
  assert.equal(await response.headerValue("x-two-renderer"), renderer, path);
  assert.match((await response.headerValue("content-type")) ?? "", /^text\/html\b/i, path);
  await expect(page).toHaveURL(EMBER_FIXTURE_ORIGIN + path);
}

async function follow(page, link, path, renderer) {
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  assert.ok(href, `missing link to ${path}`);
  assert.equal(new URL(href, page.url()).href, EMBER_FIXTURE_ORIGIN + path);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() && response.url() === EMBER_FIXTURE_ORIGIN + path,
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

async function guestJourney(page, renderer) {
  await assertDocument(page, await page.goto(EMBER_FIXTURE_ORIGIN), "/", renderer);
  await expect(page.locator("h1#home-heading")).toBeVisible();
  const events = await follow(
    page,
    page.getByRole("banner").getByRole("link", { name: "Events", exact: true }),
    "/events",
    renderer,
  );
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
    EMBER_FIXTURE_ORIGIN + "/join/discord?next=%2Fevents",
  );
  if (renderer === "kit")
    await expect(page.getByRole("heading", { name: "Join with one sign-in" })).toBeVisible();

  const directory = await page.goto(EMBER_FIXTURE_ORIGIN + "/members");
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
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
    });
    context.setDefaultTimeout(10_000);
    let backend = kitOrigin;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin !== EMBER_FIXTURE_ORIGIN ||
        request.method() !== "GET" ||
        !(request.isNavigationRequest()
          ? documents.has(url.pathname)
          : assets.has(request.resourceType()) && /\.(?:css|svg|ico|png|woff2)$/.test(url.pathname))
      ) {
        await route.abort("blockedbyclient");
        return;
      }
      // Set path and query on a fixed loopback origin, even if the path starts
      // with two slashes. Preserve browser Fetch Metadata and the local cookie.
      const target = new URL(backend);
      target.pathname = url.pathname;
      target.search = url.search;
      const headers = await request.allHeaders();
      delete headers.host;
      const response = await route.fetch({
        url: target.href,
        headers,
        maxRedirects: 0,
        timeout: 10_000,
      });
      try {
        // Playwright does not intercept every hop. Never follow a Worker redirect.
        if (response.headers().location) await route.abort("blockedbyclient");
        else await route.fulfill({ response });
      } finally {
        await response.dispose();
      }
    });

    const page = await context.newPage();
    await guestJourney(page, "kit");
    console.log(
      "PASS installed Ember browser: Home to Events to Join and frozen directory recovery",
    );

    // A signed-in non-member exposes a synthetic account label on both
    // renderers without adding a user or membership row.
    await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, expires_at, roles_checked_at)
      values (${ref}, ${ref}, ${viewerId}, ${viewer}, false, now() + interval '1 hour', now())`;
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: cookie.slice(SESSION_COOKIE.length + 1),
        url: EMBER_FIXTURE_ORIGIN + "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const signedKit = await page.goto(EMBER_FIXTURE_ORIGIN + "/events");
    await assertDocument(page, signedKit, "/events", "kit");
    await assertEventsAudience(page, signedKit, true);

    backend = fallbackOrigin;
    const signedHono = await page.reload();
    await assertDocument(page, signedHono, "/events", null);
    await assertEventsAudience(page, signedHono, true);
    await context.clearCookies();
    await guestJourney(page, null);
    console.log("PASS flag-off Hono browser fallback: same links and frozen directory recovery");
    console.log(
      "PASS cutover Events cache boundary: guest varies on Cookie; signed-in reads stay private across fallback",
    );
  } finally {
    try {
      await browser.close();
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
