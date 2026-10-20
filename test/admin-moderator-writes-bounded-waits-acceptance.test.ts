// Acceptance: moderator event/featured mutation waits are bounded and busy is
// rollback-confirmed.
//
// Event update/PATCH and lifecycle transactions, and featured Save/Delete,
// must apply finite transaction-local lock_timeout and statement_timeout,
// reusing the existing bounded-write convention (server-enforced SET LOCAL /
// set_config(..., true) inside the transaction), never global DB settings and
// never a client-side Promise.race that abandons a still-running statement.
// The bound covers dependent recurrence-child, waitlist and audit statements,
// not just the initial row acquisition. Recognized PostgreSQL lock/statement
// cancellation errors (55P03, 57014), including wrapped causes, must produce
// the existing private/no-store retryable 503 outage envelope only after the
// transaction has rolled back. A timed-out write must never claim it saved,
// emit a success redirect, or dispatch its write-back. Ordinary validation,
// constraint and programming errors keep their established paths. A later
// valid write succeeds after contention releases, and local timeout settings
// never leak into the pool. Multi-occurrence series carry a per-statement
// database bound, never a whole-request deadline.
//
// Behavioral, not a literal pin: every live case parks a holder connection on
// a real row or table lock, proves the contender reached that lock in
// pg_stat_activity (observable rendezvous, never sleeps), then requires the
// contender to settle with the busy/outage verdict while the holder is still
// parked. An unbounded wait loses the test-side detection race and fails as
// the wrong outcome. Rollback is confirmed by unchanged content/audit rows,
// zero write-back dispatch, and a later success after release. DB-free cases
// pin wrapped-timeout recognition and ordinary-error propagation without a
// database.
//
// Live against the guarded test database in a throwaway schema. Skipped when
// DATABASE_URL is unset. Never point this at production or staging.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import testApp from "./app";
import { adminApp } from "../src/admin/routes";
import {
  createEvent,
  createFeatured,
  deleteFeatured,
  patchEvent,
  setRsvpOpen,
  transitionEvent,
  updateEvent,
  updateFeatured,
  type Actor,
} from "../src/admin/store";
import { dispatchWriteBack } from "../src/admin/writeback";
import { parseEventForm, parseFeaturedForm, ValidationError } from "../src/admin/validation";
import { NotFoundError } from "../src/admin/store";
import { activityLog, events, featuredContents, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { databaseOptions } from "../src/db/connection";
import { isDatabaseUnavailable } from "../src/db/errors";
import { internalErrorHandler } from "../src/errors";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import { Hono } from "hono";
import { cookieFor, env as baseEnv, MODERATOR } from "./helpers/member-data";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { clearAuditRows } from "./helpers/audit-rows";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const MOD: Actor = { id: "100000000000000111", username: "mod" };
const EVENT_FORM = {
  title: "Bounded night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "8",
  starts_at: "2099-11-04 20:00",
  ends_at: "2099-11-04 22:00",
  timezone: "Europe/London",
};
const FEATURED_FORM = {
  title: "Bounded slot",
  body: "Bounded body",
  position: "3",
};
// Test-side unboundedWAIT detector, not a production deadline. Any finite
// server-enforced bound the builder chooses (existing conventions are
// 400ms..5s, operator CLIs 5..10s) settles well inside this. An unbounded
// wait loses this race and fails as the wrong outcome.
const SETTLE_DEADLINE_MS = 15_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pgError(code: string) {
  return Object.assign(new Error("private query details"), {
    name: "PostgresError",
    code,
  });
}

function wrapped(code: string, depth = 1) {
  let current: Error = pgError(code);
  for (let i = 0; i < depth; i++) {
    current = new Error("Failed query", { cause: current });
  }
  return current;
}

function codesInChain(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 8 && current instanceof Error; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = current.cause;
  }
  return codes;
}

