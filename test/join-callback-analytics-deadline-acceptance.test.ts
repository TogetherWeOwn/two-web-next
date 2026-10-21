/// <reference types="vite/client" />
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { checkJoinThrottle, recordAttempt } from "../src/join/service";
import type { JoinRouteDeps } from "../src/join/route";
import { createMemorySessionStore, type Sql } from "../src/sessions";

// Acceptance: waiting for best-effort attempt analytics is bounded.
//
// A rejecting `join_attempts` INSERT already resolves (see the sibling
// analytics-failure suite). This suite pins the remaining gap: an INSERT
// that never settles. The contract for the paired build:
//
//   1. `recordAttempt` waits at most a named bound of at most
//      MAX_ANALYTICS_WAIT_MS (5s: the member-access audit precedent for a
//      best-effort write on a member-facing path), driven by a setTimeout
//      race the fake clock governs — so the caller wait ends whether or
//      not SQL cancellation cooperates. This fixture's deferred INSERT
//      deliberately ignores `statement_timeout`, modelling a driver or
//      transport stall where the server-side bound never fires.
//   2. The actual statement is bounded too, where the driver supports it:
//      observably a `statement_timeout` guard applied to the attempt
//      statement (SET LOCAL / set_config) and/or `.cancel()` invoked on
//      the pending postgres.js query (which this fixture models as a
//      cancellable thenable). A caller-only race does not pass.
//   3. When the bound fires, the already-determined answer is preserved
//      exactly: recovery status/copy/invite, `Retry-After` on the
//      rate-limited recovery paths, and the success redirect/session.
//      Exactly one INSERT is initiated; nothing replays the write, the
//      Discord calls, or the session issuance.
//   4. A late settlement is inert and observed: rejecting the original
//      INSERT after the response produces no unhandled rejection, no new
//      side effects, and no log line quoting the error message or the
//      live user token. Timeout diagnostics match the existing failure
//      line: exception class only, plus the request_id only when it
//      passes validation.
//   5. Healthy and immediately-rejecting inserts keep today's behavior,
//      and a write that settles inside the bound still lands its row
//      before `recordAttempt` resolves (the bound is a wait, not an
//      abandonment).
//
// Hermetic: in-memory Sql double (throttle statements healthy, only the
// `join_attempts` INSERT deferred/throwing), memory session store, stubbed
// Discord fetch, fake clock. No database, no network, no live Discord.

const MOD_ROLE = "1546777856984481792";
const INSERT_PROBE = "attempt-deadline-probe-must-never-surface";
const USER_TOKEN = "user-token-probe-must-never-surface";
const MAX_ANALYTICS_WAIT_MS = 5_000;
const MAX_PRUNE_WAIT_MS = 2_000;
const VALID_REQUEST_ID = "0123456789abcdef";

// Real event-loop yields captured before any fake timers: crypto.subtle,
// Response body streams and other wall-clock work complete on the real
// threadpool/event loop, not on the fake clock. Interleaving a real yield
// per fake advance gives that work wall-clock time without consuming fake
// time (so the <=5 s caller bound is unchanged).
const realSetImmediateImpl: (cb: () => void) => unknown =
  globalThis.setImmediate?.bind(globalThis) ??
  (globalThis.setTimeout.bind(globalThis) as unknown as (cb: () => void) => unknown);
const realYield = () =>
  new Promise<void>((resolve) => {
    realSetImmediateImpl(() => resolve());
  });
// Real wall-clock sleep captured before fake timers. One short sleep per
// fake-time step lets threadpool/stream work finish without consuming fake
// time, so the <=5 s caller bound is unchanged while slow wall-clock work
// no longer starves inside the fake budget.
const realSetTimeoutImpl: (cb: () => void, ms: number) => unknown = globalThis.setTimeout.bind(
  globalThis,
) as unknown as (cb: () => void, ms: number) => unknown;
const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    realSetTimeoutImpl(() => resolve(), ms);
  });

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type AttemptRow = {
  outcome: string;
  source: string | null;
  requestId: string | null;
  discordId: string | null;
};

// A pending postgres.js-style query: a thenable the caller can await or
// `.cancel()`. Cancelling settles it as a rejection whose message carries
// the probe, so a diagnostic that quotes the message is caught.
class DeferredQuery implements PromiseLike<unknown[]> {
  readonly promise: Promise<unknown[]>;
  cancelCalls = 0;
  #resolve!: (rows: unknown[]) => void;
  #reject!: (err: unknown) => void;

