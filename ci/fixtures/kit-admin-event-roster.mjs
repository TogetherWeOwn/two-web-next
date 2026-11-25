import assert from "node:assert/strict";
import postgres from "postgres";
import {
  parseRenderedPage,
  renderedAttribute,
  renderedElements,
  renderedText,
} from "../rendered-page.mjs";
import { renewedModerator, session, visit } from "./kit-admin-serving.mjs";

const eventKey = "01JV0000000000000000000209";
const otherKey = "01JV0000000000000000000210";
const eventPath = `/admin/events/${eventKey}`;
const filteredPath = `${eventPath}?roster_status=waitlisted`;
const actors = ["900000000000021500", "900000000000021501", "900000000000021502"];
const memberPrefix = "Synthetic roster member ";
// The extra matching row crosses the 100-row boundary. Newer decoys would
// enter the first page if either the status or event predicate were lost.
const members = Array.from({ length: 103 }, (_, index) => {
  const position = index + 1;
  return {
    id: String(900000000000021510n + BigInt(index)),
    username: `${memberPrefix}${position}`,
    created: new Date(Date.UTC(2099, 0, 1, 10, index)),
    answered: new Date(Date.UTC(2099, 0, 1, 12, index)),
    position,
  };
});
const waitlist = members.slice(0, 101);

function pageLink(roster, rel, origin) {
  const links = [...renderedElements(roster, { tag: "a" })];
  const link = links.find((element) => renderedAttribute(element, "rel") === rel);
  if (!link) return null;
  const href = renderedAttribute(link, "href");
  assert.ok(href, `${rel}: roster link destination`);
  const url = new URL(href, origin);
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, eventPath);
  assert.equal(url.hash, "#rsvp-roster");
  assert.equal(url.searchParams.get("roster_status"), "waitlisted");
  assert.equal(url.searchParams.get("roster_sort"), "answered");
  assert.equal(url.searchParams.get("roster_order"), "desc");
  assert.equal(url.searchParams.get("roster_page"), rel === "next" ? "2" : null);
  return url.pathname + url.search;
}

function assertPage(result, expected, range, label) {
  assert.equal(result.headers.get("cache-control"), "private, no-store", label);
  assert.match(result.headers.get("content-type") ?? "", /^text\/html\b/, label);
  const document = parseRenderedPage(result.text);
  const [roster] = renderedElements(document, { tag: "section", id: "rsvp-roster" });
  assert.ok(roster, `${label}: visible roster`);
  const [statusFilter] = renderedElements(roster, { tag: "select", id: "roster-status" });
  assert.ok(statusFilter, label);
  const selected = [...renderedElements(statusFilter, { tag: "option" })]
    .filter((option) => renderedAttribute(option, "selected") !== undefined)
    .map((option) => renderedAttribute(option, "value"));
  assert.deepEqual(selected, ["waitlisted"], label);
  const [heading] = renderedElements(roster, { tag: "h2" });
  assert.ok(heading, label);
  assert.equal(renderedText(heading).trim(), "RSVPs (101)", label);
  const [rangeLine] = [...renderedElements(roster, { tag: "p" })].filter(
    (element) => renderedAttribute(element, "data-testid") === "roster-range",
  );
  assert.ok(rangeLine, label);
  assert.equal(renderedText(rangeLine).trim(), `Showing ${range} of 101 responses`, label);
  const [table] = renderedElements(roster, { tag: "table" });
  assert.ok(table, label);
  assert.deepEqual(
    [...renderedElements(table, { tag: "th" })].map((cell) => renderedText(cell).trim()),
    ["Member", "Status", "Answered (UTC) ↓", "Waitlist position"],
    label,
  );
  const [body] = renderedElements(table, { tag: "tbody" });
  assert.ok(body, label);
  const rows = [...renderedElements(body, { tag: "tr" })].map((row) => {
    const [time] = renderedElements(row, { tag: "time" });
    assert.ok(time, `${label}: answered timestamp`);
    return [
      ...[...renderedElements(row, { tag: "td" })].map((cell) => renderedText(cell).trim()),
      renderedAttribute(time, "datetime"),
    ];
  });
  assert.deepEqual(
    rows,
    expected.map(({ username, answered, position }) => {
      const iso = answered.toISOString();
      return [
        username,
        "waitlisted",
        `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`,
        `#${position}`,
        iso,
      ];
    }),
    label,
  );
  assert.ok(
    members.every(({ id }) => !result.text.includes(id)),
    `${label}: no member IDs`,
  );
  return roster;
}

