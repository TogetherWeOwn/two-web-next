// POST /api/agent-events: the scoped machine ingress (ports two-web AgentEventService, TOG-5510 Gate 2).
//
// One endpoint, five typed operations, one admitted caller. Checks run in an order that spends
// nothing before the request has earned it:
//   0. the outer route shield admits the hit — before auth, and before the body is even
//      canonicalized, so a spent bucket is 429 without touching the payload;
//   1. feature enabled, envelope parses, credential identifies a grant;
//   2. op is one of five, grant live, grant is the admitted caller on the admitted guild;
//   3. the idempotency store answers replays for free (before rate limits);
//   4. rate limits, then the operation under a Postgres advisory lock (atomic; no KV, no cache).
// Every attempt writes an audit row with a reason code and no secrets. Postgres is the only
// coordination point, so behaviour is identical across Worker isolates.
import type { Sql, TransactionSql } from "postgres";
import { sha256Hex } from "../bot/signer";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { events } from "../db/admin-schema";
import { CAPACITY_BELOW_GOING, goingCount, promoteWaitlist } from "../events/waitlist";
import { utcToWall, wallToUtc, type EventStatus } from "../admin/validation";
import type { WriteBack } from "../admin/store";
import { observeDiscordEvent, type ObservationEvent, type EventReader } from "../bot/event-read";

export type IngressEffects = {
  readEvent?: EventReader;
  writeBack?: (writeBack: NonNullable<WriteBack>) => Promise<void>;
};

export type Answer = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export type IngressConfig = {
  enabled: boolean;
  callerAgentId: string;
  stagingGuildId: string;
  productionGuildId: string;
  mutatingPerMinute: number;
  readsPerMinute: number;
  serviceMutatingPerMinute: number;
  serviceReadsPerMinute: number;
  // The outer route shield (two-web TOG-8402, config `agent-events.route_per_minute`):
  // every hit per credential per minute, counted before auth, the grant lookup
  // and the audit write. A flood guard above the inner budgets' sum, not the
  // allowance — the bot's normal burst never sees it.
  routePerMinute: number;
  lockWaitMs: number;
};

export const DEFAULT_CONFIG: IngressConfig = {
  enabled: false,
  callerAgentId: "",
  stagingGuildId: "1545644954272137297",
  productionGuildId: "326474832151838730",
  mutatingPerMinute: 10,
  readsPerMinute: 30,
  serviceMutatingPerMinute: 60,
  serviceReadsPerMinute: 300,
  routePerMinute: 60,
  lockWaitMs: 5000,
};

const OPS = ["create", "read", "update", "publish", "cancel"] as const;
type Op = (typeof OPS)[number];
type Tx = TransactionSql | Sql;
type Row = Record<string, any>;
type Grant = { id: string; agent_id: string; guild_id: string; expires_at: Date | null; disabled_at: Date | null };
// stored: the answer is persisted for replay. Denials and failures never are, so a client that
// fixes its payload under the same key is answered, not conflicted.
type Outcome = Answer & { eventKey?: string | null; stored?: boolean; writeBack?: NonNullable<WriteBack> };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()): string {
  let t = "";
  for (let n = now, i = 0; i < 10; i++, n = Math.floor(n / 32)) t = CROCKFORD[n % 32] + t;
  const r = crypto.getRandomValues(new Uint8Array(16));
  return t + [...r].map((b) => CROCKFORD[b % 32]).join("");
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Keep explicit keys safe for PostgreSQL text/varchar(26), including denied
// audits and lock names. Never truncate or repair a key into another identity.
const storedEventKey = (key: unknown): string | null =>
  typeof key === "string" && key !== "" && key.length <= 26 && !/[\u0000\uD800-\uDFFF]/u.test(key) ? key : null;

// Nesting bound for the payload digest: comfortably above every real agent
// event body (3 levels), far below stack exhaustion (~10k frames in a Worker).
export const MAX_DIGEST_DEPTH = 100;
export class PayloadTooDeepError extends Error {}

function sortRecursive(v: unknown, depth = 0): unknown {
  // Untrusted nesting is bounded: without this, an admitted deeply nested
  // body recurses until the worker throws RangeError (answered 500). Past the
  // bound the digest refuses with a typed error the caller answers 422.
  if (depth > MAX_DIGEST_DEPTH) throw new PayloadTooDeepError(`The request body nests deeper than ${MAX_DIGEST_DEPTH} levels.`);
  if (Array.isArray(v)) return v.map((e) => sortRecursive(e, depth + 1));
  if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortRecursive(v[k], depth + 1)]));
  return v;
}