  constructor(private readonly onLanded: () => void) {
    this.promise = new Promise<unknown[]>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<unknown[] | TResult> {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<unknown[]> {
    return this.promise.finally(onfinally);
  }

  execute(): Promise<unknown[]> {
    return this.promise;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.#reject(new Error(`query cancelled: ${INSERT_PROBE}`));
  }

  /** Test-side late success: the row lands, then the query resolves. */
  settleLanded(): void {
    this.onLanded();
    this.#resolve([]);
  }

  /** Test-side late failure of the original statement. */
  settleRejected(err: unknown): void {
    this.#reject(err);
  }
}

type AttemptMode = "healthy" | "throwing" | "deferred";

function fakeSql(attemptMode: AttemptMode) {
  const throttle: { bucket: string; at: number }[] = [];
  const attempts: AttemptRow[] = [];
  let attemptInsertTries = 0;
  let deferred: DeferredQuery | null = null;
  let markAttemptStarted!: () => void;
  const attemptStarted = new Promise<void>((resolve) => {
    markAttemptStarted = resolve;
  });
  // Statements are recorded per channel: the outer `sql` handle and each
  // distinct `tx` handle handed to a `begin` callback log separately.
  // Aliasing `tx` to `sql` would let a regression that runs the analytics
  // guard + INSERT on the outer connection (losing the transaction-local
  // statement bound on real postgres.js) pass unnoticed.
  const outerStatements: string[] = [];
  const txTransactions: string[][] = [];

  const attemptInsert = (values: unknown[]) => {
    attemptInsertTries += 1;
    markAttemptStarted();
    if (attemptMode === "throwing")
      return Promise.reject(new Error(`join_attempts insert failed: ${INSERT_PROBE}`));
    const [outcome, source, requestId, discordId] = values as [
      string,
      string | null,
      string | null,
      string | null,
    ];
    const row: AttemptRow = { outcome, source, requestId, discordId };
    if (attemptMode === "healthy") {
      attempts.push(row);
      return Promise.resolve([]);
    }
    deferred = new DeferredQuery(() => attempts.push(row));
    return deferred;
  };

  const runStatement = (head: string, values: unknown[], log: string[]) => {
    log.push(head);
    if (head.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    if (head.includes("set_config") || head.includes("SET LOCAL")) return Promise.resolve([]);
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      const cutoff = Date.now() - 60_000;
      const rows = throttle.filter((r) => r.bucket === bucket && r.at > cutoff);
      const wait =
        rows.length === 0
          ? 1
          : Math.max(
              1,
              Math.ceil((Math.min(...rows.map((r) => r.at)) + 60_000 - Date.now()) / 1000),
            );
      return Promise.resolve([{ n: rows.length, wait }]);
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      throttle.push({ bucket: values[0] as string, at: Date.now() });
      return Promise.resolve([]);
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return Promise.resolve([]);
    if (head.includes("INSERT INTO join_attempts")) return attemptInsert(values);
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  };

  const makeHandle = (log: string[]): Sql => {
    const handle = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      runStatement(strings.join(" "), values, log)) as unknown as Sql;
    (handle as unknown as { unsafe: (q: string, v?: unknown[]) => unknown }).unsafe = (q, v = []) =>
      runStatement(q, v, log);
    return handle;
  };

  const sql = makeHandle(outerStatements) as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  sql.begin = (run) => {
    const txLog: string[] = [];
    txTransactions.push(txLog);
    const tx = makeHandle(txLog) as Sql & {
      begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
    };
    tx.begin = (nested) => nested(tx);
    return run(tx);
  };

  return {
    sql,
    attempts,
    attemptStarted,
    outerStatements,
    txTransactions,
    get attemptInsertTries() {
      return attemptInsertTries;
    },
    get cancelCalls() {
      return deferred?.cancelCalls ?? 0;
    },
    resolveAttemptInsert() {
      deferred?.settleLanded();
    },
    rejectAttemptInsert(err: unknown) {
      deferred?.settleRejected(err);
    },
  };
}

type Fake = ReturnType<typeof fakeSql>;

function isolated(attemptMode: AttemptMode, deps: Partial<JoinRouteDeps> = {}) {
  const fake = fakeSql(attemptMode);
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql, ...deps },
  } as unknown as Env;
  return { store, fake, env: e };
}

type DiscordStubOpts = {
  joinStatus?: number;
  retryAfterSeconds?: number;
  tokenMode?: "ok" | "expired_grant" | "outage" | "rate_limited";
  beforeTokenResponse?: () => Promise<void>;
};

