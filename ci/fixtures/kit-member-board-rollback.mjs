import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";
import { fixtureSession } from "../kit-live-socket.mjs";
import { SESSION_COOKIE } from "../parity/fixture.mjs";
import {
  parseRenderedPage,
  renderedAttribute,
  renderedElements,
  renderedText,
} from "../rendered-page.mjs";

// Use the same origin class as the hosted cutover so the preview manifest cannot answer.
const appUrl = "https://two-web-kit-cutover-proof-1-1.member-board-fixture.workers.dev";
const eligible = { id: "900000000000090820", name: "Synthetic Eligible Board Member" };
const optedOut = { id: "900000000000090821", name: "Synthetic Opted Out Board Member" };
const season = "2097-11";
const activity = "synthetic leaderboard privacy";
const boardPath = `/leaderboards/members?${new URLSearchParams({ scope: "overall", season, activity })}`;

/** Run with the installed Worker runner's admitted loopback database and scratch directory. */
export async function assertMemberBoardRollback({
  databaseUrl,
  scratch,
  secret,
  startKit,
  worker,
}) {
  const entry = join(scratch, "kit-member-board-rollback.mjs");
  await writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import worker from ${JSON.stringify(worker)};

globalThis.fetch = async () => { throw new Error("Unexpected member board fixture upstream fetch"); };

export default {
  fetch(request, env, context) {
    const incoming = new URL(request.url);
    const url = new URL(env.APP_URL);
    url.pathname = incoming.pathname;
    url.search = incoming.search;
    const document = new Request(url, request);
    document.headers.set("host", url.host);
    document.headers.set("sec-fetch-mode", "navigate");
    document.headers.set("sec-fetch-dest", "document");
    const fallback = document.headers.get("x-fixture-member-board-rollback") === "true";
    document.headers.delete("x-fixture-member-board-rollback");
    const bindings = fallback ? { ...env, KIT_ROUTE_EMBER_PAGES: "false" } : env;
    return withEnv(bindings, () => worker.fetch(document, bindings, context));
  },
};\n`,
  );
  const { origin } = await startKit(entry, {
    ...EMBER_CUTOVER_VARS,
    APP_URL: appUrl,
    DISCORD_GUILD_ID: "",
  });
  const { ref, cookie: initialCookie } = await fixtureSession(secret);
  let cookie = initialCookie;
  const sql = postgres(databaseUrl, { max: 1 });
  const ids = [eligible.id, optedOut.id];
  let eventId;
  try {
    eventId = await sql.begin(async (tx) => {
      const [existing] = await tx`
        select exists (
          select 1 from board_view_logs
          where normalized_board_key = 'members' and scope = 'overall' and season = ${season}
        ) as occupied`;
      assert.equal(existing.occupied, false, "synthetic board log keys must be unused");
      await tx`insert into users (id, username, member)
        values (${eligible.id}, ${eligible.name}, true), (${optedOut.id}, ${optedOut.name}, true)`;
      await tx`insert into profiles (user_id, leaderboard_opt_out)
        values (${eligible.id}, false), (${optedOut.id}, true)`;
      const [event] =
        await tx`insert into events (event_key, title, game, status, starts_at, ends_at)
        values ('01J0000000000000000000C207', 'Synthetic Board Fixture', ${activity}, 'published',
          '2097-11-01 18:00+00', '2097-11-01 19:00+00') returning id`;
      await tx`insert into rsvps (event_id, user_id, status)
        values (${event.id}, ${eligible.id}, 'going'), (${event.id}, ${optedOut.id}, 'going')`;
      await tx`insert into web_sessions (token_hash, status_hash, user_id, username, member, expires_at, roles_checked_at)
        values (${ref}, ${ref}, ${eligible.id}, ${eligible.name}, true, now() + interval '10 minutes', now())`;
      return event.id;
    });

    for (const [phase, joinRenderer] of [
      ["Ember", "kit"],
      ["Hono fallback", null],
    ]) {
      const headers = {
        accept: "text/html",
        ...(joinRenderer === null ? { "x-fixture-member-board-rollback": "true" } : {}),
      };
      const get = (path, extra = {}) =>
        fetch(`${origin}${path}`, {
          headers: { ...headers, ...extra },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
      // This document changes owner. The member board is Hono-owned in both phases.
      const joinPage = await get("/join");
      await joinPage.body?.cancel();
      assert.equal(joinPage.status, 200, `${phase}: Join status`);
      assert.equal(joinPage.headers.get("x-two-renderer"), joinRenderer, `${phase}: Join renderer`);

      const board = await get(boardPath, { cookie });
      const html = await board.text();
      assert.equal(board.status, 200, `${phase}: member board status`);
      assert.equal(board.headers.get("x-two-renderer"), null, `${phase}: Hono owns the board`);
      assert.match(board.headers.get("content-type") ?? "", /^text\/html\b/i, phase);
      assert.equal(board.headers.get("cache-control"), "private, no-store", phase);
      assert.ok(!html.includes(optedOut.name), `${phase}: opted-out display name is absent`);
      assert.ok(
        ids.every((id) => !html.includes(id)),
        `${phase}: board emits no fixture member IDs`,
      );

      const table = [...renderedElements(parseRenderedPage(html), { tag: "table" })].find(
        (element) => renderedAttribute(element, "class") === "member-board-table",
      );
      assert.ok(table, `${phase}: rendered rankings table`);
      const rows = [...renderedElements(table, { tag: "tbody" })].flatMap((body) =>
        [...renderedElements(body, { tag: "tr" })].map((row) =>
          row.childNodes.filter((cell) => ["td", "th"].includes(cell.nodeName)).map(renderedText),
        ),
      );
      assert.deepEqual(rows, [["1", eligible.name, "1"]], `${phase}: only the eligible RSVP ranks`);

      const session = board.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
      assert.ok(session, `${phase}: Hono renews the live bearer`);
      const renewed = session.split(";", 1)[0];
      assert.ok(renewed !== cookie, `${phase}: Hono rotated the session bearer`);
      cookie = renewed;
      console.log(
        `PASS installed ${phase}: member board ranks only the eligible synthetic profile`,
      );
    }
  } finally {
    try {
      if (eventId !== undefined) {
        await sql.begin(async (tx) => {
          await tx`delete from web_session_grace where status_hash = ${ref}`;
          await tx`delete from web_sessions where status_hash = ${ref}`;
          // The only expected row is the viewer, who is excluded from audit subjects.
          // The disposable database teardown removes any append-only audit from a failed read.
          await tx`delete from board_view_logs
            where normalized_board_key = 'members' and scope = 'overall' and season = ${season}`;
          await tx`delete from events where id = ${eventId}`; // Cascades to both going RSVPs.
          await tx`delete from profiles where user_id in ${tx(ids)}`;
          await tx`delete from users where id in ${tx(ids)}`;
        });
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log("PASS synthetic member board fixture rows cleaned up");
}