// The identity of a request payload: recursive key-sorted JSON, hashed. Key order never
// distinguishes two payloads.
export const digest = (body: unknown): Promise<string> => sha256Hex(JSON.stringify(sortRecursive(body)));

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
function validWall(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = WALL.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && h < 24 && mi < 60;
}

type Fields = {
  title: string; game: string | null; description: string | null; starts_at: string; ends_at: string;
  timezone: string; location: string; capacity: number | null;
};

// Same rules as the human event form (two-web StoreEventRequest::fieldRules).
export function validateFields(raw: unknown): { ok: true; fields: Fields } | { ok: false; errors: Record<string, string[]> } {
  const e: Record<string, string[]> = {};
  const bad = (k: string, m: string) => (e[k] ??= []).push(m);
  if (!isPlainObject(raw)) return { ok: false, errors: { fields: ["An object of event `fields` is required."] } };
  const str = (k: string, max: number, required: boolean): string | null => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") {
      if (required) bad(k, `The ${k} field is required.`);
      return null;
    }
    if (typeof v !== "string") { bad(k, `The ${k} field must be a string.`); return null; }
    if ([...v].length > max) { bad(k, `The ${k} field must not be greater than ${max} characters.`); return null; }
    return v;
  };
  const title = str("title", 100, true);
  const game = str("game", 100, false);
  const description = str("description", 1000, false);
  const location = str("location", 255, true);
  const timezone = str("timezone", 64, true);
  if (timezone !== null) {
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { bad("timezone", "The timezone field must be a valid timezone."); }
  }
  const wall = (k: "starts_at" | "ends_at"): string | null => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") { bad(k, `The ${k} field is required.`); return null; }
    if (!validWall(v)) { bad(k, `The ${k} field must be a real wall time formatted YYYY-MM-DD HH:MM.`); return null; }
    return v;
  };
  const startsAt = wall("starts_at");
  const endsAt = wall("ends_at");
  if (startsAt && endsAt && endsAt <= startsAt) bad("ends_at", "The ends_at field must be a date after starts_at.");
  let capacity: number | null = null;
  if (raw.capacity !== undefined && raw.capacity !== null) {
    if (typeof raw.capacity !== "number" || !Number.isInteger(raw.capacity) || raw.capacity < 1) bad("capacity", "The capacity field must be an integer of at least 1.");
    else if (raw.capacity > 2147483647) bad("capacity", "The capacity field must not be greater than 2147483647.");
    else capacity = raw.capacity;
  }
  if (timezone && !e.timezone) {
    for (const [name, value] of [["starts_at", startsAt], ["ends_at", endsAt]] as const) {
      if (value) {
        try { wallToUtc(value, timezone); } catch { bad(name, `The ${name} field names a time that never occurred in ${timezone}.`); }
      }
    }
  }
  if (Object.keys(e).length) return { ok: false, errors: e };
  return { ok: true, fields: { title: title!, game, description, starts_at: startsAt!, ends_at: endsAt!, timezone: timezone!, location: location!, capacity } };
}

/** One 429 shape for every throttle on this ingress (two-web TOG-6788). */
export function throttleEnvelope(retryAfterSeconds: number): Answer {
  const retry = Math.max(1, retryAfterSeconds);
  return {
    status: 429,
    body: { reason: "rate_limited", message: `Too many requests. Try again in ${retry} seconds.`, retry_after: retry },
    headers: { "Retry-After": String(retry) },
  };
}

