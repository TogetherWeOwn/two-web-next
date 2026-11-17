// Ports HotPathIndexTest.php; all DDL/data stays in the guarded disposable schema.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import { waitlistOffers } from "../src/db/dormant-schema";
import { joinAttempts } from "../src/db/schema";
import { createWaitlistOffer } from "../src/events/waitlist-offers";
import { JOIN_ATTEMPT_RETENTION_DAYS } from "../src/jobs/constants";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = "2026-10-01T12:00:00Z";
const expectedIndexes = [
  { name: "rsvps_event_id_status_index", table: rsvps, columns: ["event_id", "status"] },
  { name: "rsvps_unsynced_event_id_index", table: rsvps, columns: ["event_id"] },
  { name: "events_ends_at_index", table: events, columns: ["ends_at"] },
  { name: "events_starts_at_id_index", table: events, columns: ["starts_at", "id"] },
  { name: "join_attempts_outcome_index", table: joinAttempts, columns: ["outcome"] },
];

it("declares the five legacy-named indexes in the Drizzle schema", () => {
  for (const { name, table, columns } of expectedIndexes) {
    const declared = getTableConfig(table).indexes.find((index) => index.config.name === name);
    expect(declared, name).toBeDefined();
    expect(
      declared!.config.columns.map((column) => ("name" in column ? column.name : null)),
    ).toEqual(columns);
    if (name === "rsvps_unsynced_event_id_index") {
      expect(new PgDialect().sqlToQuery(declared!.config.where!).sql).toMatch(
        /"synced_to_discord_at" is null/i,
      );
    } else {
      expect(declared!.config.where).toBeUndefined();
    }
  }
});