function mockDiscord({
  joinStatus = 201,
  retryAfterSeconds,
  tokenMode = "ok",
  beforeTokenResponse,
}: DiscordStubOpts = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) {
        if (beforeTokenResponse) await beforeTokenResponse();
        if (tokenMode === "expired_grant")
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        if (tokenMode === "outage") return new Response("bad", { status: 500 });
        if (tokenMode === "rate_limited")
          return new Response("slow down", {
            status: 429,
            headers: retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {},
          });
        return Response.json({ access_token: USER_TOKEN });
      }
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && (init as RequestInit)?.method === "PUT")
        return new Response(null, {
          status: joinStatus,
          headers:
            joinStatus === 429 && retryAfterSeconds
              ? { "retry-after": String(retryAfterSeconds) }
              : {},
        });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

const botAdds = (calls: { url: string; init?: RequestInit }[]) =>
  calls.filter((c) => c.url.includes("/members/42") && c.init?.method === "PUT").length;

async function startJoin(e: Env, query = "") {
  const res = await app.request(`/join/discord${query}`, {}, e);
  const location = res.headers.get("location") ? new URL(res.headers.get("location")!) : null;
  return {
    res,
    location,
    state: location?.searchParams.get("state") ?? null,
    cookie: cookiesFrom(res),
  };
}

const finishJoinCb = (e: Env, state: string, cookie: string, extra = "code=abc") =>
  app.request(`/join/callback?${extra}&state=${state}`, { headers: { cookie } }, e);

function captureLogs() {
  const lines: string[] = [];
  const render = (args: unknown[]) =>
    args
      .map((a) =>
        a instanceof Error ? `${a.name}: ${a.message}` : (JSON.stringify(a) ?? String(a)),
      )
      .join(" ");
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(render(args));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(render(args));
  });
  return lines;
}

function expectNoLeak(lines: string[], body: string) {
  expect(body).not.toContain(INSERT_PROBE);
  expect(body).not.toContain(USER_TOKEN);
  const logged = lines.join("\n");
  expect(logged).not.toContain(INSERT_PROBE);
  expect(logged).not.toContain(USER_TOKEN);
}

function expectStatementBounded(fake: Fake) {
  // The guard and the INSERT must arrive on the same distinct `tx` handle,
  // guard first: on real postgres.js `SET LOCAL` only bounds statements in
  // its own transaction, so either statement landing on the outer `sql`
  // silently loses the server-side bound. A query cancel is the other
  // accepted bound (contract point 2), but it cannot substitute for the
  // INSERT itself running via `tx` when a transaction was opened for it.
  const analyticsTx = fake.txTransactions.find((log) =>
    log.some((head) => head.includes("INSERT INTO join_attempts")),
  );
  expect(
    analyticsTx,
    "the attempt INSERT must run via the transaction handle (tx), not the outer sql",
  ).toBeDefined();
  const guardAt = analyticsTx!.findIndex(
    (head) =>
      head.includes("statement_timeout") &&
      (head.includes("SET LOCAL") || head.includes("set_config")),
  );
  const insertAt = analyticsTx!.findIndex((head) => head.includes("INSERT INTO join_attempts"));
  expect(
    (guardAt >= 0 && guardAt < insertAt) || fake.cancelCalls > 0,
    "the attempt statement itself must be bounded (tx statement_timeout guard before the INSERT, and/or query cancel), not only the caller wait",
  ).toBe(true);
  expect(
    fake.outerStatements.some((head) => head.includes("INSERT INTO join_attempts")),
    "no attempt INSERT may arrive via the outer sql handle",
  ).toBe(false);
  expect(
    fake.outerStatements.some((head) => head.includes("statement_timeout")),
    "no statement_timeout guard may arrive via the outer sql handle",
  ).toBe(false);
}

