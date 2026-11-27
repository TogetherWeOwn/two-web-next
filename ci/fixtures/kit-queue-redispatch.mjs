import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { STAGING_ORIGIN } from "../operator-constants.mjs";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

async function writeFixtureWorker(entry, worker, operatorId) {
  // Use the exact staging URL inside the Worker only. The driver connects over
  // loopback and the sole queue binding is an in-request outbox.
  await writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import worker from ${JSON.stringify(worker)};
let outbound = false;
globalThis.fetch = async () => {
  outbound = true;
  throw new Error("Queue redispatch fixture forbids outbound HTTP");
};
export default {
  async fetch(incoming, env, context) {
    const local = new URL(incoming.url);
    if (local.pathname === "/favicon.ico") return worker.fetch(incoming, env, context);
    const owner = incoming.headers.get("x-fixture-owner");
    if (!["kit", "hono", "unset", "wrong-stage"].includes(owner))
      return new Response(null, { status: 400 });
    const outbox = [];
    const origin = owner === "wrong-stage" ? local.origin : ${JSON.stringify(STAGING_ORIGIN)};
    const bindings = {
      ...env,
      APP_URL: origin,
      KIT_ROUTE_ADMIN: owner === "hono" || owner === "unset" ? "true" : "false",
      KIT_ROUTE_ADMIN_QUEUE_REDISPATCH: owner === "unset" ? undefined : String(owner !== "hono"),
      QUEUE_RECONCILE_PREVIEW_ENABLED: String(!incoming.headers.has("x-fixture-disabled")),
      QUEUE_RECONCILE_OPERATOR_ID: ${JSON.stringify(operatorId)},
      SYNC_EVENT_QUEUE: { async send(message, options) { outbox.push({ message, options }); } },
    };
    const url = new URL(local.pathname + local.search, origin);
    const request = new Request(url, incoming);
    request.headers.delete("x-fixture-owner");
    request.headers.delete("x-fixture-disabled");
    request.headers.set("host", url.host);
    request.headers.set("cf-connecting-ip", ${JSON.stringify(`fixture-redispatch-${operatorId}`)});
    if (request.headers.get("origin") === local.origin) request.headers.set("origin", origin);
    else if (request.headers.get("origin") === "") request.headers.delete("origin");
    const response = await withEnv(bindings, () => worker.fetch(request, bindings, context));
    if (outbound) throw new Error("Queue redispatch fixture attempted outbound HTTP");
    const headers = new Headers(response.headers);
    headers.set("x-fixture-outbox", JSON.stringify(outbox));
    return new Response(response.body, { status: response.status, headers });
  },
};\n`,
  );
}

async function fixtureSession(sql, userId, moderator) {
  const token = `two_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`insert into web_sessions
      (token_hash, status_hash, user_id, username, member, moderator, expires_at, roles_checked_at)
    values (${hash}, ${hash}, ${userId}, 'Redispatch fixture', true, ${moderator},
      now() + interval '1 hour', now())`;
  return (
    await generateSignedCookie(SESSION_COOKIE, token, FIXTURE_SECRETS.SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";", 1)[0];
}

export async function assertKitQueueRedispatchServing({ worker, scratch, databaseUrl, start }) {
  const sql = postgres(databaseUrl, { max: 1 });
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const [operatorId, moderatorId, memberId] = [actor, actor + 1n, actor + 2n].map(String);
  const bucket = `admin-write:fixture-redispatch-${operatorId}`;
  const eventKeys = [];
  const deadJobs = [];
  const entry = join(scratch, "kit-queue-redispatch.mjs");
  try {
    const operator = await fixtureSession(sql, operatorId, true);
    const moderator = await fixtureSession(sql, moderatorId, true);
    const member = await fixtureSession(sql, memberId, false);
    await writeFixtureWorker(entry, worker, operatorId);
    const origin = await start(entry);

    async function visit(owner, path, status, options = {}) {
      const {
        cookie = operator,
        method = "POST",
        originHeader = origin,
        disabled = false,
        owned = owner === "kit",
        body,
        dispatched = false,
      } = options;
      const response = await fetch(`${origin}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "application/json",
          origin: originHeader,
          "sec-fetch-site": "same-origin",
          ...(cookie ? { cookie } : {}),
          ...(disabled ? { "x-fixture-disabled": "1" } : {}),
          "x-fixture-owner": owner,
        },
        body,
      });
      const data = (await response.text()) || null;
      const label = `${owner} ${method} ${path} (${status})`;
      assert.equal(response.status, status, label);
      assert.equal(response.headers.get("x-two-renderer"), owned ? "kit" : null, label);
      assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/, label);
      assert.ok(response.headers.get("x-request-id"), label);
      const outbox = JSON.parse(response.headers.get("x-fixture-outbox"));
      assert.equal(outbox.length, dispatched ? 1 : 0, label);
      return { response, body: data === null ? null : JSON.parse(data), outbox };
    }

    async function deadRow(eventKey) {
      const jobId = randomUUID();
      deadJobs.push(jobId);
      const [row] = await sql`insert into queue_failed_jobs (job_id, kind, key, reason)
        values (${jobId}, 'sync-event', ${`sync-event:${eventKey}`}, 'synthetic transport diagnostics')
        returning *`;
      return row;
    }
    const queue = async () => [
      ...(await sql`select job_id, kind, key from queue_jobs order by job_id`),
    ];
    const locks = async () => [
      ...(await sql`select key, owner_token from job_unique_locks order by key`),
    ];
    const receipts = () => sql`select log_name, description, subject_type, subject_id,
      causer_type, causer_id, event, properties from activity_log
      where causer_id = ${operatorId} order by id`;
    const pathFor = (id) => `/admin/queue/failed/${id}/redispatch`;

    for (const owner of ["hono", "kit"]) {
      const eventKey = `01${randomBytes(12).toString("hex").toUpperCase()}`;
      eventKeys.push(eventKey);
      const [source] = await sql`insert into events
        (event_key, title, starts_at, ends_at, status, discord_event_id, sync_revision, synced_revision)
        values (${eventKey}, 'Redispatch fixture', now(), now() + interval '1 hour',
          'published', ${`redispatch-fixture-${eventKey}`}, 2, 1)
        returning *`;
      const dead = await deadRow(eventKey);
      const missingSource = await deadRow(`01${randomBytes(12).toString("hex").toUpperCase()}`);
      const path = pathFor(dead.id);
      const before = { queue: await queue(), locks: await locks(), receipts: await receipts() };

      async function refuse(status, options, field, value, target = path, mode = owner) {
        const result = await visit(mode, target, status, options);
        assert.equal(result.body?.[field], value);
      }
      await refuse(404, { disabled: true }, "error", "redispatch_disabled");
      const guest = await visit(owner, path, 401, { cookie: null });
      assert.equal(guest.body.error, "unauthenticated");
      assert.equal(guest.body.recovery, "/auth/recover?next=%2Fadmin");
      await refuse(403, { cookie: member }, "error", "forbidden");
      await refuse(403, { cookie: moderator }, "error", "operator_required");
      await refuse(403, { originHeader: "" }, "error", "cross_origin");
      await refuse(403, { originHeader: "https://foreign.invalid" }, "error", "cross_origin");
      await refuse(413, { body: "x".repeat(4097) }, "reason", "payload_too_large");
      await refuse(422, {}, "error", "invalid_failure_id", pathFor(`0${dead.id}`));
      await refuse(422, {}, "error", "invalid_failure_id", `${path}?eventKey=override`);
      await refuse(404, {}, "error", "failure_not_found", pathFor("9007199254740991"));

      await sql`insert into web_throttle_hits (bucket)
        select ${bucket} from generate_series(1, 30)`;
      await refuse(429, {}, "reason", "rate_limited");
      await refuse(403, { cookie: moderator }, "error", "operator_required");
      await refuse(413, { body: "x".repeat(4097) }, "reason", "payload_too_large");
      await sql`delete from web_throttle_hits where bucket = ${bucket}`;

      // Force the append to fail on the disposable DB while the source is
      // replayable. Each owner must refuse before reaching the stub outbox.
      await sql`alter table activity_log add constraint fixture_redispatch_audit_failure
        check (description is distinct from 'queue.failed.redispatch') not valid`;
      try {
        await refuse(503, {}, "error", "redispatch_unavailable");
      } finally {
        await sql`alter table activity_log drop constraint fixture_redispatch_audit_failure`;
      }
      assert.deepEqual(
        await receipts(),
        before.receipts,
        `${owner} denied admission has no receipt`,
      );
      assert.deepEqual(await queue(), before.queue, `${owner} refusals leave the ledger alone`);
      assert.deepEqual(await locks(), before.locks, `${owner} refusals take no queue lease`);

      if (owner === "kit") {
        await refuse(404, { disabled: true }, "error", "redispatch_disabled", path, "unset");
        await refuse(404, {}, "error", "redispatch_disabled", path, "wrong-stage");
        const get = await visit(owner, path, 405, { method: "GET", owned: false });
        assert.equal(get.response.headers.get("allow"), "POST");
        await refuse(
          404,
          { disabled: true, owned: false },
          "error",
          "redispatch_disabled",
          path.replace("/failed/", "/%66ailed/"),
        );
        await refuse(
          404,
          { method: "GET", disabled: true, owned: false },
          "error",
          "preview_disabled",
          path.replace("/redispatch", "/preview"),
        );
        await refuse(
          404,
          { method: "GET", owned: false },
          "error",
          "evidence_disabled",
          `/admin/queue/source-evidence/${dead.id}`,
        );
      }

      const kept = await visit(owner, pathFor(missingSource.id), 409);
      assert.deepEqual(kept.body, {
        error: "redispatch_refused",
        failure: {
          id: Number(missingSource.id),
          kind: "sync-event",
          failedAt: missingSource.failed_at.toISOString(),
        },
        disposition: {
          action: "keep",
          reason: "source is missing; preserve dead row for operator review",
        },
      });
      const [refusal] = (await receipts()).slice(before.receipts.length);
      assert.equal(refusal.properties.outcome.after, "refused");
      assert.deepEqual(await queue(), before.queue);
      assert.deepEqual(await locks(), before.locks);

      const result = await visit(owner, path, 200, {
        body: JSON.stringify({ eventKey: "body-cannot-select-the-source" }),
        dispatched: true,
      });
      assert.equal(new Date(result.body.observedAt).toISOString(), result.body.observedAt);
      const { message, options } = result.outbox[0];
      const { jobId, leaseToken, idempotencyKey } = message;
      for (const key of [jobId, leaseToken, idempotencyKey]) assert.match(key, /^[0-9a-f-]{36}$/);
      assert.deepEqual(message, {
        kind: "sync-event",
        eventKey,
        jobId,
        leaseToken,
        idempotencyKey,
      });
      assert.deepEqual(options, { delaySeconds: 10 });
      assert.deepEqual(result.body, {
        redispatched: true,
        failure: {
          id: Number(dead.id),
          kind: "sync-event",
          failedAt: dead.failed_at.toISOString(),
        },
        observedAt: result.body.observedAt,
        disposition: {
          action: "replay",
          reason: `source for ${eventKey} is still dirty; fresh dispatch`,
        },
      });
      const writes = (await receipts()).slice(before.receipts.length);
      assert.equal(writes.length, 2, "one refusal receipt and one attempt receipt");
      assert.deepEqual(writes[1], {
        log_name: "operations",
        description: "queue.failed.redispatch",
        subject_type: "queue_failed_jobs",
        subject_id: String(dead.id),
        causer_type: "User",
        causer_id: operatorId,
        event: "dispatch",
        properties: {
          disposition: { before: null, after: "replay" },
          reason: { before: null, after: result.body.disposition.reason },
          observedAt: { before: null, after: result.body.observedAt },
          outcome: { before: null, after: "attempted" },
        },
      });
      const ledgerKey = `sync-event:${eventKey}`;
      const live = await queue();
      const leases = await locks();
      assert.deepEqual(
        live.filter((row) => row.job_id !== jobId),
        before.queue,
      );
      assert.deepEqual(
        live.find((row) => row.job_id === jobId),
        { job_id: jobId, kind: "sync-event", key: ledgerKey },
      );
      assert.deepEqual(
        leases.filter((row) => row.key !== ledgerKey),
        before.locks,
      );
      assert.deepEqual(
        leases.find((row) => row.key === ledgerKey),
        { key: ledgerKey, owner_token: leaseToken },
      );
      const [storedSource] = await sql`select * from events where event_key = ${eventKey}`;
      const [storedDead] = await sql`select * from queue_failed_jobs where id = ${dead.id}`;
      const [storedRefusal] =
        await sql`select * from queue_failed_jobs where id = ${missingSource.id}`;
      assert.deepEqual(storedSource, source);
      assert.deepEqual(storedDead, dead);
      assert.deepEqual(storedRefusal, missingSource);
      console.log(
        `PASS installed Worker queue redispatch ${owner} ownership, zero denied sends, one audited stub intent`,
      );
    }
  } finally {
    try {
      for (const key of eventKeys) {
        await sql`delete from queue_jobs where key = ${`sync-event:${key}`}`;
        await sql`delete from job_unique_locks where key = ${`sync-event:${key}`}`;
        await sql`delete from events where event_key = ${key}`;
      }
      for (const id of deadJobs) {
        await sql`delete from queue_failed_jobs where job_id = ${id}`;
      }
      // The append-only receipts leave with the job's disposable database.
      await sql`delete from web_sessions where user_id in (${operatorId}, ${moderatorId}, ${memberId})`;
      await sql`delete from web_throttle_hits where bucket = ${bucket}`;
    } finally {
      await sql.end();
    }
  }
}
