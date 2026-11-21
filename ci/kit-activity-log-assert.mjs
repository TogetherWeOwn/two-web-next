// Run from the pinned app checkout, only with the job-private Worker and Postgres.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chromium, errors } from "@playwright/test";
import postgres from "postgres";
import { requireGithubRunner, requireTestDatabase } from "../e2e/ci-only.mjs";
import { routeA11y, routeLighthouse } from "./kit-activity-log-metrics.mjs";
import * as visual from "./kit-activity-log-visual.mjs";

const { origin, path, browserWorkMs, withDeadline } = visual;

const cdpPort = 9222;
const mod = "900000000000009301";
const member = "900000000000009302";
const [a, b] = ["900000000000009311", "900000000000009312"];
function mark(next) {
  const file = `${process.env.TMPDIR}/browser-stage`;
  // The outer watchdog can stop us mid-write. Keep the last complete stage readable.
  writeFileSync(`${file}.next`, `${next}\n`, { mode: 0o600 });
  renameSync(`${file}.next`, file);
}
function ok(condition, label) {
  if (!condition) throw new visual.AssertionFailure(label);
}
const same = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label);
const desc = (from, to) =>
  Array.from({ length: from - to + 1 }, (_, k) => `kal-${String(from - k).padStart(3, "0")}`);