// Drive a callback (or a direct recordAttempt) whose analytics INSERT is
// deferred: await its explicit rendezvous (or an early caller settlement),
// prove the caller is genuinely waiting, then advance the fake clock in 100ms steps
// up to the ceiling. Each fake advance is paired with real event-loop yields
// plus a short real sleep so wall-clock work (crypto.subtle digests/HMAC,
// Response body streams, session issuance) completes without consuming fake
// time; the caller bound stays an independent <=5 s of fake time. On failure
// the deferred INSERT is settled landed and the promise drained before
// asserting, so a red run leaves no orphaned in-flight request on the next
// test's clock.
async function driveBounded<T>(pendingInput: Promise<T> | T, fake: Fake): Promise<T> {
  const pending = Promise.resolve(pendingInput);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // A turn count is not a readiness signal: real crypto/stream work can
  // outlast it under load. Keep fake time frozen until SQL actually starts;
  // racing the caller also makes an omitted INSERT fail instead of hanging.
  await Promise.race([fake.attemptStarted, pending]);
  expect(fake.attemptInsertTries).toBe(1);
  expect(settled, "caller must actually wait for the analytics write, not drop it").toBe(false);

  let elapsed = 0;
  while (!settled && elapsed < MAX_ANALYTICS_WAIT_MS) {
    await vi.advanceTimersByTimeAsync(100);
    await realYield();
    await vi.advanceTimersByTimeAsync(0);
    await realYield();
    // Wall-clock grace without fake-time cost: the success path signs the
    // member in after the analytics deadline (moderator fetch, session
    // HMAC, roster write), all on the real threadpool/streams. A short real
    // sleep lets that work land inside the same fake-time step.
    await realSleep(5);
    elapsed += 100;
  }
  // Final drain without consuming fake time: post-deadline crypto/session
  // work may have finished on the wall clock during the last advance but its
  // .then has not run yet. This does not extend the fake-time bound.
  for (let round = 0; round < 50 && !settled; round++) {
    await vi.advanceTimersByTimeAsync(0);
    await realYield();
    await realSleep(2);
  }
  const settledWithinBound = settled;
  if (!settledWithinBound) {
    fake.resolveAttemptInsert();
    for (let round = 0; round < 200 && !settled; round++) {
      await vi.advanceTimersByTimeAsync(0);
      await realYield();
    }
  }
  expect(
    settledWithinBound,
    `must settle within ${MAX_ANALYTICS_WAIT_MS}ms of fake time without the INSERT settling`,
  ).toBe(true);
  return pending;
}

// Settle the original INSERT late, after the answer: it must be observed
// (no unhandled rejection — vitest also fails the run on one) and inert.
async function rejectLate(fake: Fake) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    fake.rejectAttemptInsert(new Error(`late analytics failure: ${INSERT_PROBE}`));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
}

// Throttle-prune fixture: the verdict statements are healthy, only the
// expiry `DELETE FROM web_throttle_hits` is deferred. Like fakeSql, `begin`
// hands the callback a distinct `tx` handle with its own statement log, so
// a guard or DELETE landing on the outer `sql` is observable.
function fakePruneSql({ refused }: { refused: boolean }) {
  let deleteTries = 0;
  let deferred: DeferredQuery | null = null;
  const outerStatements: string[] = [];
  const txTransactions: string[][] = [];

  const runStatement = (head: string, _values: unknown[], log: string[]) => {
    log.push(head);
    if (head.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    if (head.includes("set_config") || head.includes("SET LOCAL")) return Promise.resolve([]);
    if (head.includes("count(*)")) return Promise.resolve([{ n: refused ? 10 : 0, wait: 7 }]);
    if (head.includes("INSERT INTO web_throttle_hits")) return Promise.resolve([]);
    if (head.includes("DELETE FROM web_throttle_hits")) {
      deleteTries += 1;
      deferred = new DeferredQuery(() => {});
      return deferred;
    }
    throw new Error(`fakePruneSql: unexpected statement: ${head.slice(0, 80)}`);
  };

  const makeHandle = (log: string[]): Sql => {
    const handle = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      runStatement(strings.join(" "), values, log)) as unknown as Sql;
    (handle as unknown as { unsafe: (q: string, v?: unknown[]) => unknown }).unsafe = (q, v = []) =>
      runStatement(q, v, log);
    return handle;
  };

  const sql = makeHandle(outerStatements) as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  sql.begin = (run) => {
    const txLog: string[] = [];
    txTransactions.push(txLog);
    const tx = makeHandle(txLog) as Sql & {
      begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
    };
    tx.begin = (nested) => nested(tx);
    return run(tx);
  };

  return {
    sql,
    outerStatements,
    txTransactions,
    get deleteTries() {
      return deleteTries;
    },
    resolvePruneDelete() {
      deferred?.settleLanded();
    },
    rejectPruneDelete(err: unknown) {
      deferred?.settleRejected(err);
    },
  };
}

type PruneFake = ReturnType<typeof fakePruneSql>;

