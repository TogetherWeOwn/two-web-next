import postgres from "postgres";
import { databaseOptions, databaseUrl } from "../db/connection";
import type { Env } from "../env";
import {
  DISCORD_CACHE_FRESH_MS,
  DISCORD_CACHE_STALE_MS,
  DISCORD_REFRESH_LEASE_MS,
  DISCORD_SNAPSHOT_CLEANUP_BATCH,
  DISCORD_SNAPSHOT_MAX_KEYS,
  DiscordSnapshotError,
  type DiscordSnapshotStore,
  type SnapshotView,
  type SnapshotCompletion,
  decodeDiscordSnapshot,
  usableDiscordSnapshot,
} from "./discord-snapshot";

export const DISCORD_STORE_DEADLINE_MS = 1500;
export const DISCORD_STORE_SQL_TIMEOUT_MS = 400;
type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;

function view(row: Record<string, unknown>): SnapshotView {
  const millis = (v: unknown) => (v === null ? null : new Date(v as string | Date).getTime());
  const now = millis(row.now);
  if (now === null || !Number.isFinite(now)) throw new DiscordSnapshotError();
  return {
    payload: row.payload ?? null,
    succeededAt: millis(row.succeeded_at ?? null),
    retryAt: millis(row.retry_at ?? null) ?? 0,
    leaseExpiresAt: millis(row.lease_expires_at ?? null),
    now,
  };
}

async function read(tx: Tx, key: string): Promise<SnapshotView & { exists: boolean }> {
  // Volatile time makes this authoritative through Hyperdrive query caching.
  // https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
  const [row] = await tx`
    select s.key as stored_key, s.payload, s.succeeded_at, s.retry_at, s.lease_expires_at, clock_timestamp() as now
    from (select ${key}::text as key) k left join discord_event_snapshots s using (key)`;
  if (!row) throw new DiscordSnapshotError();
  return { ...view(row), exists: row.stored_key !== null };
}

function refreshHeld(view: SnapshotView): boolean {
  const rows = usableDiscordSnapshot(view);
  return (
    (rows !== null && view.now - view.succeededAt! < DISCORD_CACHE_FRESH_MS) ||
    view.retryAt > view.now ||
    (view.leaseExpiresAt ?? 0) > view.now
  );
}

