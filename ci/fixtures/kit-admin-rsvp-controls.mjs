import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

export async function prepareAdminRsvpFixture(worker, entry) {
  await writeFile(
    entry,
    `import inner from ${JSON.stringify(worker)};
import { withEnv } from "cloudflare:workers";
let attempts = 0;
globalThis.fetch = async () => {
  attempts++;
  throw new Error("Outbound HTTP is disabled for the moderator RSVP fixture");
};
export default {
  async fetch(request, env, context) {
    const sends = [];
    const bindings = {
      ...env,
      KIT_ROUTE_ADMIN: request.headers.get("x-fixture-admin") === "on" ? "true" : "false",
      DISCORD_BOT_TOKEN: "",
      SYNC_EVENT_QUEUE: { async send(message, options) { sends.push({ message, options }); } },
    };
    request = new Request(request);
    request.headers.delete("x-fixture-admin");
    const response = await withEnv(bindings, () => inner.fetch(request, bindings, context));
    const headers = new Headers(response.headers);
    headers.set("x-fixture-outbound", String(attempts));
    headers.set("x-fixture-sends", JSON.stringify(sends));
    return new Response(response.body, { status: response.status, headers });
  },
};\n`,
  );
}

export async function assertKitAdminRsvpControls({ hono, off, on, databaseUrl }) {
  const sql = postgres(databaseUrl, { max: 1 });
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const [moderatorId, holderId, headId, nextId] = [0n, 1n, 2n, 3n].map((n) => String(actor + n));
  const sessionHashes = [];
  const keys = [];
  const ips = new Map([hono, off, on].map((worker, i) => [worker, `198.51.100.${61 + i}`]));
  const json = { accept: "application/json", "content-type": "application/json" };

  async function session(id, moderator, expired = false) {
    const token = `two_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    sessionHashes.push(hash);
    await sql`insert into web_sessions
      (token_hash, status_hash, user_id, username, member, moderator, expires_at, roles_checked_at)
      values (${hash}, ${hash}, ${id}, 'Synthetic RSVP controls', true, ${moderator},
        now() + make_interval(mins => ${expired ? -1 : 60}), now())`;
    const cookie = await generateSignedCookie(
      SESSION_COOKIE,
      token,
      FIXTURE_SECRETS.SESSION_SECRET,
      { path: "/", secure: true },
    );
    return cookie.split(";", 1)[0];
  }

  async function seed(status, ended = false) {
    const key = randomBytes(13).toString("hex").toUpperCase();
    keys.push(key);
    const year = ended ? "2001" : "2099";
    const [{ id }] = await sql`insert into events
      (event_key, title, starts_at, ends_at, status, capacity, created_by)
      values (${key}, 'Synthetic RSVP controls', ${`${year}-10-01T12:00:00Z`},
        ${`${year}-10-01T13:00:00Z`}, ${status}, 1, ${moderatorId}) returning id`;
    return { id, key, path: `/admin/events/${key}`, jobKey: `sync-event:${key}` };
  }

  async function snapshot({ id, key, jobKey }) {
    const [event] =
      await sql`select rsvp_open, status, updated_at::text from events where id = ${id}`;
    const answers = await sql`select id, user_id, status, created_at::text, updated_at::text,
      synced_to_discord_at::text from rsvps where event_id = ${id} order by created_at, id`;
    const audits = await sql`select causer_id, description, properties from activity_log
      where subject_type = 'Event' and subject_id = ${key} order by id`;
    const jobs = await sql`select job_id, kind, key from queue_jobs where key = ${jobKey}`;
    return { event, answers: [...answers], audits: [...audits], jobs: [...jobs] };
  }

  async function adminHits(worker) {
    const bucket = `admin-write:${ips.get(worker)}`;
    const [{ count }] =
      await sql`select count(*)::int from web_throttle_hits where bucket = ${bucket}`;
    return count;
  }

  async function send(worker, path, status, options = {}, expectedJobs = 0) {
    const response = await fetch(worker.origin + path, {
      method: "POST",
      ...options,
      headers: {
        origin: worker.origin,
        "cf-connecting-ip": ips.get(worker),
        ...(worker === on ? { "x-fixture-admin": "on" } : {}),
        accept: "text/html",
        ...options.headers,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const label = `${worker.name} ${path}`;
    const text = await response.text();
    assert.equal(response.status, status, label);
    assert.equal(
      response.headers.get("x-two-renderer"),
      worker === on && path.startsWith("/admin/") ? "kit" : null,
      label,
    );
    assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/, label);
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /form-action 'self'/,
      label,
    );
    assert.ok(response.headers.get("x-request-id"), label);
    assert.equal(response.headers.get("x-fixture-outbound"), "0", label);
    const sends = JSON.parse(response.headers.get("x-fixture-sends"));
    assert.equal(sends.length, expectedJobs, label);
    return { text, headers: response.headers, sends };
  }

  async function assertQueued(result, event) {
    const [{ message, options }] = result.sends;
    assert.equal(message.eventKey, event.key);
    assert.equal(message.kind, "sync-event");
    assert.equal(message.requestId, result.headers.get("x-request-id"));
    assert.equal(options.delaySeconds, 10);
    assert.deepEqual((await snapshot(event)).jobs, [
      { job_id: message.jobId, kind: "sync-event", key: event.jobKey },
    ]);
  }

  const audit = (before, after) => ({
    causer_id: moderatorId,
    description: `${after ? "reopened" : "paused"} RSVPs for event Synthetic RSVP controls`,
    properties: { rsvpOpen: { before, after } },
  });

  try {
    const modCookie = await session(moderatorId, true);
    const memberCookie = await session(holderId, false);
    const expiredCookie = await session(moderatorId, true, true);
    const moderator = { headers: { cookie: modCookie }, body: new URLSearchParams() };
    const member = { cookie: memberCookie };
    const draft = await seed("draft");
    const ended = await seed("published", true);
    const invalidBefore = [await snapshot(draft), await snapshot(ended)];

    for (const worker of [hono, off, on]) {
      const event = await seed("published");
      const { id, key, path, jobKey } = event;
      await sql`insert into rsvps (event_id, user_id, status, created_at, synced_to_discord_at)
        values (${id}, ${holderId}, 'going', '2020-01-01T00:00:00Z', now()),
          (${id}, ${headId}, 'waitlisted', '2020-01-02T00:00:00Z', now()),
          (${id}, ${nextId}, 'waitlisted', '2020-01-03T00:00:00Z', now())`;
      const before = await snapshot(event);
      const pause = `${path}/rsvp-pause`;
      const reopen = `${path}/rsvp-reopen`;
      const recovery = `/auth/recover?next=${encodeURIComponent(path)}`;

      for (const target of [pause, reopen]) {
        const guest = await send(worker, target, 303, { body: new URLSearchParams() });
        assert.equal(guest.headers.get("location"), recovery);
        assert.equal(guest.headers.getSetCookie().length, 1);
        const expired = await send(worker, target, 401, {
          headers: { ...json, cookie: expiredCookie },
        });
        assert.equal(JSON.parse(expired.text).recovery, recovery);
        assert.equal(expired.headers.getSetCookie().length, 0);
        await send(worker, target, 403, { headers: member });
        const oversized = "x".repeat(4097);
        await send(worker, target, 403, {
          headers: { ...moderator.headers, origin: "https://cross-origin.invalid" },
          body: oversized,
        });
        await send(worker, target, 413, { headers: moderator.headers, body: oversized });
      }
      assert.equal(
        await adminHits(worker),
        0,
        "admission and body-cap refusals spend no admin quota",
      );
      const missing = await send(
        worker,
        `/admin/events/${"0".repeat(26)}/rsvp-reopen`,
        404,
        moderator,
      );
      assert.match(missing.text, /Event not found/);
      for (const invalid of [draft, ended]) {
        for (const action of ["rsvp-pause", "rsvp-reopen"]) {
          const result = await send(worker, `${invalid.path}/${action}`, 422, moderator);
          assert.match(
            result.text,
            /Only published events that have not ended can pause or reopen RSVPs/,
          );
          assert.ok(result.text.includes(`href="${invalid.path}"`));
          assert.ok(result.text.includes('href="/admin/events"'));
        }
      }
      assert.deepEqual([await snapshot(draft), await snapshot(ended)], invalidBefore);
      assert.deepEqual(await snapshot(event), before);

      const beforePause = await adminHits(worker);
      const paused = await send(worker, pause, 303, moderator, 1);
      assert.equal(await adminHits(worker), beforePause + 1, "pause charges the admin bucket");
      assert.equal(paused.headers.get("location"), path);
      assert.equal(paused.headers.getSetCookie().length, 0);
      await assertQueued(paused, event);
      const pausedState = await snapshot(event);
      assert.equal(pausedState.event.rsvp_open, false);
      assert.equal(pausedState.event.status, "published");
      assert.notEqual(pausedState.event.updated_at, before.event.updated_at);
      assert.deepEqual(pausedState.answers, before.answers);
      assert.deepEqual(pausedState.audits, [audit(true, false)]);
      await send(worker, pause, 303, moderator);
      assert.deepEqual(await snapshot(event), pausedState, "pause replay is a no-op");

      const rsvp = `/events/${key}/rsvp`;
      const denied = await send(worker, rsvp, 403, {
        method: "PUT",
        headers: { ...member, ...json },
        body: '{"status":"going"}',
      });
      assert.equal(JSON.parse(denied.text).why, "paused");
      await send(worker, rsvp, 204, { method: "DELETE", headers: member });
      const withdrawn = await snapshot(event);
      assert.deepEqual(withdrawn.answers, before.answers.slice(1));
      assert.deepEqual(withdrawn.audits, pausedState.audits);
      assert.deepEqual(withdrawn.jobs, pausedState.jobs, "pending sync coalesces the withdrawal");
      // Simulate settlement of this fixture's queued job without running the consumer.
      await sql`delete from queue_jobs where key = ${jobKey}`;
      await sql`delete from job_unique_locks where key = ${jobKey}`;

      const beforeReopen = await adminHits(worker);
      const opened = await send(
        worker,
        reopen,
        303,
        { headers: { ...json, cookie: modCookie } },
        1,
      );
      assert.equal(await adminHits(worker), beforeReopen + 1, "reopen charges the admin bucket");
      assert.equal(opened.headers.get("location"), path);
      assert.equal(opened.headers.getSetCookie().length, 0);
      await assertQueued(opened, event);
      const reopened = await snapshot(event);
      assert.equal(reopened.event.rsvp_open, true);
      assert.equal(reopened.event.status, "published");
      assert.deepEqual(reopened.audits, [audit(true, false), audit(false, true)]);
      assert.deepEqual(reopened.answers, [
        {
          ...before.answers[1],
          status: "going",
          synced_to_discord_at: null,
          updated_at: reopened.answers[0].updated_at,
        },
        before.answers[2],
      ]);
      await send(worker, reopen, 303, moderator);
      assert.deepEqual(await snapshot(event), reopened, "reopen replay is a no-op");
    }
  } finally {
    try {
      // Audit rows are append-only. The hosted job discards the database.
      if (keys.length) {
        const jobKeys = keys.map((key) => `sync-event:${key}`);
        await sql`delete from queue_jobs where key in ${sql(jobKeys)}`;
        await sql`delete from job_unique_locks where key in ${sql(jobKeys)}`;
        await sql`delete from events where event_key in ${sql(keys)}`;
      }
      if (sessionHashes.length)
        await sql`delete from web_sessions where token_hash in ${sql(sessionHashes)}`;
      const buckets = [...ips.values()].map((ip) => `admin-write:${ip}`);
      await sql`delete from web_throttle_hits where bucket in ${sql([...buckets, `rsvp-write:${holderId}`])}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log(
    "PASS installed moderator RSVP pause and reopen admission, fallback, audit and FIFO parity",
  );
}
