import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { databaseOptions } from "../src/db/connection";
import {
  pgDiscordSnapshotStore,
  DISCORD_STORE_SQL_TIMEOUT_MS,
  DISCORD_STORE_DEADLINE_MS,
} from "../src/events/discord-snapshot-postgres";
import { cachedDiscordEventsSource } from "../src/events/discord-transients";
import {
  discordSnapshotKey,
  DISCORD_REFRESH_LEASE_MS,
  DISCORD_SNAPSHOT_MAX_KEYS,
  DISCORD_SNAPSHOT_CLEANUP_BATCH,
  DISCORD_SNAPSHOT_MAX_BYTES,
  encodeDiscordSnapshot,
} from "../src/events/discord-snapshot";
import { discordSnapshotBoundaryRows } from "./helpers/discord-snapshot-store";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const env = { APP_URL: "https://calendar.example", DISCORD_GUILD_ID: "123" } as Env;
const key = discordSnapshotKey(env);

describe.skipIf(!raw)("Postgres Discord snapshots, independent request clients", () => {
  let fixture: MemberDataFixture;
  let clients = 0;
  const connect = () => {
    clients++;
    const url = testDatabaseUrl(raw!);
    return postgres(url.href, {
      ...databaseOptions,
      password: () => url.password,
      connect_timeout: 1,
      idle_timeout: 0, // pre-opened sessions may wait for their race
      connection: {
        search_path: fixture.schemaName,
        application_name: `discord-fence-${fixture.schemaName}`,
      },
      onnotice: () => {},
    });
  };
  beforeAll(async () => {
    fixture = await createMemberDataFixture(raw!, { max: 3 });
  }, 30_000);
  beforeEach(async () => {
    clients = 0;
    await fixture.client`delete from discord_event_snapshots`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  it("one simultaneous cold owner calls Discord; all losers return honest cold without sharing I/O", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const read = vi.fn(async () => {
      entered();
      await gate;
      return [];
    });
    const loserClients = Array.from({ length: 6 }, connect);
    try {
      // Open loser sessions before the owner takes its lease, so setup never runs under it.
      for (const client of loserClients) await client`select pg_backend_pid()`;
      const a = cachedDiscordEventsSource(
        env,
        { upcoming: read, lastReadFailed: () => false },
        pgDiscordSnapshotStore(connect),
      );
      const pending = a.upcoming();
      await started;
      const loserOpens = Array<number>(6).fill(0);
      const losers = await Promise.all(
        loserClients.map(async (client, i) => {
          const source = cachedDiscordEventsSource(
            env,
            { upcoming: read, lastReadFailed: () => false },
            pgDiscordSnapshotStore(() => {
              loserOpens[i]! += 1;
              return client;
            }),
          );
          expect(await source.upcoming()).toEqual([]);
          return source.lastReadFailed();
        }),
      );
      expect(losers).toEqual(Array(6).fill(true));
      expect(loserOpens).toEqual(Array(6).fill(1));
      expect(read).toHaveBeenCalledTimes(1);
      release();
      expect(await pending).toEqual([]);
      expect(a.lastReadFailed()).toBe(false);
      expect(clients).toBe(8);
      const fresh = cachedDiscordEventsSource(
        env,
        { upcoming: read, lastReadFailed: () => false },
        pgDiscordSnapshotStore(connect),
      );
      expect(await fresh.upcoming()).toEqual([]);
      expect(fresh.lastReadFailed()).toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all(loserClients.map((client) => client.end({ timeout: 0 })));
    }
  });
  it.each(["cold", "stale"])(
    "simultaneous %s claims have exactly one database-clock winner",
    async (state) => {
      if (state === "stale")
        await fixture.client`insert into discord_event_snapshots (key,payload,succeeded_at) values (${key}, '[]', clock_timestamp() - interval '61 seconds')`;
      const requestClients = Array.from({ length: 8 }, connect);
      const storeOpens = Array<number>(8).fill(0);
      try {
        // postgres.js connects lazily: open every session before the race.
        const backendPids = [];
        for (const client of requestClients) {
          const [backend] = await client`select pg_backend_pid() as pid`;
          backendPids.push(backend!.pid);
        }
        expect(new Set(backendPids).size).toBe(8);

        const settled = await Promise.allSettled(
          requestClients.map((client, i) =>
            pgDiscordSnapshotStore(() => {
              storeOpens[i]! += 1;
              return client;
            }).claim(key),
          ),
        );
        const claims = settled.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
        expect(claims.filter((c) => c.token)).toHaveLength(1);
        const winner = claims.find((c) => c.token)!;
        expect(winner.leaseExpiresAt! - winner.now).toBeGreaterThan(DISCORD_REFRESH_LEASE_MS - 100);
        expect(winner.leaseExpiresAt! - winner.now).toBeLessThanOrEqual(DISCORD_REFRESH_LEASE_MS);
        expect(storeOpens).toEqual(Array(8).fill(1));
      } finally {
        await Promise.all(requestClients.map((client) => client.end({ timeout: 0 })));
      }
    },
  );
  it("samples the claim clock anchor before its transaction query without an outer query", async () => {
    let outsideTransactionQueries = 0;
    let claimQueryStartedAt: number | undefined;
    const connectWithoutOuterQueries = () => {
      const client = connect();
      return new Proxy(client, {
        apply(target, thisArg, args) {
          outsideTransactionQueries++;
          return Reflect.apply(target, thisArg, args);
        },
        get(target, prop) {
          if (prop !== "begin") return Reflect.get(target, prop);
          return (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
            target.begin(async (tx) =>
              fn(
                new Proxy(tx, {
                  apply(targetTx, thisArg, args) {
                    const query = (args[0] as TemplateStringsArray).join("?");
                    if (
                      !query.includes(
                        "returning payload, succeeded_at, retry_at, lease_expires_at, clock_timestamp() as now",
                      )
                    )
                      return Reflect.apply(targetTx, thisArg, args);
                    claimQueryStartedAt = performance.now();
                    return (async () => {
                      await new Promise((resolve) => setTimeout(resolve, 10));
                      return Reflect.apply(targetTx, thisArg, args);
                    })();
                  },
                }),
              ),
            );
        },
      }) as ReturnType<typeof postgres>;
    };
    const claim = await pgDiscordSnapshotStore(connectWithoutOuterQueries).claim(key);
    expect(claim.token).toBeTruthy();
    expect(claim.nowQueryStartedAt).toEqual(expect.any(Number));
    expect(claimQueryStartedAt).toEqual(expect.any(Number));
    expect(claim.nowQueryStartedAt).toBeLessThanOrEqual(claimQueryStartedAt!);
    expect(outsideTransactionQueries).toBe(0);
  });
  it("anchors tokenless snapshots before their database-clock read", async () => {
    await fixture.client`insert into discord_event_snapshots (key, payload, succeeded_at, lease_token, lease_expires_at)
      values (${key}, '[]', clock_timestamp() - interval '61 seconds', gen_random_uuid(), clock_timestamp() + interval '1 minute')`;
    let readQueryStartedAt: number | undefined;
    const connectWithDelayedRead = () => {
      const client = connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop !== "begin") return Reflect.get(target, prop);
          return (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
            target.begin(async (tx) =>
              fn(
                new Proxy(tx, {
                  apply(targetTx, thisArg, args) {
                    const query = (args[0] as TemplateStringsArray).join("?");
                    if (!query.includes("select s.key as stored_key"))
                      return Reflect.apply(targetTx, thisArg, args);
                    readQueryStartedAt = performance.now();
                    return (async () => {
                      await new Promise((resolve) => setTimeout(resolve, 10));
                      return Reflect.apply(targetTx, thisArg, args);
                    })();
                  },
                }),
              ),
            );
        },
      }) as ReturnType<typeof postgres>;
    };
    const claim = await pgDiscordSnapshotStore(connectWithDelayedRead).claim(key);
    expect(claim.token).toBeNull();
    expect(claim.nowQueryStartedAt).toEqual(expect.any(Number));
    expect(readQueryStartedAt).toEqual(expect.any(Number));
    expect(claim.nowQueryStartedAt).toBeLessThanOrEqual(readQueryStartedAt!);
  });
  it("stale losing callers do not fetch and do not wait for HTTP", async () => {
    await fixture.client`insert into discord_event_snapshots (key,payload,succeeded_at) values (${key}, '[]', clock_timestamp() - interval '61 seconds')`;
    const owner = await pgDiscordSnapshotStore(connect).claim(key);
    expect(owner.token).toBeTruthy();
    const read = vi.fn(async () => []);
    const source = cachedDiscordEventsSource(
      env,
      { upcoming: read, lastReadFailed: () => true },
      pgDiscordSnapshotStore(connect),
    );
    expect(await source.upcoming()).toEqual([]);
    expect(source.lastReadFailed()).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "expired crashed owner and late %s completion cannot mutate a new lease or success",
    async (success) => {
      const a = pgDiscordSnapshotStore(connect),
        b = pgDiscordSnapshotStore(connect);
      const old = await a.claim(key);
      expect(old.token).toBeTruthy();
      await fixture.client`update discord_event_snapshots set lease_expires_at = clock_timestamp() - interval '1 millisecond' where key = ${key}`;
      const replacement = await b.claim(key);
      expect(replacement.token).toBeTruthy();
      expect(replacement.token).not.toBe(old.token);
      const result = success ? { payload: "[]" } : { retryMs: 90_000 };
      await a.complete(key, old.token!, result);
      const [inFlight] =
        await fixture.client`select lease_token, payload, retry_at from discord_event_snapshots where key = ${key}`;
      expect(inFlight!.lease_token).toBe(replacement.token);
      expect(inFlight!.payload).toBeNull();
      expect(new Date(inFlight!.retry_at).getTime()).toBe(0);
      await b.complete(key, replacement.token!, { payload: "[]" });
      const [before] =
        await fixture.client`select * from discord_event_snapshots where key = ${key}`;
      await a.complete(key, old.token!, result);
      const [after] =
        await fixture.client`select * from discord_event_snapshots where key = ${key}`;
      expect(after).toEqual(before);
      expect(after!.payload).toEqual([]);
    },
  );
  it("expiry alone fences a completion, even before another request replaces its token", async () => {
    const store = pgDiscordSnapshotStore(connect),
      old = await store.claim(key);
    await fixture.client`update discord_event_snapshots set lease_expires_at = clock_timestamp() - interval '1 millisecond' where key = ${key}`;
    await store.complete(key, old.token!, { payload: "[]" });
    const [row] =
      await fixture.client`select payload, lease_token from discord_event_snapshots where key = ${key}`;
    expect(row!.payload).toBeNull();
    expect(row!.lease_token).toBe(old.token);
  });
  it.each([true, false])(
    "fences %s completion after waiting on an unchanged row across expiry",
    async (success) => {
      // Whole-scenario retry: a transient 55P03 means this attempt never
      // exercised a completion waiting across expiry, so re-issuing only the
      // completion would assert the expiry-alone path (covered above) and
      // launder a deterministic lock-timeout regression. Re-running the full
      // claim/hold/wait/complete scenario once tolerates the flake
      // (node22-compat 2026-10-19, 1/14013: the completion's 350ms
      // lock_timeout can fire under CI load even though the holder nominally
      // releases ~275ms after the lease update, with serial files, so this is
      // intra-test scheduling margin, not parallel contention) while a
      // deterministic 55P03 still fails on the second attempt. Any other
      // error throws immediately.
      for (let attempt = 0; attempt < 2; attempt++) {
        const lastAttempt = attempt === 1;
        // Fresh row per attempt: beforeEach cleans the first, this cleans the retry.
        await fixture.client`delete from discord_event_snapshots`;
        const store = pgDiscordSnapshotStore(connect);
        const claim = await store.claim(key);
        // connect() is lazy, so the pid query is the handshake. Do it before
        // arming the 250ms lease: a slow handshake inside that window lets the
        // first lock-wait sample land after expiry, which fails the live pin
        // without proving the fence. The sleep still ends 25ms after expiry,
        // inside the 350ms lock_timeout.
        const holderClient = connect();
        try {
          const [backend] = await holderClient`select pg_backend_pid() as pid`;
          const holderPid: number = backend!.pid;
          await fixture.client`update discord_event_snapshots set lease_expires_at = clock_timestamp() + interval '250 milliseconds' where key = ${key}`;
          // Hold the row with a single autocommit statement: the subquery's
          // FOR UPDATE lock is held for the statement's duration and freed by
          // the server's implicit commit when pg_sleep returns. No client-sent
          // COMMIT means no JS scheduling hop between expiry and release, so an
          // event-loop stall cannot push the completion's lock wait past the
          // store's 350ms lock_timeout (55P03) instead of exercising the fence.
          // postgres.js template queries are lazy: .execute() dispatches the
          // statement now and returns the promise awaited below.
          const released =
            holderClient`select /* discord_snapshot_fence_holder */ pg_sleep(greatest(0, extract(epoch from (s.lease_expires_at - clock_timestamp()))) + 0.025)
          from (select lease_expires_at from discord_event_snapshots where key = ${key} for update) s`
              .execute()
              .then(
                () => ({ released: true as const }),
                (error: unknown) => ({ error }),
              );
          // Readiness waits for the holder's pg_sleep: it runs only after the
          // subquery's FOR UPDATE has taken the tuple lock, so wait_event =
          // 'PgSleep' proves the row is held. The sleep lasts ~250ms, so a 5ms
          // poll cannot miss it; a stall past the sleep fails under any gate.
          let holding = false;
          for (let i = 0; i < 200 && !holding; i++) {
            const [activity] = await fixture.client`select exists(
            select 1 from pg_stat_activity
            where pid = ${holderPid}
              and state = 'active'
              and wait_event = 'PgSleep'
          ) as holding`;
            holding = activity!.holding;
            if (!holding) await new Promise((r) => setTimeout(r, 5));
          }
          expect(holding).toBe(true);
          const pending = store.complete(
            key,
            claim.token!,
            success ? { payload: "[]" } : { retryMs: 90_000 },
          );
          const settled = pending.then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          let waiting = false;
          for (let i = 0; i < 30; i++) {
            const [state] =
              await fixture.client`select lease_expires_at > clock_timestamp() as live,
          exists(select 1 from pg_stat_activity where application_name = ${`discord-fence-${fixture.schemaName}`} and wait_event_type = 'Lock') as waiting
          from discord_event_snapshots where key = ${key}`;
            if (state!.waiting) {
              expect(state!.live).toBe(true); // The old UPDATE evaluated its predicate before expiry.
              waiting = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 5));
          }
          // Awaited on every path that reaches here; the wrapped promise never
          // rejects, so a failing expect above cannot leave it unobserved.
          const outcome = await released;
          const completion = await settled;
          if (
            "error" in completion &&
            (completion.error as { code?: string } | undefined)?.code === "55P03" &&
            !lastAttempt
          ) {
            // Transient flake: this attempt proved nothing, so retry the whole
            // scenario once instead of asserting on a post-expiry completion.
            continue;
          }
          expect(waiting).toBe(true);
          if ("error" in outcome) throw outcome.error;
          if ("error" in completion) throw completion.error;
          const [row] =
            await fixture.client`select payload, succeeded_at, retry_at, lease_token from discord_event_snapshots where key = ${key}`;
          expect(row!.payload).toBeNull();
          expect(row!.succeeded_at).toBeNull();
          expect(new Date(row!.retry_at).getTime()).toBe(0);
          expect(row!.lease_token).toBe(claim.token);
          return;
        } finally {
          await holderClient.end({ timeout: 0 });
        }
      }
    },
  );
  it("rechecks a formerly missing key before rejecting it at full capacity", async () => {
    await fixture.client`insert into discord_event_snapshots (key, lease_token, lease_expires_at)
      select 'capacity-' || i, gen_random_uuid(), clock_timestamp() + interval '1 minute' from generate_series(1, ${DISCORD_SNAPSHOT_MAX_KEYS - 1}) i`;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const paused = new Promise<void>((r) => {
      entered = r;
    });
    const delayedConnect = () => {
      const client = connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop !== "begin") return Reflect.get(target, prop);
          return (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
            target.begin(async (tx) =>
              fn(
                new Proxy(tx, {
                  apply(targetTx, thisArg, args) {
                    const query = (args[0] as TemplateStringsArray).join("?");
                    if (query.includes("pg_try_advisory_xact_lock"))
                      return (async () => {
                        entered();
                        await gate; // Pause after the real absent SELECT, before acquiring capacity.
                        return Reflect.apply(targetTx, thisArg, args);
                      })();
                    return Reflect.apply(targetTx, thisArg, args);
                  },
                }),
              ),
            );
        },
      }) as ReturnType<typeof postgres>;
    };
    const pending = pgDiscordSnapshotStore(delayedConnect).claim(key);
    const settled = pending.then(
      (claim) => ({ claim }),
      (error: unknown) => ({ error }),
    );
    await paused;
    try {
      const winner = pgDiscordSnapshotStore(connect);
      const claim = await winner.claim(key);
      expect(claim.token).toBeTruthy();
      await winner.complete(key, claim.token!, { payload: "[]" });
    } finally {
      release();
    }
    const result = await settled;
    if ("error" in result) throw result.error;
    expect(result.claim.token).toBeNull();
    expect(result.claim.payload).toEqual([]);
    expect(result.claim.succeededAt).not.toBeNull();
    const [count] = await fixture.client`select count(*)::int as n from discord_event_snapshots`;
    expect(count!.n).toBe(DISCORD_SNAPSHOT_MAX_KEYS);
  });
  it("persists the exact jsonb byte boundary and valid Unicode without storage rejection", async () => {
    const store = pgDiscordSnapshotStore(connect);
    const rows = discordSnapshotBoundaryRows();
    const claim = await store.claim(key);
    await store.complete(key, claim.token!, { payload: encodeDiscordSnapshot(rows) });
    const [size] =
      await fixture.client`select octet_length(payload::text)::int as bytes from discord_event_snapshots where key = ${key}`;
    expect(size!.bytes).toBe(DISCORD_SNAPSHOT_MAX_BYTES);
    await fixture.client`update discord_event_snapshots set succeeded_at = clock_timestamp() - interval '61 seconds' where key = ${key}`;
    const refreshed = await store.claim(key);
    rows[0]!.title = "Launch 🚀 é";
    rows[0]!.description = 'quotes " backslash \\ tab\t newline\n';
    const completed = await store.complete(key, refreshed.token!, {
      payload: encodeDiscordSnapshot(rows),
    });
    expect((completed.payload as Array<{ title: string }>)[0]!.title).toBe(rows[0]!.title);
  });
  it("a stale Hyperdrive-shaped read cannot grant admission over a real fresh snapshot", async () => {
    await fixture.client`insert into discord_event_snapshots (key,payload,succeeded_at) values (${key}, '[]', clock_timestamp())`;
    let intercepted = 0;
    const staleConnect = () => {
      const client = connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop !== "begin") return Reflect.get(target, prop);
          return (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
            target.begin(async (tx) =>
              fn(
                new Proxy(tx, {
                  apply(targetTx, thisArg, args) {
                    const query = (args[0] as TemplateStringsArray).join("?");
                    if (query.includes("s.key as stored_key")) {
                      intercepted++;
                      return Promise.resolve([
                        {
                          stored_key: key,
                          payload: [],
                          succeeded_at: new Date(Date.now() - 61_000),
                          retry_at: new Date(0),
                          lease_expires_at: null,
                          now: new Date(),
                        },
                      ]);
                    }
                    return Reflect.apply(targetTx, thisArg, args);
                  },
                }),
              ),
            );
        },
      }) as ReturnType<typeof postgres>;
    };
    const claim = await pgDiscordSnapshotStore(staleConnect).claim(key);
    expect(claim.token).toBeNull();
    expect(intercepted).toBeGreaterThan(0);
    const [row] =
      await fixture.client`select lease_token from discord_event_snapshots where key = ${key}`;
    expect(row!.lease_token).toBeNull();
  });
  it("propagates a longer hold without refreshing success age or extending validity", async () => {
    await fixture.client`insert into discord_event_snapshots (key,payload,succeeded_at) values (${key}, '[]', clock_timestamp() - interval '61 seconds')`;
    const store = pgDiscordSnapshotStore(connect),
      claim = await store.claim(key);
    const completed = await store.complete(key, claim.token!, { retryMs: 90_250 });
    expect(completed.succeededAt).toBe(claim.succeededAt);
    expect(completed.retryAt - completed.now).toBeGreaterThan(90_000);
    expect((await pgDiscordSnapshotStore(connect).claim(key)).token).toBeNull();
    await fixture.client`update discord_event_snapshots set succeeded_at = clock_timestamp() - interval '600 seconds' where key = ${key}`;
    const source = cachedDiscordEventsSource(
      env,
      {
        upcoming: async () => {
          throw new Error("unadmitted fetch");
        },
        lastReadFailed: () => false,
      },
      pgDiscordSnapshotStore(connect),
    );
    expect(await source.upcoming()).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
  });
  it("bounds capacity and removes at most one cleanup batch, never active leases/holds", async () => {
    await fixture.client`insert into discord_event_snapshots (key, lease_token, lease_expires_at)
      select 'capacity-' || i, gen_random_uuid(), clock_timestamp() + interval '1 minute' from generate_series(1, ${DISCORD_SNAPSHOT_MAX_KEYS}) i`;
    await expect(pgDiscordSnapshotStore(connect).claim(key)).rejects.toThrow();
    await fixture.client`update discord_event_snapshots set lease_token = null, lease_expires_at = null where key <> 'capacity-1'`;
    await pgDiscordSnapshotStore(connect).claim(key);
    const [count] = await fixture.client`select count(*)::int as n from discord_event_snapshots`;
    expect(count!.n).toBe(DISCORD_SNAPSHOT_MAX_KEYS - DISCORD_SNAPSHOT_CLEANUP_BATCH + 1);
    const [protectedRow] =
      await fixture.client`select lease_token from discord_event_snapshots where key = 'capacity-1'`;
    expect(protectedRow!.lease_token).toBeTruthy();
  });
  it("refuses corruption and missing objects without any live HTTP fallback", async () => {
    await fixture.client`insert into discord_event_snapshots (key,payload,succeeded_at) values (${key}, '[{}]', clock_timestamp())`;
    const read = vi.fn(async () => []);
    const source = cachedDiscordEventsSource(
      env,
      { upcoming: read, lastReadFailed: () => false },
      pgDiscordSnapshotStore(connect),
    );
    expect(await source.upcoming()).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(read).not.toHaveBeenCalled();
    const url = testDatabaseUrl(raw!);
    const absent = pgDiscordSnapshotStore(() =>
      postgres(url.href, {
        ...databaseOptions,
        password: () => url.password,
        connection: { search_path: "pg_catalog" },
      }),
    );
    await expect(absent.claim(key)).rejects.toMatchObject({ code: "42P01" });
  });
  it("database lock waits are cancelled server-side and request clients are terminated", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      held = new Promise<void>((r) => {
        entered = r;
      });
    const holder = fixture.client.begin(async (tx) => {
      await tx`lock table discord_event_snapshots in access exclusive mode`;
      entered();
      await gate;
    });
    await held;
    const started = Date.now();
    try {
      await expect(pgDiscordSnapshotStore(connect).claim(key)).rejects.toMatchObject({
        code: "55P03",
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(DISCORD_STORE_SQL_TIMEOUT_MS - 70);
      expect(Date.now() - started).toBeLessThan(DISCORD_STORE_DEADLINE_MS);
    } finally {
      release();
      await holder;
    }
    expect((await pgDiscordSnapshotStore(connect).claim(key)).token).toBeTruthy();
  });
  it("a stale claim blocked on the admission row lock loses tokenless with the stale view", async () => {
    await fixture.client`insert into discord_event_snapshots (key,payload,succeeded_at) values (${key}, '[]', clock_timestamp() - interval '61 seconds')`;
    const holderClient = connect();
    try {
      // connect() is lazy, so the pid query is the handshake. Do it before
      // dispatching the hold: the sleep below runs only after the subquery's
      // FOR UPDATE has taken the tuple lock.
      const [backend] = await holderClient`select pg_backend_pid() as pid`;
      const holderPid: number = backend!.pid;
      // Hold the stale row past the store's 350ms lock_timeout with a single
      // autocommit statement (same pattern as the fence test above): the lock
      // is held for the statement's duration and freed by the server's
      // implicit commit when pg_sleep returns, with no client-sent COMMIT hop.
      // postgres.js template queries are lazy: .execute() dispatches now.
      const released = holderClient`select /* discord_snapshot_claim_holder */ pg_sleep(0.9)
          from (select lease_expires_at from discord_event_snapshots where key = ${key} for update) s`
        .execute()
        .then(
          () => ({ released: true as const }),
          (error: unknown) => ({ error }),
        );
      // Readiness waits for the holder's pg_sleep: wait_event = 'PgSleep'
      // proves the row is held. The sleep lasts 900ms, so a 5ms poll cannot
      // miss it; a stall past the sleep fails here instead of hanging.
      let holding = false;
      for (let i = 0; i < 200 && !holding; i++) {
        const [activity] = await fixture.client`select exists(
            select 1 from pg_stat_activity
            where pid = ${holderPid}
              and state = 'active'
              and wait_event = 'PgSleep'
          ) as holding`;
        holding = activity!.holding;
        if (!holding) await new Promise((r) => setTimeout(r, 5));
      }
      expect(holding).toBe(true);
      // The claimant's initial SELECT takes no row lock, so it reads the
      // stale row through the held lock; only the admission UPDATE blocks,
      // waits past lock_timeout, and must lose gracefully instead of
      // throwing 55P03. Deleting the 55P03 catch must turn this test red.
      let opens = 0;
      const started = Date.now();
      const claim = await pgDiscordSnapshotStore(() => {
        opens += 1;
        return connect();
      }).claim(key);
      const elapsed = Date.now() - started;
      expect(opens).toBe(1);
      expect(claim.token).toBeNull();
      expect(claim.payload).toEqual([]);
      expect(claim.succeededAt).not.toBeNull();
      expect(claim.nowQueryStartedAt).toEqual(expect.any(Number));
      // The admission UPDATE waited out the server-side lock_timeout rather
      // than losing spuriously (same lower-bound margin as the throw pin).
      expect(elapsed).toBeGreaterThanOrEqual(DISCORD_STORE_SQL_TIMEOUT_MS - 70);
      const outcome = await released;
      if ("error" in outcome) throw outcome.error;
      // No lease strands on the timed-out claimant: a follow-up claim wins.
      const followUp = await pgDiscordSnapshotStore(connect).claim(key);
      expect(followUp.token).toBeTruthy();
      expect(followUp.leaseExpiresAt! - followUp.now).toBeGreaterThan(
        DISCORD_REFRESH_LEASE_MS - 100,
      );
      expect(followUp.leaseExpiresAt! - followUp.now).toBeLessThanOrEqual(DISCORD_REFRESH_LEASE_MS);
    } finally {
      await holderClient.end({ timeout: 0 });
    }
  });
});
