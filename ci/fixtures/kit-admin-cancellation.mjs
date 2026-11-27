import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

export async function assertEventCancellation({ kit, visit, sql, moderator, member, moderatorId }) {
  const html = { accept: "text/html" };
  const ip = "192.0.2.199";
  const rows = ["draft", "published", "past", "fallback"].map((scenario) => ({
    event_key: randomBytes(12).toString("hex").toUpperCase().padStart(26, "0"),
    title: `Fixture cancellation ${scenario}`,
    status: scenario === "fallback" ? "published" : scenario,
    starts_at: scenario === "past" ? "2000-10-01T12:00Z" : "2099-10-01T12:00Z",
    ends_at: scenario === "past" ? "2000-10-01T13:00Z" : "2099-10-01T13:00Z",
    created_by: moderatorId,
  }));
  const [draft, published, past, fallback] = rows;
  const eventPath = (row) => `/admin/events/${row.event_key}`;
  const queueKey = (row) => `sync-event:${row.event_key}`;
  const throttleBucket = `admin-write:${ip}`;

  async function snapshot(row) {
    const [event] = await sql`
      select status, updated_at::text from events where event_key = ${row.event_key}
    `;
    const activity = await sql`
      select id, description, causer_id, properties from activity_log
      where subject_type = 'Event' and subject_id = ${row.event_key} order by id
    `;
    const jobs = await sql`
      select job_id, kind from queue_jobs where key = ${queueKey(row)} order by job_id
    `;
    const [lease] = await sql`
      select owner_token from job_unique_locks where key = ${queueKey(row)}
    `;
    return { event, activity: [...activity], jobs: [...jobs], lease };
  }

  async function throttleHits() {
    const [{ count }] = await sql`
      select count(*)::int from web_throttle_hits where bucket = ${throttleBucket}
    `;
    return count;
  }

  async function cancel(
    row,
    status,
    { owned = true, cookie = moderator, origin, body, expectedHits = 1 } = {},
  ) {
    const hitsBefore = await throttleHits();
    const result = await visit(kit, `${eventPath(row)}/cancel`, status, {
      method: "POST",
      owned,
      body: body ?? new URLSearchParams(),
      headers: {
        ...html,
        "cf-connecting-ip": ip,
        ...(owned ? {} : { "x-fixture-admin-off": "1" }),
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {}),
      },
    });
    assert.equal(
      (await throttleHits()) - hitsBefore,
      expectedHits,
      `${owned ? "Kit" : "Hono"} ${row.title} POST returning ${status} throttle spend`,
    );
    const captured = result.headers.get("x-fixture-cancel-sync");
    assert.ok(captured, "the installed Worker used the cancellation transport trap");
    return { ...result, messages: JSON.parse(captured) };
  }

  try {
    await sql`insert into events ${sql(rows)}`;
    const untouched = await snapshot(draft);
    assert.equal(untouched.event.status, "draft");
    for (const owned of [true, false]) {
      const guest = await cancel(draft, 303, { owned, cookie: null, expectedHits: 0 });
      assert.equal(
        guest.headers.get("location"),
        `/auth/recover?next=${encodeURIComponent(eventPath(draft))}`,
      );
      assert.equal(guest.headers.getSetCookie().length, 1);
      assert.deepEqual(guest.messages, []);
      for (const [status, options] of [
        [403, { cookie: member }],
        [403, { origin: "https://other.example" }],
        [413, { body: "x".repeat(4097) }],
      ]) {
        const denied = await cancel(draft, status, { owned, ...options, expectedHits: 0 });
        assert.equal(denied.headers.get("location"), null);
        assert.equal(denied.headers.getSetCookie().length, 0);
        assert.deepEqual(denied.messages, []);
      }
      assert.deepEqual(await snapshot(draft), untouched);
    }
    for (const row of [draft, published, fallback]) {
      const before = await snapshot(row);
      assert.equal(before.event.status, row.status);
      assert.deepEqual(before.activity, []);
      assert.deepEqual(before.jobs, []);
      const saved = await cancel(row, 303, { owned: row !== fallback });
      assert.equal(saved.headers.get("location"), eventPath(row));
      assert.equal(saved.headers.getSetCookie().length, 0);
      assert.equal(saved.messages.length, 1, "one captured sync dispatch");
      const [{ message, options }] = saved.messages;
      assert.equal(message.kind, "sync-event");
      assert.equal(message.eventKey, row.event_key);
      assert.match(message.idempotencyKey, /^[a-f0-9-]{36}$/);
      assert.equal(message.requestId, saved.headers.get("x-request-id"));
      assert.equal(options.delaySeconds, 10);
      const committed = await snapshot(row);
      assert.equal(committed.event.status, "cancelled");
      assert.notEqual(committed.event.updated_at, before.event.updated_at);
      assert.deepEqual(committed.jobs, [{ job_id: message.jobId, kind: "sync-event" }]);
      assert.equal(committed.activity.length, 1, "one committed audit row");
      const [audit] = committed.activity;
      assert.equal(audit.causer_id, moderatorId);
      assert.equal(audit.description, `cancelled event ${row.title}`);
      assert.deepEqual(audit.properties, { status: { before: row.status, after: "cancelled" } });

      // Settle the trapped job locally so its lease cannot mask a replay dispatch.
      assert.ok(committed.lease?.owner_token, "the dispatch owns a sync lease");
      assert.equal(
        message.leaseToken,
        committed.lease.owner_token,
        "the message carries its lease",
      );
      await sql.begin(async (tx) => {
        const removed = await tx`
          delete from queue_jobs where job_id = ${message.jobId} and key = ${queueKey(row)}
        `;
        const released = await tx`
          delete from job_unique_locks where key = ${queueKey(row)}
          and owner_token = ${message.leaseToken}
        `;
        assert.equal(removed.count, 1, "the trapped job was settled");
        assert.equal(released.count, 1, "the trapped job's lease was released");
      });
      const settled = { ...committed, jobs: [], lease: undefined };
      assert.deepEqual(await snapshot(row), settled);
      for (const owned of [true, false]) {
        const stale = await cancel(row, 422, { owned });
        assert.equal(stale.headers.get("location"), null);
        assert.match(stale.text, /A cancelled event stays cancelled/);
        assert.ok(stale.text.includes(`href="${eventPath(row)}"`));
        assert.deepEqual(stale.messages, []);
        assert.deepEqual(
          await snapshot(row),
          settled,
          "stale POST preserves the audit and state without reacquiring a sync lease",
        );
      }
    }

    const pastState = await snapshot(past);
    assert.equal(pastState.event.status, "past");
    for (const owned of [true, false]) {
      const refused = await cancel(past, 422, { owned });
      assert.equal(refused.headers.get("location"), null);
      assert.match(refused.text, /Only a draft or a published event can be cancelled\./);
      assert.deepEqual(refused.messages, []);
      assert.deepEqual(await snapshot(past), pastState);
    }
  } finally {
    const keys = rows.map(queueKey);
    await sql.begin(async (tx) => {
      await tx`delete from queue_jobs where key in ${tx(keys)}`;
      await tx`delete from job_unique_locks where key in ${tx(keys)}`;
      await tx`delete from web_throttle_hits where bucket = ${throttleBucket}`;
    });
  }
  console.log(
    "PASS installed Admin cancellation, refusals, audit and Hono fallback with trapped sync",
  );
}
