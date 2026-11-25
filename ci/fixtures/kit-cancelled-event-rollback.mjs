import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { unstable_dev } from "wrangler";
import { PRODUCTION_APEX } from "../../src/http/robots.ts";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";
import { prepareInstalledKitWorker } from "../kit-worker-installed-output.mjs";
import { requireDisposableDatabase } from "../parity/record.mjs";
import {
  parseRenderedPage,
  renderedAttribute,
  renderedElements,
  renderedText,
} from "../rendered-page.mjs";

const repo = resolve(import.meta.dirname, "../..");
const loopback = "http://127.0.0.1";
const apex = `https://${PRODUCTION_APEX}`;
const cancelledTitle = "Synthetic cancelled tabletop night";
const key = (n) => `01J0000000000000000000C10${n}`;
const path = `/e/${key(0)}`;
const upcoming = ["Synthetic tabletop A", "Synthetic tabletop B", "Synthetic tabletop C"];
const game = "Synthetic cancelled tabletop fixture";
const clientIp = "192.0.2.162";

function getDocument(worker, pathname, headers = {}) {
  return worker.fetch(pathname, {
    headers: { accept: "text/html", ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

async function assertCancelledPage(worker, renderer, name) {
  const response = await getDocument(worker, path, { "if-none-match": "*" });
  const html = parseRenderedPage(await response.text());
  assert.equal(response.status, 410, name);
  assert.equal(response.headers.get("x-two-renderer"), renderer, `${name}: renderer`);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/, name);
  assert.equal(response.headers.get("cache-control"), "private, no-store", name);
  assert.equal(response.headers.get("etag"), null, name);
  assert.deepEqual(response.headers.getSetCookie(), [], `${name}: no cookie effects`);
  // Preview policy supplies this header on loopback. On the apex it must
  // come from the cancellation handler itself.
  if (renderer === null) {
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", name);
    assert.match(response.headers.get("vary") ?? "", /(?:^|,\s*)cookie(?:,|$)/i, name);
  }
  const robots = [...renderedElements(html, { tag: "meta" })]
    .filter((meta) => renderedAttribute(meta, "name") === "robots")
    .map((meta) => renderedAttribute(meta, "content"));
  assert.deepEqual(robots, ["noindex, nofollow"], `${name}: cancellation robots metadata`);
  const marked = (tag, id) =>
    [...renderedElements(html, { tag })].filter(
      (element) => renderedAttribute(element, "data-testid") === id,
    );
  assert.deepEqual(
    [...renderedElements(html, { tag: "h1" })].map(renderedText),
    [cancelledTitle],
    name,
  );
  assert.deepEqual(marked("p", "event-cancelled").map(renderedText), ["Cancelled"], name);
  assert.equal(
    marked("section", "event-cancelled-record").length,
    renderer === "kit" ? 1 : 0,
    name,
  );
  const lists = marked("ul", "event-cancelled-alternatives");
  assert.equal(lists.length, 1, `${name}: alternatives list`);
  const links = [...renderedElements(lists[0], { tag: "a" })].map((link) => [
    renderedAttribute(link, "href"),
    renderedText(link),
  ]);
  assert.deepEqual(
    links,
    upcoming.map((title, i) => [`/e/${key(i + 1)}`, title]),
    name,
  );
  console.log(`PASS ${name}: cancelled event 410, no-store and eligible upcoming links`);
}

async function checkWorker(
  scratch,
  databaseUrl,
  { name, main, assets, appUrl, vars, renderer, expectEmber },
) {
  const entry = join(scratch, `${name}.mjs`);
  // Preserve the synthetic document authority while transport stays on loopback.
  // PostgreSQL is the only allowed network dependency for these renders.
  await writeFile(
    entry,
    `import "./block-outbound.mjs";
import worker from ${JSON.stringify(main)};
export default { fetch(request, env, context) {
  const url = new URL(env.APP_URL);
  url.pathname = new URL(request.url).pathname;
  const document = new Request(url, request);
  document.headers.set("host", url.host);
  document.headers.set("cf-connecting-ip", ${JSON.stringify(clientIp)});
  document.headers.set("sec-fetch-mode", "navigate");
  document.headers.set("sec-fetch-dest", "document");
  return worker.fetch(document, env, context);
} };
`,
  );
  const config = join(scratch, `${name}.jsonc`);
  await writeFile(
    config,
    JSON.stringify({
      name,
      main: entry,
      compatibility_date: "2026-09-29",
      compatibility_flags: ["nodejs_compat"],
      assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
      vars: { APP_URL: appUrl, DATABASE_URL: databaseUrl, ...vars },
    }),
  );
  const worker = await unstable_dev(entry, {
    config,
    ip: "127.0.0.1",
    local: true,
    persist: false,
    logLevel: "error",
    experimental: { disableDevRegistry: true },
  });
  try {
    if (expectEmber) {
      // Cancelled detail is Hono-owned even with Ember off. A single Join
      // document distinguishes the active profile without a browser journey.
      const joinPage = await getDocument(worker, "/join");
      await joinPage.body?.cancel();
      assert.equal(joinPage.status, 200, `${name}: Ember Join status`);
      assert.equal(joinPage.headers.get("x-two-renderer"), "kit", `${name}: Ember is active`);
    }
    await assertCancelledPage(worker, renderer, name);
  } finally {
    await worker.stop();
  }
}

const fixtureDatabase = process.env.KIT_WORKER_TEST_DATABASE_URL;
assert.ok(
  fixtureDatabase,
  "KIT_WORKER_TEST_DATABASE_URL must name the disposable fixture database",
);
const databaseUrl = requireDisposableDatabase(fixtureDatabase).href;
const { worker, assets } = await prepareInstalledKitWorker(repo);
const scratch = await mkdtemp(join(process.env.XFS_FIXTURE_ROOT, "cancelled-event-"));
const sql = postgres(databaseUrl, { max: 1 });
let inserted = [];
try {
  // This first dependency runs before either Worker module is evaluated.
  await writeFile(
    join(scratch, "block-outbound.mjs"),
    'globalThis.fetch = () => { throw new Error("Cancelled event fixture blocks outbound fetch"); };\n',
  );
  const rows = [
    [cancelledTitle, "cancelled", "2090-01-01"],
    ...upcoming.map((title, i) => [title, "published", `2090-01-0${i + 3}`]),
    ["Synthetic unpublished night", "draft", "2090-01-02"],
    ["Synthetic ended night", "published", "2020-01-01"],
  ].map(([title, status, date], i) => ({
    event_key: key(i),
    title,
    status,
    game,
    timezone: "UTC",
    starts_at: `${date}T18:00:00Z`,
    ends_at: `${date}T20:00:00Z`,
  }));
  inserted = await sql`insert into events ${sql(rows)} returning id`;

  // The deployed Ember profile still delegates detail. The existing loopback
  // override additionally exercises the native Kit EventGone through the facade.
  for (const target of [
    {
      name: "ember-cancelled-detail",
      main: worker,
      assets,
      appUrl: apex,
      vars: EMBER_CUTOVER_VARS,
      renderer: null,
      expectEmber: true,
    },
    {
      name: "kit-cancelled-detail",
      main: worker,
      assets,
      appUrl: loopback,
      vars: { KIT_PARITY_FIXTURE_EVENT_DETAIL: "true" },
      renderer: "kit",
    },
    {
      name: "hono-cancelled-fallback",
      main: join(repo, "src/worker.ts"),
      assets: join(repo, "public"),
      appUrl: apex,
      renderer: null,
    },
  ]) {
    await checkWorker(scratch, databaseUrl, target);
  }
} finally {
  try {
    if (inserted.length) {
      await sql.begin(async (tx) => {
        await tx`delete from events where id in ${tx(inserted.map(({ id }) => id))}`;
        await tx`delete from web_throttle_hits where bucket = ${`events-read:${clientIp}`}`;
      });
    }
  } finally {
    await sql.end();
    await rm(scratch, { recursive: true, force: true });
  }
}
