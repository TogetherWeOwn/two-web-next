import postgres from "postgres";
import { databaseOptions, databaseUrl } from "../db/connection";
import type { Env } from "../env";
import { eventKeyAllowed } from "../events/keys";
import { pgEventStore } from "./events";
import { eventKeyFromFailedJob, reconcileFailedJob, type ReplayDisposition } from "./replay";

export type FailedJobPreview = {
  failure: { id: number; kind: string; failedAt: string };
  observedAt: string;
  disposition: { action: ReplayDisposition["action"]; reason: string };
};

/**
 * Server-side replay candidate: the public advice plus the rebuildable source
 * identity a guarded apply path needs. `eventKey`/`idempotencyKey` never leave
 * the server — HTTP responses carry the `preview` shape only, which omits the
 * raw ledger key, pending payload and idempotency key.
 */
export type FailedJobReplayCandidate = {
  preview: FailedJobPreview;
  eventKey: string | null;
  idempotencyKey?: string;
};

/** Canonical positive IDs only; do not round a bigint into a different row. */
export function parseFailureId(raw: string): number | null {
  if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * One consistent, database-enforced read-only snapshot. No queue, lock or
 * discard capability is constructed. A disposition is advice, not authority.
 * https://github.com/porsager/postgres#transactions
 * https://www.postgresql.org/docs/current/transaction-iso.html#XACT-REPEATABLE-READ
 */
export async function previewFailedJobWithSql(
  sql: postgres.Sql,
  failureId: number,
  appUrl: string,
): Promise<FailedJobPreview | null> {
  const candidate = await loadReplayCandidateWithSql(sql, failureId, appUrl);
  return candidate?.preview ?? null;
}

/**
 * Same read-only snapshot as the advice, plus the rebuildable identity for a
 * guarded apply. Same statements, same transaction posture; only the return
 * shape keeps what the public advice strips.
 */
export async function loadReplayCandidateWithSql(
  sql: postgres.Sql,
  failureId: number,
  appUrl: string,
): Promise<FailedJobReplayCandidate | null> {
  if (parseFailureId(String(failureId)) !== failureId) throw new Error("invalid failure ID");
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    // Never select failure text (which can contain transport diagnostics),
    // message payloads or job identities for the operational response.
    const [row] = await tx`select id, left(kind, 64) as kind, left(key, 128) as key,
      failed_at, transaction_timestamp() as observed_at, clock_timestamp() as preview_read_at
      from queue_failed_jobs where id = ${failureId} limit 1`;
    if (!row) return null;
    const failed = { kind: String(row.kind), key: row.key == null ? null : String(row.key) };
    const events = pgEventStore(tx, { bypassReadCache: true });
    // EventStore makes this optional for other consumers. Here all three
    // checks are mandatory, even if this particular row would not use one.
    const { needsSync, pendingSync, hasFailedSync } = events;
    if (
      typeof needsSync !== "function" ||
      typeof pendingSync !== "function" ||
      typeof hasFailedSync !== "function"
    ) {
      throw new Error("incomplete reconciliation store");
    }
    const eventKey = eventKeyFromFailedJob(failed);
    let disposition: ReplayDisposition;
    // Same key contract as the public event routes: ULIDs everywhere, plus the
    // fixed staging/local demo keys on those bindings only.
    if (eventKey && !eventKeyAllowed(eventKey, appUrl)) {
      disposition = {
        action: "keep",
        eventKey: null,
        reason: "invalid source identity; preserve dead row",
      };
    } else if (
      eventKey &&
      !(
        await tx`select 1, clock_timestamp() as preview_read_at from events
        where event_key = ${eventKey} limit 1`
      ).length
    ) {
      disposition = {
        action: "keep",
        eventKey,
        reason: "source is missing; preserve dead row for operator review",
      };
    } else {
      disposition = await reconcileFailedJob(
        { needsSync, pendingSync, hasFailedSync },
        failed,
        () => row.observed_at as Date,
      );
    }
    const preview: FailedJobPreview = {
      failure: {
        id: failureId,
        kind: failed.kind,
        failedAt: (row.failed_at as Date).toISOString(),
      },
      observedAt: (row.observed_at as Date).toISOString(),
      // Omit the raw ledger key, pending payload and idempotency key.
      disposition: { action: disposition.action, reason: disposition.reason },
    };
    return {
      preview,
      eventKey: disposition.eventKey,
      ...(disposition.action === "replay" && disposition.idempotencyKey
        ? { idempotencyKey: disposition.idempotencyKey }
        : {}),
    };
  });
}

/** The HTTP caller opens the same Worker source database, never caller SQL. */
export async function previewFailedJob(
  env: Env,
  failureId: number,
): Promise<FailedJobPreview | null> {
  const url = databaseUrl(env);
  if (!url) throw new Error("no source database configured");
  const sql = postgres(url, {
    ...databaseOptions,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  try {
    return await previewFailedJobWithSql(sql, failureId, env.APP_URL);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Same source database as the advice: the guarded apply reads, never caller SQL. */
export async function loadRedispatchCandidate(
  env: Env,
  failureId: number,
): Promise<FailedJobReplayCandidate | null> {
  const url = databaseUrl(env);
  if (!url) throw new Error("no source database configured");
  const sql = postgres(url, {
    ...databaseOptions,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  try {
    return await loadReplayCandidateWithSql(sql, failureId, env.APP_URL);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
