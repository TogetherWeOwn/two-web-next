// Event-reminder data model: the
// opt-out column, mute/inbox/delivery tables, 90-day delivery retention in
// the model:prune pass, and member-read gating for the new tables.
//
// Live round-trips use a guarded disposable schema on agent-testdb or the
// explicitly allowed GitHub CI Postgres service.
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordAccess } from "../src/admin/store";
import {
  eventReminderDeliveries,
  eventReminderMutes,
  memberDataAccessLogs,
  notifications,
} from "../src/db/admin-schema";
import { observeMemberReads } from "../src/db/member-reads";
import type { Env } from "../src/env";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores } from "../src/jobs/postgres";
import { bufferedMemberText, keyedMemberRead, memberReadBoundary } from "../src/member-reads";
import { env } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const url = process.env.DATABASE_URL;
const DAY_MS = 86_400_000;
const EVENT_KEY = "reminder-model-test-event";
const VIEWER = "100000000000000301";
const MEMBER = "100000000000000302";

describe.skipIf(!url)("event reminder data model (real Postgres)", () => {
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(url!);
  });

  beforeEach(async () => {
    await fixture.client`delete from event_reminder_deliveries`;
    await fixture.client`delete from event_reminder_mutes`;
    await fixture.client`delete from notifications`;
    await fixture.reset();
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  const seedEvent = async () =>
    (
      (await fixture.client`insert into events
        (event_key, title, starts_at, ends_at) values
        (${EVENT_KEY}, 'Synthetic reminder event', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z')
        returning id`) as { id: number }[]
    )[0]!.id;

  it("profiles stay subscribed unless opted out", async () => {
    await fixture.client`insert into profiles (user_id) values (${MEMBER})`;
    const [row] = (await fixture.client`select reminder_opt_out from profiles
      where user_id = ${MEMBER}`) as { reminder_opt_out: boolean }[];
    expect(row!.reminder_opt_out).toBe(false);
    await fixture.client`update profiles set reminder_opt_out = true where user_id = ${MEMBER}`;
    const [opted] = (await fixture.client`select reminder_opt_out from profiles
      where user_id = ${MEMBER}`) as { reminder_opt_out: boolean }[];
    expect(opted!.reminder_opt_out).toBe(true);
  });

  it("mutes are one row per member per event and follow the event", async () => {
    const eventId = await seedEvent();
    await fixture.client`insert into event_reminder_mutes (event_id, user_id)
      values (${eventId}, ${MEMBER})`;
    await expect(
      fixture.client`insert into event_reminder_mutes (event_id, user_id)
        values (${eventId}, ${MEMBER})`,
    ).rejects.toMatchObject({ code: "23505" });
    await fixture.client`delete from events where id = ${eventId}`;
    const left = (await fixture.client`select count(*)::int as n from event_reminder_mutes`) as {
      n: number;
    }[];
    expect(left[0]!.n).toBe(0);
  });

  it("notifications carry a nullable event link and a user+read index", async () => {
    const eventId = await seedEvent();
    await fixture.client`insert into notifications (user_id, kind, event_id, title, body, url)
      values (${MEMBER}, 'event_reminder', ${eventId}, 'T', 'B', 'https://example.test/e/1')`;
    await fixture.client`insert into notifications (user_id, kind, event_id, title, body, url)
      values (${MEMBER}, 'event_reminder', null, 'T', 'B', 'https://example.test/e/1')`;
    const [withEvent] = (await fixture.client`select read_at, created_at from notifications
      where event_id = ${eventId}`) as { read_at: string | null; created_at: string }[];
    expect(withEvent!.read_at).toBeNull();
    expect(withEvent!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const indexes = (await fixture.client`select indexname from pg_indexes
      where schemaname = ${fixture.schemaName} and tablename = 'notifications'`) as {
      indexname: string;
    }[];
    expect(indexes.map((row) => row.indexname)).toContain("notifications_user_id_read_at_idx");
    await fixture.client`delete from events where id = ${eventId}`;
    const left = (await fixture.client`select count(*)::int as n from notifications`) as {
      n: number;
    }[];
    // The cascade removes the linked row; the unlinked row survives.
    expect(left[0]!.n).toBe(1);
  });

  it("deliveries log one row per tuple with checked lead, channel, and status", async () => {
    const eventId = await seedEvent();
    await fixture.client`insert into event_reminder_deliveries
      (event_id, user_id, lead, channel, status) values
      (${eventId}, ${MEMBER}, '24h', 'site', 'sent')`;
    await expect(
      fixture.client`insert into event_reminder_deliveries
        (event_id, user_id, lead, channel, status) values
        (${eventId}, ${MEMBER}, '24h', 'site', 'sent')`,
    ).rejects.toMatchObject({ code: "23505" });
    for (const [column, value] of [
      ["lead", "12h"],
      ["channel", "email"],
      ["status", "queued"],
    ] as const) {
      const row = { lead: "24h", channel: "site", status: "sent", [column]: value };
      await expect(
        fixture.client`insert into event_reminder_deliveries
          (event_id, user_id, lead, channel, status) values
          (${eventId}, ${MEMBER}, ${row.lead}, ${row.channel}, ${row.status})`,
      ).rejects.toMatchObject({ code: "23514" });
    }
    const [logged] = (await fixture.client`select error_code, sent_at
      from event_reminder_deliveries`) as { error_code: string | null; sent_at: string }[];
    expect(logged!.error_code).toBeNull();
    expect(logged!.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    await fixture.client`delete from events where id = ${eventId}`;
    const left = (await fixture.client`select count(*)::int as n
      from event_reminder_deliveries`) as { n: number }[];
    expect(left[0]!.n).toBe(0);
  });

  it("mutes and deliveries index user_id for erasure reads", async () => {
    for (const [table, index] of [
      ["event_reminder_mutes", "event_reminder_mutes_user_id_idx"],
      ["event_reminder_deliveries", "event_reminder_deliveries_user_id_idx"],
    ] as const) {
      const indexes = (await fixture.client`select indexname from pg_indexes
        where schemaname = ${fixture.schemaName} and tablename = ${table}`) as {
        indexname: string;
      }[];
      expect(indexes.map((row) => row.indexname)).toContain(index);
    }
  });

  it("model:prune deletes only deliveries older than 90 days", async () => {
    const eventId = await seedEvent();
    const now = new Date();
    const at = {
      old: new Date(now.getTime() - 91 * DAY_MS).toISOString(),
      edge: new Date(now.getTime() - 90 * DAY_MS).toISOString(),
      fresh: new Date(now.getTime() - DAY_MS).toISOString(),
    };
    await fixture.client`insert into event_reminder_deliveries
      (event_id, user_id, lead, channel, status, sent_at) values
      (${eventId}, ${MEMBER}, '24h', 'site', 'sent', ${at.old}),
      (${eventId}, ${MEMBER}, '1h', 'site', 'sent', ${at.edge}),
      (${eventId}, ${MEMBER}, '24h', 'dm', 'sent', ${at.fresh})`;
    // A raw pool, never drizzled: drizzle() rewrites the pool's timestamp
    // serializers to identity, so Date params through fixture.client crash
    // in the driver. The production prune pools are raw too.
    const raw = postgres(url!, {
      max: 1,
      connect_timeout: 5,
      password: () => new URL(url!).password,
      onnotice: () => {},
      connection: { search_path: fixture.schemaName },
    });
    let counts: Awaited<ReturnType<typeof pruneModelTables>>;
    let again: typeof counts;
    try {
      counts = await pruneModelTables(pgPruneStores(raw), now);
      expect(counts).toEqual({
        agentEventAudits: 0,
        accessLog: 0,
        joinAttempts: 0,
        idempotencyKeys: 0,
        searchLog: 0,
        boardViews: 0,
        reminderDeliveries: 1,
        sessions: 0,
        jobUniqueLocks: 0,
      });
      const survivors = (await fixture.client`select lead, channel from event_reminder_deliveries
      order by lead, channel`) as { lead: string; channel: string }[];
      // Age-only, like every other pruned table: strictly older than the cutoff
      // goes, the cutoff-exact and fresh rows survive.
      expect(survivors).toEqual([
        { lead: "1h", channel: "site" },
        { lead: "24h", channel: "dm" },
      ]);
      again = await pruneModelTables(pgPruneStores(raw), now);
    } finally {
      await raw.end();
    }
    expect(again!.reminderDeliveries).toBe(0);
  });

  it("keyed reads over reminder tables capture their owners", async () => {
    const eventId = await seedEvent();
    await fixture.client`insert into event_reminder_mutes (event_id, user_id)
      values (${eventId}, ${MEMBER})`;
    await fixture.client`insert into notifications (user_id, kind, title, body, url)
      values (${MEMBER}, 'event_reminder', 'T', 'B', 'https://example.test/e/1')`;
    await fixture.client`insert into event_reminder_deliveries
      (event_id, user_id, lead, channel, status) values
      (${eventId}, ${MEMBER}, '24h', 'site', 'sent')`;
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", (c, next) =>
      memberReadBoundary(
        c,
        { resource: "member", action: "list", route: "test.reminder-reads", viewer: VIEWER },
        (entry) => recordAccess(fixture.db, entry),
        next,
      ),
    );
    app.get("/existing", async (c) => {
      const db = observeMemberReads(fixture.db);
      const mutes = await keyedMemberRead(() =>
        db
          .select({ eventId: eventReminderMutes.eventId, userId: eventReminderMutes.userId })
          .from(eventReminderMutes),
      );
      const inbox = await keyedMemberRead(() =>
        db.select({ id: notifications.id, userId: notifications.userId }).from(notifications),
      );
      const logged = await keyedMemberRead(() =>
        db
          .select({ id: eventReminderDeliveries.id, userId: eventReminderDeliveries.userId })
          .from(eventReminderDeliveries),
      );
      return bufferedMemberText(c, `${mutes.length}/${inbox.length}/${logged.length}`);
    });
    const res = await app.request("/existing", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1/1/1");
    expect(await fixture.db.select().from(memberDataAccessLogs)).toMatchObject([
      { viewerDiscordId: VIEWER, subjectUserIds: [MEMBER], subjectCount: 1 },
    ]);
  });

  it("keyed reads without the owner projection refuse", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", (c, next) =>
      memberReadBoundary(
        c,
        { resource: "member", action: "list", route: "test.reminder-reads", viewer: VIEWER },
        (entry) => recordAccess(fixture.db, entry),
        next,
      ),
    );
    app.get("/existing", async (c) => {
      const db = observeMemberReads(fixture.db);
      const inbox = await keyedMemberRead(() =>
        db.select({ id: notifications.id }).from(notifications),
      );
      return bufferedMemberText(c, `${inbox.length}`);
    });
    const res = await app.request("/existing", {}, env);
    expect(res.status).toBe(503);
    expect(await fixture.db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });
});