async function main() {
  requireGithubRunner();
  const database = requireTestDatabase(process.env.DATABASE_URL);
  mark("FIXTURE");
  const secret = readFileSync("ci/kit-worker-dev.mjs", "utf8").match(
    /SESSION_SECRET: "([^"]+)"/,
  )?.[1];
  ok(secret, "fixture-secret");
  const sql = postgres(database, { max: 1, connect_timeout: 5, onnotice: () => {} });
  let launched;
  const stop = new AbortController();
  const checkTime = () => {
    stop.signal.throwIfAborted();
    if (performance.now() >= browserWorkMs) throw new visual.BrowserDeadline();
  };
  const progress = (next) => {
    checkTime();
    mark(next);
  };
  async function exercise() {
    // Same DB-minted signed session as e2e/kit-parity/moderator-fixture.ts.
    async function mint(id, moderator) {
      const bearer = `two_${randomBytes(32).toString("base64url")}`;
      const hash = createHash("sha256").update(bearer).digest("hex");
      await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
        values (${hash}, ${hash}, ${id}, 'Synthetic Viewer', true, ${moderator}, now() + interval '15 minutes')`;
      return `${bearer}.${createHmac("sha256", secret).update(bearer).digest("base64")}`;
    }
    const cookie = "__Host-two_session";
    const moderatorToken = await mint(mod, true);
    const memberToken = await mint(member, false);
    const audits =
      () => sql`select viewer_discord_id as viewer, viewer_user_id as actor, resource, action, route,
      subject_user_ids as subjects, subject_count as n from member_data_access_logs order by id`;
    // Parameterize the table name so the observer query does not count itself.
    async function reads() {
      const [row] = await sql`select coalesce(sum(calls), 0) as n from pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database())
          and query ilike '%' || ${"activity_log"} || '%'`;
      return Number(row.n);
    }
    same(await audits(), [], "private-empty-audit");
    ok((await sql`select count(*)::int as n from activity_log`)[0].n === 0, "private-empty-log");
    // Rows 60 and 61 tie on time, so page 2 also exercises the id tie-break.
    await sql`insert into activity_log (description, subject_type, subject_id, causer_id, event, created_at)
      select 'kal-' || lpad(i::text, 3, '0'), 'Synthetic', 'k' || i,
        case i % 4 when 0 then ${a} when 1 then ${b} when 2 then '7' end, 'updated',
        timestamptz '2098-01-01 00:00:00+00' + (case when i = 61 then 60 else i end) * interval '1 minute'
      from generate_series(1, 120) as i order by i`;
    progress("LAUNCH");
    launched = chromium.launch({
      timeout: Math.max(1, Math.min(15_000, browserWorkMs - performance.now())),
      args: [
        "--proxy-server=http://127.0.0.1:9",
        `--proxy-bypass-list=<-loopback>;${origin}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${cdpPort}`,
      ],
    });
    const browser = await launched;
    progress("MODERATOR");
    const context = await browser.newContext({ serviceWorkers: "block", javaScriptEnabled: false });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const domain = new URL(origin).hostname;
    await context.addCookies([
      { name: cookie, value: moderatorToken, domain, path: "/", secure: true },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const table = page.getByTestId("activity-log-table");
    async function view(query, label) {
      const url = `${origin}${path}${query}`;
      const res = await page.goto(url);
      ok(
        res?.url() === url && res.status() === 200 && res.headers()["x-two-renderer"] === "kit",
        label,
      );
      ok(res.headers()["cache-control"] === "private, no-store", "moderator:cache");
      return table.locator("tbody td:nth-child(2)").allTextContents();
    }
    const before = await reads();
    same(await view("", "moderator:kit"), desc(120, 71), "page1:newest-first");
    same(await page.locator(".kit-admin h1").textContent(), "Activity log", "kit:admin-shell");
    same(await page.locator('a[rel="next"]').getAttribute("href"), `${path}?page=2`, "page1:next");
    ok((await reads()) > before, "moderator:positive-read-control");
    const snapshot = await audits();
    same(
      snapshot.map((row) => [row.viewer, row.actor, row.resource, row.action, row.route]),
      [[mod, mod, "activity_log", "list", "admin.activity-log.index"]],
      "moderator:audit-route",
    );
    same([snapshot[0].subjects, snapshot[0].n], [[a, b], 2], "moderator:audit-subjects");

    progress("REFUSALS");
    const quiet = await reads();
    const probe = `${path}?subject=kal-120&causer=${a}`;
    const request = (headers) => {
      checkTime();
      return fetch(`${origin}${probe}`, { headers, redirect: "manual", signal: stop.signal });
    };
    const denied = await request({ cookie: `${cookie}=${memberToken}` });
    same([denied.status, denied.headers.get("x-two-renderer")], [403, "kit"], "member:kit-403");
    ok(!(await denied.text()).includes("kal-120"), "member:no-row");
    const guest = await request();
    same([guest.status, guest.headers.get("x-two-renderer")], [302, "kit"], "guest:kit-302");
    const target = `/auth/discord?next=${encodeURIComponent(probe)}`;
    same(guest.headers.get("location"), target, "guest:return-path");
    checkTime();
    ok((await reads()) === quiet, "refused:no-activity-log-reads");
    checkTime();
    same(await audits(), snapshot, "refused:no-new-audits");

    progress("PAGINATION_FILTERS");
    same(await view("?page=2", "page2:kit"), desc(70, 21), "page2:newest-first");
    same(await view("?page=3", "page3:kit"), desc(20, 1), "page3:newest-first");
    ok((await page.locator('a[rel="next"]').count()) === 0, "page3:last");
    const byCauser = desc(120, 1).filter((row) => Number(row.slice(4)) % 4 === 0);
    same(await view(`?causer=${a}`, "causer:kit"), byCauser, "causer:filter");
    same(await view("?subject=kal-005", "subject:kit"), ["kal-005"], "subject:filter");
    same(await view("?subject=zz-no-activity", "empty:kit"), [], "empty:no-rows");
    ok(await page.getByTestId("activity-log-empty").isVisible(), "empty:message");
    same(
      (await audits()).map((row) => row.subjects),
      [[a, b], [a, b], [a, b], [a], [b]],
      "audit:subjects",
    );
    await context.close();
    const scratch = process.env.TMPDIR;
    const record = (text) => appendFileSync(`${scratch}/metrics.txt`, `${text}\n`);
    // A successful moderator GET rotates the session, so never seed a second context with it.
    const mintModerator = () =>
      mint(mod, true).then((value) => ({ name: cookie, value, domain, path: "/", secure: true }));
    const lighthouse = await visual.collectVisuals(
      browser,
      mintModerator,
      `${scratch}/screenshots`,
      {
        mark: progress,
        audit: async (page, name) => {
          const a11y = await routeA11y(page, progress);
          record(`${name} ${a11y}`);
          ok(a11y.startsWith("a11y: PASS "), "visual:a11y");
          progress("CAPTURE");
        },
        measure: routeLighthouse.bind(null, cdpPort),
        TimeoutError: errors.TimeoutError,
      },
    );
    record(`populated-desktop.png ${lighthouse ?? "lighthouse: unavailable"}`);
  }
  async function work() {
    await withDeadline(exercise, browserWorkMs - performance.now());
    // On work failure leave the last reached stage intact, even if cleanup stalls.
    mark("TEARDOWN");
  }
  async function cleanup() {
    stop.abort(new visual.BrowserDeadline());
    try {
      await withDeadline(async () => (await launched?.catch(() => undefined))?.close(), 10_000);
    } finally {
      // Actions disposes of the service container and all fixture rows.
      await withDeadline(() => sql.end({ timeout: 5 }), 6_000);
    }
  }
  await visual.withCleanup(work, cleanup);
  mark("COMPLETE");
}

await main().then(
  // Teardown and the synchronous stage write finished; don't wait on Lighthouse handles.
  () => process.exit(0),
  (error) => {
    if (error instanceof visual.AssertionFailure) process.exit(20);
    if (error instanceof visual.BrowserDeadline || error instanceof errors.TimeoutError)
      process.exit(21);
    process.exit(22);
  },
);
