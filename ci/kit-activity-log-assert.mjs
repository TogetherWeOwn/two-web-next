// Run from the pinned app checkout, only with the job-private Worker and Postgres.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { requireGithubRunner, requireTestDatabase } from "../e2e/ci-only.mjs";
import { routeA11y, routeLighthouse } from "./kit-activity-log-metrics.mjs";
import * as visual from "./kit-activity-log-visual.mjs";

const { origin, path, browserWorkMs, withDeadline, collectVisuals, AssertionFailure } = visual;
const cdpPort = 9222;
const mod = "900000000000009301";
const member = "900000000000009302";
const [a, b] = ["900000000000009311", "900000000000009312"];
function mark(stage, viewport = "NONE", operation = "NONE") {
  const file = `${process.env.TMPDIR}/browser-stage`;
  writeFileSync(`${file}.next`, `${stage} ${viewport} ${operation}\n`, { mode: 0o600 });
  renameSync(`${file}.next`, file);
}
function ok(condition, label) {
  if (!condition) throw new AssertionFailure(label);
}
const same = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label);
const desc = (from, to) =>
  Array.from({ length: from - to + 1 }, (_, k) => `kal-${String(from - k).padStart(3, "0")}`);

// Always clean up, retaining the first rejection if cleanup also fails.
const thenCleanup = (task, close, ms) =>
  task.finally(() => withDeadline(close, ms)).finally(() => task);
export async function runWork(exercise, progress, closeBrowser, closeDatabase) {
  const stop = new AbortController();
  const checkTime = (stage = "", ...detail) => {
    if (stop.signal.aborted || performance.now() >= browserWorkMs)
      throw new visual.BrowserDeadline();
    if (stage) progress(stage, ...detail);
  };
  const budget = { signal: stop.signal, checkTime };
  const verdict = withDeadline(() => exercise(budget), browserWorkMs - performance.now())
    .finally(() => stop.abort())
    .then(() => progress("TEARDOWN"));
  await thenCleanup(thenCleanup(verdict, closeBrowser, 10_000), closeDatabase, 6_000);
  progress("COMPLETE");
}
export async function memberRefusal(probe, headers, { signal, checkTime }, fetcher = fetch) {
  const send = (headers) => fetcher(`${origin}${probe}`, { headers, redirect: "manual", signal });
  checkTime();
  const denied = await send(headers);
  same([denied.status, denied.headers.get("x-two-renderer")], [403, "kit"], "member:kit-403");
  const body = await denied.text();
  checkTime();
  ok(!body.includes("kal-120"), "member:no-row");
  return send;
}
async function main() {
  requireGithubRunner();
  const database = requireTestDatabase(process.env.DATABASE_URL);
  const { chromium, errors } = await import("@playwright/test");
  const { default: postgres } = await import("postgres");
  await exitFixture(exerciseFixture(chromium, postgres, errors, database), errors.TimeoutError);
}
async function exerciseFixture(chromium, postgres, { TimeoutError }, database) {
  mark("FIXTURE");
  const secret = readFileSync("ci/kit-worker-dev.mjs", "utf8").match(
    /SESSION_SECRET: "([^"]+)"/,
  )?.[1];
  ok(secret, "fixture-secret");
  const sql = postgres(database, { max: 1, connect_timeout: 5, onnotice: () => {} });
  let launched;
  const closeBrowser = async () => (await launched?.catch(() => undefined))?.close();
  const closeDatabase = () => sql.end({ timeout: 5 });
  async function exercise(budget) {
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
    budget.checkTime("LAUNCH");
    launched = chromium.launch({
      args: [
        "--proxy-server=http://127.0.0.1:9",
        `--proxy-bypass-list=<-loopback>;${origin}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${cdpPort}`,
      ],
    });
    const browser = await launched;
    budget.checkTime("MODERATOR");
    const context = await browser.newContext({ serviceWorkers: "block", javaScriptEnabled: false });
    await context.route("**/*", (route) =>
      !budget.signal.aborted && new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
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

    budget.checkTime("REFUSALS");
    const quiet = await reads();
    const probe = `${path}?subject=kal-120&causer=${a}`;
    const request = await memberRefusal(probe, { cookie: `${cookie}=${memberToken}` }, budget);
    budget.checkTime();
    const guest = await request();
    same([guest.status, guest.headers.get("x-two-renderer")], [302, "kit"], "guest:kit-302");
    const target = `/auth/discord?next=${encodeURIComponent(probe)}`;
    same(guest.headers.get("location"), target, "guest:return-path");
    budget.checkTime();
    ok((await reads()) === quiet, "refused:no-activity-log-reads");
    budget.checkTime();
    same(await audits(), snapshot, "refused:no-new-audits");

    budget.checkTime("PAGINATION_FILTERS");
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
    budget.checkTime("TEARDOWN");
    await withDeadline(() => context.close());
    const scratch = process.env.TMPDIR;
    const record = (text) => appendFileSync(`${scratch}/metrics.txt`, `${text}\n`);
    // A successful moderator GET rotates the session, so never seed a second context with it.
    const mintModerator = () =>
      mint(mod, true).then((value) => ({ name: cookie, value, domain, path: "/", secure: true }));
    const lighthouse = await collectVisuals(browser, mintModerator, `${scratch}/screenshots`, {
      signal: budget.signal,
      TimeoutError,
      mark: budget.checkTime,
      audit: async (page, name, step) => {
        const a11y = await routeA11y(page, step);
        record(`${name} ${a11y}`);
        ok(a11y.startsWith("a11y: PASS "), "visual:a11y");
      },
      measure: routeLighthouse.bind(null, cdpPort),
    });
    record(`populated-desktop.png ${lighthouse ?? "lighthouse: unavailable"}`);
  }
  await runWork(exercise, mark, closeBrowser, closeDatabase);
}

export async function exitFixture(task, TimeoutError) {
  const classify = (error) => {
    if (error instanceof AssertionFailure) return 20;
    return error instanceof visual.BrowserDeadline || error instanceof TimeoutError ? 21 : 22;
  };
  process.exit(await task.then(() => 0, classify));
}
if (import.meta.main) await main().catch(() => process.exit(22));