export async function assertAdminEventRosterParity({ kit, fallback, databaseUrl }) {
  const sql = postgres(databaseUrl, { max: 1 });
  const [kitModerator, fallbackModerator, memberId] = actors;
  let seeded = false;
  try {
    await sql.begin(async (tx) => {
      const events = await tx`insert into events (event_key, title, starts_at, ends_at)
        values (${eventKey}, 'Synthetic roster event', '2099-01-05 18:00+00', '2099-01-05 19:00+00'),
          (${otherKey}, 'Synthetic roster decoy event', '2099-01-06 18:00+00', '2099-01-06 19:00+00')
        returning id, event_key`;
      const ids = new Map(events.map(({ event_key, id }) => [event_key, id]));
      await tx`insert into users ${tx(members.map(({ id, username }) => ({ id, username })))}`;
      const rsvps = members.map(({ id, position, created, answered }) => ({
        event_id: ids.get(position === 103 ? otherKey : eventKey),
        user_id: id,
        status: position === 102 ? "going" : "waitlisted",
        created_at: created,
        updated_at: answered,
      }));
      await tx`insert into rsvps ${tx(rsvps)}`;
    });
    seeded = true;

    const first = waitlist.slice(1).reverse();
    const second = waitlist.slice(0, 1);
    const member = await session(sql, memberId, false);
    for (const [worker, owned, moderatorId] of [
      [kit, true, kitModerator],
      [fallback, false, fallbackModerator],
    ]) {
      const read = (path, status, cookie) =>
        visit(worker, path, status, { owned, headers: { accept: "text/html", cookie } });
      const moderator = await session(sql, moderatorId, true);
      const firstPage = await read(filteredPath, 200, moderator);
      const firstRoster = assertPage(firstPage, first, "1-100", `${worker.name}: first page`);
      assert.equal(pageLink(firstRoster, "prev", worker.origin), null);
      const next = pageLink(firstRoster, "next", worker.origin);
      assert.ok(next, `${worker.name}: next page`);
      const secondPage = await read(next, 200, renewedModerator(firstPage.headers));
      const secondRoster = assertPage(secondPage, second, "101-101", `${worker.name}: second page`);
      assert.ok(pageLink(secondRoster, "prev", worker.origin), `${worker.name}: previous page`);
      assert.equal(pageLink(secondRoster, "next", worker.origin), null);

      const denied = await read(next, 403, member);
      assert.ok(!denied.text.includes("rsvp-roster"), `${worker.name}: no roster section`);
      assert.ok(!denied.text.includes(memberPrefix), `${worker.name}: no roster names`);
      assert.equal(denied.headers.getSetCookie().length, 0, worker.name);
    }

    // The append-only audit records each rendered page's subjects. The
    // disposable database is removed by the hosted job after teardown.
    const audits =
      await sql`select viewer_discord_id, resource, action, route, subject_count, subject_user_ids
      from member_data_access_logs where viewer_discord_id in ${sql(actors)} order by id`;
    assert.deepEqual(
      [...audits],
      [kitModerator, fallbackModerator].flatMap((viewer) =>
        [first, second].map((page) => ({
          viewer_discord_id: viewer,
          resource: "events",
          action: "view",
          route: "admin.events.edit",
          subject_count: page.length,
          subject_user_ids: page.map(({ id }) => id).sort(),
        })),
      ),
    );
  } finally {
    try {
      if (seeded) {
        await sql.begin(async (tx) => {
          await tx`delete from web_session_grace where user_id in ${tx(actors)}`;
          await tx`delete from web_sessions where user_id in ${tx(actors)}`;
          // Event deletion also removes its fixture RSVPs via the existing FK.
          await tx`delete from events where event_key in (${eventKey}, ${otherKey})`;
          await tx`delete from users where id in ${tx(members.map(({ id }) => id))}`;
        });
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log(
    "PASS installed moderator roster status filter, paging, audited reads and refusal across Kit and Hono fallback",
  );
}