export async function handleAgentEvent(
  sql: Sql,
  cfg: IngressConfig,
  body: unknown,
  credential: string | null,
  clientIp: string | null = null,
  effects: IngressEffects = {},
): Promise<Answer> {
  const admitted = await admitAgentEvent(sql, cfg, credential, clientIp, effects);
  return "handle" in admitted ? admitted.handle(body) : admitted;
}

/** Admission binds the body handler to this hit; HTTP callers run it before buffering. */
export async function admitAgentEvent(
  sql: Sql,
  cfg: IngressConfig,
  credential: string | null,
  clientIp: string | null = null,
  effects: IngressEffects = {},
): Promise<Answer | { handle: (body: unknown) => Promise<Answer> }> {
  const requestId = ulid();

  // The outer shield (two-web TOG-8402): every hit per credential per minute,
  // counted before auth, the grant lookup and the audit write — ahead of the
  // enabled check, as the route middleware fires before the controller runs,
  // and ahead of payload canonicalization, so a spent bucket is refused
  // without ever running the recursive digest over untrusted JSON. A presented
  // credential buckets on its own hash (one guess never spends another's);
  // anonymous hits bucket per IP. Refused hits write nothing.
  const shieldKey = credential ? await sha256Hex(credential) : `ip:${clientIp ?? "unknown"}`;
  const shielded = await shield(sql, cfg, shieldKey, requestId);
  if (shielded) return shielded;
  return { handle: (body) => processAgentEvent(sql, cfg, body, credential, requestId, effects) };
}

