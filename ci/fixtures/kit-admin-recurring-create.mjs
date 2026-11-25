import assert from "node:assert/strict";

const formFields = {
  title: "Fixture weekly draft",
  description: "Keep the weekly draft details",
  starts_at: "2099-03-01T18:30",
  ends_at: "2099-03-01T19:45",
  timezone: "America/New_York",
  recurrence_frequency: "weekly",
  recurrence_count: "4",
  recurrence_ends_on: "2099-03-15",
};

// The repeat-until date includes the third Sunday and excludes the fourth.
// Local times stay fixed when New York moves to daylight time on March 8.
const schedule = [
  ["2099-03-01T23:30:00.000Z", "2099-03-02T00:45:00.000Z"],
  ["2099-03-08T22:30:00.000Z", "2099-03-08T23:45:00.000Z"],
  ["2099-03-15T22:30:00.000Z", "2099-03-15T23:45:00.000Z"],
];

const eventKeyPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

async function counts(sql) {
  const [state] = await sql`select
    (select count(*)::int from events) as events,
    (select count(*)::int from activity_log) as audits,
    (select count(*)::int from queue_jobs) as queued,
    (select count(*)::int from queue_failed_jobs) as failed,
    (select count(*)::int from event_sync_attempts) as sync_attempts`;
  return state;
}

export async function assertRecurringCreateParity({ kit, sql, visit, session, actors }) {
  const contracts = [];
  for (const [owner, actor] of Object.entries(actors)) {
    const label = `${owner} recurring create`;
    try {
      const cookie = await session(sql, actor, true);
      const before = await counts(sql);
      async function post(status, fields) {
        const response = await visit(kit, "/admin/events", status, {
          method: "POST",
          owned: owner === "kit",
          headers: { accept: "text/html", cookie, "x-fixture-recurring-create-owner": owner },
          body: new URLSearchParams(fields),
        });
        assert.equal(response.headers.get("x-fixture-recurring-create-dispatches"), "0", label);
        assert.equal(response.headers.getSetCookie().length, 0, label);
        return response;
      }

      const invalid = await post(422, { ...formFields, recurrence_ends_on: "2099-02-28" });
      assert.match(invalid.text, /The repeat-until date is before the first meeting\./, label);
      assert.ok(invalid.text.includes(formFields.title), label);
      assert.match(invalid.headers.get("content-type") ?? "", /^text\/html\b/, label);
      assert.equal(invalid.headers.get("location"), null, label);
      assert.deepEqual(await counts(sql), before, `${label}: rejected form leaves no writes`);

      const saved = await post(303, formFields);
      assert.equal(saved.text, "", label);
      assert.deepEqual(
        await counts(sql),
        { ...before, events: before.events + 3, audits: before.audits + 3 },
        `${label}: three drafts and three audit receipts, with no queued or mirrored work`,
      );
      const rows = await sql`
        select id, event_key, title, description, status, starts_at, ends_at, timezone,
          parent_event_id, recurrence_index, recurrence_frequency, recurrence_count,
          recurrence_ends_on, rsvp_open, discord_event_id
        from events where created_by = ${actor} order by recurrence_index
      `;
      assert.equal(rows.length, schedule.length, label);
      assert.equal(new Set(rows.map(({ event_key }) => event_key)).size, schedule.length, label);
      const [parent] = rows;
      assert.equal(
        saved.headers.get("location"),
        `/admin/events/${parent.event_key}?saved=1`,
        label,
      );

      const audits = await sql`
        select subject_id, subject_type, description, properties
        from activity_log where causer_id = ${actor}
      `;
      assert.equal(audits.length, schedule.length, label);
      const byKey = new Map(audits.map((row) => [row.subject_id, row]));
      for (const [offset, row] of rows.entries()) {
        const { id: _id, event_key: key, ...draft } = row;
        const first = offset === 0;
        const [start, end] = schedule[offset];
        const occurrence = `${label}, occurrence ${offset + 1}`;
        assert.match(key, eventKeyPattern, occurrence);
        assert.deepEqual(
          draft,
          {
            title: formFields.title,
            description: formFields.description,
            status: "draft",
            starts_at: new Date(start),
            ends_at: new Date(end),
            timezone: formFields.timezone,
            parent_event_id: first ? null : parent.id,
            recurrence_index: offset + 1,
            recurrence_frequency: first ? "weekly" : null,
            recurrence_count: first ? 4 : null,
            recurrence_ends_on: first ? new Date("2099-03-15T00:00:00.000Z") : null,
            rsvp_open: true,
            discord_event_id: null,
          },
          occurrence,
        );
        const audit = byKey.get(key);
        assert.ok(audit, `${occurrence}: a distinct audit subject`);
        assert.equal(audit.subject_type, "Event", occurrence);
        assert.equal(audit.description, `created event ${formFields.title}`, occurrence);
        const expected = {
          eventKey: key,
          createdBy: actor,
          title: formFields.title,
          description: formFields.description,
          status: "draft",
          timezone: formFields.timezone,
          startsAt: start,
          endsAt: end,
          recurrenceIndex: offset + 1,
          ...(first
            ? {
                recurrenceFrequency: "weekly",
                recurrenceCount: 4,
                recurrenceEndsOn: "2099-03-15T00:00:00.000Z",
              }
            : { parentEventId: parent.id }),
        };
        for (const [field, after] of Object.entries(expected)) {
          assert.deepEqual(
            audit.properties[field],
            { before: null, after },
            `${occurrence}: ${field}`,
          );
        }
      }
      contracts.push({
        redirectType: saved.headers.get("content-type"),
        refusalType: invalid.headers.get("content-type"),
      });
    } finally {
      // Activity receipts are append-only. The disposable database teardown removes them.
      await sql`delete from events where created_by = ${actor}`;
      await sql`delete from web_sessions where user_id = ${actor}`;
      const [remaining] = await sql`select
        exists (select 1 from events where created_by = ${actor}) as events,
        exists (select 1 from web_sessions where user_id = ${actor}) as sessions`;
      assert.deepEqual(remaining, { events: false, sessions: false }, `${label}: cleanup`);
    }
  }
  assert.deepEqual(contracts[0], contracts[1], "recurring create response content types match");
  console.log(
    "PASS installed Kit and Hono recurring draft creation, rejection, audits, zero dispatch, and scoped cleanup",
  );
}