function expectPruneTxBounded(fake: PruneFake) {
  const pruneTx = fake.txTransactions.find((log) =>
    log.some((head) => head.includes("DELETE FROM web_throttle_hits")),
  );
  expect(
    pruneTx,
    "the prune DELETE must run via the transaction handle (tx), not the outer sql",
  ).toBeDefined();
  const guardAt = pruneTx!.findIndex(
    (head) => head === `SET LOCAL statement_timeout = '${MAX_PRUNE_WAIT_MS}ms'`,
  );
  const deleteAt = pruneTx!.findIndex((head) => head.includes("DELETE FROM web_throttle_hits"));
  expect(
    guardAt >= 0 && guardAt < deleteAt,
    "the prune DELETE must be preceded in the same transaction by SET LOCAL statement_timeout = '2000ms'",
  ).toBe(true);
  expect(
    fake.outerStatements.some((head) => head.includes("DELETE FROM web_throttle_hits")),
    "no prune DELETE may arrive via the outer sql handle",
  ).toBe(false);
  expect(
    fake.outerStatements.some((head) => head.includes("statement_timeout")),
    "no statement_timeout guard may arrive via the outer sql handle",
  ).toBe(false);
}

// Drive a throttle verdict whose prune DELETE never settles: prove the
// caller is waiting, then advance the fake clock up to the 2 s ceiling. On
// failure the deferred DELETE is settled and drained before asserting, so
// a red run (e.g. the unbounded prune) leaves no orphaned in-flight work
// on the next test's clock.
async function drivePruneBounded<T>(pendingInput: Promise<T>, fake: PruneFake): Promise<T> {
  const pending = Promise.resolve(pendingInput);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let round = 0; round < 1000 && fake.deleteTries === 0 && !settled; round++) {
    await vi.advanceTimersByTimeAsync(0);
    await realYield();
  }
  expect(fake.deleteTries).toBe(1);
  expect(settled, "the verdict must wait (bounded) for the prune, not abandon it").toBe(false);

  let elapsed = 0;
  while (!settled && elapsed < MAX_PRUNE_WAIT_MS) {
    await vi.advanceTimersByTimeAsync(100);
    await realYield();
    elapsed += 100;
  }
  for (let round = 0; round < 50 && !settled; round++) {
    await vi.advanceTimersByTimeAsync(0);
    await realYield();
  }
  const settledWithinBound = settled;
  if (!settledWithinBound) {
    fake.resolvePruneDelete();
    for (let round = 0; round < 200 && !settled; round++) {
      await vi.advanceTimersByTimeAsync(0);
      await realYield();
    }
  }
  expect(
    settledWithinBound,
    `the decided verdict must return within ${MAX_PRUNE_WAIT_MS}ms of fake time without the prune DELETE settling`,
  ).toBe(true);
  return pending;
}

async function settlePruneLate(fake: PruneFake, mode: "resolve" | "reject") {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    if (mode === "resolve") fake.resolvePruneDelete();
    else fake.rejectPruneDelete(new Error(`late prune failure: ${INSERT_PROBE}`));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
}

