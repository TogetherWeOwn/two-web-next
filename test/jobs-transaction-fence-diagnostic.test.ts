import postgres from "postgres";
import { expect, it, vi } from "vitest";
import { databaseOptions } from "../src/db/connection";
import type { JobsEnv } from "../src/env";
import { consume } from "../src/jobs/consumer";
import { pgEventStore } from "../src/jobs/events";
import { handleQueue } from "../src/jobs/worker";
import { createJobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

// Run only via the non-deploy CI dispatch. Use the real handler's pool factory
// and teardown, replacing only the as-yet-unimplemented consumer protocol.
vi.mock("../src/jobs/consumer", () => ({ consume: vi.fn() }));
vi.mock("postgres", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof postgres }>();
  return { ...actual, default: vi.fn(actual.default) };
});

const AT = new Date("2026-10-01T10:00:00Z");
const ENDS_AT = new Date("2026-10-01T11:00:00Z");
const ROLLBACK = new Error("fixture rollback");
const HANDLER_MS = 7_000;

function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

function latch() {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, ready };
}

it("qualifies row authority and legacy DB write rejection on Node with direct PostgreSQL", async () => {
  expect(process.env.GITHUB_ACTIONS).toBe("true");
  const url = testDatabaseUrl(process.env.DATABASE_URL ?? "");
  expect(url.hostname).toBe("localhost");
  expect(url.pathname).toBe("/postgres");
  const real = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
  const fixture = await createJobsFixture(url.href);
  const outsider = fixture.client;
  const pools: postgres.Sql[] = [];
  const spyEnd = (pool: postgres.Sql) => vi.spyOn(pool, "end");
  const endSpies: ReturnType<typeof spyEnd>[] = [];
  vi.mocked(postgres).mockImplementation(((raw: string, options: postgres.Options<{}>) => {
    expect(raw === url.href).toBe(true);
    expect(options).toEqual(databaseOptions);
    const pool = real(raw, {
      ...options,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    pools.push(pool);
    endSpies.push(spyEnd(pool));
    return pool;
  }) as typeof postgres);
  const env = {
    DATABASE_URL: url.href,
    APP_URL: "https://web.invalid",
    BOT_ENDPOINT_URL: "https://bot.invalid",
    BOT_KEY_ID: "fixture",
    BOT_SHARED_SECRET: crypto.randomUUID(),
  } as unknown as JobsEnv;
  const batch = { messages: [] } as unknown as MessageBatch<unknown>;

  async function seed(eventKey: string) {
    const [event] = await outsider<{ id: number }[]>`insert into events
      (event_key, title, starts_at, ends_at, timezone, location, status)
      values (${eventKey}, 'Synthetic event', ${AT}, ${ENDS_AT}, 'UTC', 'Fixture', 'published')
      returning id`;
    return event!.id;
  }

  const read = async (key: string) =>
    (
      await outsider`select idempotency_key, event_id, revision, action, payload, mirrored_at,
      request_attempts, state, generation, next_attempt_at from event_sync_attempts
      where idempotency_key = ${key}`
    )[0];

  const trySettle = (key: string, nowait = false) =>
    outsider.begin(async (tx) => {
      await tx`set local statement_timeout = '1500ms'`;
      await tx`set local lock_timeout = '1000ms'`;
      await tx`select 1 from event_sync_attempts where idempotency_key = ${key}
        for update ${nowait ? tx`nowait` : tx``}`;
      return tx`update event_sync_attempts set state = 'failed', generation = generation + 1
        where idempotency_key = ${key} and state = 'pending' and generation = 1 returning state`;
    });

  try {
    const [server] = await outsider<
      { version: number }[]
    >`select current_setting('server_version_num')::int as version`;
    expect(Math.floor(server!.version / 10_000)).toBe(17);
    // Stage the additive column before the legacy client prepares SELECT a.*.
    // Activate only the trigger after the claim so the result shape stays stable.
    await outsider`alter table event_sync_attempts add column generation bigint`;
    const legacy = pgEventStore(outsider);
    const legacyId = await seed("fixture-legacy");
    const legacyKey = crypto.randomUUID();
    const old = await legacy.prepareSync("fixture-legacy", legacyKey, AT);
    if (!old || "waiting" in old) throw new Error("legacy fixture did not prepare");
    const claimed = await legacy.claimSync(old, AT);
    if (!claimed) throw new Error("legacy fixture did not claim");
    expect(claimed.requestAttempts).toBe(1);
    await seed("fixture-unclaimed");

    await outsider.begin(async (tx) => {
      await tx`set local statement_timeout = '1500ms'`;
      await tx`lock table event_sync_attempts in access exclusive mode`;
      // A fixture DB guard, not a production migration or a receiver barrier.
      await tx`create function fixture_fence() returns trigger language plpgsql as $$
      begin
        if (TG_OP = 'INSERT' and new.generation is distinct from 0)
          or (TG_OP = 'UPDATE' and (old.generation is null
            or new.generation is distinct from old.generation + 1
            or row(new.idempotency_key, new.event_id, new.revision, new.action, new.payload, new.mirrored_at)
              is distinct from row(old.idempotency_key, old.event_id, old.revision, old.action, old.payload, old.mirrored_at)))
        then raise exception 'fixture fence rejected write' using errcode = '23514';
        end if;
        return new;
      end $$`;
      await tx`create trigger fixture_fence before insert or update on event_sync_attempts
        for each row execute function fixture_fence()`;
    });
    const legacySnapshot = await read(legacyKey);
    await expect(legacy.completeSync(claimed, "123456789012345678")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      legacy.prepareSync("fixture-unclaimed", crypto.randomUUID(), AT),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await read(legacyKey)).toEqual(legacySnapshot);
    expect(
      await outsider`select discord_event_id, synced_revision::int from events where id = ${legacyId}`,
    ).toEqual([{ discord_event_id: null, synced_revision: 0 }]);

    for (const order of ["rollback", "disconnect", "settler-first"] as const) {
      const eventKey = `fixture-${order}`;
      const eventId = await seed(eventKey);
      const key = crypto.randomUUID();
      const payload = {
        eventKey,
        name: "Synthetic event",
        startsAt: AT.toISOString(),
        endsAt: ENDS_AT.toISOString(),
        location: "Fixture",
        description: null,
      };
      await outsider`insert into event_sync_attempts
        (idempotency_key, event_id, revision, action, payload, mirrored_at, generation)
        values (${key}, ${eventId}, 1, 'event.upsert', ${outsider.json(payload)}, ${AT}, 0)`;
      const before = await read(key);
      const started = latch();
      const admitted = latch();
      const release = latch();
      const fetchFake = vi.fn<typeof fetch>(async (resource, init) => {
        expect(String(resource)).toBe("https://bot.invalid/internal/actions");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(key);
        expect(init?.signal?.aborted).toBe(false);
        admitted.open();
        await bounded(release.ready, 4_000, "fake bot response");
        expect(init?.signal?.aborted).toBe(false);
        return Response.json({
          ok: true,
          result: { outcome: "created", event_id: "123456789012345678" },
        });
      });
      vi.stubGlobal("fetch", fetchFake);
      const firstPool = pools.length;
      const late = latch();
      let lateError: unknown;
      vi.mocked(consume).mockImplementation(async (_, { bot }) => {
        const owner = pools[firstPool]!;
        expect(
          await owner.begin(
            (tx) => tx`update event_sync_attempts
          set request_attempts = request_attempts + 1, generation = generation + 1, next_attempt_at = null
          where idempotency_key = ${key} and generation = 0 returning request_attempts`,
          ),
        ).toEqual([{ request_attempts: 1 }]);
        started.open();
        if (order === "settler-first") await bounded(release.ready, 4_000, "settler handoff");
        const transaction = owner.begin(async (tx) => {
          await tx`set local statement_timeout = '1500ms'`;
          await tx`set local idle_in_transaction_session_timeout = '15s'`;
          const [held] = await tx`select pg_backend_pid() as pid from event_sync_attempts
            where idempotency_key = ${key} and state = 'pending' and generation = 1 for update nowait`;
          if (!held) return;
          const result = await bot.upsertEvent(payload, key);
          expect(result.ok).toBe(true);
          try {
            const [written] = await tx`update event_sync_attempts
              set state = 'succeeded', generation = generation + 1 where idempotency_key = ${key}
              and state = 'pending' and generation = 1 returning pg_backend_pid() as pid`;
            expect(written).toEqual(held);
          } catch (error) {
            lateError = error;
            throw error;
          } finally {
            late.open();
          }
          if (order === "rollback") throw ROLLBACK;
        });
        if (order === "rollback") await expect(transaction).rejects.toBe(ROLLBACK);
        else await transaction;
      });
      const began = performance.now();
      // Capture rejection immediately, including from disconnect or an early failure.
      const handler = handleQueue(batch, env).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      const wait = async (ready: Promise<void>, label: string) =>
        bounded(
          Promise.race([
            ready,
            handler.then((outcome) => {
              if ("error" in outcome) throw outcome.error;
              throw new Error(`handler ended before ${label}`);
            }),
          ]),
          3_000,
          label,
        );
      try {
        await wait(started.ready, "reservation commit");
        const reserved = { ...before, generation: "1", request_attempts: 1, next_attempt_at: null };
        expect(await read(key)).toEqual(reserved);
        if (order === "settler-first") {
          expect(await trySettle(key)).toEqual([{ state: "failed" }]);
          release.open();
          expect(await bounded(handler, HANDLER_MS, "handler cleanup")).toEqual({ ok: true });
          expect(fetchFake).not.toHaveBeenCalled();
        } else {
          await wait(admitted.ready, "fake HTTP admission");
          await expect(trySettle(key, true)).rejects.toMatchObject({ code: "55P03" });
          expect(await read(key)).toEqual(reserved);
          if (order === "disconnect") {
            await bounded(pools[firstPool]!.end({ timeout: 0 }), 2_000, "owner disconnect");
          } else {
            release.open();
            expect(await bounded(handler, HANDLER_MS, "rollback cleanup")).toEqual({ ok: true });
          }
          expect(await read(key)).toEqual(reserved);
          expect(await trySettle(key)).toEqual([{ state: "failed" }]);
          release.open();
          const outcome = await bounded(handler, HANDLER_MS, "handler cleanup");
          if (order === "disconnect") {
            expect(outcome).toMatchObject({ ok: false });
            await bounded(late.ready, 1_000, "late write rejection");
            expect(lateError).toMatchObject({
              code: expect.stringMatching(/^CONNECTION_(?:DESTROYED|CLOSED)$/),
            });
          }
          expect(fetchFake).toHaveBeenCalledTimes(1);
        }
        expect(await read(key)).toEqual({ ...reserved, generation: "2", state: "failed" });
        expect(pools).toHaveLength(firstPool + 3);
        for (const end of endSpies.slice(firstPool))
          expect(end).toHaveBeenCalledWith({ timeout: 1 });
        expect(performance.now() - began).toBeLessThan(HANDLER_MS);
      } finally {
        release.open();
        await bounded(handler, HANDLER_MS, "final handler drain");
      }
    }
  } finally {
    vi.unstubAllGlobals();
    vi.mocked(postgres).mockImplementation(real);
    await fixture.dispose();
  }
});