async function processAgentEvent(sql: Sql, cfg: IngressConfig, body: unknown, credential: string | null, requestId: string, effects: IngressEffects): Promise<Answer> {
  const doc: Record<string, unknown> = isPlainObject(body) ? body : {};
  let dig: string;
  try {
    dig = await digest(isPlainObject(body) ? body : {});
  } catch (err) {
    if (err instanceof PayloadTooDeepError) {
      await audit(sql, null, "unknown", null, null, "unhashable", requestId, "denied", "payload_too_deep");
      return { status: 422, body: { reason: "payload_too_deep", message: err.message, request_id: requestId } };
    }
    throw err;
  }

  const rawOp = doc.op;
  const rawKey = doc.idempotency_key;
  const auditOp = typeof rawOp === "string" && rawOp !== "" ? rawOp.slice(0, 32) : "unknown";
  const auditKey = typeof rawKey === "string" && rawKey !== "" && rawKey.length <= 255 ? rawKey : null;
  const deny = async (grant: Grant | null, op: string, key: string | null, result: string, reason: string, status: number, message: string, eventKey: string | null = null): Promise<Answer> => {
    await audit(sql, grant, op, eventKey, key, dig, requestId, result, reason);
    return { status, body: { reason, message, request_id: requestId } };
  };

  if (!cfg.enabled) {
    return deny(null, auditOp, auditKey, "denied", "ingress_disabled", 404, "The agent event ingress is not enabled in this environment.");
  }

  const op = doc.op;
  const idem = doc.idempotency_key;
  if (typeof op !== "string" || typeof idem !== "string" || idem === "" || idem.length > 255) {
    return deny(null, auditOp, auditKey, "denied", "validation_failed", 422, "The request needs a string `op` and a non-empty string `idempotency_key` (max 255 characters).");
  }

  const grant = credential ? await findGrant(sql, credential) : null;
  if (!grant) return deny(null, op, idem, "denied", "unauthenticated", 401, "A valid machine credential is required.");

  if (!(OPS as readonly string[]).includes(op)) return deny(grant, op, idem, "denied", "forbidden_action", 403, "Unknown operation. Only create, read, update, publish and cancel are admitted.");
  if (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now()) return deny(grant, op, idem, "denied", "grant_expired", 403, "The grant has expired. Expiry rejects ingress and dispatch alike.");
  if (grant.disabled_at) return deny(grant, op, idem, "denied", "grant_disabled", 403, "The grant has been disabled by its provisioning owner.");

  // Fail closed: no admitted caller configured means every grant is denied.
  if (cfg.callerAgentId === "" || grant.agent_id !== cfg.callerAgentId) {
    return deny(grant, op, idem, "denied", "wrong_caller", 403, "This grant is not the admitted caller for the agent event ingress.");
  }
  if (cfg.stagingGuildId !== "" && grant.guild_id !== cfg.stagingGuildId) {
    const prod = cfg.productionGuildId !== "" && grant.guild_id === cfg.productionGuildId;
    return deny(grant, op, idem, "denied", prod ? "production_guild" : "wrong_audience", 403,
      prod ? "This grant is bound to the production guild, which the agent event ingress never serves." : "This grant is not bound to the admitted staging guild.");
  }
  // The guild comes from the grant, never the caller.
  if (doc.guild_id !== undefined && doc.guild_id !== null && String(doc.guild_id) !== grant.guild_id) {
    return deny(grant, op, idem, "denied", "wrong_guild", 403, "This grant is bound to one guild; the supplied guild is rejected.");
  }

  // Replays are answered from the store without spending rate budget.
  const replay = await lookupReplay(sql, grant.id, idem);
  if (!replay) {
    const limited = await rateLimit(sql, cfg, grant, op as Op);
    if (limited) {
      await audit(sql, grant, op, null, idem, dig, requestId, "denied", "rate_limited");
      return limited;
    }
  }

  let replaying = !!replay;
  let eventKeyIn = replay ? replay.event_key : storedEventKey(doc.event_key);
  try {
    const lockName = op === "create" || op === "read" ? `agent-event-grant:${grant.id}` : `agent-event:${eventKeyIn ?? `owned:${grant.id}`}`;
    const committed = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(cfg.lockWaitMs))}ms'`);
      // Replay identity spans operations and explicit/implicit event addresses.
      // Acquire its lock before the operation lock and transactional replay check.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-event-idempotency:${grant.id}:${idem}`}, 0))`;
      // Fast receipts can wait on the grant FK too; bound them after the
      // idempotency lock, without an operation lock, inner budgets or effects.
      if (replay) return replayAnswer(tx, grant, op, replay, dig, requestId, idem);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`;
      // Admission can change while the operation lock waits. Do not replay a success
      // for a grant that has since expired or been disabled.
      const refused = await checkGrant(tx, grant, op, idem, dig, requestId, eventKeyIn);
      if (refused) return refused;
      // Re-check under the locks: a concurrent call may have stored while we waited.
      const raced = await lookupReplay(tx, grant.id, idem);
      if (raced) {
        // A raced replay waited on the operation lock: revalidate admission before
        // answering (main #215), then attribute the bounded error receipt to the
        // stored event key so it never waits on the same held grant FK again.
        const refused = await checkGrant(tx, grant, op, idem, dig, requestId, eventKeyIn, true);
        if (refused) return refused;
        replaying = true;
        eventKeyIn = raced.event_key;
        return replayAnswer(tx, grant, op, raced, dig, requestId, idem);
      }

      const out = await execute(tx, grant, op as Op, doc, idem, dig, requestId, effects);
      if (out.stored) {
        // Bind encoded JSON as text so postgres.js cannot JSON-encode it again.
        // Drizzle's transparent serializers must not change the stored shape.
        await tx`INSERT INTO agent_event_idempotency_keys (grant_id, key, payload_digest, status, body, event_key)
                 VALUES (${grant.id}, ${idem}, ${dig}, ${out.status}, ${JSON.stringify(out.body)}::text::jsonb, ${out.eventKey ?? null})`;
      }
      return { status: out.status, body: out.body, writeBack: out.writeBack };
    });
    // External queue work starts only after commit. Replays (including raced replays)
    // have no dispatch intent, so a duplicate delivery never sends twice.
    if ("writeBack" in committed && committed.writeBack) await effects.writeBack?.(committed.writeBack);
    return { status: committed.status, body: committed.body };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "55P03") {
      // A replay's grant may be held/deleted: do not wait on the same FK again.
      // Bound the error receipt too; an unavailable audit table must not turn
      // a retryable failure into a hung connection or an unaudited success.
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(cfg.lockWaitMs))}ms'`);
          await audit(tx, replaying ? null : grant, op, eventKeyIn, idem, dig, requestId, "error", "operation_busy");
        });
      } catch (auditErr) {
        if ((auditErr as { code?: string }).code !== "55P03") throw auditErr;
      }
      return { status: 503, body: { reason: "operation_busy", message: "Another operation on this event is still running. Retry with the same idempotency key.", request_id: requestId } };
    }
    throw err;
  }
}

