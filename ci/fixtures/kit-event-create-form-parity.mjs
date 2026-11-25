import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

const fixtureIp = "192.0.2.193";
const formLimit = 32 * 1024;
const form = {
  title: "Synthetic Event + Form",
  starts_at: "2099-07-01 18:30",
  ends_at: "2099-07-01 20:00",
  timezone: "Europe/London",
  capacity: "8",
};

function formAtSize(bytes) {
  const body = new URLSearchParams({ ...form, padding: "" });
  body.set("padding", "x".repeat(bytes - Buffer.byteLength(body.toString())));
  return body;
}

function session(actor, moderator) {
  const token = `two_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return { moderator, token, hash, actor };
}

export async function assertEventCreateFormParity({ hono, off, on, databaseUrl }) {
  const sql = postgres(databaseUrl, { max: 1 });
  const actorPrefix = `900000193${String(randomInt(100_000_000)).padStart(8, "0")}`;
  const moderator = session(`${actorPrefix}0`, true);
  const member = session(`${actorPrefix}1`, false);
  const actors = [moderator.actor, member.actor];
  const eventRows = async () => [
    ...(await sql`
      select event_key, title, status, created_by, discord_event_id from events
      where created_by in ${sql(actors)} order by event_key`),
  ];
  const auditRows = async () => [
    ...(await sql`
      select subject_id, subject_type, causer_id, description from activity_log
      where causer_id in ${sql(actors)} order by subject_id`),
  ];

  try {
    for (const who of [moderator, member]) {
      await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
        values (${who.hash}, ${who.hash}, ${who.actor}, 'Synthetic Event Editor', true,
          ${who.moderator}, now() + interval '15 minutes')`;
      const signed = await generateSignedCookie(
        SESSION_COOKIE,
        who.token,
        FIXTURE_SECRETS.SESSION_SECRET,
        {
          path: "/",
          secure: true,
        },
      );
      who.cookie = signed.split(";", 1)[0];
    }

    async function post(
      worker,
      { label, body = form, cookie = moderator.cookie, foreign = false, status },
    ) {
      const context = `${worker.name}: POST /events ${label}`;
      const response = await fetch(`${worker.origin}/events`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "text/html",
          origin: foreign ? "https://example.invalid" : worker.origin,
          cookie,
          "cf-connecting-ip": fixtureIp,
          "x-forwarded-for": fixtureIp,
        },
        body: new URLSearchParams(body),
      });
      const text = await response.text();
      assert.equal(response.status, status, context);
      assert.equal(response.headers.get("x-two-renderer"), worker === on ? "kit" : null, context);
      assert.equal(response.headers.get("content-type"), "application/json", context);
      assert.equal(response.headers.get("location"), null, context);
      assert.equal(response.headers.get("set-cookie"), null, context);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", context);
      const requestId = response.headers.get("x-request-id");
      assert.ok(requestId, context);
      if ((status === 403 && foreign) || status === 413) {
        assert.equal(response.headers.get("cache-control"), "no-store, private", context);
        assert.equal(response.headers.get("vary"), "Accept", context);
      }
      return { context, requestId, payload: JSON.parse(text) };
    }

    const atLimit = formAtSize(formLimit);
    const oversized = formAtSize(formLimit + 1);
    for (const worker of [hono, off, on]) {
      for (const [label, status, options, expected] of [
        [
          "foreign oversized form",
          403,
          { body: oversized, foreign: true },
          { error: "cross_origin" },
        ],
        [
          "oversized member form",
          413,
          { body: oversized, cookie: member.cookie },
          {
            reason: "payload_too_large",
            message: "Reduce the size of your request and try again.",
          },
        ],
        ["member form", 403, { cookie: member.cookie }, { error: "forbidden" }],
        [
          "invalid form",
          422,
          { body: { ...form, ends_at: form.starts_at, event_key: "fixture" } },
          {
            error: "invalid",
            fields: {
              event_key:
                "The event key is assigned when the event is created and cannot be changed.",
              ends_at: "The end is after the start.",
            },
          },
        ],
      ]) {
        const { context, requestId, payload } = await post(worker, { label, status, ...options });
        assert.deepEqual(payload, { ...expected, request_id: requestId }, context);
      }
    }
    assert.deepEqual(await eventRows(), [], "refused forms leave no event rows");
    assert.deepEqual(await auditRows(), [], "refused forms leave no audit rows");

    // Create commits a local draft and its audit. The loopback workers have no sync queue binding.
    const keys = [];
    for (const worker of [hono, off, on]) {
      const { context, payload } = await post(worker, {
        label: "valid form at the 32 KiB limit",
        body: atLimit,
        status: 201,
      });
      const key = payload.data?.event_key;
      assert.match(key ?? "", /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, context);
      keys.push(key);
      assert.deepEqual(
        payload,
        {
          data: {
            event_key: key,
            title: form.title,
            game: null,
            description: null,
            starts_at: "2099-07-01T17:30:00.000Z",
            ends_at: "2099-07-01T19:00:00.000Z",
            starts_at_local: form.starts_at,
            ends_at_local: form.ends_at,
            timezone: form.timezone,
            location: null,
            capacity: 8,
            going_count: 0,
            going_occupancy: 0,
            status: "draft",
            rsvp_open: true,
            synced_to_discord: false,
          },
        },
        context,
      );
    }
    assert.equal(new Set(keys).size, 3, "each successful form creates a fresh draft");
    keys.sort();
    assert.deepEqual(
      await eventRows(),
      keys.map((event_key) => ({
        event_key,
        title: form.title,
        status: "draft",
        created_by: moderator.actor,
        discord_event_id: null,
      })),
    );
    assert.deepEqual(
      await auditRows(),
      keys.map((subject_id) => ({
        subject_id,
        subject_type: "Event",
        causer_id: moderator.actor,
        description: `created event ${form.title}`,
      })),
    );
  } finally {
    try {
      // The disposable database teardown removes the append-only audit rows.
      await sql`delete from events where created_by in ${sql(actors)}`;
      await sql`delete from web_sessions where token_hash in ${sql([moderator.hash, member.hash])}`;
      await sql`delete from web_throttle_hits where bucket = ${`event-write:${fixtureIp}`}`;
    } finally {
      await sql.end();
    }
  }
  console.log("PASS Worker POST /events form admission, draft output and default-off fallback");
}