const sessionCookies = (res: Response) =>
  res.headers.getSetCookie().filter((c) => /__Host-two_session=[^;]/.test(c));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("join callback with a never-settling analytics INSERT", () => {
  it("denied consent still renders the recovery page within the bound", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    const calls = mockDiscord();
    const start = await startJoin(e, "?source=web-homepage");
    vi.useFakeTimers();
    const res = await driveBounded(
      app.request(
        `/join/callback?error=access_denied&error_description=never-echo&state=${start.state}`,
        { headers: { cookie: start.cookie } },
        e,
      ),
      fake,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expect(html).toContain("https://discord.gg/invite");
    expect(sessionCookies(res)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(fake.attemptInsertTries).toBe(1);
    expect(fake.attempts).toEqual([]);
    expectStatementBounded(fake);
    expectNoLeak(lines, html);

    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expect(calls).toHaveLength(0);
    expectNoLeak(lines, "");
  });

  it("an expired approval still renders the expired page within the bound", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    const calls = mockDiscord({ tokenMode: "expired_grant" });
    const { state, cookie } = await startJoin(e);
    vi.useFakeTimers();
    const res = await driveBounded(finishJoinCb(e, state!, cookie), fake);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join approval expired");
    expect(sessionCookies(res)).toEqual([]);
    expect(fake.attemptInsertTries).toBe(1);
    expectStatementBounded(fake);
    expectNoLeak(lines, html);

    const callsBefore = calls.length;
    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expect(calls).toHaveLength(callsBefore);
    expectNoLeak(lines, "");
  });

  it("waits for the INSERT rendezvous when expired-token work outlasts the old preparation loop", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    let markTokenRequested!: () => void;
    const tokenRequested = new Promise<void>((resolve) => {
      markTokenRequested = resolve;
    });
    const calls = mockDiscord({
      tokenMode: "expired_grant",
      beforeTokenResponse: async () => {
        markTokenRequested();
        await tokenGate;
      },
    });
    const { state, cookie } = await startJoin(e);
    vi.useFakeTimers();
    const before = Date.now();
    const callback = finishJoinCb(e, state!, cookie);
    // Observe a driver failure immediately, but release and drain the real
    // callback before rethrowing it so a RED run cannot pollute the next clock.
    const driven = driveBounded(callback, fake).then(
      (res) => ({ ok: true, res }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    let responseReturned = false;
    try {
      await tokenRequested;
      // A controlled prerequisite stays pending for more turns than the old
      // 1000-round preparation loop. No wall-clock sleep or fake-time budget
      // increase: the analytics INSERT cannot exist until this gate opens.
      for (let round = 0; round < 1001; round++) {
        await vi.advanceTimersByTimeAsync(0);
        await realYield();
      }
      expect(fake.attemptInsertTries).toBe(0);
      expect(Date.now()).toBe(before);
      releaseToken();
      const result = await driven;
      if (!result.ok) throw result.error;
      responseReturned = true;
      const { res } = result;
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Join approval expired");
      expect(sessionCookies(res)).toEqual([]);
      expect(fake.attemptInsertTries).toBe(1);
      expect(fake.attempts).toEqual([]);
      expectStatementBounded(fake);
      expect(calls).toHaveLength(1);
      expectNoLeak(lines, html);

      await rejectLate(fake);
      expect(fake.attemptInsertTries).toBe(1);
      expect(calls).toHaveLength(1);
      expectNoLeak(lines, "");
    } finally {
      releaseToken();
      if (!responseReturned) {
        await Promise.race([fake.attemptStarted, callback]);
        fake.resolveAttemptInsert();
        await callback;
      }
      await driven;
    }
  });

  it("a Discord outage keeps its 503 recovery status within the bound", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    const calls = mockDiscord({ tokenMode: "outage" });
    const { state, cookie } = await startJoin(e);
    vi.useFakeTimers();
    const res = await driveBounded(finishJoinCb(e, state!, cookie), fake);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Discord is unreachable");
    expect(res.headers.get("retry-after")).toBeNull();
    expect(sessionCookies(res)).toEqual([]);
    expect(fake.attemptInsertTries).toBe(1);
    expectStatementBounded(fake);
    expectNoLeak(lines, html);

    const callsBefore = calls.length;
    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expect(calls).toHaveLength(callsBefore);
    expectNoLeak(lines, "");
  });

  it("a rate-limited token exchange keeps 503 and its Retry-After within the bound", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    mockDiscord({ tokenMode: "rate_limited", retryAfterSeconds: 7 });
    const { state, cookie } = await startJoin(e);
    vi.useFakeTimers();
    const res = await driveBounded(finishJoinCb(e, state!, cookie), fake);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    const html = await res.text();
    expect(html).toContain("Discord is unreachable");
    expect(sessionCookies(res)).toEqual([]);
    expect(fake.attemptInsertTries).toBe(1);
    expectStatementBounded(fake);
    expectNoLeak(lines, html);

    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expectNoLeak(lines, "");
  });

  it("a refused bot add still renders the invite fallback within the bound, bot called once", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    const calls = mockDiscord({ joinStatus: 403 });
    const { state, cookie } = await startJoin(e);
    vi.useFakeTimers();
    const res = await driveBounded(finishJoinCb(e, state!, cookie), fake);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(html).toContain("https://discord.gg/invite");
    expect(res.headers.get("retry-after")).toBeNull();
    expect(sessionCookies(res)).toEqual([]);
    expect(botAdds(calls)).toBe(1);
    expect(fake.attemptInsertTries).toBe(1);
    expectStatementBounded(fake);
    expectNoLeak(lines, html);

    const callsBefore = calls.length;
    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expect(calls).toHaveLength(callsBefore);
    expect(botAdds(calls)).toBe(1);
    expectNoLeak(lines, "");
  });

  it("a rate-limited bot add keeps its Retry-After within the bound, bot called once", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    const calls = mockDiscord({ joinStatus: 429, retryAfterSeconds: 9 });
    const { state, cookie } = await startJoin(e);
    vi.useFakeTimers();
    const res = await driveBounded(finishJoinCb(e, state!, cookie), fake);
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBe("9");
    const html = await res.text();
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(sessionCookies(res)).toEqual([]);
    expect(botAdds(calls)).toBe(1);
    expect(fake.attemptInsertTries).toBe(1);
    expectStatementBounded(fake);
    expectNoLeak(lines, html);

    const callsBefore = calls.length;
    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expect(calls).toHaveLength(callsBefore);
    expectNoLeak(lines, "");
  });

  it("success still signs the member in exactly once and redirects within the bound", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    const calls = mockDiscord({ joinStatus: 201 });
    const { state, cookie } = await startJoin(e, "?source=web-homepage");
    vi.useFakeTimers();
    const res = await driveBounded(finishJoinCb(e, state!, cookie), fake);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(sessionCookies(res)).toHaveLength(1);
    expect(botAdds(calls)).toBe(1);
    expect(fake.attemptInsertTries).toBe(1);
    expect(fake.attempts).toEqual([]);
    expectStatementBounded(fake);
    expectNoLeak(lines, await res.clone().text());

    const callsBefore = calls.length;
    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expect(calls).toHaveLength(callsBefore);
    expect(botAdds(calls)).toBe(1);
    expectNoLeak(lines, "");
    vi.useRealTimers();
    // The issued session is untouched by the late analytics failure.
    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    expect(await home.text()).toContain("Rick");
  });
});

