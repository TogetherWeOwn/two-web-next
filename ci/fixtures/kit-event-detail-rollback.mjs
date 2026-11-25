import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";

// Match ISOLATED_CUTOVER_ORIGIN so the installed Worker uses the shipped profile.
const appUrl = "https://two-web-kit-cutover-proof-1-1.event-detail-fixture.workers.dev";

async function inPhase(reportPhase, phase, run) {
  reportPhase(phase, "start");
  try {
    const result = await run();
    reportPhase(phase, "complete");
    return result;
  } catch {
    // Lower-level failures can include a request URL, response body, or Worker output.
    throw new Error(`Event detail rollback phase failed: ${phase}`);
  }
}

function assertDetailHeaders(response, name) {
  const label = `${name}: event detail HTTP ${response.status}`;
  assert.equal(response.headers.get("x-two-renderer"), null, `${label}: Hono owns detail`);
  assert.equal(response.headers.get("cache-control"), "private, no-store", label);
  assert.match(response.headers.get("vary") ?? "", /(?:^|,\s*)cookie(?:,|$)/i, label);
  assert.equal(response.headers.get("etag"), null, label);
}

export async function assertEventDetailRollback({
  scratch,
  kit,
  hono,
  startWorker,
  waitForWorker,
  event,
  fetchPage = fetch,
}) {
  async function startProfile(name, { main, assets }, vars) {
    // The two profile names and each phase are fixed at the call sites.
    const reportPhase = (phase, state) =>
      console.log(`[event-detail-rollback] ${name} ${phase} ${state}`);
    const instance = await inPhase(reportPhase, "launch", async () => {
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
    // These requests stand in for top-level navigations through the loopback client.
    document.headers.set("sec-fetch-mode", "navigate");
    document.headers.set("sec-fetch-dest", "document");
    return worker.fetch(document, env, context);
  },
};\n`,
      );
      const worker = await startWorker(name, entry, assets, {
        ...vars,
        APP_URL: appUrl,
        // The Home renderer control uses the fallback and cannot refresh Discord events.
        DISCORD_GUILD_ID: "",
      });
      worker.reportPhase = reportPhase;
      return worker;
    });
    await inPhase(reportPhase, "readiness", () => waitForWorker(instance));
    return instance;
  }

  // Finish registering both Workers before the caller's shared teardown takes its snapshot.
  const profiles = await Promise.allSettled([
    startProfile("kit-ember-event-detail", kit, EMBER_CUTOVER_VARS),
    startProfile("hono-event-detail-rollback", hono, {}),
  ]);
  const [ember, rollback] = profiles.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  const path = `/e/${event.key}`;
  const query = "?archivePage=2&archiveQuery=Synthetic%20Markdown";
  const alias = `/e/${event.key.toLowerCase()}${query}`;
  assert.ok(alias !== `${path}${query}`, "fixture key has a lower-case alias");

  for (const [{ name, origin, reportPhase }, homeRenderer] of [
    [ember, "kit"],
    [rollback, null],
  ]) {
    async function get(target, status) {
      const response = await fetchPage(`${origin}${target}`, {
        headers: { ...event.headers, accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, status);
      return response;
    }

    // Detail is Hono-owned in both phases, so use Home to prove profile selection.
    await inPhase(reportPhase, "home-control", async () => {
      const home = await get("/", 200);
      assert.equal(home.headers.get("x-two-renderer"), homeRenderer, `${name}: Home renderer`);
      await home.body?.cancel();
    });

    const destination = await inPhase(reportPhase, "event-detail-redirect", async () => {
      const redirect = await get(alias, 301);
      const destination = redirect.headers.get("location");
      assert.equal(destination, `${path}${query}`, `${name}: canonical redirect preserves query`);
      await redirect.body?.cancel();
      assertDetailHeaders(redirect, name);
      return destination;
    });

    await inPhase(reportPhase, "event-detail-request", async () => {
      const page = await get(destination, 200);
      assertDetailHeaders(page, name);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html\b/, name);
      const body = await page.text();
      const { parseRenderedPage, renderedAttribute, renderedElements, renderedText } = await import(
        "../rendered-page.mjs"
      );
      const html = parseRenderedPage(body);
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
    });
  }
  console.log(
    "PASS installed Ember and Hono rollback preserve the event detail deep link and cache policy",
  );
}
