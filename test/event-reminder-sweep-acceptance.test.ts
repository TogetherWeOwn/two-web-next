// Acceptance contract for "Events: reminder sweep job with site delivery"
// (TOG-36130; design TOG-35932#document-spec). ACCEPTANCE-OWNED: the paired
// build card (TOG-36131) builds on this branch and must never edit this file.
// Wrong tests go back to the Test Author via TOG-36130; this branch is never
// merged without the Builder's implementation.
//
// What the Builder implements (nothing else in this file may change meaning):
//   - NEW module `src/jobs/event-reminders.ts` exporting
//       sweepEventReminders(deps: {
//         db: postgres.Sql;            // run-owned test DB in these tests
//         now?: () => Date;            // sweep instant; default () => new Date()
//         beforeSend?: (candidates: readonly unknown[]) => Promise<void> | void;
//       }): Promise<{ sent: number; [k: string]: unknown }>
//     `db` is a postgres.js client (the jobs convention: worker.ts threads
//     postgres.Sql, not drizzle). `now` is the ONLY clock: due math, the
//     rolling R4 window and written `sent_at` all derive from it, never from
//     wall time or `clock_timestamp()` — every sweep test below injects a `now`
//     2h off wall clock (plus fixed 2026 DST instants), so a wall-clock read
//     fails. `beforeSend` is a test-only seam, called exactly once per sweep
//     after candidate derivation and before ANY delivery/notification write;
//     production never passes it. It lets the race tests revoke eligibility
//     between derivation and send. The Builder must call it outside any held
//     row lock (derive with a plain SELECT; re-check eligibility inside the
//     per-tuple send statement) or the hook deadlocks the sweep.
//     The resolved `sent` count must equal the rows this run inserted with
//     status 'sent'.
//   - Tables/columns come from the data-model slice (TOG-36127, spec section 3):
//     notifications(id, user_id, kind, event_id, title, body, url, read_at,
//     created_at), event_reminder_deliveries(event_id, user_id, lead, channel,
//     status, error_code, sent_at) with UNIQUE(event_id, user_id, lead,
//     channel), event_reminder_mutes(event_id, user_id, created_at),
//     profiles.reminder_opt_out. Column semantics belong to TOG-36126; this
//     file only reads/writes them.
//   - Statuses: 'sent' | 'skipped_muted' | 'skipped_optout' | 'skipped_rsvp'
//     | 'skipped_window' | 'skipped_cap' (+ 'failed'/'dm_blocked' for v2 paths
//     this suite never triggers). `skipped_rsvp` covers BOTH send-time gate
//     races: the RSVP left going/maybe (or its row vanished) AND the event
//     left 'published' between derivation and send. `skipped_window` is purely
//     temporal: a lead whose due instant is past the grace bound (no catch-up).
//   - Precedence when several skip causes apply:
//     window > rsvp/event gate > opt-out > mute > cap. The cap is evaluated
//     last so ineligible tuples never consume R4 budget; the window is first
//     (no I/O). Global opt-out beats per-event mute.
//   - Leads: '24h' and '1h', due at starts_at - lead as exact instants.
//     A lead sends iff its due instant is reached and not older than the grace
//     bound. These tests pin the grace between 5 min (5-min-overdue sends)
//     and 30 min (30-min-overdue skips); the Builder picks a value inside,
//     e.g. one cron period. Derivation considers future events; past events
//     never send (skip rows for long-past tuples are intentionally unasserted
//     — the Builder SHOULD bound derivation so first deploy does not backfill
//     ancient history, and the reviewer verifies that bound plus the EXPLAIN
//     the card requires documented).
//   - R4: at most 6 rows with status 'sent' per member in the rolling
//     (now - 24h, now] window, counted from event_reminder_deliveries;
//     over-cap tuples skip as 'skipped_cap', soonest-starting event first.
//   - Site delivery of a send = one notifications row (kind 'event_reminder',
//     read_at NULL, non-empty title/body/url) + one deliveries row (channel
//     'site', status 'sent', sent_at ~= now). Copy is NOT pinned (the owner
//     wordsmiths it at slice 4): only presence is asserted.
//   - Logs carry counts only: at least one line with a digit on a sending
//     sweep, and never a member user id, username, or notification title/body.
//   - Wiring: the existing */10 jobs cron (two-web-jobs handleScheduled,
//     RECONCILE_CRON) runs the sweep; the wiring test proves it end to end.
//     No new cron, queue, or Worker.
//
// RED expectations: before the data-model migration lands, setup fails with
// "relation does not exist" (TOG-36127 owns that half). After the migration
// but before the sweep, every behavioral test fails on assertions (zero rows
// where sends/skips are expected, or the sweep module loader below fails).
// The no-schedule-table guard passes vacuously until violated by design.
//
// Fixture event keys reuse the repo's globally allowlisted synthetic ULIDs
// (see .gitleaks.toml: the Test Author cannot add allowlist entries, so no
// new ULID-shaped literal may appear here). Keys repeat across tests because
// every test truncates first. Member ids are low-entropy "sweep-member-NNN"
// strings (user_id is plain text; the sweep only equates them).