describe("recordAttempt with a never-settling INSERT (direct)", () => {
  it("resolves within the bound and logs class-only with the validated request_id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSql("deferred");
    vi.useFakeTimers();
    await driveBounded(
      recordAttempt(fake.sql, {
        outcome: "added",
        source: "web-homepage",
        requestId: VALID_REQUEST_ID,
        discordId: "42",
      }),
      fake,
    );
    expect(fake.attemptInsertTries).toBe(1);
    expect(fake.attempts).toEqual([]);
    expectStatementBounded(fake);
    // Exact payload, not substrings: the runbook stall-detection guidance
    // keys on `exception: AnalyticsWriteDeadline`, so a rename to a generic
    // class (e.g. `Error`) must go red here.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("join attempt write failed");
    expect(warn.mock.calls[0]?.[1]).toEqual({
      exception: "AnalyticsWriteDeadline",
      outcome: "added",
      request_id: VALID_REQUEST_ID,
    });
    expectNoLeak([JSON.stringify(warn.mock.calls)], "");

    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expectNoLeak([JSON.stringify(warn.mock.calls)], "");
  });

  it("omits a malformed request_id from timeout diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSql("deferred");
    vi.useFakeTimers();
    await driveBounded(
      recordAttempt(fake.sql, {
        outcome: "error",
        source: null,
        requestId: `not a valid id ${INSERT_PROBE}`,
        discordId: null,
      }),
      fake,
    );
    expect(fake.attemptInsertTries).toBe(1);
    expectStatementBounded(fake);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("join attempt write failed");
    expect(warn.mock.calls[0]?.[1]).toEqual({
      exception: "AnalyticsWriteDeadline",
      outcome: "error",
    });
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("request_id");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("not a valid id");
    expectNoLeak([JSON.stringify(warn.mock.calls)], "");

    await rejectLate(fake);
    expect(fake.attemptInsertTries).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expectNoLeak([JSON.stringify(warn.mock.calls)], "");
  });

  it("a write that settles inside the bound still lands its row before resolving", async () => {
    const lines = captureLogs();
    const fake = fakeSql("deferred");
    vi.useFakeTimers();
    let settled = false;
    const pending = recordAttempt(fake.sql, {
      outcome: "denied",
      source: "web-homepage",
      requestId: null,
      discordId: null,
    }).then(() => {
      settled = true;
    });
    await Promise.race([fake.attemptStarted, pending]);
    expect(fake.attemptInsertTries).toBe(1);
    expect(settled).toBe(false);
    fake.resolveAttemptInsert();
    await vi.advanceTimersByTimeAsync(0);
    await realYield();
    await pending;
    expect(settled).toBe(true);
    expect(fake.attempts).toEqual([
      { outcome: "denied", source: "web-homepage", requestId: null, discordId: null },
    ]);
    expect(lines.join("\n")).not.toContain("join attempt write failed");
    expectNoLeak(lines, "");
  });
});