/** The factory must return a new client: no request shares a pool, transaction, or pending query. */
export function pgDiscordSnapshotStore(connect: () => Sql): DiscordSnapshotStore {
  const run = async <T>(
    key: string,
    body: (tx: Tx, check: () => void) => Promise<T>,
  ): Promise<T> => {
    if (!key || key.length > 512) throw new DiscordSnapshotError();
    const client = connect();
    let expired = false;
    const check = () => {
      if (expired) throw new DiscordSnapshotError();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        // Force termination cancels pending I/O and rolls back the short transaction.
        void client.end({ timeout: 0 }).catch(() => {});
        reject(new DiscordSnapshotError());
      }, DISCORD_STORE_DEADLINE_MS);
    });
    const operation = client.begin(async (tx) => {
      check();
      // Use this transaction client, never the outer max:1 pool. Server-side
      // caps prevent a JS race from leaving a lock/statement queued indefinitely.
      await tx`select set_config('lock_timeout', ${`${DISCORD_STORE_SQL_TIMEOUT_MS - 50}ms`}, true),
        set_config('statement_timeout', ${`${DISCORD_STORE_SQL_TIMEOUT_MS}ms`}, true),
        set_config('idle_in_transaction_session_timeout', '1000ms', true)`;
      check();
      return body(tx, check);
    });
    try {
      const result = await Promise.race([operation, deadline]);
      return result as T;
    } finally {
      expired = true;
      clearTimeout(timer);
      await client.end({ timeout: 0 });
    }
  };
  return {
    claim: (key) =>
      run(key, async (tx, check) => {
        let initial = await read(tx, key);
        check();
        if (refreshHeld(initial)) return { ...initial, token: null };
        if (!initial.exists) {
          // Serialize only new-key capacity admission, without waiting on another request.
          // Existing refreshes do not contend on this global lock.
          const [lock] =
            await tx`select pg_try_advisory_xact_lock(hashtextextended('discord-snapshot-capacity-v1', 0)) as got`;
          check();
          if (!lock?.got) return { ...(await read(tx, key)), token: null };
          // A concurrent request may have installed this key after our first SELECT.
          initial = await read(tx, key);
          check();
          if (refreshHeld(initial)) return { ...initial, token: null };
          if (!initial.exists) {
            // Expiring cache bytes only: never events/audit/history. At most 16 per claim.
            await tx`delete from discord_event_snapshots where key in (
          select key from discord_event_snapshots
          where coalesce(succeeded_at, '-infinity'::timestamptz) <= clock_timestamp() - make_interval(secs => ${DISCORD_CACHE_STALE_MS / 1000})
            and retry_at <= clock_timestamp()
            and coalesce(lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp()
          order by key limit ${DISCORD_SNAPSHOT_CLEANUP_BATCH} for update skip locked)`;
            check();
            const [capacity] =
              await tx`select count(*)::int as count, clock_timestamp() as now from discord_event_snapshots`;
            check();
            if (!capacity || capacity.count >= DISCORD_SNAPSHOT_MAX_KEYS)
              throw new DiscordSnapshotError();
          }
        }
        const token = crypto.randomUUID();
        // Atomic current-row admission, never granted by the preceding SELECT.
        // https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT
        // Anchor before the same RETURNING clock sample; never strand a lease on a second query.
        const nowQueryStartedAt = performance.now();
        const [claimed] = initial.exists
          ? await tx`
        update discord_event_snapshots set lease_token = ${token}::uuid,
          lease_expires_at = clock_timestamp() + make_interval(secs => ${DISCORD_REFRESH_LEASE_MS / 1000})
        where key = ${key}
          and (succeeded_at is null or succeeded_at <= clock_timestamp() - make_interval(secs => ${DISCORD_CACHE_FRESH_MS / 1000}))
          and retry_at <= clock_timestamp()
          and coalesce(lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp()
        returning payload, succeeded_at, retry_at, lease_expires_at, clock_timestamp() as now`
          : await tx`
        insert into discord_event_snapshots (key, lease_token, lease_expires_at)
        values (${key}, ${token}::uuid, clock_timestamp() + make_interval(secs => ${DISCORD_REFRESH_LEASE_MS / 1000}))
        on conflict (key) do update set lease_token = excluded.lease_token,
          lease_expires_at = clock_timestamp() + make_interval(secs => ${DISCORD_REFRESH_LEASE_MS / 1000})
        where (discord_event_snapshots.succeeded_at is null or discord_event_snapshots.succeeded_at <= clock_timestamp() - make_interval(secs => ${DISCORD_CACHE_FRESH_MS / 1000}))
          and discord_event_snapshots.retry_at <= clock_timestamp()
          and coalesce(discord_event_snapshots.lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp()
        returning payload, succeeded_at, retry_at, lease_expires_at, clock_timestamp() as now`;
        check();
        return {
          ...(claimed ? view(claimed) : await read(tx, key)),
          token: claimed ? token : null,
          ...(claimed ? { nowQueryStartedAt } : {}),
        };
      }),
    complete: (key, token, result: SnapshotCompletion) =>
      run(key, async (tx, check) => {
        const payload = "payload" in result ? JSON.parse(result.payload) : null;
        if ("payload" in result) decodeDiscordSnapshot(payload);
        else if (!Number.isFinite(result.retryMs) || result.retryMs < 10_000)
          throw new DiscordSnapshotError();
        // Acquire the tuple lock before evaluating clock-dependent fences. UPDATE
        // need not recheck an expiry predicate after waiting on an unchanged tuple.
        // https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS
        await tx`select key, clock_timestamp() as now from discord_event_snapshots where key = ${key} for update`;
        check();
        if ("payload" in result) {
          await tx`update discord_event_snapshots set payload = ${tx.json(payload)}::jsonb,
          succeeded_at = clock_timestamp(), retry_at = to_timestamp(0),
          lease_token = null, lease_expires_at = null
          where key = ${key} and lease_token = ${token}::uuid and lease_expires_at > clock_timestamp()`;
        } else {
          await tx`update discord_event_snapshots set
          retry_at = clock_timestamp() + make_interval(secs => ${result.retryMs / 1000}),
          lease_token = null, lease_expires_at = null
          where key = ${key} and lease_token = ${token}::uuid and lease_expires_at > clock_timestamp()`;
        }
        check();
        return read(tx, key);
      }),
  };
}

/** Existing connection selection only. No schema bootstrap, grants, or credential fallback. */
export function postgresDiscordSnapshotStore(env: Env): DiscordSnapshotStore {
  return pgDiscordSnapshotStore(() => {
    const url = databaseUrl(env);
    if (!url) throw new DiscordSnapshotError();
    return postgres(url, { ...databaseOptions, connect_timeout: 1 });
  });
}
