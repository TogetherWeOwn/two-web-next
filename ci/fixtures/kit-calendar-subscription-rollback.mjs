import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";
import {
  parseRenderedPage,
  renderedAttribute,
  renderedElements,
  renderedText,
} from "../rendered-page.mjs";

const appUrl = new URL("https://two-web-kit-cutover-proof-1-1.calendar-fixture.workers.dev");
const feedCache = "max-age=300, public";

export async function assertCalendarSubscriptionRollback({ event, scratch, worker, startKit }) {
  const entry = join(scratch, "kit-calendar-rollback.mjs");
  await writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import worker from ${JSON.stringify(worker)};

globalThis.fetch = async () => { throw new Error("Unexpected calendar fixture upstream fetch"); };
const calendar = { upcoming: async () => [], lastReadFailed: () => false };

export default {
  fetch(request, env, context) {
    const incoming = new URL(request.url);
    const url = new URL(env.APP_URL);
    url.pathname = incoming.pathname;
    url.search = incoming.search;
    const local = new Request(url, request);
    local.headers.set("host", url.host);
    if (url.pathname === "/events") {
      local.headers.set("sec-fetch-mode", "navigate");
      local.headers.set("sec-fetch-dest", "document");
    }
    const rollback = local.headers.get("x-fixture-calendar-rollback") === "true";
    local.headers.delete("x-fixture-calendar-rollback");
    const bindings = {
      ...env,
      DISCORD_EVENTS: calendar,
      KIT_ROUTE_EMBER_PAGES: rollback ? "false" : env.KIT_ROUTE_EMBER_PAGES,
    };
    return withEnv(bindings, () => worker.fetch(local, bindings, context));
  },
};\n`,
  );
  const { origin } = await startKit(
    "kit-calendar-rollback",
    { ...EMBER_CUTOVER_VARS, APP_URL: appUrl.origin },
    entry,
  );
  const search = new URLSearchParams({ game: event.game });
  // Map the saved HTTPS authority onto the loopback Worker without following redirects.
  const get = (url, headers) =>
    fetch(`${origin}${url.pathname}${url.search}`, {
      headers: {
        "cf-connecting-ip": event.clientIp,
        "x-forwarded-for": event.clientIp,
        ...headers,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

  const scheduleUrl = new URL(`/events?${search}`, appUrl);
  const member = { cookie: event.cookie };
  const ember = await get(scheduleUrl, member);
  assert.equal(ember.status, 200, "Ember schedule");
  assert.equal(ember.headers.get("x-two-renderer"), "kit", "Ember owns the schedule");
  assert.equal(ember.headers.get("cache-control"), "private, no-store");
  assert.match(ember.headers.get("vary") ?? "", /(?:^|,\s*)cookie(?:,|$)/i);
  const document = parseRenderedPage(await ember.text());
  const account = [...renderedElements(document, { tag: "nav" })].find(
    (nav) => renderedAttribute(nav, "aria-label") === "Account",
  );
  assert.ok(account && renderedText(account).includes("Open Discord"), "member schedule");
  const links = [...renderedElements(document, { tag: "a" })]
    .filter((link) => renderedAttribute(link, "data-testid") === "events-subscribe")
    .map((link) => renderedAttribute(link, "href"));
  assert.equal(links.length, 1, "one rendered subscription link");
  const [href] = links;
  assert.equal(href, `webcal://${appUrl.host}/events.ics?${search}`, "scoped public link");
  const saved = new URL(href.replace(/^webcal:/, "https:"));

  async function readFeed(headers) {
    const response = await get(saved, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-two-renderer"), null, "feed remains Hono-owned");
    assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(response.headers.get("content-disposition"), 'inline; filename="events.ics"');
    assert.equal(response.headers.get("cache-control"), feedCache);
    assert.equal(response.headers.get("set-cookie"), null);
    return { body: await response.text(), etag: response.headers.get("etag") };
  }

  const before = await readFeed(member);
  assert.match(before.etag ?? "", /^"[a-f0-9]{64}"$/);
  assert.ok(before.body.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(before.body.endsWith("END:VCALENDAR\r\n"));
  const lines = before.body.replace(/\r\n[ \t]/g, "").split("\r\n");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("UID:")),
    [`UID:${event.key}@${appUrl.host}`],
  );
  assert.ok(lines.includes(`URL:${appUrl.origin}/e/${event.key}`));

  const rollback = { "x-fixture-calendar-rollback": "true" };
  const hono = await get(scheduleUrl, rollback);
  assert.equal(hono.status, 200, "Hono schedule after rollback");
  assert.equal(hono.headers.get("x-two-renderer"), null, "Hono owns the schedule after rollback");
  await hono.body?.cancel();

  assert.deepEqual(await readFeed(rollback), before, "anonymous rollback feed matches member read");
  const cached = await get(saved, { ...rollback, "if-none-match": before.etag });
  assert.equal(cached.status, 304, "pre-rollback validator still matches the saved URL");
  assert.equal(cached.headers.get("etag"), before.etag);
  assert.equal(cached.headers.get("cache-control"), feedCache);
  assert.equal(cached.headers.get("content-type"), null);
  assert.equal(cached.headers.get("content-disposition"), null);
  assert.equal(cached.headers.get("set-cookie"), null);
  assert.equal(await cached.text(), "");
  console.log(
    "PASS installed Ember subscription URL retains the same public feed after Hono rollback",
  );
}