async function findGrant(sql: Tx, credential: string): Promise<Grant | null> {
  const [row] = await sql<Grant[]>`SELECT id, agent_id, guild_id, expires_at, disabled_at FROM agent_event_grants WHERE verifier_hash = ${await sha256Hex(credential)}`;
  return row ?? null;
}

// The final admission lock follows the operation/event locks, never precedes an
// event-row wait. It holds off provisioning updates until effects commit. Time is
// sampled after all waits, not with transaction-start now(); epoch milliseconds
// match initial Date admission without depending on the client's timestamp decoder.
async function checkGrant(tx: Tx, grant: Grant, op: string, key: string, dig: string, requestId: string, eventKey: string | null, lock = false): Promise<Answer | null> {
  if (lock) await tx`SELECT id FROM agent_event_grants WHERE id = ${grant.id} FOR SHARE`;
  const [current] = await tx`SELECT floor(extract(epoch FROM expires_at) * 1000)::double precision AS expires_at_ms,
                            disabled_at IS NOT NULL AS disabled FROM agent_event_grants WHERE id = ${grant.id}`;
  const expired = current?.expires_at_ms != null && current.expires_at_ms <= Date.now();
  if (current && !expired && !current.disabled) return null;
  const reason = expired ? "grant_expired" : "grant_disabled";
  await audit(tx, current ? grant : null, op, eventKey, key, dig, requestId, "denied", reason);
  return { status: 403, body: { reason, message: expired
    ? "The grant has expired. Expiry rejects ingress and dispatch alike."
    : "The grant has been disabled by its provisioning owner.", request_id: requestId } };
}

async function lookupReplay(sql: Tx, grantId: string, key: string): Promise<Row | null> {
  const [row] = await sql`SELECT payload_digest, status, body, event_key FROM agent_event_idempotency_keys WHERE grant_id = ${grantId} AND key = ${key}`;
  return row ?? null;
}

async function replayAnswer(sql: Tx, grant: Grant, op: string, replay: Row, dig: string, requestId: string, key: string): Promise<Answer> {
  if (!timingSafeEqualHex(replay.payload_digest, dig)) {
    await audit(sql, grant, op, replay.event_key, key, dig, requestId, "conflict", "idempotency_conflict");
    return { status: 409, body: { reason: "idempotency_conflict", message: "This idempotency key was already used with a different payload. A key identifies one operation.", request_id: requestId } };
  }
  // A delivery receipt, not another successful operation: keep stored evidence
  // untouched and distinguish replays from the original mutation/read.
  // Earlier standalone clients double-encoded the body; retain their replay
  // evidence without rewriting it or losing the original response fields.
  await audit(sql, grant, op, replay.event_key, key, dig, requestId, "replayed", null);
  const body = typeof replay.body === "string" ? JSON.parse(replay.body) : replay.body;
  return { status: replay.status, body: { ...(body as Record<string, unknown>), replayed: true, request_id: requestId } };
}

