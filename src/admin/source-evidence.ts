import type { Context } from "hono";
import postgres from "postgres";
import { databaseOptions, databaseUrl } from "../db/connection";
import type { Env } from "../env";
import type { SourceReadReport, SourceReadStatement } from "../jobs/events";
import { loadReplayCandidateWithSql, parseFailureId } from "../jobs/preview";
import { STAGING_APP_URL } from "../qa";
import type { QueuePreviewVars } from "./queue-preview";

/**
 * Evidence-only source/cache verifier. Protected, default-off, staging-only.
 *
 * Unlike the operational preview next to it, this route is session-free by
 * construction: no cookie is read, no session is looked up, no OAuth redirect
 * is ever issued, and it never calls the preview-success handler, so the
 * operational audit-table write is unreachable from here. Authentication is a one-time bearer
 * token plus the authorized incident ID and expiry instant, all runtime-only
 * settings (never checked-in config; merging leaves this route inert).
 * Provisioning and teardown of those settings belong to the separately
 * authorized execution workflow, not to this slice.
 *
 * Execution is exactly one attempt: one guarded snapshot, no loop, no retry.
 * Single-invocation discipline is executor-side and attested in the
 * control-plane receipt. Output is technical identity/freshness evidence only.
 */

export const SOURCE_EVIDENCE_STATEMENT_TIMEOUT_MS = 10_000;
const MAX_AUTHORIZATION_WINDOW_MS = 3_600_000;
const MARKER_SKEW_MS = 60_000;
const CLOCK_SKEW_MS = 60_000;
const MIN_TOKEN_LENGTH = 32;

/** Canonical fixed source SELECTs. Comparison/hash material only: these
 * strings are never executed. Execution uses `loadReplayCandidateWithSql`;
 * `test/source-evidence-statements.test.ts` asserts each entry is present
 * verbatim (whitespace-insensitive) in the module that executes it, so any
 * SQL edit fails the test and forces a reviewed hash update. */
const CANONICAL_STATEMENTS: ReadonlyArray<{ statement: SourceReadStatement; text: string }> = [
  {
    statement: "queue_failed_jobs_by_id",
    text: `select id, left(kind, 64) as kind, left(key, 128) as key,
      failed_at, transaction_timestamp() as observed_at, clock_timestamp() as preview_read_at
      from queue_failed_jobs where id = \${failureId} limit 1`,
  },
  {
    statement: "events_by_key_exists",
    text: `select 1, clock_timestamp() as preview_read_at from events
        where event_key = \${eventKey} limit 1`,
  },
  {
    statement: "stale_keys",
    text: `select event_key\${readMarker()} from events
      where (\${eventKey}::text is null or event_key = \${eventKey}) and (
        exists (select 1 from event_sync_attempts pending
          where pending.event_id = events.id and pending.state = 'pending'
            and pending.request_attempts > 0 and pending.request_attempts < \${SYNC_EVENT.tries}
            and pending.next_attempt_at is not null)
        or (status in ('published', 'cancelled')
          and not exists (select 1 from event_sync_attempts rejected
            where rejected.event_id = events.id and rejected.revision = events.sync_revision and rejected.state = 'failed')
          and (sync_revision > synced_revision or
            (status = 'published' and (discord_event_id is null or exists (
              select 1 from rsvps where rsvps.event_id = events.id and synced_to_discord_at is null
            ))))))`,
  },
  {
    statement: "failed_sync",
    text: `select 1\${readMarker()} from event_sync_attempts rejected
        join events e on e.id = rejected.event_id
        where e.event_key = \${eventKey}
          and rejected.revision = e.sync_revision
          and rejected.state = 'failed' limit 1`,
  },
  {
    statement: "pending_sync",
    text: `select a.*\${readMarker()} from event_sync_attempts a join events e on e.id = a.event_id
        where e.event_key = \${eventKey} and a.state = 'pending'`,
  },
];