describe("checkJoinThrottle with a never-settling prune DELETE (direct)", () => {
  it("returns the decided refusal within the bound and warns exactly ThrottlePruneDeadline; a late rejection is inert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakePruneSql({ refused: true });
    vi.useFakeTimers();
    const verdict = await drivePruneBounded(
      checkJoinThrottle(fake.sql, "join:203.0.113.7", 10),
      fake,
    );
    expect(verdict).toEqual({ limited: true, retryAfter: 7 });
    expect(fake.deleteTries).toBe(1);
    expectPruneTxBounded(fake);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "Join throttle prune failed; keeping the decided verdict.",
    );
    expect(warn.mock.calls[0]?.[1]).toEqual({ exception: "ThrottlePruneDeadline" });
    expectNoLeak([JSON.stringify(warn.mock.calls)], "");

    await settlePruneLate(fake, "reject");
    expect(fake.deleteTries).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expectNoLeak([JSON.stringify(warn.mock.calls)], "");
  });

  it("returns the decided admission within the bound; a late prune success changes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakePruneSql({ refused: false });
    vi.useFakeTimers();
    const verdict = await drivePruneBounded(
      checkJoinThrottle(fake.sql, "join:203.0.113.8", 10),
      fake,
    );
    expect(verdict).toEqual({ limited: false });
    expect(fake.deleteTries).toBe(1);
    expectPruneTxBounded(fake);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "Join throttle prune failed; keeping the decided verdict.",
    );
    expect(warn.mock.calls[0]?.[1]).toEqual({ exception: "ThrottlePruneDeadline" });
    expectNoLeak([JSON.stringify(warn.mock.calls)], "");

    await settlePruneLate(fake, "resolve");
    expect(fake.deleteTries).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expectNoLeak([JSON.stringify(warn.mock.calls)], "");
  });
});

describe("analytics driver readiness control", () => {
  it("rejects an early expired-link answer with no INSERT instead of hanging at the rendezvous", async () => {
    const lines = captureLogs();
    const { fake, env: e } = isolated("deferred");
    const calls = mockDiscord();
    vi.useFakeTimers();
    const callback = finishJoinCb(e, "unadmitted-state", "");
    await expect(driveBounded(callback, fake)).rejects.toMatchObject({ actual: 0, expected: 1 });
    const res = await callback;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join link expired");
    expect(sessionCookies(res)).toEqual([]);
    expect(fake.attemptInsertTries).toBe(0);
    expect(calls).toHaveLength(0);
    expectNoLeak(lines, html);
  });
});

describe("positive controls (green before the build)", () => {
  it("healthy store: success records the row, signs in and redirects", async () => {
    const { fake, env: e } = isolated("healthy");
    mockDiscord({ joinStatus: 201 });
    const { state, cookie } = await startJoin(e, "?source=web-homepage");
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(sessionCookies(res)).toHaveLength(1);
    expect(fake.attempts).toEqual([
      { outcome: "added", source: "web-homepage", requestId: null, discordId: "42" },
    ]);
  });

  it("healthy store: a rate-limited bot add records its row and keeps Retry-After", async () => {
    const { fake, env: e } = isolated("healthy");
    mockDiscord({ joinStatus: 429, retryAfterSeconds: 9 });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBe("9");
    expect(fake.attempts).toMatchObject([{ outcome: "rate_limited", discordId: "42" }]);
  });

  it("immediately rejecting INSERT: outage keeps 503 and success still signs in", async () => {
    const lines = captureLogs();
    const outage = isolated("throwing");
    mockDiscord({ tokenMode: "outage" });
    const first = await startJoin(outage.env);
    const res503 = await finishJoinCb(outage.env, first.state!, first.cookie);
    expect(res503.status).toBe(503);
    expect(await res503.text()).toContain("Discord is unreachable");
    expect(outage.fake.attemptInsertTries).toBe(1);

    const ok = isolated("throwing");
    mockDiscord({ joinStatus: 201 });
    const second = await startJoin(ok.env);
    const res302 = await finishJoinCb(ok.env, second.state!, second.cookie);
    expect(res302.status).toBe(302);
    expect(sessionCookies(res302)).toHaveLength(1);
    expect(ok.fake.attemptInsertTries).toBe(1);
    expectNoLeak(lines, "");
  });

  it("direct recordAttempt resolves on healthy and immediately-rejecting stores", async () => {
    const healthy = fakeSql("healthy");
    await expect(
      recordAttempt(healthy.sql, {
        outcome: "added",
        source: null,
        requestId: null,
        discordId: "42",
      }),
    ).resolves.toBeUndefined();
    expect(healthy.attempts).toHaveLength(1);

    const lines = captureLogs();
    const throwing = fakeSql("throwing");
    await expect(
      recordAttempt(throwing.sql, {
        outcome: "added",
        source: null,
        requestId: null,
        discordId: "42",
      }),
    ).resolves.toBeUndefined();
    expect(throwing.attemptInsertTries).toBe(1);
    expectNoLeak(lines, "");
  });
});

describe("real timer restoration control", () => {
  it("restores working real timers after the analytics lifecycle", async () => {
    expect(vi.isFakeTimers()).toBe(false);
    const winner = await Promise.race([
      new Promise<string>((resolve) => {
        globalThis.setTimeout(() => resolve("timer"), 5);
      }),
      realSleep(300).then(() => "never"),
    ]);
    expect(winner).toBe("timer");
  });
});
