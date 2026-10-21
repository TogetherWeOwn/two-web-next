// The one-click web-to-Discord join journey (W6).
//
// Ports two-web JoinController's funnel contract onto the Workers stack:
//   GET  /join            — the journey page (one-click button + invite fallback)
//   GET  /join/discord    — throttle, then 302 to Discord with identify+guilds.join
//   GET  /join/callback   — throttle, exchange, synchronous bot add, sign-in
//
// Three deliberate differences from legacy, each pinned by tests:
//   1. The synchronous bot call goes to Discord's own
//      PUT /guilds/{guild}/members/{user} with the bot token (the same call the
//      /auth/discord flow already makes), not to a bot HMAC endpoint: the bot
//      rewrite is Rust with its contract pending, and the token-hygiene property
//      — the live member token is used once in this stack frame and never lands
//      in a queue table, a row or a log — holds either way.
//   2. The join page and the journey state carry a signed `join_source` /
//      `join_next` cookie pair instead of the Laravel session (there is no
//      server session yet at that point): `source` is attribution-only and
//      validated against the legacy pattern; `next` must pass the same
//      open-redirect guard as legacy SafeRedirect.
//   3. The throttle is Postgres (`web_throttle_hits`), not the cache store: the
//      funnel floor must not depend on a cache that is the database everywhere
//      shipped, and Workers isolates share nothing in memory — Postgres is the
//      only coordination point, so behaviour is identical across isolates.
//
// Token hygiene (the W6 acceptance test): the only values written anywhere are
// outcome, source, request_id and discord_id. The OAuth/token-exchange response
// bodies and exception messages can quote the live token, so none of them is
// ever a recordAttempt parameter and none is ever logged.
import { addGuildMemberDetailed, type JoinResult } from "../discord";
import { PER_REQUEST_STATEMENT_TIMEOUT_LOCAL } from "../db/connection";
import { safeRequestId } from "../request-log";
import type { Sql } from "../sessions";

export const JOIN_OUTCOMES = [
  "added",
  "already_member",
  "error",
  "denied",
  "degraded",
  "rate_limited",
] as const;
export type JoinOutcome = (typeof JOIN_OUTCOMES)[number];

/**
 * Legacy 10/min budget on /join/discord + /join/callback. One bucket per client
 * (legacy `throttle:10,1` keyed guests by IP), shared by the two routes.
 */
export const JOIN_THROTTLE_PER_MINUTE = 10;
export const JOIN_THROTTLE_BUCKET = "join";
// The privacy policy promises this window for rate-limit counters; change it only with a policy version.
export const THROTTLE_COUNTER_RETENTION_MINUTES = 5;

/**
 * Bound on the per-bucket admission-lock wait. A held `web-throttle:` advisory
 * lock resolves to a refusal within this bound (55P03 → `{ limited: true }`,
 * no hit charged) instead of hanging a funnel request behind another
 * isolate's admission. Sized above the ~1s held-lock windows pinned by the
 * concurrency suite and well inside the 4s busy bound in
 * `test/web-throttle-lock-busy.test.ts`. A refusal is the correct mapping
 * because every bucket is per client (`<name>:<clientKey>`): contention on a
 * bucket only comes from that same client's parallel requests, which is the
 * burst the throttle exists to limit — admitting it would turn the throttle
 * off under exactly the load it exists to stop.
 */
export const WEB_THROTTLE_LOCK_TIMEOUT_MS = 2000;

/**
 * Named wait for the best-effort throttle prune: the already-decided verdict
 * returns after at most this long, whether or not the database cancels the
 * statement.
 */
const THROTTLE_PRUNE_WAIT_MS = 2_000;

function exceptionClass(err: unknown): string {
  return err instanceof Error
    ? err.name
    : ((err as { constructor?: { name?: string } })?.constructor?.name ?? "unknown");
}

/**
 * Legacy join_source validation (JoinController::rememberSource): starts
 * alnum, then up to 63 of [a-z0-9:_-]. Anything else leaves no trace.
 */
export function sanitizeSource(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(raw) ? raw : null;
}