it("declares dormant waitlist offers owned by the RSVP with no member or event column", async () => {
  const cfg = getTableConfig(waitlistOffers);
  const columnNames = cfg.columns.map((c) => c.name);
  expect(columnNames).not.toContain("user_id");
  expect(columnNames).not.toContain("event_id");
  expect(cfg.foreignKeys.map((fk) => fk.reference().foreignTable)).toEqual([rsvps]);
  expect(cfg.foreignKeys[0]!.onDelete).toBe("cascade");
  expect(cfg.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([
    ["waitlist_offers_held_rsvp_idx", true],
  ]);
  const sql = await readFile(
    fileURLToPath(new URL("../drizzle/1037_waitlist-offers.sql", import.meta.url).href),
    "utf8",
  );
  expect(sql.match(/^GRANT (\w+) ON TABLE/gm)).toEqual([
    "GRANT SELECT ON TABLE",
    "GRANT INSERT ON TABLE",
    "GRANT UPDATE ON TABLE",
  ]);
});

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe.skipIf(!process.env.DATABASE_URL)("hot-path indexes (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let client: MemberDataFixture["client"];
  let eventId: number;

  beforeAll(async () => {
    // Applies the full journal to a fresh schema, including this migration.
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
    client = fixture.client;
    // A long archive plus a small live tail makes the event range/order plans stable.
    await client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'past' || g, 'Past ' || g,
             ${NOW}::timestamptz - g * interval '1 day',
             ${NOW}::timestamptz - g * interval '1 day' + interval '2 hours',
             case g % 6 when 0 then 'cancelled' when 1 then 'past' else 'published' end
      from generate_series(1, 1500) g`;
    await client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'next' || g, 'Next ' || g,
             ${NOW}::timestamptz + g * interval '1 day',
             ${NOW}::timestamptz + g * interval '1 day' + interval '2 hours', 'published'
      from generate_series(1, 30) g`;
    const [event] = await client<{ id: number }[]>`select id from events where event_key = 'next1'`;
    eventId = event!.id;
    await client`
      insert into rsvps (event_id, user_id, status, legacy_id, created_at, synced_to_discord_at)
      select e.id, 'member' || g,
             case g % 4 when 0 then 'going' when 1 then 'waitlisted' when 2 then 'maybe' else 'not_going' end,
             100000 + g, ${NOW}::timestamptz - g * interval '1 minute',
             case when g % 97 = 0 then null else ${NOW}::timestamptz end
      from events e cross join generate_series(1, 100) g where e.id <= 120 or e.id = ${eventId}`;
    // Retained outcome batches keep the grouping path competitive with the date index.
    // These forced plans prove usability, not the winning plan for interleaved production rows.
    await client`
      insert into join_attempts (outcome, created_at)
      select case g % 3 when 0 then 'joined' when 1 then 'failed' else 'already_member' end,
             ${NOW}::timestamptz - (g % 28) * interval '1 day'
      from generate_series(1, 12000) g order by 1, g`;
    await client`analyze events`;
    await client`analyze rsvps`;
    await client`analyze join_attempts`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  it("creates all five exact index definitions on a fresh migrated schema", async () => {
    const indexes = await client<{ tablename: string; indexname: string; indexdef: string }[]>`
      select tablename, indexname, indexdef from pg_indexes where schemaname = ${fixture.schemaName}`;
    for (const { name, table, columns } of expectedIndexes) {
      const found = indexes.find((index) => index.indexname === name);
      expect(found, name).toBeDefined();
      expect(found!.tablename).toBe(getTableConfig(table).name);
      expect(found!.indexdef).toContain(`USING btree (${columns.join(", ")})`);
      if (name === "rsvps_unsynced_event_id_index") {
        expect(found!.indexdef).toContain("WHERE (synced_to_discord_at IS NULL)");
      } else {
        expect(found!.indexdef).not.toContain("WHERE");
      }
    }
  });

  it("applies twice over pre-existing legacy indexes without replacing them or losing rows", async () => {
    const migration = await readFile(
      fileURLToPath(new URL("../drizzle/1013_hot-path-indexes.sql", import.meta.url).href),
      "utf8",
    );
    await client.begin(async (tx) => {
      // Recreate the independent legacy definitions before applying the new migration.
      // These are only the fixture's indexes, not anything in public or another test schema.
      for (const { name, table, columns } of expectedIndexes) {
        await tx.unsafe(`drop index "${name}"`);
        const predicate =
          name === "rsvps_unsynced_event_id_index" ? " WHERE synced_to_discord_at IS NULL" : "";
        await tx.unsafe(
          `create index "${name}" on "${getTableConfig(table).name}" (${columns.join(", ")})${predicate}`,
        );
      }
      const snapshot = () => tx`
        select c.relname, c.oid, i.indexdef from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_indexes i on i.schemaname = n.nspname and i.indexname = c.relname
        where n.nspname = ${fixture.schemaName} and c.relname in ${tx(expectedIndexes.map((index) => index.name))}
        order by c.relname`;
      const rowCounts = () => tx`
        select (select count(*) from events) as events,
               (select count(*) from rsvps) as rsvps,
               (select count(*) from join_attempts) as attempts`;
      const before = await snapshot();
      const counts = await rowCounts();
      expect(before).toHaveLength(5);
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of migration.split("--> statement-breakpoint"))
          await tx.unsafe(statement);
        expect(await snapshot()).toEqual(before);
        expect(await rowCounts()).toEqual(counts);
      }
    });
  });

  it("stores waitlist offers per RSVP: one held, kept history, unique keys, cascade", async () => {
    const [rsvp] = await client<{ id: number }[]>`
      insert into rsvps (event_id, user_id, status)
      values (${eventId}, 'offer-fixture', 'waitlisted') returning id`;
    const rsvpId = rsvp!.id;
    const offer = (state: string, hours = 1) => client`
      insert into waitlist_offers (rsvp_id, state, offered_at, expires_at)
      values (${rsvpId!}, ${state}, now(), now() + make_interval(hours => ${hours}::int)) returning id, notification_key`;
    const [first] = await offer("held");
    await expect(offer("held")).rejects.toThrow(/waitlist_offers_held_rsvp_idx/);
    await client`update waitlist_offers set state = 'expired' where id = ${first!.id}`;
    const [second] = await offer("held");
    expect(second!.notification_key).not.toBe(first!.notification_key);
    const history = await client<{ state: string; notification_key: string }[]>`
      select state, notification_key from waitlist_offers where rsvp_id = ${rsvpId!}`;
    expect(history).toHaveLength(2);
    expect(history).toEqual(
      expect.arrayContaining([
        { state: "expired", notification_key: first!.notification_key },
        { state: "held", notification_key: second!.notification_key },
      ]),
    );
    await expect(offer("bogus")).rejects.toThrow(/waitlist_offers_state_check/);
    await expect(offer("accepted", 0)).rejects.toThrow(/waitlist_offers_window_check/);
    await expect(
      client`insert into waitlist_offers (rsvp_id, offered_at, expires_at, notification_key)
        values (${rsvpId!}, now(), now() + interval '1 hour', ${first!.notification_key})`,
    ).rejects.toThrow(/waitlist_offers_notification_key_unique/);
    await client`delete from rsvps where id = ${rsvpId!}`;
    expect(await client`select 1 from waitlist_offers`).toHaveLength(0);
  });

  describe("waitlist offer creation", () => {
    // Assumed API: createWaitlistOffer(tx, rsvpId) locks the event, reads one
    // post-lock clock_timestamp(), expires lapsed holds and returns the live
    // held offer, a new one, or null when ineligible or no seat is free.
    let offerSeq = 0;
    afterEach(async () => {
      // Scoped cleanup: never touch the suite's seeded rows.
      await client`delete from events where event_key like 'offer-event-%'`;
    });

    async function makeEvent(
      o: {
        startsIn?: string;
        capacity?: number | null;
        status?: string;
        rsvpOpen?: boolean;
        endsIn?: string;
      } = {},
    ) {
      const key = `offer-event-${++offerSeq}`;
      const [row] = await client<{ id: number }[]>`
        insert into events (event_key, title, starts_at, ends_at, status, capacity, rsvp_open)
        values (${key}, ${key}, now() + ${o.startsIn ?? "1 day"}::interval,
          now() + ${o.endsIn ?? "2 days"}::interval, ${o.status ?? "published"},
          ${o.capacity === undefined ? 1 : o.capacity}, ${o.rsvpOpen ?? true})
        returning id`;
      return row!.id;
    }
    async function makeRsvp(eventId: number, status: string, user = `u${++offerSeq}`) {
      const [row] = await client<{ id: number }[]>`
        insert into rsvps (event_id, user_id, status) values (${eventId}, ${user}, ${status})
        returning id`;
      return row!.id;
    }
    const create = (rsvpId: number) =>
      fixture.db.transaction((tx) => createWaitlistOffer(tx, rsvpId));
    const rows = (rsvpId: number) =>
      client<{ state: string; offered_at: string; expires_at: string }[]>`
        select state, offered_at::text, expires_at::text from waitlist_offers
        where rsvp_id = ${rsvpId} order by created_at, id`;

    it("creates a two-hour held offer stamped from the database clock", async () => {
      const eventId = await makeEvent();
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      const [before] = await client<{ t: string }[]>`select clock_timestamp()::text as t`;
      const offer = await create(rsvpId);
      const [after] = await client<{ t: string }[]>`select clock_timestamp()::text as t`;
      expect(offer).not.toBeNull();
      const [row] = await rows(rsvpId);
      expect(row!.state).toBe("held");
      expect(Date.parse(row!.offered_at)).toBeGreaterThanOrEqual(Date.parse(before!.t));
      expect(Date.parse(row!.offered_at)).toBeLessThanOrEqual(Date.parse(after!.t));
      expect(Date.parse(row!.expires_at) - Date.parse(row!.offered_at)).toBe(TWO_HOURS_MS);
    });

    it("takes the offer instant after waiting on the event lock, not before", async () => {
      const eventId = await makeEvent();
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      let released!: () => void;
      const gate = new Promise<void>((r) => (released = r));
      let lockedAt!: () => void;
      const locked = new Promise<void>((r) => (lockedAt = r));
      const holder = client.begin(async (tx) => {
        await tx`select id from events where id = ${eventId} for update`;
        lockedAt();
        await gate;
        const [t] = await tx<{ t: string }[]>`select clock_timestamp()::text as t`;
        return t!.t;
      });
      await locked;
      const pending = create(rsvpId);
      await new Promise((r) => setTimeout(r, 300));
      released();
      const releasedAt = await holder;
      expect(await pending).not.toBeNull();
      const [row] = await rows(rsvpId);
      expect(Date.parse(row!.offered_at)).toBeGreaterThanOrEqual(Date.parse(releasedAt));
    });

    it("truncates the window at event start", async () => {
      const eventId = await makeEvent({ startsIn: "30 minutes" });
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      expect(await create(rsvpId)).not.toBeNull();
      const [ev] = await client<
        { starts_at: string }[]
      >`select starts_at::text from events where id = ${eventId}`;
      const [row] = await rows(rsvpId);
      expect(Date.parse(row!.expires_at)).toBe(Date.parse(ev!.starts_at));
      expect(Date.parse(row!.expires_at)).toBeGreaterThan(Date.parse(row!.offered_at));
    });

    it("refuses when the event start passes while waiting on the event lock", async () => {
      const eventId = await makeEvent({ startsIn: "1 second" });
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      let locked!: () => void;
      const ready = new Promise<void>((r) => (locked = r));
      const holder = client.begin(async (tx) => {
        await tx`select id from events where id = ${eventId} for update`;
        locked();
        await new Promise((r) => setTimeout(r, 1500));
      });
      await ready;
      const pending = create(rsvpId);
      await holder;
      expect(await pending).toBeNull();
      expect(await rows(rsvpId)).toHaveLength(0);
    });

    it("rolls back a newly created offer with its transaction", async () => {
      const eventId = await makeEvent();
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      await expect(
        fixture.db.transaction(async (tx) => {
          expect(await createWaitlistOffer(tx, rsvpId)).not.toBeNull();
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await rows(rsvpId)).toHaveLength(0);
      expect(await create(rsvpId)).not.toBeNull();
    });

    it("refuses an offer once the event has started (no empty window)", async () => {
      const eventId = await makeEvent({ startsIn: "-1 minute", endsIn: "1 hour" });
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      expect(await create(rsvpId)).toBeNull();
      expect(await rows(rsvpId)).toHaveLength(0);
    });

    it("returns the live held offer instead of creating a second", async () => {
      const eventId = await makeEvent();
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      const first = await create(rsvpId);
      const again = await create(rsvpId);
      expect(again).toMatchObject({ id: first!.id, notificationKey: first!.notificationKey });
      expect(await rows(rsvpId)).toHaveLength(1);
    });

    it("expires a lapsed hold and opens a fresh window with a new key", async () => {
      const eventId = await makeEvent();
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      const [old] = await client<{ id: string; notification_key: string }[]>`
        insert into waitlist_offers (rsvp_id, offered_at, expires_at)
        values (${rsvpId}, now() - interval '3 hours', now() - interval '1 hour')
        returning id, notification_key`;
      const offer = await create(rsvpId);
      expect(offer).not.toBeNull();
      expect(offer!.id).not.toBe(old!.id);
      expect(offer!.notificationKey).not.toBe(old!.notification_key);
      const history = await rows(rsvpId);
      expect(history.map((r) => r.state)).toEqual(["expired", "held"]);
      expect(Date.parse(history[1]!.expires_at) - Date.parse(history[1]!.offered_at)).toBe(
        TWO_HOURS_MS,
      );
      expect(Date.parse(history[1]!.offered_at)).toBeGreaterThan(
        Date.parse(history[0]!.expires_at),
      );
    });

    it.each(["going", "maybe", "not_going"])("refuses a %s RSVP", async (status) => {
      const eventId = await makeEvent({ capacity: 5 });
      const rsvpId = await makeRsvp(eventId, status);
      expect(await create(rsvpId)).toBeNull();
      expect(await rows(rsvpId)).toHaveLength(0);
    });

    it.each([
      ["draft event", { status: "draft" }],
      ["cancelled event", { status: "cancelled" }],
      ["closed RSVPs", { rsvpOpen: false }],
    ])("refuses a %s", async (_name, o) => {
      const eventId = await makeEvent(o);
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      expect(await create(rsvpId)).toBeNull();
      expect(await rows(rsvpId)).toHaveLength(0);
    });

    it("refuses a missing RSVP", async () => {
      expect(await create(2_000_000_000)).toBeNull();
    });

    it("refuses when going seats fill capacity", async () => {
      const eventId = await makeEvent({ capacity: 1 });
      await makeRsvp(eventId, "going");
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      expect(await create(rsvpId)).toBeNull();
    });

    it("counts another member's live hold against capacity, and frees it on expiry", async () => {
      const eventId = await makeEvent({ capacity: 1 });
      const first = await makeRsvp(eventId, "waitlisted");
      const second = await makeRsvp(eventId, "waitlisted");
      expect(await create(first)).not.toBeNull();
      expect(await create(second)).toBeNull();
      await client`update waitlist_offers set offered_at = now() - interval '3 hours',
        expires_at = now() - interval '1 hour' where rsvp_id = ${first}`;
      expect(await create(second)).not.toBeNull();
    });

    it("scopes offers for an event with more RSVPs than the driver parameter limit", async () => {
      const eventId = await makeEvent({ capacity: 1 });
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      const otherEvent = await makeEvent();
      const otherRsvp = await makeRsvp(otherEvent, "waitlisted");
      const another = await makeRsvp(eventId, "waitlisted");
      const rollback = new Error("roll back bulk fixture");
      // Roll back the bulk rows rather than cascading 70,000 trigger-bearing deletes.
      await expect(
        fixture.db.transaction(async (tx) => {
          await tx.execute(sql`
            insert into rsvps (event_id, user_id, status)
            select ${eventId}, 'bulk-' || g, 'waitlisted' from generate_series(1, 70000) g`);
          await tx.execute(sql`
            insert into waitlist_offers (rsvp_id, offered_at, expires_at)
            values (${rsvpId}, now() - interval '3 hours', now() - interval '1 hour'),
                   (${otherRsvp}, now() - interval '3 hours', now() - interval '1 hour')`);
          const states = async (id: number) =>
            (
              await tx.execute<{ state: string }>(sql`
              select state from waitlist_offers where rsvp_id = ${id} order by created_at, id`)
            ).map((row) => row.state);
          expect(await createWaitlistOffer(tx, rsvpId)).not.toBeNull();
          expect(await states(rsvpId)).toEqual(["expired", "held"]);
          expect(await states(otherRsvp)).toEqual(["held"]);
          expect(await createWaitlistOffer(tx, rsvpId)).not.toBeNull();
          expect(await createWaitlistOffer(tx, another)).toBeNull();
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }, 60_000);

    it("offers while capacity is unlimited", async () => {
      const eventId = await makeEvent({ capacity: null });
      await makeRsvp(eventId, "going");
      const rsvpId = await makeRsvp(eventId, "waitlisted");
      expect(await create(rsvpId)).not.toBeNull();
    });

    it("serializes concurrent creators to one held offer for the last seat", async () => {
      const eventId = await makeEvent({ capacity: 1 });
      const a = await makeRsvp(eventId, "waitlisted");
      const b = await makeRsvp(eventId, "waitlisted");
      const results = await Promise.all([create(a), create(b), create(a)]);
      expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
      const [held] = await client<{ n: number }[]>`
        select count(*)::int as n from waitlist_offers where state = 'held'`;
      expect(held!.n).toBe(1);
    });
  });

  async function plan(statement: string, params: (string | number)[] = []): Promise<string> {
    return client.begin(async (tx) => {
      // Prove usable access paths, not production cost superiority on a small fixture.
      // SET LOCAL prevents this forced planner setting leaking into other tests/queries.
      await tx`set local enable_seqscan = off`;
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${statement}`, params);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
  }

  it("uses the composite RSVP index for going count and batched page counts", async () => {
    expect(
      await plan("select count(*) from rsvps where event_id = $1 and status = 'going'", [eventId]),
    ).toContain("rsvps_event_id_status_index");
    expect(
      await plan(
        "select event_id, count(*) from rsvps where event_id in ($1, $2) and status = 'going' group by event_id",
        [eventId, 1],
      ),
    ).toContain("rsvps_event_id_status_index");
  });

  it("uses the composite RSVP index for the FIFO head and locked waitlist", async () => {
    for (const limit of ["limit 5", ""]) {
      expect(
        await plan(
          `select id from rsvps where event_id = $1 and status = 'waitlisted'
        order by created_at, coalesce(legacy_id, id), id ${limit} for update`,
          [eventId],
        ),
      ).toContain("rsvps_event_id_status_index");
    }
  });

  it("uses the composite RSVP index for Next's batched waitlist-position window", async () => {
    expect(
      await plan(
        `select event_id, position from (
      select event_id, user_id, row_number() over (
        partition by event_id order by created_at, coalesce(legacy_id, id), id)::int as position
      from rsvps where event_id in ($1, $2) and status = 'waitlisted'
      ) line where user_id = $3`,
        [eventId, 1, "member1"],
      ),
    ).toContain("rsvps_event_id_status_index");
    expect(
      await plan(
        `select count(*) from rsvps where event_id = $1 and status = 'waitlisted'
      and (created_at < $2 or (created_at = $2 and id <= $3))`,
        [eventId, NOW, 1],
      ),
    ).toContain("rsvps_event_id_status_index");
  });

  it("uses the partial RSVP index for the legacy unsynced event probe", async () => {
    expect(
      await plan("select * from rsvps where event_id = $1 and synced_to_discord_at IS NULL", [
        eventId,
      ]),
    ).toContain("rsvps_unsynced_event_id_index");
  });

  it("uses ends_at for Next's unlimited upcoming calendar and the legacy bounded listing", async () => {
    for (const limit of ["", "limit 20"]) {
      expect(
        await plan(
          `select * from events where ends_at >= $1 and status <> 'draft' order by starts_at ${limit}`,
          [NOW],
        ),
      ).toContain("events_ends_at_index");
    }
  });

  it("uses starts_at/id for the calendar past drawer and paginated archive", async () => {
    expect(
      await plan(
        "select * from events where ends_at < $1 and status <> 'draft' order by starts_at desc, id desc limit 20",
        [NOW],
      ),
    ).toContain("events_starts_at_id_index");
    expect(
      await plan(
        `select * from events where status = 'past' or (status = 'published' and ends_at < $1)
      order by starts_at desc, id desc limit 21 offset 20`,
        [NOW],
      ),
    ).toContain("events_starts_at_id_index");
  });

  it("uses starts_at/id for both directions of the legacy neighbour shape", async () => {
    for (const [comparison, direction] of [
      [">", "asc"],
      ["<", "desc"],
    ]) {
      expect(
        await plan(
          `select id from events where status <> 'draft' and status <> 'cancelled'
        and (starts_at ${comparison} $1 or (starts_at = $1 and id ${comparison} $2))
        order by starts_at ${direction}, id ${direction} limit 1`,
          [NOW, eventId],
        ),
      ).toContain("events_starts_at_id_index");
    }
  });

  it("uses the outcome index for Next's retained funnel group-by", async () => {
    const cutoff = new Date(
      Date.parse(NOW) - JOIN_ATTEMPT_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    expect(
      await plan(
        "select outcome, count(*) from join_attempts where created_at >= $1 group by outcome",
        [cutoff],
      ),
    ).toContain("join_attempts_outcome_index");
  });
});
