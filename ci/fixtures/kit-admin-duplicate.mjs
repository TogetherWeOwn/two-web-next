import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

function fixtureKey() {
  return `0${randomBytes(13).toString("hex").slice(0, 25).toUpperCase()}`;
}

export async function assertAdminDuplicateServing({
  kit,
  off,
  hono,
  sql,
  moderatorId,
  moderator,
  member,
  visit,
}) {
  const sourceKey = fixtureKey();
  const invalidKey = fixtureKey();
  const missingKey = fixtureKey();
  const sourcePath = `/admin/events/${sourceKey}`;
  const duplicate = `${sourcePath}/duplicate`;
  const title = "Fixture published source";
  const copiedTitle = `Copy of ${title}`;
  await sql`
    insert into events (event_key, title, description, starts_at, ends_at, timezone, location,
                        status, rsvp_open, discord_event_id, created_by)
    values (${sourceKey}, ${title}, 'Copy this detail', '2099-10-01T12:00:00Z', '2099-10-01T13:00:00Z',
            'UTC', 'Fixture venue', 'published', false, ${moderatorId}, ${moderatorId}),
           (${invalidKey}, '   ', 'Repair this source', '2099-10-02T12:00:00Z', '2099-10-02T13:00:00Z',
            'UTC', 'Fixture venue', 'draft', true, null, ${moderatorId})
  `;

  async function snapshot() {
    const events = await sql`
      select to_jsonb(events) as row from events where created_by = ${moderatorId} order by id
    `;
    const audits = await sql`
      select to_jsonb(activity_log) as row from activity_log
      where causer_id = ${moderatorId} order by id
    `;
    const [{ queued, failed }] = await sql`select
      (select count(*)::int from queue_jobs) as queued,
      (select count(*)::int from queue_failed_jobs) as failed`;
    return {
      events: events.map(({ row }) => row),
      audits: audits.map(({ row }) => row),
      queued,
      failed,
    };
  }

  const cases = [
    { status: 303, location: `/auth/recover?next=${encodeURIComponent(sourcePath)}`, cookies: 1 },
    { status: 403, cookie: member, message: /You do not have access to this/ },
    {
      status: 403,
      cookie: moderator,
      origin: "https://untrusted.example",
      accept: "application/json",
      message: /"error":"cross_origin"/,
    },
    {
      status: 413,
      cookie: moderator,
      body: `pad=${"x".repeat(4097)}`,
      message: /That request is too large/,
    },
    {
      status: 404,
      cookie: moderator,
      path: `/admin/events/${missingKey}/duplicate`,
      message: /Event not found/,
    },
    {
      status: 422,
      cookie: moderator,
      path: `/admin/events/${invalidKey}/duplicate`,
      message: /Give the event a title\./,
    },
  ];
  let parity;
  for (const target of [hono, off, kit]) {
    const owned = target === kit;
    const before = await snapshot();
    const post = (
      path,
      status,
      { cookie, origin = target.origin, accept = "text/html", body = "" } = {},
    ) =>
      visit(target, path, status, {
        method: "POST",
        headers: {
          accept,
          origin,
          cookie: cookie ?? "",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        owned,
      });
    const refusals = [];
    for (const test of cases) {
      const { headers, text } = await post(test.path ?? duplicate, test.status, test);
      assert.equal(headers.get("location"), test.location ?? null);
      assert.equal(headers.getSetCookie().length, test.cookies ?? 0);
      if (test.message) assert.match(text, test.message);
      refusals.push({
        type: headers.get("content-type"),
        cache: headers.get("cache-control"),
        body: text
          .replaceAll(target.origin, "ORIGIN")
          .replaceAll(headers.get("x-request-id"), "REQUEST_ID"),
      });
    }
    const wrongMethod = await visit(target, duplicate, 302, { owned: false });
    assert.equal(wrongMethod.headers.get("location"), "/auth/discord");
    assert.deepEqual(
      await snapshot(),
      before,
      "refusals and GET preserved events, audits and queue ledgers",
    );

    const { headers, text } = await post(duplicate, 303, { cookie: moderator });
    const location = headers.get("location") ?? "";
    assert.match(location, /^\/admin\/events\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.notEqual(location, sourcePath);
    assert.equal(text, "");
    assert.equal(headers.getSetCookie().length, 0);

    const after = await snapshot();
    assert.deepEqual(
      after.events.slice(0, -1),
      before.events,
      "every original event row is unchanged",
    );
    assert.equal(after.events.length, before.events.length + 1);
    const copy = after.events.at(-1);
    assert.equal(location, `/admin/events/${copy.event_key}`);
    assert.equal(copy.title, copiedTitle);
    assert.equal(copy.status, "draft");
    assert.equal(copy.rsvp_open, true);
    assert.equal(copy.discord_event_id, null);
    assert.equal(copy.created_by, moderatorId);
    const original = before.events.find(({ event_key }) => event_key === sourceKey);
    for (const field of ["description", "location", "starts_at", "ends_at", "timezone"]) {
      assert.equal(copy[field], original[field], `copy preserves ${field}`);
    }
    assert.deepEqual(after.audits.slice(0, -1), before.audits, "original audit rows are unchanged");
    assert.equal(after.audits.length, before.audits.length + 1);
    const audit = after.audits.at(-1);
    assert.equal(audit.subject_type, "Event");
    assert.equal(audit.subject_id, copy.event_key);
    assert.equal(audit.causer_id, moderatorId);
    assert.equal(audit.description, `duplicated event ${copiedTitle} from ${title}`);
    assert.deepEqual(audit.properties.status, { before: null, after: "draft" });
    assert.deepEqual(audit.properties.eventKey, { before: null, after: copy.event_key });
    assert.deepEqual(audit.properties.title, { before: null, after: copiedTitle });
    assert.equal(after.queued, before.queued);
    assert.equal(after.failed, before.failed);

    const { id, createdAt, updatedAt, eventKey, ...auditChanges } = audit.properties;
    const contract = { refusals, auditChanges, redirectType: headers.get("content-type") };
    if (parity) assert.deepEqual(contract, parity, `${target.name} response and audit parity`);
    else parity = contract;
  }
  console.log(
    "PASS installed Worker event duplication authorization, response and audit parity, one draft, and zero dispatch",
  );
}