/**
 * Bound on a return destination (login_next / intended, explicit or
 * gate-recorded), in UTF-8 bytes. A multi-KB value risks silent cookie-cap
 * drops, and a surviving long value lands in the callback Location header —
 * so anything longer is rejected at write time (no cookie set) and at consume
 * time (fall back to the next layer, then the default landing).
 *
 * Bytes, not UTF-16 units: the cookie serializer percent-encodes every byte
 * of a multibyte character, so 512 CJK characters would still serialize past
 * the browser's 4096-byte per-cookie cap; 512 bytes stays near 1.6 KB. ASCII
 * (every gate-recorded page, which is already percent-encoded) counts one
 * byte per character.
 */
export const MAX_RETURN_DESTINATION_BYTES = 512;

/**
 * Legacy SafeRedirect::safe: the value survives only when it is a same-origin
 * path — starts with exactly one `/`, no `//`, no backslash, no scheme.
 * Hostile values leave no trace and the callback keeps the default landing.
 *
 * Control bytes (notably NUL) are rejected too: a surviving value lands in
 * the callback's Location header, where Headers.set throws on them and turns
 * an otherwise successful login into a 500.
 */
export function safeNext(raw: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  if (typeof raw !== "string" || raw === "" || /[\s\x00-\x1f\x7f]/.test(raw)) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_RETURN_DESTINATION_BYTES) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  try {
    const u = new URL(raw, "https://join.invalid");
    if (u.origin !== "https://join.invalid") return null;
  } catch {
    return null;
  }
  return raw;
}

export type ThrottleVerdict = { limited: false } | { limited: true; retryAfter: number };

/**
 * Fixed-window throttle: count rows in this bucket in the last 60 s; over
 * budget refuses before the token exchange runs. A missing store degrades to
 * allow — refusing the funnel top on a DB outage is worse than a missed count
 * (legacy funnel.php made the same call for the leaves: no throttle at all
 * rather than a cache-backed one that 500s when the database is down).
 *
 * Lock contention is a refusal: the admission lock waits at most
 * `WEB_THROTTLE_LOCK_TIMEOUT_MS`, and a timed-out wait (55P03) resolves to
 * `{ limited: true, retryAfter: 1 }` with no hit charged — contention on a
 * per-client bucket is that same client's burst, so the busy pass refuses
 * with the shared 429 rather than admitting free. The join funnel calls this
 * function with no catch of its own, so the mapping lives here: a
 * lock-timeout error never propagates to a caller and never becomes an
 * admission. Any other store error still propagates (the generic middleware
 * maps it to allow; the direct join path to its outage envelope).
 */