describe("moderator write busy classification (offline)", () => {
  it.each(["55P03", "57014"])("recognizes Postgres cancellation code %s", (code) => {
    expect(isDatabaseUnavailable(pgError(code))).toBe(true);
  });

  it.each(["55P03", "57014"])("recognizes %s through a single query wrapper", (code) => {
    expect(isDatabaseUnavailable(wrapped(code, 1))).toBe(true);
  });

  it.each(["55P03", "57014"])("recognizes %s through a double-wrapped cause chain", (code) => {
    expect(isDatabaseUnavailable(wrapped(code, 2))).toBe(true);
  });

  it.each([pgError("23505"), pgError("42601"), pgError("42501"), new TypeError("bug")])(
    "does not disguise ordinary errors as outage: %s",
    (error) => {
      expect(isDatabaseUnavailable(error)).toBe(false);
    },
  );

  it("does not classify validation or not-found as outage", () => {
    expect(isDatabaseUnavailable(new ValidationError({ title: "x" }))).toBe(false);
    expect(isDatabaseUnavailable(new NotFoundError("event"))).toBe(false);
  });

  it("keeps bounds transaction-local, never global connection settings", () => {
    // The existing bounded-write convention is SET LOCAL / set_config(...,
    // true) inside each mutation transaction. Global databaseOptions must not
    // carry statement_timeout or lock_timeout: those would bound every pooled
    // read, not just moderator writes.
    expect(databaseOptions).not.toHaveProperty("statement_timeout");
    expect(databaseOptions).not.toHaveProperty("lock_timeout");
  });

  it("documents the per-statement database bound, never a whole-request deadline", () => {
    // A multi-occurrence series is many statements in one atomic transaction:
    // the bound applies per statement, so a large series is not refused as a
    // whole. The builder documents that where a moderator or operator will
    // find it: the moderator guide or the store leaves that own the bound.
    const candidates = [
      "../docs/moderator-admin-guide.md",
      "../src/admin/store-event-writes.ts",
      "../src/admin/store-featured.ts",
    ].map((rel) => {
      try {
        return readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), "utf8");
      } catch {
        return "";
      }
    });
    const combined = candidates.join("\n");
    expect(combined).toMatch(/per-statement|per statement/i);
    expect(combined).toMatch(/statement_timeout|lock_timeout/i);
  });
});

