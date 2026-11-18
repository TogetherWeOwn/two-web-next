import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, rsvps } from "../../src/db/admin-schema";
import { waitlistOffers } from "../../src/db/dormant-schema";
import {
  allocateWaitlistOffers,
  claimWaitlistOffer,
  createWaitlistOffer,
  declineWaitlistOffer,
  expireWaitlistOffer,
} from "../../src/events/waitlist-offers";
import { pgEventStore } from "../../src/jobs/events";
import { createMemberDataFixture, type MemberDataFixture, testDatabaseUrl } from "./member-data-db";

// Disposable-schema proof of the dormant offer lifecycle. No production caller
// exists yet; each case drives the store through real transactions and locks.
const HOUR = 3600_000;
export function registerWaitlistOfferLifecycle() {
  describe("waitlist offer lifecycle (real Postgres)", () => {
    let fx: MemberDataFixture;
    beforeAll(async () => {
      fx = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
    });
    beforeEach(() => fx.reset());
    afterEach(() => fx.reset());
    afterAll(() => fx?.dispose());

    let seq = 0;
    async function seed(
      opts: { startsInMs?: number; capacity?: number | null; users?: string[] } = {},
    ) {
      const startsAt = new Date(Date.now() + (opts.startsInMs ?? 24 * HOUR));
      const [event] = await fx.db
        .insert(events)
        .values({
          eventKey: `wl-offer-${++seq}`,
          title: "Waitlist night",
          status: "published",
          capacity: opts.capacity === undefined ? 1 : opts.capacity,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 2 * HOUR),
        })
        .returning();
      const rows = await fx.db
        .insert(rsvps)
        .values(
          (opts.users ?? ["u1"]).map((userId) => ({
            eventId: event!.id,
            userId,
            status: "waitlisted",
            syncedToDiscordAt: new Date(),
          })),
        )
        .returning();
      return { event: event!, rsvp: rows[0]!, rows };
    }
    const run = <T>(
      fn: (tx: Parameters<Parameters<typeof fx.db.transaction>[0]>[0]) => Promise<T>,
    ) => fx.db.transaction(fn);
    const create = async (_e: { id: number }, r: { id: number }) => {
      const offer = await run((tx) => createWaitlistOffer(tx, r.id));
      return offer ? { ok: true as const, offer } : { ok: false as const, reason: "refused" };
    };
    const claim = (e: { id: number }, r: { id: number }, userId: string, offerId: string) =>
      run((tx) => claimWaitlistOffer(tx, e.id, r.id, userId, offerId));
    const decline = (e: { id: number }, r: { id: number }, userId: string, offerId: string) =>
      run((tx) => declineWaitlistOffer(tx, e.id, r.id, userId, offerId));
    const expire = (e: { id: number }, r: { id: number }, offerId: string) =>
      run((tx) => expireWaitlistOffer(tx, e.id, r.id, offerId));
    const offers = () => fx.db.select().from(waitlistOffers);
    const rsvpOf = async (id: number) =>
      (await fx.db.select().from(rsvps).where(eq(rsvps.id, id)))[0]!;
    const made = async (e: { id: number }, r: { id: number }) => {
      const res = await create(e, r);
      if (!res.ok) throw new Error(`offer refused: ${res.reason}`);
      return res.offer;
    };
    // Move an offer's window wholly into the past using the database clock.
    const lapse = (id: string) =>
      fx.db
        .update(waitlistOffers)
        .set({
          offeredAt: sql`now() - interval '3 hours'`,
          expiresAt: sql`now() - interval '1 second'`,
        })
        .where(eq(waitlistOffers.id, id));

    const allocate = (eventId: number) => run((tx) => allocateWaitlistOffers(tx, eventId));

    it("allocates only the free seats in exact FIFO order without touching RSVP mirrors", async () => {
      const { event, rows } = await seed({
        capacity: 5,
        users: ["later", "native", "tied", "legacy", "last", "going"],
      });
      const [later, native, tied, legacy, last, going] = rows;
      await fx.db.update(rsvps).set({ status: "going" }).where(eq(rsvps.id, going!.id));
      await fx.db
        .update(rsvps)
        .set({
          createdAt: sql`timestamptz '2026-01-01T00:00:00.000001Z' +
            case when id = ${later!.id} then interval '1 microsecond' else interval '0' end`,
          legacyId: sql`case id when ${tied!.id} then ${native!.id}::bigint
            when ${legacy!.id} then ${native!.id - 1}::bigint else null end`,
        })
        .where(eq(rsvps.eventId, event.id));
      const before = await fx.db.select().from(rsvps).orderBy(rsvps.id);
      expect((await allocate(event.id)).map((o) => o.rsvpId)).toEqual([
        legacy!.id,
        native!.id,
        tied!.id,
        last!.id,
      ]);
      expect(await fx.db.select().from(rsvps).orderBy(rsvps.id)).toEqual(before);
    });

    it("serializes concurrent allocators and keeps existing holds after a capacity reduction", async () => {
      const { event, rows } = await seed({ capacity: 2, users: ["u1", "u2", "u3"] });
      const results = await Promise.all([allocate(event.id), allocate(event.id)]);
      expect(results.map((batch) => batch.length).sort()).toEqual([0, 2]);
      const held = results.flat();
      expect(held.map((offer) => offer.rsvpId)).toEqual(rows.slice(0, 2).map((row) => row.id));
      await fx.db.update(events).set({ capacity: 1 }).where(eq(events.id, event.id));
      expect(await allocate(event.id)).toEqual([]);
      expect(await offers()).toHaveLength(2);
      expect(await offers()).toEqual(expect.arrayContaining(held));
    });

    it.each(["declined", "expired"] as const)(
      "advances past a %s head with a fresh hold",
      async (state) => {
        const { event, rsvp, rows } = await seed({ users: ["u1", "u2"] });
        const old = await made(event, rsvp);
        if (state === "declined") {
          expect((await decline(event, rsvp, "u1", old.id)).ok).toBe(true);
        } else await lapse(old.id);
        const allocated = await allocate(event.id);
        expect(allocated).toHaveLength(1);
        const next = allocated[0]!;
        expect(next).toMatchObject({ rsvpId: rows[1]!.id, state: "held" });
        expect(next.notificationKey).not.toBe(old.notificationKey);
        expect(next.expiresAt.getTime() - next.offeredAt.getTime()).toBe(2 * HOUR);
        expect((await offers()).find((offer) => offer.id === old.id)?.state).toBe(state);
      },
    );

    it.each([{ rsvpOpen: false }, { status: "cancelled" }, { status: "draft" }])(
      "freezes allocation for %j even with vacancies",
      async (patch) => {
        const { event } = await seed();
        await fx.db.update(events).set(patch).where(eq(events.id, event.id));
        expect(await allocate(event.id)).toEqual([]);
        expect(await offers()).toEqual([]);
      },
    );

    it("offers every unbounded seat but caps every window at event start", async () => {
      const { event, rows } = await seed({ capacity: null, startsInMs: HOUR, users: ["u1", "u2"] });
      const allocated = await allocate(event.id);
      expect(allocated.map((offer) => offer.rsvpId)).toEqual(rows.map((row) => row.id));
      for (const offer of allocated) expect(offer.expiresAt).toEqual(event.startsAt);
    });

    const actions = ["claim", "decline", "expire"] as const;
    it.each(actions)("%s reads the clock after the event lock", async (action) => {
      const { event, rsvp } = await seed();
      const offer = await made(event, rsvp);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let holderPid = 0;
      const holder = run(async (tx) => {
        await tx.execute(sql`select 1 from events where id = ${event.id} for update`);
        const rows = await tx.execute(sql`select pg_backend_pid() as pid`);
        holderPid = Number((rows as unknown as { pid: number }[])[0]!.pid);
        await gate;
        await tx
          .update(waitlistOffers)
          .set({ expiresAt: sql`clock_timestamp()` })
          .where(eq(waitlistOffers.id, offer.id));
      });
      const holderDeadline = performance.now() + 5000;
      while (!holderPid && performance.now() < holderDeadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (!holderPid) {
        release();
        await holder;
        throw new Error("event lock holder did not start");
      }
      const pending =
        action === "expire"
          ? expire(event, rsvp, offer.id)
          : (action === "claim" ? claim : decline)(event, rsvp, "u1", offer.id);
      try {
        const deadline = performance.now() + 5000;
        let blocked = 0;
        while (!blocked && performance.now() < deadline) {
          const rows = await fx.client`select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and ${holderPid} = any(pg_blocking_pids(pid))`;
          blocked = rows[0]!.n as number;
          if (!blocked) await new Promise((r) => setTimeout(r, 20));
        }
        expect(blocked).toBeGreaterThan(0);
        expect((await offers())[0]!.state).toBe("held");
      } finally {
        release();
        await Promise.all([holder, pending]);
      }
      expect(await pending).toMatchObject(
        action === "expire"
          ? { ok: true, replay: false, offer: { state: "expired" } }
          : { ok: false, reason: "expired" },
      );
      expect((await offers())[0]!.state).toBe(action === "expire" ? "expired" : "held");
      expect((await rsvpOf(rsvp.id)).status).toBe("waitlisted");
    });

    it.each(["expiry", "start"] as const)("refuses exactly at %s", async (boundary) => {
      const { event, rsvp } = await seed({ capacity: 2, users: ["u1", "u2"] });
      const offer = await made(event, rsvp);
      await run(async (tx) => {
        // Shadow only this transaction's clock with its fixed database timestamp.
        await tx.execute(sql`create function ${sql.identifier(fx.schemaName)}.clock_timestamp()
          returns timestamptz language sql stable as 'select pg_catalog.transaction_timestamp()'`);
        await tx.execute(
          sql`select set_config('search_path', ${`${fx.schemaName}, pg_catalog`}, true)`,
        );
        if (boundary === "expiry") {
          await tx
            .update(waitlistOffers)
            .set({ expiresAt: sql`transaction_timestamp()` })
            .where(eq(waitlistOffers.id, offer.id));
        } else {
          await tx
            .update(events)
            .set({ startsAt: sql`transaction_timestamp()` })
            .where(eq(events.id, event.id));
        }
        const [proof] = await tx.execute<{ equal: boolean; live: boolean }>(sql`
          select ${boundary === "expiry" ? sql`o.expires_at` : sql`e.starts_at`} = clock_timestamp() as equal,
            o.expires_at > clock_timestamp() as live
          from waitlist_offers o join events e on e.id = ${event.id} where o.id = ${offer.id}`);
        expect(proof).toMatchObject({ equal: true, live: boundary === "start" });
        expect(await claimWaitlistOffer(tx, event.id, rsvp.id, "u1", offer.id)).toMatchObject({
          ok: false,
          reason: boundary === "expiry" ? "expired" : "unavailable",
        });
        const state = async () =>
          (await tx.select().from(waitlistOffers).where(eq(waitlistOffers.id, offer.id)))[0]!.state;
        expect(await state()).toBe("held");
        if (boundary === "expiry") {
          expect(await declineWaitlistOffer(tx, event.id, rsvp.id, "u1", offer.id)).toEqual({
            ok: false,
            reason: "expired",
          });
          expect((await expireWaitlistOffer(tx, event.id, rsvp.id, offer.id)).ok).toBe(true);
          const [stamp] = await tx.execute<{ exact: boolean }>(sql`
            select updated_at = expires_at as exact from waitlist_offers where id = ${offer.id}`);
          expect(stamp?.exact).toBe(true);
        } else {
          expect(await allocateWaitlistOffers(tx, event.id)).toEqual([]);
        }
        await tx.execute(sql`drop function ${sql.identifier(fx.schemaName)}.clock_timestamp()`);
      });
      expect((await offers())[0]!.state).toBe(boundary === "expiry" ? "expired" : "held");
      expect((await rsvpOf(rsvp.id)).status).toBe("waitlisted");
    });

    it("claims for the owner, resets the mirror, and replays acceptance", async () => {
      const { event, rsvp } = await seed();
      const offer = await made(event, rsvp);
      const res = await claim(event, rsvp, "u1", offer.id.toUpperCase());
      expect(res).toMatchObject({ ok: true, offer: { id: offer.id, state: "accepted" } });
      expect(await rsvpOf(rsvp.id)).toMatchObject({ status: "going", syncedToDiscordAt: null });
      await fx.db.update(rsvps).set({ syncedToDiscordAt: new Date() }).where(eq(rsvps.id, rsvp.id));
      const replay = await claim(event, rsvp, "u1", offer.id);
      expect(replay).toMatchObject({ ok: true, replay: true, offer: { id: offer.id } });
      // A replay must not reopen the mirror outbox.
      expect((await rsvpOf(rsvp.id)).syncedToDiscordAt).not.toBeNull();
    });

    it("does not let an older sync settlement acknowledge a claimed RSVP", async () => {
      const { event, rsvp } = await seed();
      const offer = await made(event, rsvp);
      await fx.db
        .update(rsvps)
        .set({ updatedAt: new Date("2019-01-01T00:00:00Z") })
        .where(eq(rsvps.id, rsvp.id));
      // Drizzle changes its client's timestamp serializers; the jobs store uses
      // its own Postgres client in production. Keep this one schema-scoped too.
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      const client = postgres(url.href, {
        max: 1,
        password: () => url.password,
        connection: { search_path: fx.schemaName },
      });
      try {
        const store = pgEventStore(client);
        const attempt = await store.prepareSync(
          event.eventKey,
          "00000000-0000-4000-8000-000000000001",
          new Date("2020-01-01T00:00:00Z"),
        );
        if (!attempt || "waiting" in attempt) throw new Error("sync attempt not prepared");
        expect((await claim(event, rsvp, "u1", offer.id)).ok).toBe(true);
        await store.completeSync(attempt, "discord-event");
        const [settled] = await fx.client`select state from event_sync_attempts
          where idempotency_key = ${attempt.idempotencyKey}::uuid`;
        expect(settled?.state).toBe("succeeded");
        expect(await rsvpOf(rsvp.id)).toMatchObject({ status: "going", syncedToDiscordAt: null });
      } finally {
        await client.end({ timeout: 1 });
      }
    });

    it("lets only one of two racing claims win the last seat", async () => {
      const { event, rows } = await seed({ capacity: 2, users: ["u1", "u2"] });
      const [a, b] = [await made(event, rows[0]!), await made(event, rows[1]!)];
      // A moderator may reduce capacity after the offers were issued.
      await fx.db.update(events).set({ capacity: 1 }).where(eq(events.id, event.id));
      const results = await Promise.all([
        claim(event, rows[0]!, "u1", a.id),
        claim(event, rows[1]!, "u2", b.id),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const going = (await fx.db.select().from(rsvps)).filter((r) => r.status === "going");
      expect(going).toHaveLength(1);
      const accepted = (await offers()).filter((o) => o.state === "accepted");
      expect(accepted).toHaveLength(1);
    });

    it("serializes racing claims by one owner into one claim and one replay", async () => {
      const { event, rsvp } = await seed();
      const offer = await made(event, rsvp);
      const results = await Promise.all([
        claim(event, rsvp, "u1", offer.id),
        claim(event, rsvp, "u1", offer.id),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.ok && r.replay)).toHaveLength(1);
    });

    it("denies a non-owner claim without changing state", async () => {
      const { event, rsvp } = await seed({ users: ["u1", "u2"] });
      const offer = await made(event, rsvp);
      expect(await claim(event, rsvp, "u1", "")).toMatchObject({ ok: false, reason: "not_found" });
      expect(await claim(event, rsvp, "u1", "invalid")).toMatchObject({
        ok: false,
        reason: "not_found",
      });
      expect(await claim(event, rsvp, "u2", offer.id)).toMatchObject({ ok: false });
      expect((await offers())[0]!.state).toBe("held");
      expect((await rsvpOf(rsvp.id)).status).toBe("waitlisted");
    });

    it("refuses a full, closed, unpublished or started event and an unknown offer id", async () => {
      const full = await seed({ users: ["u1", "u2"] });
      const fullOffer = await made(full.event, full.rsvp);
      await fx.db.update(rsvps).set({ status: "going" }).where(eq(rsvps.id, full.rows[1]!.id));
      expect(await claim(full.event, full.rsvp, "u1", fullOffer.id)).toMatchObject({ ok: false });

      for (const patch of [
        { rsvpOpen: false },
        { status: "draft" },
        { startsAt: new Date(Date.now() - 1000) },
      ]) {
        const { event, rsvp } = await seed();
        const offer = await made(event, rsvp);
        await fx.db.update(events).set(patch).where(eq(events.id, event.id));
        expect(await claim(event, rsvp, "u1", offer.id)).toMatchObject({ ok: false });
        expect((await rsvpOf(rsvp.id)).status).toBe("waitlisted");
      }
      const { event, rsvp } = await seed();
      const wrong = await claim(event, rsvp, "u1", "00000000-0000-4000-8000-000000000000");
      expect(wrong).toMatchObject({ ok: false });
    });

    it("refuses to claim an expired offer, then expires it and issues a fresh window and key", async () => {
      const { event, rsvp } = await seed();
      const old = await made(event, rsvp);
      await lapse(old.id);
      expect(await claim(event, rsvp, "u1", old.id)).toMatchObject({ ok: false });
      expect((await rsvpOf(rsvp.id)).status).toBe("waitlisted");
      const fresh = await create(event, rsvp);
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      expect(fresh.offer.id).not.toBe(old.id);
      expect(fresh.offer.notificationKey).not.toBe(old.notificationKey);
      expect(fresh.offer.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const states = Object.fromEntries((await offers()).map((o) => [o.id, o.state]));
      expect(states).toEqual({ [old.id]: "expired", [fresh.offer.id]: "held" });
    });

    it("refuses a claim at event start even while the offer window is open", async () => {
      const { event, rsvp } = await seed({ startsInMs: 30 * 60_000 });
      const offer = await made(event, rsvp);
      await fx.db
        .update(events)
        .set({ startsAt: sql`now() - interval '1 second'` })
        .where(eq(events.id, event.id));
      await fx.db.update(waitlistOffers).set({ offeredAt: sql`now() - interval '1 minute'` });
      expect(await claim(event, rsvp, "u1", offer.id)).toMatchObject({ ok: false });
      expect((await rsvpOf(rsvp.id)).status).toBe("waitlisted");
    });

    it("binds a decline to the owner, event, RSVP and offer even on replay", async () => {
      const { event, rsvp, rows } = await seed({ users: ["u1", "u2"] });
      const other = await seed();
      const offer = await made(event, rsvp);
      const missing = { ok: false, reason: "not_found" };
      expect(await decline(event, rsvp, "u1", "invalid")).toEqual(missing);
      expect(await decline(event, rsvp, "u2", offer.id)).toEqual(missing);
      expect(await decline(event, rows[1]!, "u2", offer.id)).toEqual(missing);
      expect(await decline(other.event, rsvp, "u1", offer.id)).toEqual(missing);
      expect(await expire(event, rows[1]!, offer.id)).toEqual(missing);
      expect(await expire(event, rsvp, offer.id)).toEqual({ ok: false, reason: "not_due" });
      expect(await offers()).toEqual([offer]);
      expect(await decline(event, rsvp, "u1", offer.id.toUpperCase())).toMatchObject({
        ok: true,
        replay: false,
        offer: { state: "declined", notificationKey: offer.notificationKey },
      });
      expect(await decline(event, rsvp, "u2", offer.id)).toEqual(missing);
      expect(await rsvpOf(rsvp.id)).toEqual(rsvp);
    });

    it("expires only the requested offer when two holds in the event are due", async () => {
      const { event, rsvp, rows } = await seed({ capacity: 2, users: ["u1", "u2"] });
      const target = await made(event, rsvp);
      const other = await made(event, rows[1]!);
      await lapse(target.id);
      await lapse(other.id);
      const before = (await offers()).find((offer) => offer.id === other.id);
      expect(before).toMatchObject({ state: "held" });

      expect(await expire(event, rsvp, target.id)).toMatchObject({
        ok: true,
        replay: false,
        offer: { id: target.id, state: "expired" },
      });
      const after = await offers();
      expect(after.find((offer) => offer.id === target.id)?.state).toBe("expired");
      expect(after.find((offer) => offer.id === other.id)).toEqual(before);
    });

    it.each(["declined", "expired"] as const)("replays %s safely", async (state) => {
      const { event, rsvp } = await seed();
      const old = await made(event, rsvp);
      const release = () =>
        state === "expired" ? expire(event, rsvp, old.id) : decline(event, rsvp, "u1", old.id);
      if (state === "expired") await lapse(old.id);
      const settled = await release();
      if (!settled.ok) throw new Error(`release refused: ${settled.reason}`);
      const fresh = await made(event, rsvp);
      expect(fresh.notificationKey).not.toBe(old.notificationKey);
      expect(await release()).toEqual({ ok: true, offer: settled.offer, replay: true });
      expect(await offers()).toEqual(expect.arrayContaining([settled.offer, fresh]));
      expect(await rsvpOf(rsvp.id)).toEqual(rsvp);
    });

    it("serializes a claim racing a decline of the same offer", async () => {
      const { event, rsvp } = await seed();
      const offer = await made(event, rsvp);
      const [claimed, declined] = await Promise.all([
        claim(event, rsvp, "u1", offer.id),
        decline(event, rsvp, "u1", offer.id),
      ]);
      expect(claimed.ok === declined.ok).toBe(false);
      expect(claimed.ok ? declined : claimed).toEqual({ ok: false, reason: "not_held" });
      expect((await offers())[0]!.state).toBe(claimed.ok ? "accepted" : "declined");
      expect((await rsvpOf(rsvp.id)).status).toBe(claimed.ok ? "going" : "waitlisted");
    });

    it.each(actions)("rolls %s back with its caller's transaction", async (action) => {
      const { event, rsvp } = await seed();
      const offer = await made(event, rsvp);
      if (action === "expire") await lapse(offer.id);
      const before = await offers();
      await expect(
        run(async (tx) => {
          const res =
            action === "expire"
              ? await expireWaitlistOffer(tx, event.id, rsvp.id, offer.id)
              : await (action === "claim" ? claimWaitlistOffer : declineWaitlistOffer)(
                  tx,
                  event.id,
                  rsvp.id,
                  "u1",
                  offer.id,
                );
          expect(res.ok).toBe(true);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect((await offers())[0]!.state).toBe("held");
      expect(await offers()).toEqual(before);
      expect(await rsvpOf(rsvp.id)).toMatchObject({ status: "waitlisted" });
      expect((await rsvpOf(rsvp.id)).syncedToDiscordAt).not.toBeNull();
    });
  });
}