// The outer shield's counter (two-web TOG-8402): one bucket per credential
// hash (or anonymous IP), counted before auth. Returns the 429 envelope when
// the budget is spent — audited by nobody, since the hit never reached auth —
// and records the hit otherwise.
//
// Two properties the exact-head review pinned down:
// - The advisory lock waits at most lockWaitMs (SET LOCAL lock_timeout, as in
//   the operation transaction). Contention is a 503 operation_busy audited as
//   an error — a retryable answer, never a hung connection.
// - Stale counters are pruned here, on every shield pass, capped per pass so a
//   long-idle table cannot stall admission. The candidate select is SKIP LOCKED
//   so expired rows held by unrelated transactions are left for a later pass
//   instead of turning a fresh credential's admission into a 503. Denied-only
//   and replay-only periods still run this transaction, so expiry no longer
//   depends on a successful authenticated operation reaching the inner rate
//   limiter.
async function shield(sql: Sql, cfg: IngressConfig, shieldKey: string, requestId: string): Promise<Answer | null> {
  const bucket = `shield:${shieldKey}`;
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(cfg.lockWaitMs))}ms'`);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`}, 0))`;
      await tx`WITH candidates AS (SELECT id FROM agent_event_hits WHERE at < now() - interval '5 minutes' ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM agent_event_hits USING candidates WHERE agent_event_hits.id = candidates.id`;
      const [r] = await tx`SELECT count(*)::int AS n, coalesce(ceil(extract(epoch FROM (min(at) + interval '60 seconds' - now()))), 1)::int AS wait
                           FROM agent_event_hits WHERE bucket = ${bucket} AND at > now() - interval '60 seconds'`;
      if (r!.n >= cfg.routePerMinute) return throttleEnvelope(Math.max(1, r!.wait));
      await tx`INSERT INTO agent_event_hits (bucket) VALUES (${bucket})`;
      return null;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "55P03") {
      // Contention, not a decision. Audited as an error so a run of these reads as load.
      await audit(sql, null, "unknown", null, null, null, requestId, "error", "operation_busy");
      return { status: 503, body: { reason: "operation_busy", message: "The ingress is busy admitting requests. Retry with the same idempotency key.", request_id: requestId } };
    }
    throw err;
  }
}

