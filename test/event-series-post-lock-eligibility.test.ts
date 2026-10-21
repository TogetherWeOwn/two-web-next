// route-inventory: POST /admin/events/:key
// route-inventory: PATCH /events/:key
// Acceptance: selecting a future child before FOR UPDATE is not permission to
// reschedule it after it starts. A real child-row lock parks the parent edit;
// pg_blocking_pids proves the rendezvous before the Date-only clock advances.
// Started (including exactly equal) children must receive no UPDATE, version,
// audit or write-back, and must not veto the edit through a hypothetical
// duration inversion. Still-future children keep independent absolute deltas.
// Only the producer's external queue is captured; SQL, transactions, locks,
// audit, revision triggers and the write-back producer all run for real.
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import { updateEvent, type EventRow } from "../src/admin/store";
import { parseEventForm, ValidationError } from "../src/admin/validation";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import { agentEventGrants } from "../src/db/schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env as baseEnv, MODERATOR } from "./helpers/member-data";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { savedForm } from "./helpers/event-save-document";

// Any producer-created connection must inherit the fixture's owned schema.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const START = new Date("2099-11-04T20:00:00.000Z");
const BEFORE = new Date("2099-11-04T19:59:59.998Z");
const CROSSED = new Date("2099-11-04T20:00:00.001Z");
const STILL_FUTURE = new Date("2099-11-04T19:59:59.999Z");
const END_ERROR = "The end is after the start.";
const FORM = {
  title: "Series lock boundary",
  game: "Chess",
  description: "An individually rescheduled occurrence overlaps its parent",
  location: "Voice",
  capacity: "1",
  starts_at: "2099-11-04 20:00",
  ends_at: "2099-11-04 22:00",
  timezone: "Europe/London",
};
const MOVE = { starts_at: "2099-11-04 20:15", ends_at: "2099-11-04 22:45" };
const SHORTEN = { ends_at: "2099-11-04 21:00", capacity: "2" };
type Surface = "store" | "native Save" | "JSON PATCH";
type Status = "published" | "cancelled" | "draft";
type Outcome = {
  status: number;
  fields?: Record<string, string>;
  childWriteBacks?: Array<{ eventKey: string; status: string }>;
};

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("series child eligibility after real lock waits (live)", () => {
  let fixture: MemberDataFixture;
  let realPostgres: typeof postgres;
  const sessions = createMemorySessionStore();
  let cookie = "";
  const sent: QueueMessage[] = [];
  const env = () =>
    ({
      ...baseEnv,
      ADMIN_DB: fixture.db,
      SESSION_STORE: sessions,
      DB: { connectionString: testDatabaseUrl(url!).href },
      SYNC_EVENT_QUEUE: { send: async (message: QueueMessage) => void sent.push(message) },
    }) as unknown as Env;

  beforeAll(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    // Holder + parent updater + concurrent PATCH + observer/producer.
    fixture = await createMemberDataFixture(url!, { max: 6 });
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}> = {}) => {
      const safe = testDatabaseUrl(raw);
      return realPostgres(safe.href, {
        ...opts,
        password: () => safe.password,
        connection: { ...opts.connection, search_path: fixture.schemaName },
      });
    }) as typeof postgres);
    // A fixture-local UPDATE receipt catches even a write whose values happen
    // to be unchanged. It is transactional, so a rejected edit leaves none.
    await fixture.client`create table series_update_receipts (event_key text not null)`;
    await fixture.client`create function record_series_update() returns trigger language plpgsql as $$
      begin
        insert into series_update_receipts(event_key) values (new.event_key);
        return new;
      end
    $$`;
    await fixture.client`create trigger record_series_update after update on events
      for each row execute function record_series_update()`;
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.delete(agentEventGrants);
    await fixture.client`delete from queue_jobs`;
    await fixture.client`delete from job_unique_locks`;
    await fixture.client`delete from web_throttle_hits`;
    await fixture.client`delete from series_update_receipts`;
    sent.length = 0;
    // Socket, observer and application deadline timers remain real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE);
    cookie = await cookieFor(sessions, MODERATOR);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
  });

  async function seed(
    status: Status = "published",
    nearEnd = "2099-11-04T22:00:00Z",
    laterEnd = "2099-11-11T22:00:00Z",
  ) {
    const [parent] = await fixture.db
      .insert(events)
      .values({
        eventKey: "lock-series-parent",
        title: FORM.title,
        game: FORM.game,
        description: FORM.description,
        location: FORM.location,
        capacity: 1,
        timezone: FORM.timezone,
        startsAt: START,
        endsAt: new Date("2099-11-04T22:00:00Z"),
        status: "published",
        recurrenceFrequency: "weekly",
        recurrenceCount: 3,
        recurrenceIndex: 1,
      })
      .returning();
    const children: EventRow[] = [];
    for (const [index, child] of [
      { eventKey: "lock-series-near", startsAt: START, endsAt: new Date(nearEnd) },
      {
        eventKey: "lock-series-later",
        startsAt: new Date("2099-11-11T20:00:00Z"),
        endsAt: new Date(laterEnd),
      },
    ].entries()) {
      const [grant] = await fixture.db
        .insert(agentEventGrants)
        .values({
          agentId: `series-fixture-${index}`,
          companyId: "synthetic-company",
          guildId: baseEnv.DISCORD_GUILD_ID,
          verifierHash: `series-fixture-hash-${index}`,
        })
        .returning();
      const [row] = await fixture.db
        .insert(events)
        .values({
          ...child,
          title: FORM.title,
          location: FORM.location,
          timezone: FORM.timezone,
          capacity: 1,
          status,
          parentEventId: parent!.id,
          recurrenceIndex: index + 2,
          agentGrantId: grant!.id,
          agentVersion: 7,
        })
        .returning();
      children.push(row!);
    }
    await fixture.db.insert(rsvps).values([
      { eventId: parent!.id, userId: "100000000000000301", status: "going" },
      { eventId: parent!.id, userId: "100000000000000302", status: "waitlisted" },
    ]);
    await fixture.client`delete from series_update_receipts`;
    return { parent: parent!, near: children[0]!, later: children[1]! };
  }

  const stored = async (key: string) =>
    (await fixture.db.select().from(events).where(eq(events.eventKey, key)))[0]!;
  const audits = (key: string) =>
    fixture.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.subjectId, key))
      .orderBy(asc(activityLog.id));
  const receipts = (key: string) =>
    fixture.client`select event_key from series_update_receipts where event_key = ${key}`;
  const snapshot = async () => ({
    events: await fixture.db.select().from(events).orderBy(events.id),
    audits: await fixture.db.select().from(activityLog).orderBy(activityLog.id),
    rsvps: await fixture.db.select().from(rsvps).orderBy(rsvps.id),
    jobs: await fixture.client`select * from queue_jobs order by job_id`,
    locks: await fixture.client`select * from job_unique_locks order by key`,
    updates: await fixture.client`select * from series_update_receipts order by event_key`,
  });

  const patch = async (key: string, body: Record<string, string>) =>
    app.request(
      `/events/${key}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          origin: baseEnv.APP_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env(),
    );
  async function edit(
    surface: Surface,
    key: string,
    changes: Record<string, string>,
  ): Promise<Outcome> {
    if (surface === "store") {
      try {
        const result = await updateEvent(
          fixture.db,
          { id: MODERATOR.userId, username: MODERATOR.username },
          key,
          parseEventForm({ ...FORM, ...changes }),
        );
        return { status: 200, childWriteBacks: result.childWriteBacks };
      } catch (error) {
        if (error instanceof ValidationError) return { status: 422, fields: error.fields };
        throw error;
      }
    }
    if (surface !== "JSON PATCH") {
      // The admin surface carries the save precondition from its own GET.
      const page = await adminApp({ sessionStore: sessions, db: fixture.db }).request(
        `/events/${key}`,
        { headers: { cookie } },
        env(),
      );
      expect(page.status).toBe(200);
      changes = { ...changes, ...savedForm(await page.text()).hidden };
    }
    const res =
      surface === "JSON PATCH"
        ? await patch(key, changes)
        : await adminApp({ sessionStore: sessions, db: fixture.db }).request(
            `/events/${key}`,
            {
              method: "POST",
              headers: { cookie, origin: baseEnv.APP_URL },
              body: new URLSearchParams({ ...FORM, ...changes }),
            },
            env(),
          );
    if (res.status === 422) {
      if (surface === "JSON PATCH") {
        const body = (await res.json()) as { fields: Record<string, string>; request_id: string };
        expect(body.request_id).toBe(res.headers.get("x-request-id"));
        return { status: 422, fields: body.fields };
      }
      expect(await res.text()).toContain(END_ERROR);
    }
    return { status: res.status };
  }

  // Follow the exact holder's blocking chain, not any unrelated waiting query
  // in this database. performance.now stays real under Date-only fake timers.
  async function waitForBlocked(holderPid: number, count = 1) {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const [row] = await fixture.client`with recursive blocked(pid) as (
        select pid from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and ${holderPid} = any(pg_blocking_pids(pid))
        union
        select a.pid from pg_stat_activity a join blocked b
          on b.pid = any(pg_blocking_pids(a.pid))
          where a.datname = current_database() and a.wait_event_type = 'Lock'
      ) select count(*)::int as n from blocked`;
      if (Number(row!.n) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`updater did not reach the held series lock (wanted ${count})`);
  }

  async function whileChildLocked<T>(
    child: EventRow,
    after: Date,
    first: () => Promise<T>,
    second?: () => Promise<Response>,
  ): Promise<{ result: T; second?: Response }> {
    let pending: Promise<T> | undefined;
    let following: Promise<Response> | undefined;
    try {
      await fixture.client.begin(async (holder) => {
        const [pid] = await holder`select pg_backend_pid() as pid`;
        await holder`select id from events where id = ${child.id} for update`;
        pending = first();
        // Attach rejection handlers now, but propagate the original outcome
        // below. Barrier failures must still release and drain every request.
        void pending.catch(() => undefined);
        await waitForBlocked(Number(pid!.pid));
        if (second) {
          following = second();
          void following.catch(() => undefined);
          // The second updater waits on the parent held by the first, which
          // is itself blocked on our child. This also proves parent-first order.
          await waitForBlocked(Number(pid!.pid), 2);
        }
        vi.setSystemTime(after);
      });
    } finally {
      await Promise.allSettled([pending, following]);
    }
    return { result: await pending!, second: following ? await following : undefined };
  }

  function writeBackKeys(surface: Surface, result: Outcome) {
    if (surface === "store") return result.childWriteBacks!.map((target) => target.eventKey).sort();
    return sent
      .filter((message) => message.kind === "sync-event")
      .map((message) => message.eventKey)
      .filter((key) => key !== "lock-series-parent")
      .sort();
  }
  async function unchanged(row: EventRow) {
    // Whole-row equality includes updatedAt, agentVersion, syncRevision,
    // syncedRevision, icsSequence, grant, status and both timestamps.
    expect.soft(await stored(row.eventKey)).toEqual(row);
    expect.soft(await audits(row.eventKey)).toEqual([]);
    expect.soft(await receipts(row.eventKey)).toHaveLength(0);
  }
  async function shifted(row: EventRow, start: string, end: string, at: Date) {
    const moved = await stored(row.eventKey);
    expect.soft(moved.startsAt.toISOString()).toBe(start);
    expect.soft(moved.endsAt.toISOString()).toBe(end);
    expect.soft(moved.updatedAt).toEqual(at);
    expect.soft(moved.agentVersion).toBe(8);
    expect.soft(moved.syncRevision).toBe(row.syncRevision + 1);
    expect.soft(moved.icsSequence).toBeGreaterThan(row.icsSequence);
    expect.soft(moved.agentGrantId).toBe(row.agentGrantId);
    expect.soft(moved.status).toBe(row.status);
    expect.soft(await receipts(row.eventKey)).toHaveLength(1);
    const logs = await audits(row.eventKey);
    expect.soft(logs).toHaveLength(1);
    expect.soft(logs[0]?.properties).toMatchObject({
      startsAt: { before: row.startsAt.toISOString(), after: start },
      endsAt: { before: row.endsAt.toISOString(), after: end },
    });
  }

  for (const surface of ["store", "native Save", "JSON PATCH"] as const) {
    describe(surface, () => {
      for (const [boundary, at] of [
        ["crossed start", CROSSED],
        ["exactly start", START],
      ] as const) {
        it.each(["published", "cancelled", "draft"] as const)(
          `${boundary}: leaves the now-started %s child untouched while shifting its later sibling`,
          async (status) => {
            const { parent, near, later } = await seed(status);
            const { result } = await whileChildLocked(near, at, () =>
              edit(surface, parent.eventKey, MOVE),
            );
            expect(result.status).toBe(surface === "native Save" ? 303 : 200);
            await unchanged(near);
            await shifted(later, "2099-11-11T20:15:00.000Z", "2099-11-11T22:45:00.000Z", at);
            expect
              .soft(writeBackKeys(surface, result))
              .toEqual(status === "draft" ? [] : [later.eventKey]);
            const saved = await stored(parent.eventKey);
            expect.soft(saved.startsAt.toISOString()).toBe("2099-11-04T20:15:00.000Z");
            expect.soft(saved.endsAt.toISOString()).toBe("2099-11-04T22:45:00.000Z");
          },
        );

        it(`${boundary}: a now-started short child cannot veto the parent's shorter end`, async () => {
          const { parent, near, later } = await seed("published", "2099-11-04T20:30:00Z");
          const { result } = await whileChildLocked(near, at, () =>
            edit(surface, parent.eventKey, SHORTEN),
          );
          expect(result.status).toBe(surface === "native Save" ? 303 : 200);
          await unchanged(near);
          expect((await stored(parent.eventKey)).endsAt.toISOString()).toBe(
            "2099-11-04T21:00:00.000Z",
          );
          const moved = await stored(later.eventKey);
          expect(moved.startsAt.toISOString()).toBe("2099-11-11T20:00:00.000Z");
          expect(moved.endsAt.toISOString()).toBe("2099-11-11T21:00:00.000Z");
          expect(moved.agentVersion).toBe(8);
          expect(await audits(later.eventKey)).toHaveLength(1);
          expect(writeBackKeys(surface, result)).toEqual([later.eventKey]);
          const answers = await fixture.db.select().from(rsvps).orderBy(rsvps.id);
          expect(answers.map((answer) => answer.status)).toEqual(["going", "going"]);
        });
      }

      it("positive control: a child still 1ms in the future gets both independent deltas exactly once", async () => {
        const { parent, near, later } = await seed();
        const { result } = await whileChildLocked(near, STILL_FUTURE, () =>
          edit(surface, parent.eventKey, MOVE),
        );
        expect(result.status).toBe(surface === "native Save" ? 303 : 200);
        await shifted(near, "2099-11-04T20:15:00.000Z", "2099-11-04T22:45:00.000Z", STILL_FUTURE);
        await shifted(later, "2099-11-11T20:15:00.000Z", "2099-11-11T22:45:00.000Z", STILL_FUTURE);
        expect(writeBackKeys(surface, result)).toEqual([later.eventKey, near.eventKey].sort());
      });

      it("a started child does not hide a later-future inversion: the entire edit still rolls back", async () => {
        const { parent, near } = await seed(
          "published",
          "2099-11-04T22:00:00Z",
          "2099-11-11T20:30:00Z",
        );
        const before = await snapshot();
        const { result } = await whileChildLocked(near, CROSSED, () =>
          edit(surface, parent.eventKey, SHORTEN),
        );
        expect(result.status).toBe(422);
        if (surface !== "native Save") expect(result.fields).toEqual({ ends_at: END_ERROR });
        expect(await snapshot()).toEqual(before);
        expect(sent).toEqual([]);
      });

      it.each([
        ["inverted", "2099-11-04T20:30:00Z"],
        ["zero-length", "2099-11-04T21:00:00Z"],
      ])(
        "negative control: a genuinely future %s child rolls back parent, audit, waitlist and write-backs",
        async (_label, end) => {
          const { parent, near } = await seed("published", end);
          const before = await snapshot();
          const { result } = await whileChildLocked(near, STILL_FUTURE, () =>
            edit(surface, parent.eventKey, SHORTEN),
          );
          expect(result.status).toBe(422);
          if (surface !== "native Save") expect(result.fields).toEqual({ ends_at: END_ERROR });
          expect(await snapshot()).toEqual(before);
          expect(sent).toEqual([]);
        },
      );
    });
  }

  it("a title-only PATCH queued behind the child wait neither restores omitted times nor double-shifts siblings", async () => {
    const { parent, near, later } = await seed();
    const { result, second } = await whileChildLocked(
      near,
      CROSSED,
      () => edit("JSON PATCH", parent.eventKey, MOVE),
      () => patch(parent.eventKey, { title: "Renamed during reschedule" }),
    );
    expect(result.status).toBe(200);
    expect(second!.status).toBe(200);
    const saved = await stored(parent.eventKey);
    expect.soft(saved.title).toBe("Renamed during reschedule");
    expect.soft(saved.startsAt.toISOString()).toBe("2099-11-04T20:15:00.000Z");
    expect.soft(saved.endsAt.toISOString()).toBe("2099-11-04T22:45:00.000Z");
    await unchanged(near);
    await shifted(later, "2099-11-11T20:15:00.000Z", "2099-11-11T22:45:00.000Z", CROSSED);
    const logs = await audits(parent.eventKey);
    expect.soft(logs).toHaveLength(2);
    expect.soft(logs[1]?.properties).toMatchObject({
      title: { before: FORM.title, after: "Renamed during reschedule" },
    });
    // Revision/timestamp bookkeeping is legitimate; omitted endpoint changes
    // are not. This assertion is deliberately about the domain delta only.
    expect.soft(logs[1]?.properties).not.toHaveProperty("startsAt");
    expect.soft(logs[1]?.properties).not.toHaveProperty("endsAt");
    expect.soft(writeBackKeys("JSON PATCH", result)).toEqual([later.eventKey]);
  });
});
