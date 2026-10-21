import type postgres from "postgres";
import type { Env } from "../env";
import type { Sql } from "../sessions";

// Explicit local/dev configuration wins. Hyperdrive is used only when that
// configuration is absent, never as a retry after a connection failure.
export function databaseUrl(env: Pick<Env, "DATABASE_URL" | "DB">): string | undefined {
  return env.DATABASE_URL || env.DB?.connectionString;
}

// Homepage counts and profile stats read the bot-owned `web_v1` views, which
// live in the bot database — never in the web database above. Same selection
// rule, own binding: an explicit local/dev URL wins, else the BOT_DB
// Hyperdrive binding. Absent both, counts and stats degrade to hidden; the
// web DB is never a fallback because it holds no `web_v1` views.
export function botDatabaseUrl(env: Pick<Env, "BOT_DATABASE_URL" | "BOT_DB">): string | undefined {
  return env.BOT_DATABASE_URL || env.BOT_DB?.connectionString;
}

// Hyperdrive pools underneath the per-request client: no prepared statements
// or extra type-discovery round trips.
export const databaseOptions = {
  max: 1,
  idle_timeout: 10,
  connect_timeout: 10,
  prepare: false,
  fetch_types: false,
};

// Per-request statement bound: 5 seconds, installed as `SET LOCAL
// statement_timeout` as the first statement of a short explicit transaction
// around each request-path operation (session reads/writes, throttle
// admission, dbFor queries). A stuck Postgres backend cancels with 57014
// into the existing honest-outage handling instead of wedging the request.
// The transaction shape is the point: Hyperdrive pools in transaction mode
// and RESETs pooled connections on return, so session-level state (startup
// GUCs, bare SET) is documented-unsupported there and would silently not
// bind production, while per-transaction SET LOCAL is the documented
// mechanism and behaves identically on a direct connection:
// https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/
// https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
// Normal per-request statements are millisecond-scale single-row work, and
// the fresh-login lock wait (10 s) and the connect timeout above both sit
// above this bound. Never add this to databaseOptions: that object stays
// bare so pooled and injected/shared clients are never bounded here — each
// choke point opts in through the helpers below. Tighter per-path bounds
// (roster 500 ms, throttle prune, access log) keep their own SET LOCAL /
// set_config, which override this value inside their transactions.
export const PER_REQUEST_STATEMENT_TIMEOUT_MS = 5_000;

/** The bound as one install statement, shared by every choke point. */
export const PER_REQUEST_STATEMENT_TIMEOUT_LOCAL = `SET LOCAL statement_timeout = '${PER_REQUEST_STATEMENT_TIMEOUT_MS}ms'`;

type BeginCapableSql = Sql & {
  begin: <T>(run: (tx: Sql) => Promise<T>) => Promise<T>;
};

/**
 * Bound Sql-seam adapter: every statement runs in its own short transaction
 * starting with SET LOCAL statement_timeout. One statement per transaction
 * keeps each statement's snapshot exactly as today (autocommit), so wrapping
 * changes nothing but the bound. Minimal injected doubles without `begin`
 * (the roster.ts precedent) run unmodified: production builders always pass
 * a native postgres.js client, and store injection is tests-only. Wrapping
 * twice is a no-op: the adapter exposes no `begin`, so an outer wrap passes
 * it through to the single inner bound.
 */
export function withPerRequestStatementBound(sql: Sql): Sql {
  const store = sql as Partial<BeginCapableSql>;
  if (typeof store.begin !== "function") return sql;
  const begin = store.begin.bind(sql);
  const call = (<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> =>
    begin(async (tx) => {
      await tx.unsafe(PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
      return tx<T>(strings, ...values);
    })) as Sql;
  call.unsafe = (query: string) =>
    begin(async (tx) => {
      await tx.unsafe(PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
      return tx.unsafe(query);
    });
  return call;
}

/**
 * Install the per-request statement bound on an owned, freshly created
 * postgres.js client (the dbFor path): top-level `unsafe` queries each run
 * in a short transaction starting with SET LOCAL statement_timeout, and
 * `begin` injects the same statement first so transaction bodies are bounded
 * too. Mutates and returns the client — call only on a client nothing else
 * holds. The `unsafe` replacement keeps the PendingQuery surface the two
 * consumers need: await plus `.values()` for drizzle's mapped rows, and
 * `.execute()` passed straight through to the native client for postgres.js
 * `begin` internals (begin opens its transaction via
 * `sql.unsafe('begin ...').execute()`); every other member passes through to
 * the native client untouched.
 */
export function installPerRequestStatementBound<TClient extends postgres.Sql>(
  client: TClient,
): TClient {
  const rawUnsafe = client.unsafe.bind(client) as (...args: Parameters<postgres.Sql["unsafe"]>) => {
    execute: () => Promise<unknown>;
  };
  const rawBegin = client.begin.bind(client) as unknown as (
    ...call: [...unknown[], (tx: postgres.Sql) => Promise<unknown>]
  ) => Promise<unknown>;
  const runBound = (work: (tx: postgres.Sql) => Promise<unknown>): Promise<unknown> =>
    rawBegin(async (tx: postgres.Sql) => {
      await tx.unsafe(PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
      return work(tx);
    });
  const boundUnsafe = ((...args: Parameters<postgres.Sql["unsafe"]>) => {
    let plain: Promise<unknown> | undefined;
    let valued: Promise<unknown> | undefined;
    const pending: PromiseLike<unknown> & {
      values: () => Promise<unknown>;
      execute: () => Promise<unknown>;
    } = {
      then: (onfulfilled, onrejected) =>
        (plain ??= runBound(async (tx) => tx.unsafe(...args))).then(onfulfilled, onrejected),
      values: () => (valued ??= runBound(async (tx) => tx.unsafe(...args).values())),
      execute: () => rawUnsafe(...args).execute(),
    };
    return pending;
  }) as unknown as TClient["unsafe"];
  const boundBegin = ((...args: unknown[]) => {
    const fn = args[args.length - 1] as (tx: postgres.Sql) => Promise<unknown>;
    const head = args.slice(0, -1);
    return rawBegin(...head, async (tx: postgres.Sql) => {
      await tx.unsafe(PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
      return fn(tx);
    });
  }) as unknown as TClient["begin"];
  client.unsafe = boundUnsafe;
  client.begin = boundBegin;
  return client;
}