export async function checkJoinThrottle(
  sql: Sql | null,
  bucket: string,
  max: number,
): Promise<ThrottleVerdict> {
  if (!sql) return { limited: false };
  // The native postgres.js store supports transactions; the session SQL seam
  // deliberately exposes only the statements needed by session stores.
  const store = sql as Sql & {
    begin: (run: (tx: Sql) => Promise<ThrottleVerdict>) => Promise<ThrottleVerdict>;
  };
  let verdict: ThrottleVerdict;
  try {
    verdict = await store.begin(async (tx) => {
      // Bound the admission-lock wait: without this, a bucket whose advisory
      // lock is held by another isolate blocks here until the holder commits.
      // Same `SET LOCAL lock_timeout` shape as the agent-events shield, inner
      // limiter and ingress operation locks.
      await tx.unsafe(`SET LOCAL lock_timeout = '${WEB_THROTTLE_LOCK_TIMEOUT_MS}ms'`);
      // Per-request statement bound: a lock timeout alone cannot cancel an
      // executing statement, so the INSERT below also carries the shared
      // 5 s bound. It sits above the 2 s lock timeout, so lock waits still
      // refuse with 55P03 while executing statements cancel with 57014 and
      // propagate to the callers' fail-open/outage handling.
      await tx.unsafe(PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`web-throttle:${bucket}`}, 0))`;
      // now() is transaction-start time, which can precede a long lock wait.
      const rows = await tx<{ n: number; wait: number }[]>`
      SELECT count(*)::int AS n,
        coalesce(ceil(extract(epoch FROM (min(at) + interval '60 seconds' - clock_timestamp()))), 1)::int AS wait
      FROM web_throttle_hits WHERE bucket = ${bucket} AND at > clock_timestamp() - interval '60 seconds'`;
      const r = rows[0];
      if (r && r.n >= max) return { limited: true, retryAfter: Math.max(1, r.wait) };
      await tx`INSERT INTO web_throttle_hits (bucket, at) VALUES (${bucket}, clock_timestamp())`;
      return { limited: false };
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "55P03") throw err;
    // Busy pass: the verdict transaction aborted with no hit inserted. Fall
    // through to the best-effort prune below so a busy pass still drains
    // expired rows, then answer a refusal — the shared 429 with Retry-After: 1
    // at every caller (join funnel, generic middleware, profile writes).
    verdict = { limited: true, retryAfter: 1 };
  }
  // Global expiry cleanup stays outside the per-bucket admission lock so it
  // never prolongs it. Refused requests prune too: a bucket under sustained
  // refused load would otherwise accumulate expired rows until some request
  // is admitted. The prune is age-only, so it records no hit and never moves
  // a request across the admit/refuse boundary. One bounded oldest-first
  // batch per request (1,000 rows, the established cleanup batch, skip-locked
  // so rows held by unrelated transactions wait for a later pass). It is
  // best-effort: a throwing prune must not flip a decided refusal into an
  // admission (the generic middleware catch) or a 500 on the direct join path
  // (no catch there) — and a stalled prune must not hold the decided verdict
  // either. The answer waits at most THROTTLE_PRUNE_WAIT_MS, independently of
  // the transaction-local statement timeout; the server cancels a slow DELETE
  // without changing pooled settings, while connection/transport stalls still
  // cannot hold the caller. A late settlement is observed without a second
  // warning or a verdict change.
  const pruneDelete = (tx: Sql) =>
    tx`DELETE FROM web_throttle_hits USING (SELECT id FROM web_throttle_hits WHERE at < now() - make_interval(mins => ${THROTTLE_COUNTER_RETENTION_MINUTES}) ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED) AS candidates WHERE web_throttle_hits.id = candidates.id`;
  const pruneStore = sql as Sql & {
    begin: (run: (tx: Sql) => Promise<void>) => Promise<void>;
  };
  const prune = (async () => {
    try {
      await pruneStore.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '${THROTTLE_PRUNE_WAIT_MS}ms'`);
        await pruneDelete(tx);
      });
      return null;
    } catch (err) {
      return { err };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), THROTTLE_PRUNE_WAIT_MS);
  });
  try {
    const failure = await Promise.race([prune, deadline]);
    if (failure !== null) {
      // Housekeeping failed or stalled; the verdict below was already decided.
      // Log the exception class only: the message can quote statement bindings.
      // An expired wait logs once as ThrottlePruneDeadline; a late settlement
      // causes no second warning.
      console.warn("Join throttle prune failed; keeping the decided verdict.", {
        exception: failure === "deadline" ? "ThrottlePruneDeadline" : exceptionClass(failure.err),
      });
    }
  } finally {
    clearTimeout(timer);
  }
  return verdict;
}

// Fixture helper only (TOG-19721): the same shape as
// drizzle/1000_join-attempts-throttle.sql, kept identical so disposable test
// schemas match migrated databases. The request path must NOT call
// migrateJoin(): the runtime role holds read/write only, no schema CREATE —
// the funnel floor assumes the migrate workflow created these tables.
// The import-only legacy_id key (drizzle/1012) is deliberately absent here:
// the admin viewer selects explicit columns so both shapes stay readable, and
// keeping the bootstrap identical to 1000 means 1012 still applies cleanly on
// bootstrapped databases.
const JOIN_MIGRATION = [
  `create table if not exists join_attempts (
    id bigserial primary key,
    outcome varchar(16) not null,
    source varchar(64),
    request_id text,
    discord_id text,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists web_throttle_hits (
    id bigserial primary key,
    bucket text not null,
    at timestamptz not null default now()
  )`,
  `create index if not exists join_attempts_created_at_idx on join_attempts (created_at)`,
  `create index if not exists web_throttle_hits_bucket_at_idx on web_throttle_hits (bucket, at)`,
];

export async function migrateJoin(sql: Sql): Promise<void> {
  for (const stmt of JOIN_MIGRATION) await sql.unsafe(stmt);
}

/**
 * Named wait for the best-effort attempt write: the join answers after at most
 * this long, whether or not the database cancels the statement.
 */
const ATTEMPT_ANALYTICS_WAIT_MS = 2_000;

/**
 * One queryable row per terminal join path. Null store = no-op (funnel stays up).
 * Analytics must never break the join: the answer waits at most
 * ATTEMPT_ANALYTICS_WAIT_MS, independently of the transaction-local statement
 * timeout. The server cancels a slow INSERT without changing pooled settings;
 * connection/transport stalls still cannot hold the caller. A late settlement is
 * observed without replaying the write or changing the request outcome.
 * Logs only the exception class (never the message, which can quote the live
 * token or statement text) plus the validated request_id, so the line joins to
 * request logs. Absent/malformed IDs are omitted, never raw.
 */