describe("moderator write outage mapping (offline, fake Db)", () => {
  const fakeRefusing = (error: unknown) =>
    ({
      transaction: async () => {
        throw error;
      },
      select: () => {
        throw error;
      },
      insert: () => {
        throw error;
      },
      update: () => {
        throw error;
      },
      delete: () => {
        throw error;
      },
      execute: async () => {
        throw error;
      },
    }) as unknown as Db;

  const store = createMemorySessionStore();
  let cookie = "";

  beforeEach(async () => {
    vi.mocked(dispatchWriteBack).mockClear();
    cookie = await cookieFor(store, MODERATOR);
  });

  const liveEnv = (db: Db) =>
    ({ ...baseEnv, ADMIN_DB: db, SESSION_STORE: store }) as unknown as Env;

  const formHeaders = () => ({
    cookie,
    origin: baseEnv.APP_URL,
    "content-type": "application/x-www-form-urlencoded",
  });

  const assertOutage = async (res: Response) => {
    expect(res.status).toBe(503);
    const cache = res.headers.get("cache-control") ?? "";
    expect(cache).toContain("no-store");
    expect(cache).toContain("private");
    expect(res.headers.get("location")).toBeNull();
    const body = await res.text();
    expect(body).not.toMatch(/private query details|Failed query|55P03|57014/);
    expect(vi.mocked(dispatchWriteBack)).not.toHaveBeenCalled();
    return body;
  };

  it.each([
    ["POST", "/admin/events", true],
    ["POST", "/admin/events/01J00000000000000000000015/publish", false],
    ["POST", "/admin/featured", true],
    ["POST", "/admin/featured/1/delete", false],
  ])("maps a wrapped lock-timeout to the 503 outage on %s %s", async (method, path, hasBody) => {
    const db = fakeRefusing(wrapped("55P03", 1));
    const res = await testApp.request(
      path,
      {
        method,
        headers: formHeaders(),
        ...(hasBody ? { body: new URLSearchParams(EVENT_FORM) } : {}),
      },
      liveEnv(db),
    );
    const body = await assertOutage(res);
    expect(body).toContain("Together We Own");
  });

  it("maps a wrapped statement-timeout to the 503 outage on admin update", async () => {
    const db = fakeRefusing(wrapped("57014", 1));
    const res = await testApp.request(
      "/admin/events/01J00000000000000000000015",
      {
        method: "POST",
        headers: formHeaders(),
        body: new URLSearchParams(EVENT_FORM),
      },
      liveEnv(db),
    );
    await assertOutage(res);
  });

  it.each([
    ["POST", "/events"],
    ["PATCH", "/events/01J00000000000000000000015"],
    ["POST", "/events/01J00000000000000000000015/publish"],
  ])("maps a wrapped timeout to JSON db_unavailable on %s %s", async (method, path) => {
    const db = fakeRefusing(wrapped("55P03", 1));
    const payload =
      method === "POST" && path === "/events" ? { ...EVENT_FORM } : { title: "Outage fixture" };
    const res = await testApp.request(
      path,
      {
        method,
        headers: {
          cookie,
          origin: baseEnv.APP_URL,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      },
      liveEnv(db),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "db_unavailable" });
    expect(vi.mocked(dispatchWriteBack)).not.toHaveBeenCalled();
  });

  it.each([pgError("23505"), pgError("42601"), new TypeError("private bug")])(
    "keeps ordinary store failures off the outage envelope: %s",
    async (error) => {
      const scratch = new Hono();
      scratch.onError(internalErrorHandler);
      scratch.post("/admin/events", () => {
        throw error;
      });
      const res = await scratch.request(
        "/admin/events",
        { method: "POST", headers: { cookie } },
        baseEnv,
      );
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("private");
    },
  );

  it("keeps invalid moderator input at 422 without touching the database", async () => {
    const db = fakeRefusing(wrapped("55P03", 1));
    const res = await testApp.request(
      "/admin/events",
      {
        method: "POST",
        headers: formHeaders(),
        body: new URLSearchParams({ title: "", starts_at: "nope", ends_at: "nope" }),
      },
      liveEnv(db),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Give the event a title.");
    expect(vi.mocked(dispatchWriteBack)).not.toHaveBeenCalled();
  });
});

const raw = process.env.DATABASE_URL;
describe.skipIf(!raw)("moderator writes bounded waits (test database)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const sessionStore = createMemorySessionStore();
  let cookie = "";
  const liveEnv = () =>
    ({ ...baseEnv, ADMIN_DB: db, SESSION_STORE: sessionStore }) as unknown as Env;

  beforeAll(async () => {
    // Measured transaction + assertion queries + pg_stat_activity observer
    // each need a connection while a separate holder pool parks its lock.
    fixture = await createMemberDataFixture(raw!, { max: 8 });
    db = fixture.db;
    cookie = await cookieFor(sessionStore, MODERATOR);
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.reset();
    await db.delete(featuredContents);
    vi.mocked(dispatchWriteBack).mockClear();
  });

  const audits = () => fixture.db.select().from(activityLog).orderBy(asc(activityLog.id));
  const settings = async () =>
    fixture.client<{ statement: string; lock: string }[]>`
      select current_setting('statement_timeout') as statement,
             current_setting('lock_timeout') as lock`;

  const holderClient = () => {
    const url = testDatabaseUrl(raw!);
    return postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
  };

  async function waitForBlocked(holderPid: number) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await fixture.client`select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and ${holderPid} = any(pg_blocking_pids(pid))`;
      if (rows.length >= 1) return;
      if (Date.now() >= deadline) throw new Error("contender did not reach the held lock");
      await delay(25);
    }
  }

  type Settled<T> =
    | { settled: true; value: T }
    | { settled: true; error: unknown }
    | { settled: false };

  async function raceBounded<T>(pending: Promise<T>): Promise<Settled<T>> {
    const verdict = pending.then(
      (value): Settled<T> => ({ settled: true, value }),
      (error): Settled<T> => ({ settled: true, error }),
    );
    const deadline = delay(SETTLE_DEADLINE_MS).then((): Settled<T> => ({ settled: false }));
    return Promise.race([verdict, deadline]);
  }

  const seedEvent = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(events)
      .values({
        eventKey: `01J00000000000000000${String(Math.floor(Math.random() * 900) + 100)}`,
        title: "Bounded night",
        game: "Chess",
        description: "Boards out",
        startsAt: new Date("2099-11-04T20:00:00.000Z"),
        endsAt: new Date("2099-11-04T22:00:00.000Z"),
        timezone: "Europe/London",
        location: "Voice",
        capacity: 8,
        status: "draft",
        ...over,
      })
      .returning();
    return row!;
  };

  const seedFeatured = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(featuredContents)
      .values({
        title: "Bounded slot",
        body: "Bounded body",
        url: null,
        imageUrl: null,
        imageAlt: null,
        isPublished: false,
        position: 3,
        startsAt: null,
        endsAt: null,
        ...over,
      })
      .returning();
    return row!;
  };

  const eventInput = () => parseEventForm({ ...EVENT_FORM });
  const featuredInput = () => parseFeaturedForm({ ...FEATURED_FORM });

  it("control: an uncontended event update lands, audits once, and owes its write-back", async () => {
    const seeded = await seedEvent({ status: "published" });
    const beforeSettings = await settings();
    const { row, writeBack, childWriteBacks } = await updateEvent(
      db,
      MOD,
      seeded.eventKey,
      eventInput(),
    );
    expect(row.title).toBe("Bounded night");
    expect(writeBack).toEqual({ eventKey: row.eventKey, status: "published" });
    expect(childWriteBacks).toEqual([]);
    expect(await audits()).toHaveLength(1);
    expect(vi.mocked(dispatchWriteBack)).not.toHaveBeenCalled();
    expect(await settings()).toEqual(beforeSettings);
  });

  it("control: a three-occurrence series creates atomically with no whole-request deadline", async () => {
    const beforeSettings = await settings();
    const { row } = await createEvent(db, MOD, eventInput(), {
      frequency: "weekly",
      count: 3,
      endsOn: null,
    });
    expect(await db.select().from(events)).toHaveLength(3);
    expect(await audits()).toHaveLength(3);
    expect(row.recurrenceFrequency).toBe("weekly");
    expect(await settings()).toEqual(beforeSettings);
  });

  it("control: ordinary validation still refuses without a busy verdict", async () => {
    const seeded = await seedEvent({ status: "draft", location: null });
    await expect(transitionEvent(db, MOD, seeded.eventKey, "published")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(isDatabaseUnavailable(new ValidationError({ location: "x" }))).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it("updateEvent behind a held event row fails bounded with rollback, then succeeds", async () => {
    const seeded = await seedEvent({ status: "published" });
    const beforeSettings = await settings();
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from events where event_key = ${seeded.eventKey} for update`;
      pending = updateEvent(db, MOD, seeded.eventKey, eventInput());
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(
        outcome.settled,
        "updateEvent must settle bounded while the holder still parks its row lock",
      ).toBe(true);
      if (!outcome.settled) throw new Error("unbounded updateEvent wait");
      expect("error" in outcome, "a timed-out update must reject, never resolve").toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(55P03|57014)$/)]),
      );
      expect(isDatabaseUnavailable(error)).toBe(true);
      // Rollback-confirmed while still parked: content, audit and write-back.
      const [after] = await db.select().from(events).where(eq(events.eventKey, seeded.eventKey));
      expect(after).toEqual(seeded);
      expect(await audits()).toHaveLength(0);
      expect(vi.mocked(dispatchWriteBack)).not.toHaveBeenCalled();
      expect(await settings()).toEqual(beforeSettings);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    // Later valid write succeeds after contention releases.
    const { row } = await updateEvent(db, MOD, seeded.eventKey, eventInput());
    expect(row.title).toBe("Bounded night");
    expect(await audits()).toHaveLength(1);
    expect(await settings()).toEqual(beforeSettings);
  });

  it("patchEvent behind a held event row fails bounded with rollback, then succeeds", async () => {
    const seeded = await seedEvent({ status: "published" });
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from events where event_key = ${seeded.eventKey} for update`;
      pending = patchEvent(db, MOD, seeded.eventKey, { title: "Patched title" });
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "patchEvent must settle bounded while held").toBe(true);
      if (!outcome.settled) throw new Error("unbounded patchEvent wait");
      expect("error" in outcome).toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(55P03|57014)$/)]),
      );
      expect(isDatabaseUnavailable(error)).toBe(true);
      const [after] = await db.select().from(events).where(eq(events.eventKey, seeded.eventKey));
      expect(after!.title).toBe(seeded.title);
      expect(await audits()).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const { row } = await patchEvent(db, MOD, seeded.eventKey, { title: "Patched title" });
    expect(row.title).toBe("Patched title");
    expect(await audits()).toHaveLength(1);
  });

  it("transitionEvent publish behind a held row fails bounded, then publishes", async () => {
    const seeded = await seedEvent({ status: "draft", location: "Voice" });
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from events where event_key = ${seeded.eventKey} for update`;
      pending = transitionEvent(db, MOD, seeded.eventKey, "published");
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "publish must settle bounded while held").toBe(true);
      if (!outcome.settled) throw new Error("unbounded publish wait");
      expect("error" in outcome).toBe(true);
      expect(isDatabaseUnavailable((outcome as { error: unknown }).error)).toBe(true);
      const [after] = await db.select().from(events).where(eq(events.eventKey, seeded.eventKey));
      expect(after!.status).toBe("draft");
      expect(await audits()).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const { row, writeBack } = await transitionEvent(db, MOD, seeded.eventKey, "published");
    expect(row.status).toBe("published");
    expect(writeBack).toEqual({ eventKey: row.eventKey, status: "published" });
    expect(await audits()).toHaveLength(1);
  });

  it("setRsvpOpen reopen behind a held waitlisted row fails bounded without settling", async () => {
    const seeded = await seedEvent({ status: "published", rsvpOpen: false, capacity: 1 });
    const [going] = await db
      .insert(rsvps)
      .values({ eventId: seeded.id, userId: "100000000000000201", status: "going" })
      .returning();
    const [waitlisted] = await db
      .insert(rsvps)
      .values({ eventId: seeded.id, userId: "100000000000000202", status: "waitlisted" })
      .returning();
    void going;
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from rsvps where id = ${waitlisted!.id} for update`;
      pending = setRsvpOpen(db, MOD, seeded.eventKey, true);
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "reopen must settle bounded while the waitlist row is held").toBe(
        true,
      );
      if (!outcome.settled) throw new Error("unbounded reopen wait");
      expect("error" in outcome).toBe(true);
      expect(isDatabaseUnavailable((outcome as { error: unknown }).error)).toBe(true);
      const [after] = await db.select().from(events).where(eq(events.eventKey, seeded.eventKey));
      expect(after!.rsvpOpen).toBe(false);
      const line = await db.select().from(rsvps).where(eq(rsvps.eventId, seeded.id));
      expect(line.find((r) => r.userId === "100000000000000202")!.status).toBe("waitlisted");
      expect(await audits()).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const { row } = await setRsvpOpen(db, MOD, seeded.eventKey, true);
    expect(row.rsvpOpen).toBe(true);
    expect(await audits()).toHaveLength(1);
  });

  it("parent reschedule behind a held child row fails bounded with zero child writes", async () => {
    const { row: parent } = await createEvent(db, MOD, eventInput(), {
      frequency: "weekly",
      count: 2,
      endsOn: null,
    });
    const children = await db.select().from(events).where(eq(events.parentEventId, parent.id));
    expect(children).toHaveLength(1);
    const child = children[0]!;
    const auditsBefore = await audits();
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    const moved = parseEventForm({
      ...EVENT_FORM,
      starts_at: "2099-11-05 20:00",
      ends_at: "2099-11-05 22:00",
    });
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from events where id = ${child.id} for update`;
      pending = updateEvent(db, MOD, parent.eventKey, moved);
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "child-blocked reschedule must settle bounded").toBe(true);
      if (!outcome.settled) throw new Error("unbounded child reschedule wait");
      expect("error" in outcome).toBe(true);
      expect(isDatabaseUnavailable((outcome as { error: unknown }).error)).toBe(true);
      const [parentAfter] = await db.select().from(events).where(eq(events.id, parent.id));
      const [childAfter] = await db.select().from(events).where(eq(events.id, child.id));
      expect(parentAfter).toEqual(parent);
      expect(childAfter).toEqual(child);
      expect(await audits()).toEqual(auditsBefore);
      expect(vi.mocked(dispatchWriteBack)).not.toHaveBeenCalled();
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const { childWriteBacks } = await updateEvent(db, MOD, parent.eventKey, moved);
    expect(childWriteBacks).toEqual([]);
    expect((await audits()).length).toBeGreaterThan(auditsBefore.length);
  });

  it("updateFeatured behind a held row fails bounded with rollback, then succeeds", async () => {
    const seeded = await seedFeatured();
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from featured_contents where id = ${seeded.id} for update`;
      pending = updateFeatured(db, MOD, seeded.id, {
        ...featuredInput(),
        title: "Edited slot",
      });
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "featured update must settle bounded while held").toBe(true);
      if (!outcome.settled) throw new Error("unbounded featured update wait");
      expect("error" in outcome).toBe(true);
      expect(isDatabaseUnavailable((outcome as { error: unknown }).error)).toBe(true);
      const [after] = await db
        .select()
        .from(featuredContents)
        .where(eq(featuredContents.id, seeded.id));
      expect(after!.title).toBe(seeded.title);
      expect(await audits()).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const row = await updateFeatured(db, MOD, seeded.id, {
      ...featuredInput(),
      title: "Edited slot",
    });
    expect(row.title).toBe("Edited slot");
    expect(await audits()).toHaveLength(1);
  });

  it("deleteFeatured behind a held row fails bounded, then deletes", async () => {
    const seeded = await seedFeatured();
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from featured_contents where id = ${seeded.id} for update`;
      pending = deleteFeatured(db, MOD, seeded.id);
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "featured delete must settle bounded while held").toBe(true);
      if (!outcome.settled) throw new Error("unbounded featured delete wait");
      expect("error" in outcome).toBe(true);
      expect(isDatabaseUnavailable((outcome as { error: unknown }).error)).toBe(true);
      expect(
        await db.select().from(featuredContents).where(eq(featuredContents.id, seeded.id)),
      ).toHaveLength(1);
      expect(await audits()).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    await deleteFeatured(db, MOD, seeded.id);
    expect(
      await db.select().from(featuredContents).where(eq(featuredContents.id, seeded.id)),
    ).toHaveLength(0);
    expect(await audits()).toHaveLength(1);
  });

  it("createEvent behind a held audit table lock fails bounded with zero rows", async () => {
    const beforeSettings = await settings();
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE activity_log IN EXCLUSIVE MODE");
      pending = createEvent(db, MOD, eventInput(), null);
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "audit-blocked create must settle bounded").toBe(true);
      if (!outcome.settled) throw new Error("unbounded audit-blocked create wait");
      expect("error" in outcome).toBe(true);
      expect(isDatabaseUnavailable((outcome as { error: unknown }).error)).toBe(true);
      expect(await db.select().from(events)).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
      expect(await settings()).toEqual(beforeSettings);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const { row } = await createEvent(db, MOD, eventInput(), null);
    expect(row.title).toBe("Bounded night");
    expect(await audits()).toHaveLength(1);
  });

  it("createFeatured behind a held audit table lock fails bounded with zero rows", async () => {
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE activity_log IN EXCLUSIVE MODE");
      pending = createFeatured(db, MOD, featuredInput());
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "audit-blocked featured create must settle bounded").toBe(true);
      if (!outcome.settled) throw new Error("unbounded featured create wait");
      expect("error" in outcome).toBe(true);
      expect(isDatabaseUnavailable((outcome as { error: unknown }).error)).toBe(true);
      expect(await db.select().from(featuredContents)).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const row = await createFeatured(db, MOD, featuredInput());
    expect(row.title).toBe("Bounded slot");
    expect(await audits()).toHaveLength(1);
  });

  it("a slow statement inside an event write is cancelled by statement_timeout", async () => {
    const seeded = await seedEvent({ status: "published" });
    await fixture.client`
      CREATE OR REPLACE FUNCTION bounded_write_sleep() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(6);
        RETURN NEW;
      END $$`;
    await fixture.client`
      CREATE TRIGGER bounded_write_sleep BEFORE UPDATE ON events
      FOR EACH ROW EXECUTE FUNCTION bounded_write_sleep()`;
    try {
      await expect(updateEvent(db, MOD, seeded.eventKey, eventInput())).rejects.toSatisfy(
        (error: unknown) => codesInChain(error).includes("57014"),
      );
      const [after] = await db.select().from(events).where(eq(events.eventKey, seeded.eventKey));
      expect(after).toEqual(seeded);
      expect(await audits()).toHaveLength(0);
    } finally {
      await fixture.client`DROP TRIGGER bounded_write_sleep ON events`;
      await fixture.client`DROP FUNCTION bounded_write_sleep()`;
    }
    const { row } = await updateEvent(db, MOD, seeded.eventKey, eventInput());
    expect(row.title).toBe("Bounded night");
  });

  it("admin event save behind a held row answers 503 with no redirect or write-back", async () => {
    const seeded = await seedEvent({ status: "published" });
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from events where event_key = ${seeded.eventKey} for update`;
      pending = Promise.resolve(
        testApp.request(
          `/admin/events/${seeded.eventKey}`,
          {
            method: "POST",
            headers: {
              cookie,
              origin: baseEnv.APP_URL,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(EVENT_FORM),
          },
          liveEnv(),
        ),
      );
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending!);
      expect(outcome.settled, "held admin save must answer bounded").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded admin save wait");
      const res = (outcome as { value: Response }).value;
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("cache-control")).toContain("private");
      expect(res.headers.get("location")).toBeNull();
      const body = await res.text();
      expect(body).not.toMatch(/private query details|55P03|57014/);
      expect(vi.mocked(dispatchWriteBack)).not.toHaveBeenCalled();
      const [after] = await db.select().from(events).where(eq(events.eventKey, seeded.eventKey));
      expect(after).toEqual(seeded);
      expect(await audits()).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const retry = await testApp.request(
      `/admin/events/${seeded.eventKey}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: baseEnv.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(EVENT_FORM),
      },
      liveEnv(),
    );
    expect(retry.status).toBe(303);
    expect(await audits()).toHaveLength(1);
  });

  it("JSON PATCH behind a held row answers 503 db_unavailable with no write-back", async () => {
    const seeded = await seedEvent({ status: "published" });
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from events where event_key = ${seeded.eventKey} for update`;
      pending = Promise.resolve(
        testApp.request(
          `/events/${seeded.eventKey}`,
          {
            method: "PATCH",
            headers: {
              cookie,
              origin: baseEnv.APP_URL,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ title: "Patched while held" }),
          },
          liveEnv(),
        ),
      );
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending!);
      expect(outcome.settled, "held JSON PATCH must answer bounded").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded JSON PATCH wait");
      const res = (outcome as { value: Response }).value;
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "db_unavailable" });
      expect(vi.mocked(dispatchWriteBack)).not.toHaveBeenCalled();
      const [after] = await db.select().from(events).where(eq(events.eventKey, seeded.eventKey));
      expect(after!.title).toBe(seeded.title);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const retry = await testApp.request(
      `/events/${seeded.eventKey}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          origin: baseEnv.APP_URL,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ title: "Patched after release" }),
      },
      liveEnv(),
    );
    expect(retry.status).toBe(200);
  });

  it("admin featured delete behind a held row answers 503, then deletes", async () => {
    const seeded = await seedFeatured();
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from featured_contents where id = ${seeded.id} for update`;
      pending = Promise.resolve(
        testApp.request(
          `/admin/featured/${seeded.id}/delete`,
          { method: "POST", headers: { cookie, origin: baseEnv.APP_URL } },
          liveEnv(),
        ),
      );
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending!);
      expect(outcome.settled, "held featured delete must answer bounded").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded featured delete wait");
      const res = (outcome as { value: Response }).value;
      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
      expect(
        await db.select().from(featuredContents).where(eq(featuredContents.id, seeded.id)),
      ).toHaveLength(1);
      expect(await audits()).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const retry = await testApp.request(
      `/admin/featured/${seeded.id}/delete`,
      { method: "POST", headers: { cookie, origin: baseEnv.APP_URL } },
      liveEnv(),
    );
    expect(retry.status).toBe(303);
    expect(await audits()).toHaveLength(1);
  });

  it("live missing-key writes keep the not-found contract, never the outage", async () => {
    await expect(
      updateEvent(db, MOD, "01J00000000000000000000999", eventInput()),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      patchEvent(db, MOD, "01J00000000000000000000999", { title: "x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteFeatured(db, MOD, 987654321)).rejects.toBeInstanceOf(NotFoundError);
    expect(await audits()).toHaveLength(0);
  });
});