import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobsEnv } from "../src/env";
import { RECONCILE_CRON } from "../src/jobs/constants";
import { handleScheduled } from "../src/jobs/worker";
import { testDatabaseUrl } from "./helpers/member-data-db";

// ---------------------------------------------------------------------------
// Run-owned database (per-invocation; same guards as the redispatch fixture).
// ---------------------------------------------------------------------------

const REMINDER_DB_PREFIX = "two_web_next_tog36130";

function buildReminderDbName(pid: number, nowMs: number, rand: number): string {
  const pidPart = String(Math.floor(Math.abs(pid)) % 1_000_000);
  const randPart = String(Math.floor(Math.abs(rand)) % 1_000_000).padStart(6, "0");
  return `${REMINDER_DB_PREFIX}${Math.floor(Math.abs(nowMs))}${pidPart}${randPart}`;
}

function isOwnedReminderDbName(name: string): boolean {
  return /^two_web_next_tog[0-9]+$/.test(name);
}

const DB_NAME = buildReminderDbName(process.pid, Date.now(), randomInt(0, 1_000_000));

function runDbUrl(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${DB_NAME}`;
  return url.href;
}

function adminDbUrl(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = "/postgres";
  return url.href;
}

// ---------------------------------------------------------------------------
// Sweep loader: the module does not exist until the Builder writes it. A
// non-literal dynamic import keeps tsc green on the tests-only branch while
// each test still FAILS (assertion, not collection error) until the module
// and export exist.
// ---------------------------------------------------------------------------

type SweepResult = { sent: number; [k: string]: unknown };
type SweepFn = (deps: {
  db: postgres.Sql;
  now?: () => Date;
  beforeSend?: (candidates: readonly unknown[]) => Promise<void> | void;
}) => Promise<SweepResult>;

const SWEEP_MODULE: string = "../src/jobs/event-reminders";

async function loadSweep(): Promise<SweepFn> {
  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ SWEEP_MODULE);
  } catch {
    expect.unreachable(
      "sweep module missing: the Builder (TOG-36131) must create src/jobs/event-reminders.ts " +
        "exporting sweepEventReminders (see this file's header for the contract)",
    );
  }
  const fn = (mod as Record<string, unknown>)["sweepEventReminders"];
  expect(
    typeof fn,
    "src/jobs/event-reminders.ts must export sweepEventReminders (see header contract)",
  ).toBe("function");
  return fn as SweepFn;
}

async function runSweep(
  sql: postgres.Sql,
  now: Date,
  extra?: Pick<Parameters<SweepFn>[0], "beforeSend">,
): Promise<SweepResult> {
  const sweep = await loadSweep();
  const result = await sweep({ db: sql, now: () => now, ...extra });
  expect(
    result && typeof result.sent === "number",
    "sweep must resolve { sent: number, ... }",
  ).toBe(true);
  return result;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

// Globally allowlisted synthetic ULIDs (.gitleaks.toml). No other ULID-shaped
// literal may appear in this file.
const KEYS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  "01ARZ3NDEKTSV4RRFFQ69G5FAB",
  "01ARZ3NDEKTSV4RRFFQ69G5FAC",
  "01ARZ3NDEKTSV4RRFFQ69G5FAD",
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01J0AABBCCDDEEFFGGHHMMNNPP",
  "01J2ZB2X5X3Q8T1V9W4Y6Z7A8B",
  "01J2ZB2X5X3Q8T1V9W4Y6Z7A8C",
  "01M41G95P1M3EWP30VWZPFYSG9",
] as const;

const member = (n: number): string => `sweep-member-${String(n).padStart(3, "0")}`;

type NewEvent = {
  key: string;
  startsAt: Date;
  endsAt?: Date;
  status?: "draft" | "published" | "cancelled";
  timezone?: string;
};

async function insertEvent(sql: postgres.Sql, e: NewEvent): Promise<number> {
  const rows = (await sql`
    insert into events (event_key, title, starts_at, ends_at, status, timezone)
    values (
      ${e.key},
      ${`Sweep fixture ${e.key.slice(-4)}`},
      ${e.startsAt},
      ${e.endsAt ?? new Date(e.startsAt.getTime() + 2 * 3600_000)},
      ${e.status ?? "published"},
      ${e.timezone ?? "UTC"}
    )
    returning id`) as unknown as { id: number }[];
  return rows[0]!.id;
}

async function insertRsvp(
  sql: postgres.Sql,
  eventId: number,
  userId: string,
  status: "going" | "maybe" | "not_going" | "waitlisted" = "going",
): Promise<void> {
  await sql`insert into rsvps (event_id, user_id, status) values (${eventId}, ${userId}, ${status})`;
}

async function setOptOut(sql: postgres.Sql, userId: string): Promise<void> {
  await sql`
    insert into profiles (user_id, reminder_opt_out) values (${userId}, true)
    on conflict (user_id) do update set reminder_opt_out = true`;
}

async function insertMute(sql: postgres.Sql, eventId: number, userId: string): Promise<void> {
  await sql`insert into event_reminder_mutes (event_id, user_id) values (${eventId}, ${userId})`;
}

async function insertSentDelivery(
  sql: postgres.Sql,
  args: {
    eventId: number;
    userId: string;
    lead: "24h" | "1h";
    sentAt: Date;
  },
): Promise<void> {
  await sql`
    insert into event_reminder_deliveries (event_id, user_id, lead, channel, status, sent_at)
    values (${args.eventId}, ${args.userId}, ${args.lead}, 'site', 'sent', ${args.sentAt})`;
}

type DeliveryRow = {
  event_id: number;
  user_id: string;
  lead: string;
  channel: string;
  status: string;
  sent_at: Date | null;
};

async function readDeliveries(sql: postgres.Sql): Promise<DeliveryRow[]> {
  return (await sql`
    select event_id, user_id, lead, channel, status, sent_at
    from event_reminder_deliveries
    order by event_id, user_id, lead`) as unknown as DeliveryRow[];
}

type NotificationRow = {
  user_id: string;
  kind: string;
  event_id: number | null;
  title: string;
  body: string;
  url: string;
  read_at: Date | null;
};

async function readNotifications(sql: postgres.Sql): Promise<NotificationRow[]> {
  return (await sql`
    select user_id, kind, event_id, title, body, url, read_at
    from notifications
    order by user_id, event_id, id`) as unknown as NotificationRow[];
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const push = (...args: unknown[]): void => {
    lines.push(
      args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a) ?? String(a);
          } catch {
            return String(a);
          }
        })
        .join(" "),
    );
  };
  const spies = [
    vi.spyOn(console, "info").mockImplementation(push),
    vi.spyOn(console, "warn").mockImplementation(push),
    vi.spyOn(console, "error").mockImplementation(push),
  ];
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

function expectNoLeak(lines: string[], secrets: string[]): void {
  const blob = lines.join("\n");
  for (const secret of secrets) {
    expect(secret.length, "leak fixture must be non-empty to prove anything").toBeGreaterThan(0);
    expect(blob).not.toContain(secret);
  }
}

const HOUR = 3600_000;
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.DATABASE_URL)("event reminder sweep (acceptance)", () => {
  let sql: postgres.Sql;
  let createdDb = false;

  beforeAll(async () => {
    testDatabaseUrl(process.env.DATABASE_URL!);
    if (!isOwnedReminderDbName(DB_NAME))
      throw new Error("refusing to create an unguarded database");
    const admin = postgres(adminDbUrl(), {
      max: 1,
      connect_timeout: 5,
      password: () => new URL(adminDbUrl()).password,
      onnotice: () => {},
    });
    try {
      const rows = (await admin.unsafe(
        "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
        [DB_NAME],
      )) as unknown as { owner: string }[];
      if (rows[0]?.owner) throw new Error(`refusing to reuse existing database "${DB_NAME}"`);
      await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
      createdDb = true;
    } finally {
      await admin.end({ timeout: 1 });
    }
    const dbUrl = runDbUrl();
    const migrate = postgres(dbUrl, {
      max: 1,
      connect_timeout: 5,
      password: () => new URL(dbUrl).password,
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
    sql = postgres(dbUrl, {
      max: 3,
      connect_timeout: 5,
      password: () => new URL(dbUrl).password,
      onnotice: () => {},
    });
  }, 120000);

  afterAll(async () => {
    try {
      await sql?.end({ timeout: 1 });
    } finally {
      if (createdDb && isOwnedReminderDbName(DB_NAME)) {
        const admin = postgres(adminDbUrl(), {
          max: 1,
          connect_timeout: 5,
          password: () => new URL(adminDbUrl()).password,
          onnotice: () => {},
        });
        try {
          await admin.unsafe(`DROP DATABASE "${DB_NAME}" WITH (FORCE)`);
        } finally {
          await admin.end({ timeout: 1 });
        }
      }
    }
  });

  beforeEach(async () => {
    // Fails with "relation does not exist" until the data-model slice lands —
    // that is the RED signal for TOG-36127, not for this card's Builder.
    await sql`
      truncate events, profiles, notifications, event_reminder_deliveries,
        event_reminder_mutes, job_unique_locks, queue_jobs, queue_failed_jobs
      cascade`;
  });

  it("sends the T-24h lead once; an immediate re-sweep inserts zero rows", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, eventId, member(1));

    const first = await runSweep(sql, now);
    expect(first.sent).toBe(1);
    expect(await readDeliveries(sql)).toEqual([
      {
        event_id: eventId,
        user_id: member(1),
        lead: "24h",
        channel: "site",
        status: "sent",
        sent_at: expect.any(Date),
      },
    ]);
    const notifications = await readNotifications(sql);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      user_id: member(1),
      kind: "event_reminder",
      event_id: eventId,
      read_at: null,
    });
    expect(notifications[0]!.title.length).toBeGreaterThan(0);
    expect(notifications[0]!.body.length).toBeGreaterThan(0);
    expect(notifications[0]!.url.length).toBeGreaterThan(0);

    const second = await runSweep(sql, now);
    expect(second.sent).toBe(0);
    expect(await readDeliveries(sql)).toHaveLength(1);
    expect(await readNotifications(sql)).toHaveLength(1);
  });

  it("sends the T-1h lead on its later pass without re-sending T-24h", async () => {
    const start = new Date(Date.now() + 2 * HOUR + 25 * HOUR);
    const eventId = await insertEvent(sql, { key: KEYS[0], startsAt: start });
    await insertRsvp(sql, eventId, member(1));

    const dayBefore = await runSweep(sql, new Date(start.getTime() - 24 * HOUR + 5 * MIN));
    expect(dayBefore.sent).toBe(1);
    const hourBefore = await runSweep(sql, new Date(start.getTime() - HOUR + 5 * MIN));
    expect(hourBefore.sent).toBe(1);

    const deliveries = await readDeliveries(sql);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.filter((d) => d.lead === "24h" && d.status === "sent")).toHaveLength(1);
    expect(deliveries.filter((d) => d.lead === "1h" && d.status === "sent")).toHaveLength(1);
    expect(await readNotifications(sql)).toHaveLength(2);
  });

  it("writes nothing before the window opens and never sends after the event", async () => {
    const start = new Date(Date.now() + 2 * HOUR + 26 * HOUR);
    const eventId = await insertEvent(sql, { key: KEYS[0], startsAt: start });
    await insertRsvp(sql, eventId, member(1));

    const early = await runSweep(sql, new Date(start.getTime() - 25 * HOUR));
    expect(early.sent).toBe(0);
    expect(await readDeliveries(sql)).toHaveLength(0);
    expect(await readNotifications(sql)).toHaveLength(0);

    const late = await runSweep(sql, new Date(start.getTime() + 2 * HOUR));
    expect(late.sent).toBe(0);
    expect(await readNotifications(sql)).toHaveLength(0);
    // Skip rows for long-past tuples are intentionally unasserted (see header);
    // what matters is no catch-up send.
    expect((await readDeliveries(sql)).filter((d) => d.status === "sent")).toHaveLength(0);
  });

  it("computes due instants across DST boundaries (spring forward and fall back)", async () => {
    // Spring: 2026-03-08 12:00 America/New_York is EDT (post-transition); the
    // 24h lead is due 2026-03-07T16:00Z, NOT Mar 7 12:00 local (17:00Z).
    const springStart = new Date("2026-03-08T12:00:00-04:00");
    const springId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: springStart,
      timezone: "America/New_York",
    });
    await insertRsvp(sql, springId, member(1));
    // Fall: 2026-11-01 12:00 America/New_York is EST (post-transition); the 24h
    // lead is due 2026-10-31T17:00Z, NOT Oct 31 12:00 local (16:00Z).
    const fallStart = new Date("2026-11-01T12:00:00-05:00");
    const fallId = await insertEvent(sql, {
      key: KEYS[1],
      startsAt: fallStart,
      timezone: "America/New_York",
    });
    await insertRsvp(sql, fallId, member(2));

    await runSweep(sql, new Date("2026-03-07T16:05:00Z"));
    expect(
      (await readDeliveries(sql)).filter(
        (d) => d.event_id === springId && d.lead === "24h" && d.status === "sent",
      ),
    ).toHaveLength(1);
    expect((await readDeliveries(sql)).filter((d) => d.user_id === member(2))).toHaveLength(0);

    await runSweep(sql, new Date("2026-10-31T17:05:00Z"));
    expect(
      (await readDeliveries(sql)).filter(
        (d) => d.event_id === fallId && d.lead === "24h" && d.status === "sent",
      ),
    ).toHaveLength(1);
    // The spring event is long past: its March send stands, nothing new sends.
    expect(
      (await readDeliveries(sql)).filter((d) => d.user_id === member(1) && d.status === "sent"),
    ).toHaveLength(1);
  });

  it("sends only going/maybe on published events; drafts, cancelled, not_going and waitlisted write zero rows", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const start = new Date(now.getTime() + 24 * HOUR - 5 * MIN);
    const pub = await insertEvent(sql, { key: KEYS[0], startsAt: start, status: "published" });
    await insertRsvp(sql, pub, member(1), "going");
    await insertRsvp(sql, pub, member(2), "maybe");
    await insertRsvp(sql, pub, member(3), "not_going");
    await insertRsvp(sql, pub, member(4), "waitlisted");
    const draft = await insertEvent(sql, { key: KEYS[1], startsAt: start, status: "draft" });
    await insertRsvp(sql, draft, member(5), "going");
    const cancelled = await insertEvent(sql, {
      key: KEYS[2],
      startsAt: start,
      status: "cancelled",
    });
    await insertRsvp(sql, cancelled, member(6), "going");

    const result = await runSweep(sql, now);
    expect(result.sent).toBe(2);
    const deliveries = await readDeliveries(sql);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((d) => d.user_id))).toEqual(new Set([member(1), member(2)]));
    expect(deliveries.every((d) => d.status === "sent" && d.lead === "24h")).toBe(true);
    expect(await readNotifications(sql)).toHaveLength(2);
  });

  it("an un-RSVP between derivation and send yields skipped_rsvp, never a send", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, eventId, member(1));
    await insertRsvp(sql, eventId, member(2));
    const hook = vi.fn(async (candidates: readonly unknown[]) => {
      expect(Array.isArray(candidates)).toBe(true);
      await sql`update rsvps set status = 'not_going' where event_id = ${eventId} and user_id = ${member(1)}`;
      await sql`delete from rsvps where event_id = ${eventId} and user_id = ${member(2)}`;
    });

    const result = await runSweep(sql, now, { beforeSend: hook });
    expect(hook).toHaveBeenCalledOnce();
    expect(result.sent).toBe(0);
    const deliveries = await readDeliveries(sql);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === "skipped_rsvp")).toBe(true);
    expect(await readNotifications(sql)).toHaveLength(0);
  });

  it("an unpublish between derivation and send yields skipped_rsvp, never a send", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, eventId, member(1));

    const result = await runSweep(sql, now, {
      beforeSend: async () => {
        await sql`update events set status = 'draft' where id = ${eventId}`;
      },
    });
    expect(result.sent).toBe(0);
    expect(await readDeliveries(sql)).toEqual([
      {
        event_id: eventId,
        user_id: member(1),
        lead: "24h",
        channel: "site",
        status: "skipped_rsvp",
        sent_at: null,
      },
    ]);
    expect(await readNotifications(sql)).toHaveLength(0);
  });

  it("muted and opted-out members skip with their own statuses while others send", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, eventId, member(1));
    await insertRsvp(sql, eventId, member(2));
    await insertRsvp(sql, eventId, member(3));
    await insertMute(sql, eventId, member(1));
    await setOptOut(sql, member(2));

    const result = await runSweep(sql, now);
    expect(result.sent).toBe(1);
    const byUser = new Map((await readDeliveries(sql)).map((d) => [d.user_id, d]));
    expect(byUser.get(member(1))?.status).toBe("skipped_muted");
    expect(byUser.get(member(2))?.status).toBe("skipped_optout");
    expect(byUser.get(member(3))?.status).toBe("sent");
    const notifications = await readNotifications(sql);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.user_id).toBe(member(3));
  });

  it("global opt-out wins over a per-event mute when both apply", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, eventId, member(1));
    await insertMute(sql, eventId, member(1));
    await setOptOut(sql, member(1));

    const result = await runSweep(sql, now);
    expect(result.sent).toBe(0);
    expect(await readDeliveries(sql)).toEqual([
      {
        event_id: eventId,
        user_id: member(1),
        lead: "24h",
        channel: "site",
        status: "skipped_optout",
        sent_at: null,
      },
    ]);
    expect(await readNotifications(sql)).toHaveLength(0);
  });

  it("leads missed past the grace bound skip as skipped_window: no catch-up, window beats mute", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 30 * MIN),
    });
    await insertRsvp(sql, eventId, member(1));
    await insertRsvp(sql, eventId, member(2));
    await insertMute(sql, eventId, member(1));

    const result = await runSweep(sql, now);
    expect(result.sent).toBe(0);
    const deliveries = await readDeliveries(sql);
    expect(deliveries).toHaveLength(4);
    expect(deliveries.every((d) => d.status === "skipped_window")).toBe(true);
    expect(new Set(deliveries.map((d) => `${d.user_id}:${d.lead}`))).toEqual(
      new Set([`${member(1)}:24h`, `${member(1)}:1h`, `${member(2)}:24h`, `${member(2)}:1h`]),
    );
    expect(await readNotifications(sql)).toHaveLength(0);
  });

  it("R4 caps at 6 sends per rolling 24h with soonest-starting winning", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const userId = member(1);
    // Five sends inside the window on three past events (two leads each max).
    const old1 = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() - 20 * HOUR),
    });
    const old2 = await insertEvent(sql, {
      key: KEYS[1],
      startsAt: new Date(now.getTime() - 21 * HOUR),
    });
    const old3 = await insertEvent(sql, {
      key: KEYS[2],
      startsAt: new Date(now.getTime() - 22 * HOUR),
    });
    await insertSentDelivery(sql, {
      eventId: old1,
      userId,
      lead: "24h",
      sentAt: new Date(now.getTime() - 5 * HOUR),
    });
    await insertSentDelivery(sql, {
      eventId: old1,
      userId,
      lead: "1h",
      sentAt: new Date(now.getTime() - 4 * HOUR),
    });
    await insertSentDelivery(sql, {
      eventId: old2,
      userId,
      lead: "24h",
      sentAt: new Date(now.getTime() - 3 * HOUR),
    });
    await insertSentDelivery(sql, {
      eventId: old2,
      userId,
      lead: "1h",
      sentAt: new Date(now.getTime() - 2 * HOUR),
    });
    await insertSentDelivery(sql, {
      eventId: old3,
      userId,
      lead: "24h",
      sentAt: new Date(now.getTime() - HOUR),
    });
    const soon = await insertEvent(sql, {
      key: KEYS[3],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    const later = await insertEvent(sql, {
      key: KEYS[4],
      startsAt: new Date(now.getTime() + 24 * HOUR - 4 * MIN),
    });
    await insertRsvp(sql, soon, userId);
    await insertRsvp(sql, later, userId);

    const result = await runSweep(sql, now);
    expect(result.sent).toBe(1);
    const deliveries = await readDeliveries(sql);
    const forTuple = (eventId: number) =>
      deliveries.filter((d) => d.user_id === userId && d.event_id === eventId && d.lead === "24h");
    expect(forTuple(soon).map((d) => d.status)).toEqual(["sent"]);
    expect(forTuple(later).map((d) => d.status)).toEqual(["skipped_cap"]);
    expect(
      deliveries.filter(
        (d) =>
          d.user_id === userId &&
          d.status === "sent" &&
          d.sent_at!.getTime() > now.getTime() - 24 * HOUR,
      ),
    ).toHaveLength(6);
    const notifications = await readNotifications(sql);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ user_id: userId, event_id: soon });
  });

  it("R4 is a rolling window: an aged-out send frees budget, a full window caps", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const full = member(1);
    const aged = member(2);
    const old1 = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() - 20 * HOUR),
    });
    const old2 = await insertEvent(sql, {
      key: KEYS[1],
      startsAt: new Date(now.getTime() - 21 * HOUR),
    });
    const old3 = await insertEvent(sql, {
      key: KEYS[2],
      startsAt: new Date(now.getTime() - 22 * HOUR),
    });
    for (const [eventId, lead, hoursAgo] of [
      [old1, "24h", 6],
      [old1, "1h", 5],
      [old2, "24h", 4],
      [old2, "1h", 3],
      [old3, "24h", 2],
      [old3, "1h", 1],
    ] as const) {
      await insertSentDelivery(sql, {
        eventId,
        userId: full,
        lead,
        sentAt: new Date(now.getTime() - hoursAgo * HOUR),
      });
    }
    for (const [eventId, lead, sentAt] of [
      [old1, "24h", new Date(now.getTime() - 5 * HOUR)],
      [old1, "1h", new Date(now.getTime() - 4 * HOUR)],
      [old2, "24h", new Date(now.getTime() - 3 * HOUR)],
      [old2, "1h", new Date(now.getTime() - 2 * HOUR)],
      [old3, "24h", new Date(now.getTime() - HOUR)],
      [old3, "1h", new Date(now.getTime() - 25 * HOUR)],
    ] as const) {
      await insertSentDelivery(sql, { eventId, userId: aged, lead, sentAt });
    }
    const dueFull = await insertEvent(sql, {
      key: KEYS[3],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    const dueAged = await insertEvent(sql, {
      key: KEYS[4],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, dueFull, full);
    await insertRsvp(sql, dueAged, aged);

    const result = await runSweep(sql, now);
    expect(result.sent).toBe(1);
    const deliveries = await readDeliveries(sql);
    expect(
      deliveries.filter((d) => d.user_id === full && d.event_id === dueFull).map((d) => d.status),
    ).toEqual(["skipped_cap"]);
    expect(
      deliveries.filter((d) => d.user_id === aged && d.event_id === dueAged).map((d) => d.status),
    ).toEqual(["sent"]);
  });

  it("eligibility beats the cap: muted and opted-out members skip without consuming budget", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const muted = member(1);
    const optedOut = member(2);
    const old1 = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() - 20 * HOUR),
    });
    const old2 = await insertEvent(sql, {
      key: KEYS[1],
      startsAt: new Date(now.getTime() - 21 * HOUR),
    });
    const old3 = await insertEvent(sql, {
      key: KEYS[2],
      startsAt: new Date(now.getTime() - 22 * HOUR),
    });
    for (const userId of [muted, optedOut]) {
      let hoursAgo = 1;
      for (const [eventId, lead] of [
        [old1, "24h"],
        [old1, "1h"],
        [old2, "24h"],
        [old2, "1h"],
        [old3, "24h"],
        [old3, "1h"],
      ] as const) {
        await insertSentDelivery(sql, {
          eventId,
          userId,
          lead,
          sentAt: new Date(now.getTime() - hoursAgo * HOUR),
        });
        hoursAgo += 1;
      }
    }
    const eventId = await insertEvent(sql, {
      key: KEYS[3],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, eventId, muted);
    await insertRsvp(sql, eventId, optedOut);
    await insertMute(sql, eventId, muted);
    await setOptOut(sql, optedOut);

    const result = await runSweep(sql, now);
    expect(result.sent).toBe(0);
    const deliveries = await readDeliveries(sql);
    expect(deliveries.filter((d) => d.user_id === muted && d.event_id === eventId)).toEqual([
      {
        event_id: eventId,
        user_id: muted,
        lead: "24h",
        channel: "site",
        status: "skipped_muted",
        sent_at: null,
      },
    ]);
    expect(deliveries.filter((d) => d.user_id === optedOut && d.event_id === eventId)).toEqual([
      {
        event_id: eventId,
        user_id: optedOut,
        lead: "24h",
        channel: "site",
        status: "skipped_optout",
        sent_at: null,
      },
    ]);
    expect((await readNotifications(sql)).filter((n) => n.event_id === eventId)).toHaveLength(0);
  });

  it("two simultaneous sweeps insert exactly one row per tuple", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    const users = Array.from({ length: 10 }, (_, i) => member(i + 1));
    for (const userId of users) await insertRsvp(sql, eventId, userId);
    // Separate pools: a shared max:1 pool would serialize the "concurrent" pair.
    const dbUrl = runDbUrl();
    const sqlA = postgres(dbUrl, {
      max: 1,
      connect_timeout: 5,
      password: () => new URL(dbUrl).password,
      onnotice: () => {},
    });
    const sqlB = postgres(dbUrl, {
      max: 1,
      connect_timeout: 5,
      password: () => new URL(dbUrl).password,
      onnotice: () => {},
    });
    try {
      const [a, b] = await Promise.all([runSweep(sqlA, now), runSweep(sqlB, now)]);
      expect(a.sent + b.sent).toBe(10);
    } finally {
      await sqlA.end({ timeout: 1 });
      await sqlB.end({ timeout: 1 });
    }
    const deliveries = await readDeliveries(sql);
    expect(deliveries).toHaveLength(10);
    expect(deliveries.every((d) => d.status === "sent")).toBe(true);
    expect(new Set(deliveries.map((d) => d.user_id)).size).toBe(10);
    const dupes = (await sql`
      select event_id, user_id, lead, channel, count(*)
      from event_reminder_deliveries
      group by event_id, user_id, lead, channel
      having count(*) > 1`) as unknown as unknown[];
    expect(dupes).toHaveLength(0);
    expect(await readNotifications(sql)).toHaveLength(10);
  });

  it("sends at most ~200 per pass; leftovers ride the next pass", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    for (let i = 1; i <= 220; i++) await insertRsvp(sql, eventId, member(i));

    const first = await runSweep(sql, now);
    expect(first.sent).toBeLessThanOrEqual(200);
    expect(first.sent).toBeGreaterThanOrEqual(150);
    const second = await runSweep(sql, now);
    expect(first.sent + second.sent).toBe(220);
    const third = await runSweep(sql, now);
    expect(third.sent).toBe(0);
    expect(await readDeliveries(sql)).toHaveLength(220);
    expect(await readNotifications(sql)).toHaveLength(220);
  });

  it("logs carry counts only: never member ids, titles, or bodies", async () => {
    const now = new Date(Date.now() + 2 * HOUR);
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(now.getTime() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, eventId, member(1));
    const captured = captureConsole();
    try {
      const result = await runSweep(sql, now);
      expect(result.sent).toBe(1);
    } finally {
      captured.restore();
    }
    expect(captured.lines.length).toBeGreaterThan(0);
    expect(captured.lines.join("\n")).toMatch(/\d/);
    const notifications = await readNotifications(sql);
    expect(notifications).toHaveLength(1);
    expectNoLeak(captured.lines, [member(1), notifications[0]!.title, notifications[0]!.body]);
    const deliveries = await readDeliveries(sql);
    expect(deliveries).toHaveLength(1);
    // sent_at runs on the sweep clock (see header), not wall time.
    expect(Math.abs(deliveries[0]!.sent_at!.getTime() - now.getTime())).toBeLessThan(10 * MIN);
  });

  it("an empty sweep resolves zero and writes nothing", async () => {
    const result = await runSweep(sql, new Date(Date.now() + 2 * HOUR));
    expect(result.sent).toBe(0);
    expect(await readDeliveries(sql)).toHaveLength(0);
    expect(await readNotifications(sql)).toHaveLength(0);
  });

  it("the */10 jobs cron runs the sweep (two-web-jobs owns it)", async () => {
    const eventId = await insertEvent(sql, {
      key: KEYS[0],
      startsAt: new Date(Date.now() + 24 * HOUR - 5 * MIN),
    });
    await insertRsvp(sql, eventId, member(1));
    const env = {
      DATABASE_URL: runDbUrl(),
      SYNC_EVENT_QUEUE: { send: async () => {} },
      APP_URL: "http://localhost/",
    } as unknown as JobsEnv;

    await handleScheduled({ cron: RECONCILE_CRON } as unknown as ScheduledController, env);

    expect(
      (await readDeliveries(sql)).filter(
        (d) => d.event_id === eventId && d.user_id === member(1) && d.status === "sent",
      ),
    ).toHaveLength(1);
    expect(
      (await readNotifications(sql)).filter(
        (n) => n.event_id === eventId && n.user_id === member(1),
      ),
    ).toHaveLength(1);
  });

  it("moved events re-aim unsent leads only; sent leads never re-send", async () => {
    const base = Date.now() + 2 * HOUR;
    const alice = member(1);
    const bruno = member(2);
    const cara = member(3);
    const later = await insertEvent(sql, { key: KEYS[0], startsAt: new Date(base + 25 * HOUR) });
    const earlier = await insertEvent(sql, { key: KEYS[1], startsAt: new Date(base + 25 * HOUR) });
    const past = await insertEvent(sql, { key: KEYS[2], startsAt: new Date(base + 72 * HOUR) });
    await insertRsvp(sql, later, alice);
    await insertRsvp(sql, earlier, bruno);
    await insertRsvp(sql, past, cara);

    // Nothing is due yet anywhere.
    expect((await runSweep(sql, new Date(base))).sent).toBe(0);
    expect(await readDeliveries(sql)).toHaveLength(0);

    // One event moves later (past its old due), one moves into the missed zone.
    await sql`update events set starts_at = ${new Date(base + 73 * HOUR)} where id = ${later}`;
    await sql`update events set starts_at = ${new Date(base + 70 * MIN)} where id = ${past}`;
    expect((await runSweep(sql, new Date(base + 65 * MIN))).sent).toBe(1);
    // The moved-later event sailed past its old due instant untouched.
    expect((await readDeliveries(sql)).filter((d) => d.event_id === later)).toHaveLength(0);
    // The untouched event sent its 24h lead on schedule.
    expect(
      (await readDeliveries(sql)).filter((d) => d.event_id === earlier && d.status === "sent"),
    ).toHaveLength(1);
    // The moved-earlier event's leads are missed with no catch-up.
    expect((await readDeliveries(sql)).filter((d) => d.event_id === past)).toEqual([
      {
        event_id: past,
        user_id: cara,
        lead: "1h",
        channel: "site",
        status: "skipped_window",
        sent_at: null,
      },
      {
        event_id: past,
        user_id: cara,
        lead: "24h",
        channel: "site",
        status: "skipped_window",
        sent_at: null,
      },
    ]);

    // The sent event moves earlier: its 1h lead follows the new start, the sent
    // 24h lead is never re-sent.
    await sql`update events set starts_at = ${new Date(base + 10 * HOUR)} where id = ${earlier}`;
    expect((await runSweep(sql, new Date(base + 9 * HOUR + 5 * MIN))).sent).toBe(1);
    const deliveries = await readDeliveries(sql);
    expect(deliveries.filter((d) => d.event_id === later)).toHaveLength(0);
    expect(
      deliveries.filter((d) => d.event_id === earlier && d.lead === "24h" && d.status === "sent"),
    ).toHaveLength(1);
    expect(
      deliveries.filter((d) => d.event_id === earlier && d.lead === "1h" && d.status === "sent"),
    ).toHaveLength(1);
    expect(deliveries.filter((d) => d.event_id === earlier)).toHaveLength(2);
    expect((await readNotifications(sql)).filter((n) => n.event_id === earlier)).toHaveLength(2);
    // The long-past event sends nothing more (skip rows already stand).
    expect(deliveries.filter((d) => d.event_id === past && d.status === "sent")).toHaveLength(0);
    expect((await readNotifications(sql)).filter((n) => n.event_id === past)).toHaveLength(0);
  });

  it("derives due tuples per run: no pre-materialized schedule table exists", async () => {
    const rows = (await sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and (table_name like '%reminder%sched%' or table_name like '%sched%reminder%')`) as unknown as {
      table_name: string;
    }[];
    expect(rows).toHaveLength(0);
  });
});
