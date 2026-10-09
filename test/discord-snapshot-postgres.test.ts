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
      let loserOpens = 0;
      const losers = await Promise.all(
        loserClients.map(async (client) => {
          const source = cachedDiscordEventsSource(
            env,
            { upcoming: read, lastReadFailed: () => false },
            pgDiscordSnapshotStore(() => {
              loserOpens++;
              return client;
            }),
          );
          expect(await source.upcoming()).toEqual([]);
          return source.lastReadFailed();
        }),
      );
      expect(losers).toEqual(Array(6).fill(true));
      expect(loserOpens).toBe(6);
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
      let storeOpens = 0;
      try {
        // postgres.js connects lazily: open every session before the race.
        const backendPids = [];
        for (const client of requestClients) {
          const [backend] = await client`select pg_backend_pid() as pid`;
          backendPids.push(backend!.pid);
        }
        expect(new Set(backendPids).size).toBe(8);

        const settled = await Promise.allSettled(
          requestClients.map((client) =>
            pgDiscordSnapshotStore(() => {
              storeOpens++;
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
        expect(storeOpens).toBe(8);
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
      const store = pgDiscordSnapshotStore(connect);
      const claim = await store.claim(key);
      await fixture.client`update discord_event_snapshots set lease_expires_at = clock_timestamp() + interval '250 milliseconds' where key = ${key}`;
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const locked = new Promise<void>((r) => {
        entered = r;
      });
      const holder = fixture.client.begin(async (tx) => {
        await tx`select key from discord_event_snapshots where key = ${key} for update`;
        entered();
        await gate; // This transaction never modifies the tuple.
      });
      await locked;
      const pending = store.complete(
        key,
        claim.token!,
        success ? { payload: "[]" } : { retryMs: 90_000 },
      );
      const settled = pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        let waiting = false;
        for (let i = 0; i < 30; i++) {
          const [state] = await fixture.client`select lease_expires_at > clock_timestamp() as live,
          exists(select 1 from pg_stat_activity where application_name = ${`discord-fence-${fixture.schemaName}`} and wait_event_type = 'Lock') as waiting
          from discord_event_snapshots where key = ${key}`;
          if (state!.waiting) {
            expect(state!.live).toBe(true); // The old UPDATE evaluated its predicate before expiry.
            waiting = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(waiting).toBe(true);
        await fixture.client`select pg_sleep(greatest(0, extract(epoch from (lease_expires_at - clock_timestamp()))) + 0.025)
        from discord_event_snapshots where key = ${key}`;
      } finally {
        release();
        await holder;
      }
      const completion = await settled;
      if ("error" in completion) throw completion.error;
      const [row] =
        await fixture.client`select payload, succeeded_at, retry_at, lease_token from discord_event_snapshots where key = ${key}`;
      expect(row!.payload).toBeNull();
      expect(row!.succeeded_at).toBeNull();
      expect(new Date(row!.retry_at).getTime()).toBe(0);
      expect(row!.lease_token).toBe(claim.token);
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
});
