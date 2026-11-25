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

const appUrl = "https://two-web-kit-cutover-proof-1-1.event-detail-fixture.workers.dev";

export async function assertEventDetailRollback({ scratch, kit, hono, startWorker, event }) {
  async function startProfile(name, { main, assets }, vars) {
    const entry = join(scratch, `${name}.mjs`);
    // Both Workers see the same HTTPS authority. All requests arrive on loopback.
    await writeFile(
      entry,
      `import worker from ${JSON.stringify(main)};
export default {
  fetch(request, env, context) {
    const incoming = new URL(request.url);
    const url = new URL(env.APP_URL);
    url.pathname = incoming.pathname;
    url.search = incoming.search;
    const document = new Request(url, request);
    document.headers.set("host", url.host);
    return worker.fetch(document, env, context);
  },
};\n`,
    );
    return startWorker(name, entry, assets, { ...vars, APP_URL: appUrl });
  }

  const [ember, rollback] = await Promise.all([
    startProfile("kit-ember-event-detail", kit, EMBER_CUTOVER_VARS),
    startProfile("hono-event-detail-rollback", hono, {}),
  ]);
  const path = `/e/${event.key}`;
  const query = "?archivePage=2&archiveQuery=Synthetic%20Markdown";
  const alias = `/e/${event.key.toLowerCase()}${query}`;
  assert.notEqual(alias, `${path}${query}`, "fixture key has a lower-case alias");

  for (const { name, origin } of [ember, rollback]) {
    async function get(path, status) {
      const label = `${name}: ${path}`;
      const response = await fetch(`${origin}${path}`, {
        headers: { ...event.headers, accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, status, label);
      // The shipped Ember profile delegates event detail to Hono.
      assert.equal(response.headers.get("x-two-renderer"), null, `${label}: Hono owns detail`);
      assert.equal(response.headers.get("cache-control"), "private, no-store", label);
      assert.match(response.headers.get("vary") ?? "", /(?:^|,\s*)cookie(?:,|$)/i, label);
      assert.equal(response.headers.get("etag"), null, label);
      return response;
    }

    const redirect = await get(alias, 301);
    const destination = redirect.headers.get("location");
    assert.equal(destination, `${path}${query}`, `${name}: canonical redirect preserves query`);
    await redirect.body?.cancel();

    const page = await get(destination, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html\b/, name);
    const html = parseRenderedPage(await page.text());
    const headings = [...renderedElements(html, { tag: "h1" })].map(renderedText);
    assert.deepEqual(headings, [event.title], `${name}: event title`);
    const canonical = [...renderedElements(html, { tag: "link" })]
      .filter((link) => renderedAttribute(link, "rel") === "canonical")
      .map((link) => renderedAttribute(link, "href"));
    assert.deepEqual(canonical, [`${appUrl}${path}`], `${name}: canonical detail URL`);
    const hasArchiveReturn = [...renderedElements(html, { tag: "a" })].some(
      (link) => renderedAttribute(link, "href") === "/events/past?page=2&q=Synthetic+Markdown",
    );
    assert.ok(hasArchiveReturn, `${name}: archive return preserves search and page`);
  }
  console.log(
    "PASS installed Ember and Hono rollback preserve the event detail deep link and cache policy",
  );
}