export async function recordAttempt(
  sql: Sql | null,
  attempt: {
    outcome: JoinOutcome;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  },
): Promise<void> {
  if (!sql) return;
  const warn = (exception: string) => {
    const requestId = safeRequestId(attempt.requestId);
    console.warn("join attempt write failed", {
      exception,
      outcome: attempt.outcome,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
    });
  };
  const store = sql as Sql & {
    begin?: (run: (tx: Sql) => Promise<void>) => Promise<void>;
  };
  const insert = (tx: Sql) =>
    tx`INSERT INTO join_attempts (outcome, source, request_id, discord_id)
    VALUES (${attempt.outcome}, ${attempt.source}, ${attempt.requestId}, ${attempt.discordId})`;
  const write = (async () => {
    try {
      if (store.begin) {
        await store.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = '${ATTEMPT_ANALYTICS_WAIT_MS}ms'`);
          await insert(tx);
        });
      } else {
        // The minimal Sql seam does not require transactions; native stores do.
        await insert(sql);
      }
      return null;
    } catch (err) {
      return { err };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ATTEMPT_ANALYTICS_WAIT_MS);
  });
  try {
    const failure = await Promise.race([write, deadline]);
    if (failure === null) return;
    warn(failure === "deadline" ? "AnalyticsWriteDeadline" : exceptionClass(failure.err));
  } finally {
    clearTimeout(timer);
  }
}

export type BotAdd = (
  guildId: string,
  userId: string,
  accessToken: string,
) => Promise<{
  result: JoinResult;
  requestId: string | null;
  retryAfter?: number;
}>;

/** The production bot call: Discord's own add-member endpoint with the bot token. */
export function liveBotAdd(botToken: string): BotAdd {
  return async (guildId, userId, accessToken) => {
    const add = await addGuildMemberDetailed(guildId, userId, accessToken, botToken);
    if (add.result !== "rate_limited" || add.retryAfter === undefined)
      return { result: add.result, requestId: null };
    return { result: add.result, requestId: null, retryAfter: add.retryAfter };
  };
}

export type JoinFinish =
  | {
      kind: "signed_in";
      outcome: JoinOutcome;
      redirect: string;
      requestId: string | null;
      discordId: string;
    }
  | {
      kind: "recoverable";
      outcome: JoinOutcome;
      requestId: string | null;
      retryAfter?: number;
    };

/**
 * The synchronous tail of the callback: one bot attempt owns the live token,
 * then the frame drops it. Outcomes mirror the legacy JoinOutcome enum:
 * added / already_member → sign in; a rate-limited bot add → recoverable
 * with the distinct `rate_limited` outcome (plus the bounded `retryAfter`
 * when the bot seam carried one); any other classified bot refusal
 * (forbidden, provider_outage, transport_failure, failed) or any transport
 * throw → degraded (a `retryAfter` riding on any non-rate-limited answer is
 * dropped); the callback never stores the token, never logs it, never queues it.
 */
export async function finishJoin(
  bot: BotAdd,
  guildId: string,
  userId: string,
  accessToken: string,
  next: string | null,
): Promise<JoinFinish> {
  let result: JoinResult;
  let requestId: string | null = null;
  let retryAfter: number | undefined;
  try {
    const answer = await bot(guildId, userId, accessToken);
    result = answer.result;
    requestId = answer.requestId;
    retryAfter = answer.retryAfter;
  } catch {
    return { kind: "recoverable", outcome: "degraded", requestId: null };
  }
  if (result === "rate_limited")
    return retryAfter === undefined
      ? { kind: "recoverable", outcome: "rate_limited", requestId }
      : { kind: "recoverable", outcome: "rate_limited", requestId, retryAfter };
  if (result !== "joined" && result !== "already_member")
    return { kind: "recoverable", outcome: "degraded", requestId };
  const outcome: JoinOutcome = result === "joined" ? "added" : "already_member";
  const notice = result === "joined" ? "joined" : "already_member";
  return {
    kind: "signed_in",
    outcome,
    redirect: next ?? `/?n=${notice}`,
    requestId,
    discordId: userId,
  };
}