async function rateLimit(sql: Sql, cfg: IngressConfig, grant: Grant, op: Op): Promise<Answer | null> {
  const read = op === "read";
  const buckets: [string, number][] = [
    [`${read ? "read" : "mutating"}:${grant.id}`, read ? cfg.readsPerMinute : cfg.mutatingPerMinute],
    [read ? "service-read" : "service-mutating", read ? cfg.serviceReadsPerMinute : cfg.serviceMutatingPerMinute],
  ];
  return sql.begin(async (tx) => {
    let retry = 0;
    for (const [bucket] of [...buckets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`}, 0))`;
    }
    for (const [bucket, max] of buckets) {
      const [r] = await tx`SELECT count(*)::int AS n, coalesce(ceil(extract(epoch FROM (min(at) + interval '60 seconds' - now()))), 1)::int AS wait
                           FROM agent_event_hits WHERE bucket = ${bucket} AND at > now() - interval '60 seconds'`;
      if (r!.n >= max) retry = Math.max(retry, Math.max(1, r!.wait));
    }
    if (retry > 0) return throttleEnvelope(retry);
    for (const [bucket] of buckets) await tx`INSERT INTO agent_event_hits (bucket) VALUES (${bucket})`;
    await tx`DELETE FROM agent_event_hits WHERE at < now() - interval '5 minutes'`;
    return null;
  });
}

async function audit(sql: Tx, grant: Grant | null, operation: string, eventKey: string | null, key: string | null, dig: string | null, requestId: string, result: string, reason: string | null): Promise<void> {
  await sql`INSERT INTO agent_event_audits (grant_id, operation, event_key, idempotency_key, payload_digest, request_id, result, reason_code)
            VALUES (${grant?.id ?? null}, ${operation.slice(0, 32)}, ${storedEventKey(eventKey)}, ${key}, ${dig}, ${requestId}, ${result}, ${reason})`;
}

const rid = (requestId: string) => ({ request_id: requestId });

async function execute(tx: Tx, grant: Grant, op: Op, doc: Record<string, unknown>, key: string, dig: string, requestId: string, effects: IngressEffects): Promise<Outcome> {
  const denyOutcome = async (status: number, reason: string, message: string, extra: Record<string, unknown> = {}, eventKey: string | null = null): Promise<Outcome> => {
    await audit(tx, grant, op, eventKey, key, dig, requestId, "denied", reason);
    return { status, body: { reason, message, ...extra, ...rid(requestId) } };
  };
  const done = async (status: number, body: Record<string, unknown>, eventKey: string, writeBack?: NonNullable<WriteBack>): Promise<Outcome> => {
    await audit(tx, grant, op, eventKey, key, dig, requestId, "ok", null);
    return { status, body: { ...body, ...rid(requestId) }, eventKey, stored: true, writeBack };
  };

  if (op === "create") {
    // The final admission lock follows the operation/event locks, never precedes
    // an event-row wait (main #215). Only the table name changed here: the
    // shared `events` rows carry the agent ownership columns, not the retired
    // standalone table.
    const refusedCreate = await checkGrant(tx, grant, op, key, dig, requestId, null, true);
    if (refusedCreate) return refusedCreate;
    const [existing] = await tx`SELECT event_key FROM events WHERE agent_grant_id = ${grant.id}`;
    if (existing) return denyOutcome(409, "quota_exceeded", "This grant already owns its one proof event. Updates reuse it.", { event_key: existing.event_key });
    const v = validateFields(doc.fields);
    if (!v.ok) return denyOutcome(422, "validation_failed", "The event fields did not validate.", { errors: v.errors });
    const f = v.fields;
    const eventKey = ulid();
    const marker = `agent-proof-${ulid()}`;
    await tx`INSERT INTO events (event_key, agent_grant_id, proof_marker, title, game, description, starts_at, ends_at, timezone, location, capacity)
             VALUES (${eventKey}, ${grant.id}, ${marker}, ${f.title}, ${f.game}, ${f.description}, ${wallToUtc(f.starts_at, f.timezone).toISOString()}, ${wallToUtc(f.ends_at, f.timezone).toISOString()}, ${f.timezone}, ${f.location}, ${f.capacity})`;
    return done(201, { event_key: eventKey, status: "draft", agent_version: 1, proof_marker: marker }, eventKey);
  }

  const keyIn = doc.event_key;
  const event = await ownedEvent(tx, grant, keyIn);
  const refused = await checkGrant(tx, grant, op, key, dig, requestId, typeof event === "string" ? storedEventKey(keyIn) : event.event_key, true);
  if (refused) return refused;
  if (typeof event === "string") {
    return denyOutcome(event === "foreign_event" ? 403 : 404, event, event === "foreign_event" ? "That event is not owned by this grant." : "This grant owns no such event.", {}, typeof keyIn === "string" ? keyIn : null);
  }
  const ek = event.event_key as string;

  if (op === "read") {
    const [{ n }] = await tx`SELECT count(*)::int AS n FROM events WHERE agent_grant_id = ${grant.id}` as [{ n: number }];
    // The bounded window (two-web AgentEventReceiptWindowTest): the latest 50,
    // oldest first. Newest-first then reversed — LIMIT applies before the flip.
    const newest = await tx`SELECT operation, result, reason_code, request_id, created_at FROM agent_event_audits WHERE grant_id = ${grant.id} AND event_key = ${ek} ORDER BY id DESC LIMIT 50`;
    const receipts = [...newest].reverse();
    return done(200, {
      event: proofFields(event),
      local: { status: event.status, synced_to_discord: event.discord_event_id !== null },
      discord: await observeDiscordEvent(event as ObservationEvent, effects.readEvent),
      owned_event_count: n,
      proof_marker_matches: 1,
      receipts: receipts.map((r) => ({ operation: r.operation, result: r.result, reason_code: r.reason_code, request_id: r.request_id, at: new Date(r.created_at).toISOString() })),
    }, ek);
  }

  if (op === "update") {
    if (!Number.isInteger(doc.version)) return denyOutcome(422, "validation_failed", "An update needs the integer `version` last seen on a read.", {}, ek);
    if (event.status === "cancelled") return denyOutcome(409, "event_not_open", "That event is not open for this move.", {}, ek);
    const v = validateFields(doc.fields);
    if (!v.ok) return denyOutcome(422, "validation_failed", "The event fields did not validate.", { errors: v.errors }, ek);
    const f = v.fields;
    // Reuse the shared seat rules on this already-open raw transaction; a
    // postgres TransactionSql has no client options for postgres-js drizzle().
    const orm = drizzle(async (query, params) => ({ rows: await tx.unsafe(query, params as never).values() }));
    if (f.capacity !== null && f.capacity < await goingCount(orm, event.id)) {
      return denyOutcome(422, "validation_failed", "The event fields did not validate.", { errors: { capacity: [CAPACITY_BELOW_GOING] } }, ek);
    }
    const startsAt = updatedInstant(f.starts_at, f.timezone, event.starts_at, event.timezone);
    const endsAt = updatedInstant(f.ends_at, f.timezone, event.ends_at, event.timezone);
    if (endsAt <= startsAt) {
      return denyOutcome(422, "validation_failed", "The event fields did not validate.", { errors: { ends_at: ["The ends_at field must be a date after starts_at."] } }, ek);
    }
    const [u] = await tx`UPDATE events SET title=${f.title}, game=${f.game}, description=${f.description}, starts_at=${startsAt.toISOString()}, ends_at=${endsAt.toISOString()},
                         timezone=${f.timezone}, location=${f.location}, capacity=${f.capacity}, agent_version = agent_version + 1, updated_at = now()
                         WHERE event_key = ${ek} AND agent_version = ${doc.version as number} RETURNING status, agent_version`;
    if (!u) return denyOutcome(409, "stale_version", "The event changed since that version. Re-read and retry.", { agent_version: event.agent_version }, ek);
    const [updated] = await orm.select().from(events).where(eq(events.id, event.id));
    await promoteWaitlist(orm, updated!);
    return done(200, { event_key: ek, status: u.status, agent_version: u.agent_version }, ek, writeBackFor(ek, u.status));
  }

  // publish / cancel: cancelled stays terminal.
  const ok = op === "publish" ? event.status === "draft" : event.status !== "cancelled";
  if (!ok) return denyOutcome(409, "event_not_open", "That event is not in a position to make this move.", {}, ek);
  const next = op === "publish" ? "published" : "cancelled";
  await tx`UPDATE events SET status = ${next}, updated_at = now() WHERE event_key = ${ek}`;
  return done(200, { event_key: ek, status: next }, ek, writeBackFor(ek, next));
}

// An explicit event_key addresses that event; omitted, the grant's single owned event answers.
// Unknown key is 404; known-but-not-mine is 403. Row-locked so the answer is the latest state.
async function ownedEvent(tx: Tx, grant: Grant, key: unknown): Promise<Row | "event_not_found" | "foreign_event"> {
  if (key === undefined || key === null) {
    const [owned] = await tx`SELECT * FROM events WHERE agent_grant_id = ${grant.id} FOR UPDATE`;
    return owned ?? "event_not_found";
  }
  const keyIn = storedEventKey(key);
  if (keyIn === null) return "event_not_found";
  const [event] = await tx`SELECT * FROM events WHERE event_key = ${keyIn} FOR UPDATE`;
  if (!event) return "event_not_found";
  return event.agent_grant_id === grant.id ? event : "foreign_event";
}

// Only proof-owned fields cross this boundary.
const proofFields = (e: Row) => ({
  event_key: e.event_key, title: e.title, game: e.game, description: e.description, starts_at: utcToWall(new Date(e.starts_at), e.timezone), ends_at: utcToWall(new Date(e.ends_at), e.timezone),
  timezone: e.timezone, location: e.location, capacity: e.capacity, status: e.status, agent_version: e.agent_version,
  proof_marker: e.proof_marker, discord_event_id: e.discord_event_id,
});

// Read speaks minute-precision wall text, not an offset. An unchanged endpoint
// and zone must keep the exact instant, including a migrated second fold.
function updatedInstant(wall: string, timezone: string, stored: Date | string, storedTimezone: string): Date {
  const previous = new Date(stored);
  return timezone === storedTimezone && wall === utcToWall(previous, timezone) ? previous : wallToUtc(wall, timezone);
}

function writeBackFor(eventKey: string, status: EventStatus): NonNullable<WriteBack> | undefined {
  return status === "published" || status === "cancelled" ? { eventKey, status } : undefined;
}