export function normalizeStatementText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function statementSetHash(): Promise<string> {
  const joined = CANONICAL_STATEMENTS.map((entry) => normalizeStatementText(entry.text)).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Pinned by `test/source-evidence-statements.test.ts`; recompute there. */
export const STATEMENT_SET_HASH =
  "sha256:d9463d2564c15bd7acb498f80be70bad3031a0115f5fde9d5dce3540628eb001";

export function canonicalStatementTexts(): ReadonlyArray<{
  statement: SourceReadStatement;
  text: string;
}> {
  return CANONICAL_STATEMENTS;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function markerTimeMs(readAt: unknown): number | null {
  const ms = readAt instanceof Date ? readAt.getTime() : Date.parse(String(readAt ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

export type EvidenceSelect = {
  index: number;
  statement: SourceReadStatement;
  rowCount: number;
  readAt: string | null;
};

/**
 * Validate the collected per-SELECT evidence. Throws (→ 503, ends the
 * attempt) on unknown statements, a missing failed-row read, or a missing or
 * stale `clock_timestamp()` marker on any SELECT that returned rows. Empty
 * SELECTs are recorded with a null marker: the live round trip executed them,
 * but there is no row to carry a freshness value.
 */
export function buildEvidenceSelects(
  reports: SourceReadReport[],
  rowFound: boolean,
  startedAtMs: number,
  nowMs: number,
): EvidenceSelect[] {
  const known = new Set(CANONICAL_STATEMENTS.map((entry) => entry.statement));
  for (const report of reports) {
    if (!known.has(report.statement)) throw new Error("unknown source statement");
  }
  const first = reports[0];
  if (!first || first.statement !== "queue_failed_jobs_by_id") {
    throw new Error("missing failed-row source read");
  }
  if (rowFound) {
    const marker = markerTimeMs(first.readAt);
    if (
      marker === null ||
      marker < startedAtMs - MARKER_SKEW_MS ||
      marker > nowMs + MARKER_SKEW_MS
    ) {
      throw new Error("missing failed-row freshness evidence");
    }
  }
  return reports.map((report, index) => {
    const marker = markerTimeMs(report.readAt);
    if (report.rowCount > 0) {
      if (
        marker === null ||
        marker < startedAtMs - MARKER_SKEW_MS ||
        marker > nowMs + MARKER_SKEW_MS
      ) {
        throw new Error(`missing freshness evidence for ${report.statement}`);
      }
      return {
        index,
        statement: report.statement,
        rowCount: report.rowCount,
        readAt: new Date(marker).toISOString(),
      };
    }
    return { index, statement: report.statement, rowCount: report.rowCount, readAt: null };
  });
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

/** Write verbs on the evidence path refuse before any middleware or source read. */
export function sourceEvidenceMethodRefused(c: Context<QueuePreviewVars>) {
  c.header("cache-control", "private, no-store");
  c.header("allow", "GET");
  return c.json({ error: "method_not_allowed" }, 405);
}

export async function sourceEvidenceHandler(c: Context<QueuePreviewVars>) {
  c.header("cache-control", "private, no-store");
  const env = c.env;
  if (
    env.SOURCE_EVIDENCE_VERIFIER_ENABLED !== "true" ||
    env.APP_URL !== STAGING_APP_URL ||
    new URL(c.req.url).origin !== STAGING_APP_URL
  ) {
    return c.json({ error: "evidence_disabled" }, 404);
  }
  // Only GET reaches this handler: sibling write verbs are refused by
  // `sourceEvidenceMethodRefused`, registered on the same path before every
  // admin middleware, so the method contract never depends on sibling flags.
  const id = parseFailureId(c.req.param("id") ?? "");
  // No query overrides are admitted.
  if (id === null || new URL(c.req.url).search !== "") {
    return c.json({ error: "invalid_failure_id" }, 422);
  }
  const expectedToken = env.SOURCE_EVIDENCE_VERIFIER_TOKEN ?? "";
  const authorizedId = parseFailureId(env.SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID ?? "");
  // The authorization lifetime is bounded, not just its expiry: issued and
  // expiry instants pin a window of at most one hour containing now.
  const issuedAt = Number(env.SOURCE_EVIDENCE_VERIFIER_ISSUED_AT ?? "");
  const expiresAt = Number(env.SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT ?? "");
  const now = Date.now();
  if (
    expectedToken.length < MIN_TOKEN_LENGTH ||
    !timingSafeEqual(bearerToken(c.req.raw), expectedToken) ||
    authorizedId === null ||
    authorizedId !== id ||
    !Number.isFinite(issuedAt) ||
    issuedAt > now + CLOCK_SKEW_MS ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_AUTHORIZATION_WINDOW_MS
  ) {
    return c.json({ error: "evidence_forbidden" }, 403);
  }
  const url = databaseUrl(env);
  if (!url) return c.json({ error: "evidence_unavailable" }, 503);
  const sql = postgres(url, {
    ...databaseOptions,
    connect_timeout: 2,
    connection: { statement_timeout: SOURCE_EVIDENCE_STATEMENT_TIMEOUT_MS },
  });
  const startedAt = Date.now();
  try {
    // Exactly one guarded snapshot. No loop, no retry: any throw below fails
    // the attempt and the teardown removes the capability.
    const reports: SourceReadReport[] = [];
    const candidate = await loadReplayCandidateWithSql(sql, id, env.APP_URL, {
      onSourceRead: (report) => {
        reports.push(report);
      },
    });
    if (!candidate) return c.json({ error: "failure_not_found" }, 404);
    const selects = buildEvidenceSelects(reports, true, startedAt, Date.now());
    return c.json({
      evidenceOnly: true,
      statementSetHash: STATEMENT_SET_HASH,
      incidentId: id,
      binding: {
        kind: env.DATABASE_URL ? "explicit-url" : "hyperdrive",
        databaseUrlOverride: Boolean(env.DATABASE_URL),
      },
      selects,
      observedAt: candidate.preview.observedAt,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  } catch {
    return c.json({ error: "evidence_unavailable" }, 503);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
