import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { Env } from "../src/env";
import { pgEventStore } from "../src/jobs/events";
import type { QueueMessage } from "../src/jobs/types";
import { STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const DB_NAME = "two_web_next_tog19289";
const operator = "100000000000000111";
const secret = "test-session-secret-at-least-32-bytes-long";
const sourceIdentity = "01ARZ3NDEKTSV4RRFFQ69G5FAA";

function baseEnv(queueSend: (body: QueueMessage) => void): Env {
  return {
    APP_URL: STAGING_APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "1545644954272137297",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: secret,
    DATABASE_URL: `postgres://agent_test@agent-testdb:5432/${DB_NAME}`,
    QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
    QUEUE_RECONCILE_OPERATOR_ID: operator,
    // The transport receipt is irrelevant here; the suite counts deliveries.
    SYNC_EVENT_QUEUE: {
      send: queueSend as unknown as NonNullable<Env["SYNC_EVENT_QUEUE"]>["send"],
    },
  };
}

describe.skipIf(!process.env.DATABASE_URL)("guarded one-row failed-job re-dispatch apply", () => {
  let sql: postgres.Sql;
  let store: ReturnType<typeof createMemorySessionStore>;
  let bearer: string;
  let sent: unknown[];

  beforeAll(async () => {
    const adminUrl = new URL(process.env.DATABASE_URL!);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.href, {
      max: 1,
      connect_timeout: 5,
      password: () => adminUrl.password,
      onnotice: () => {},
    });
    try {
      const rows = (await admin.unsafe(
        "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
        [DB_NAME],
      )) as unknown as { owner: string }[];
      const owner = rows[0]?.owner;
      if (owner) {
        if (owner !== "agent_test") {
          throw new Error(`refusing to drop database owned by ${owner}`);
        }
        await admin.unsafe(`DROP DATABASE "${DB_NAME}" WITH (FORCE)`);
      }
      await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
    } finally {
      await admin.end({ timeout: 1 });
    }
    const dbUrl = `postgres://agent_test@agent-testdb:5432/${DB_NAME}`;
    const migrate = postgres(dbUrl, {
      max: 1,
      connect_timeout: 5,
      password: () => "",
      onnotice: () => {},
    });
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url).href),
      });
      await migrate.begin(async (tx) => {
        for (const migration of migrations)
          for (const statement of migration.sql) {
            if (statement.trim()) await tx.unsafe(statement);
          }
      });
    } finally {
      await migrate.end({ timeout: 1 });
    }
    sql = postgres(dbUrl, { max: 2, connect_timeout: 5, password: () => "", onnotice: () => {} });
    store = createMemorySessionStore();
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: operator,
      username: "fixture",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600000),
    });
    bearer = (
      await serializeSigned("__Host-two_session", token, secret, {
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
      })
    ).split(";")[0]!;
  }, 120000);
  afterAll(async () => {
    try {
      await sql?.end({ timeout: 1 });
    } finally {
      const adminUrl = new URL(process.env.DATABASE_URL!);
      adminUrl.pathname = "/postgres";
      const admin = postgres(adminUrl.href, {
        max: 1,
        connect_timeout: 5,
        password: () => adminUrl.password,
        onnotice: () => {},
      });
      try {
        await admin.unsafe(`DROP DATABASE "${DB_NAME}" WITH (FORCE)`);
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
  }, 60000);

  beforeEach(async () => {
    await sql`delete from event_sync_attempts`;
    await sql`delete from events`;
    await sql`delete from queue_failed_jobs`;
    await sql`delete from queue_jobs`;
    await sql`delete from job_unique_locks`;
    await sql`insert into events (event_key, title, starts_at, ends_at, status, discord_event_id, synced_revision)
      values (${sourceIdentity}, 'Redispatch fixture', now(), now() + interval '1 hour', 'published', 'mapped', 1)`;
    sent = [];
  });

  async function seedDeadRow(reason = "private transport diagnostics"): Promise<number> {
    const [row] = await sql`insert into queue_failed_jobs (job_id, kind, key, reason)
      values (${crypto.randomUUID()}::uuid, 'sync-event', ${`sync-event:${sourceIdentity}`}, ${reason})
      returning id`;
    return Number((row as { id: number }).id);
  }

  async function state(failureId: number) {
    const [dead] = await sql`select * from queue_failed_jobs where id = ${failureId}`;
    const live = await sql`select job_id, kind, key from queue_jobs order by job_id`;
    const locks = await sql`select * from job_unique_locks`;
    const receipts = await sql`select * from activity_log
      where description = 'queue.failed.redispatch' and subject_id = ${String(failureId)}`;
    return { dead, live, locks, receipts };
  }

  function request(path: string, init: RequestInit = {}) {
    const app = new Hono().route("/admin", adminApp(store));
    return app.request(
      `${STAGING_APP_URL}${path}`,
      {
        method: "POST",
        ...init,
        headers: { origin: STAGING_APP_URL, cookie: bearer, ...init.headers },
      },
      baseEnv((body) => void sent.push(body)),
    );
  }

  async function previewAdvice(failureId: number) {
    const app = new Hono().route("/admin", adminApp(store));
    const res = await app.request(
      `${STAGING_APP_URL}/admin/queue/failed/${failureId}/preview`,
      { headers: { origin: STAGING_APP_URL, cookie: bearer } },
      baseEnv(() => {}),
    );
    return { status: res.status, body: await res.json() };
  }

  it("re-dispatches replay advice exactly once and audits the bounded receipt", async () => {
    await sql`update events set title = 'Changed' where event_key = ${sourceIdentity}`;
    const failureId = await seedDeadRow();
    const res = await request(`/admin/queue/failed/${failureId}/redispatch`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      redispatched: true,
      failure: { id: failureId, kind: "sync-event" },
      disposition: { action: "replay" },
    });
    expect(JSON.stringify(body)).not.toContain("private transport diagnostics");
    expect(body as Record<string, unknown>).not.toHaveProperty("deduped");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "sync-event", eventKey: sourceIdentity });
    const { dead, live, receipts } = await state(failureId);
    expect(dead).toBeDefined();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: "sync-event", key: `sync-event:${sourceIdentity}` });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      log_name: "operations",
      description: "queue.failed.redispatch",
      subject_type: "queue_failed_jobs",
      subject_id: String(failureId),
      causer_type: "User",
      causer_id: operator,
      event: "dispatch",
    });
    expect(JSON.stringify(receipts[0])).not.toContain("private transport diagnostics");
    // Receipts count attempts: the dispatch outcome lives in the response,
    // and the trail stays append-only. Real dispatches are the live rows.
    expect(
      (receipts[0] as { properties: { outcome: { after: string } } }).properties.outcome,
    ).toEqual({
      before: null,
      after: "attempted",
    });
    // The advice is unchanged: the row stays until a confirmed recovery discards it.
    const preview = await previewAdvice(failureId);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ disposition: { action: "replay" } });
  });

  it("a double submit sends once, receipts each attempt, and reports the in-flight dispatch", async () => {
    await sql`update events set title = 'Changed' where event_key = ${sourceIdentity}`;
    const failureId = await seedDeadRow();
    const first = await (await request(`/admin/queue/failed/${failureId}/redispatch`)).json();
    const second = await request(`/admin/queue/failed/${failureId}/redispatch`);
    expect(first).toMatchObject({ redispatched: true });
    expect(first).not.toHaveProperty("deduped");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ redispatched: true, deduped: true });
    expect(sent).toHaveLength(1);
    const { dead, live, receipts } = await state(failureId);
    expect(dead).toBeDefined();
    expect(live).toHaveLength(1);
    // One receipt per attempt: the deduped report reuses its own attempt's
    // receipt instead of borrowing the in-flight dispatch's.
    expect(receipts).toHaveLength(2);
    const outcomes = (receipts as unknown as { properties: { outcome: { after: string } } }[]).map(
      (r) => r.properties.outcome.after,
    );
    // Both attempts share the attempt outcome; only the responses tell the
    // dispatch apart from the deduped report.
    expect(outcomes).toEqual(["attempted", "attempted"]);
  });

  it("a definitive refusal is refused untouched with unchanged advice", async () => {
    const events = pgEventStore(sql);
    await sql`update events set title = 'Dirty' where event_key = ${sourceIdentity}`;
    const attempt = await events.prepareSync(sourceIdentity, crypto.randomUUID(), new Date());
    if (!attempt || "waiting" in attempt) throw new Error("fixture snapshot missing");
    await events.failSync(attempt.idempotencyKey);
    const failureId = await seedDeadRow();
    const res = await request(`/admin/queue/failed/${failureId}/redispatch`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "redispatch_refused",
      failure: { id: failureId },
      disposition: { action: "keep" },
    });
    expect((body as { disposition: { reason: string } }).disposition.reason).toMatch(
      /definitive refusal/,
    );
    expect(sent).toHaveLength(0);
    const { dead, live, receipts } = await state(failureId);
    expect(dead).toBeDefined();
    expect(live).toHaveLength(0);
    // The refusal carries the preview advice, so it carries a receipt.
    expect(receipts).toHaveLength(1);
    expect(
      (receipts[0] as { properties: { outcome: { after: string } } }).properties.outcome.after,
    ).toBe("refused");
    const preview = await previewAdvice(failureId);
    expect(preview.body).toMatchObject({ disposition: { action: "keep" } });
  });

  it("a stale row is never deleted by the apply path", async () => {
    const failureId = await seedDeadRow();
    const res = await request(`/admin/queue/failed/${failureId}/redispatch`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "redispatch_refused",
      disposition: { action: "discard-stale" },
    });
    expect(sent).toHaveLength(0);
    const { dead, live, receipts } = await state(failureId);
    expect(dead).toBeDefined();
    expect(live).toHaveLength(0);
    // The refusal carries the preview advice, so it carries a receipt.
    expect(receipts).toHaveLength(1);
    expect(
      (receipts[0] as { properties: { outcome: { after: string } } }).properties.outcome.after,
    ).toBe("refused");
    const preview = await previewAdvice(failureId);
    expect(preview.body).toMatchObject({ disposition: { action: "discard-stale" } });
  });

  it("a queue failure leaves the row and the advice untouched but audits the attempt", async () => {
    await sql`update events set title = 'Changed' where event_key = ${sourceIdentity}`;
    const failureId = await seedDeadRow();
    const app = new Hono().route("/admin", adminApp(store));
    const res = await app.request(
      `${STAGING_APP_URL}/admin/queue/failed/${failureId}/redispatch`,
      {
        method: "POST",
        headers: { origin: STAGING_APP_URL, cookie: bearer },
      },
      baseEnv(() => {
        throw new Error("private queue outage");
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "redispatch_unavailable" });
    const { dead, live, receipts } = await state(failureId);
    expect(dead).toBeDefined();
    // The ledger compensation removes the un-sent row: no phantom backlog.
    expect(live).toHaveLength(0);
    // The receipt is written before the queue send, so the 503 keeps it.
    expect(receipts).toHaveLength(1);
    expect(
      (receipts[0] as { properties: { outcome: { after: string } } }).properties.outcome.after,
    ).toBe("attempted");
    const preview = await previewAdvice(failureId);
    expect(preview.body).toMatchObject({ disposition: { action: "replay" } });
  });

  it("a missing source keeps the dead row for operator review", async () => {
    await sql`delete from events`;
    const failureId = await seedDeadRow();
    const res = await request(`/admin/queue/failed/${failureId}/redispatch`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "redispatch_refused",
      disposition: { action: "keep" },
    });
    expect(sent).toHaveLength(0);
    const { dead, receipts } = await state(failureId);
    expect(dead).toBeDefined();
    // The refusal carries the preview advice, so it carries a receipt.
    expect(receipts).toHaveLength(1);
    expect(
      (receipts[0] as { properties: { outcome: { after: string } } }).properties.outcome.after,
    ).toBe("refused");
  });
});
