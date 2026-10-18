import type { Sql } from "postgres";
import { sha256Hex } from "../bot/signer";
import { retireAnonEventCaches } from "../events/anon-cache";
import { retireHomeGuestCache } from "../home-cache";
import type { Answer, Grant, IngressConfig, IngressEffects, Op } from "./types";
import { OPS } from "./types";
import {
  digest,
  hasIngressControlBytes,
  isPlainObject,
  PayloadTooDeepError,
  storedEventKey,
  ulid,
} from "./payload";
import { audit } from "./audit";
import { normalizeClientIp } from "../throttle";
import { checkGrant, findGrant } from "./grants";
import { shield } from "./shield";
import { lookupReplay, replayAnswer } from "./idempotency";
import { rateLimit } from "./rate-limit";
import { execute } from "./dispatch";

// The longest captured Bearer credential the ingress will hash, look up or
// count. Anything longer dies here as unauthenticated before the shield hash,
// the hit insert and the grant lookup — and it is never demoted to the
// anonymous bucket, so a rotation flood mints no buckets and spends no
// budget. The refusal carries the existing 401 envelope and nothing of the
// credential, exactly as an unknown short credential is answered.
export const MAX_BEARER_CREDENTIAL_LENGTH = 512;

// Pre-auth refusals insert zero audit rows. A sampled, constant-shape warn
// keeps flood signal without recording attacker-controlled data: no
// credential, body, operation, key or anything else the caller chose (the
// request id is generated server-side). Deliberately probabilistic, not a
// token bucket: a flood of distinct unknown credentials must not be able to
// spend a shared budget to blind the sink.
const PRE_AUTH_REFUSAL_WARN_RATE = 0.01;
function warnPreAuthRefusal(requestId: string): void {
  if (Math.random() >= PRE_AUTH_REFUSAL_WARN_RATE) return;
  console.warn("agent-events.ingress.pre_auth_refusal", { request_id: requestId });
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

/** Admission binds the body handler to this hit; HTTP callers run the byte cap first, so admission sees only bounded, buffered bodies. */
export async function admitAgentEvent(
  sql: Sql,
  cfg: IngressConfig,
  credential: string | null,
  clientIp: string | null = null,
  effects: IngressEffects = {},
): Promise<Answer | { handle: (body: unknown) => Promise<Answer> }> {
  const requestId = ulid();

  // Overlong credentials never reach the hash: no shield bucket, no hit row,
  // no verifier lookup, no payload digest and no audit write — the same
  // envelope an unknown credential receives, so a granted overlong bearer is
  // indistinguishable from an unknown short one.
  if (credential !== null && credential.length > MAX_BEARER_CREDENTIAL_LENGTH) {
    warnPreAuthRefusal(requestId);
    return {
      status: 401,
      body: {
        reason: "unauthenticated",
        message: "A valid machine credential is required.",
        request_id: requestId,
      },
    };
  }

  // The outer shield (two-web TOG-8402): every hit per credential per minute,
  // counted before auth, the grant lookup and the audit write — ahead of the
  // enabled check, as the route middleware fires before the controller runs,
  // and ahead of payload canonicalization, so a spent bucket is refused
  // without ever running the recursive digest over untrusted JSON. A presented
  // credential buckets on its own hash (one guess never spends another's);
  // anonymous hits bucket per normalized IP, like human throttles (IPv6 /64,
  // mapped-IPv4, malformed verbatim). A refused hit writes no hit row and at
  // most a sampled denied/rate_limited audit row with this admission's
  // request_id, with every refusal counted in memory (see shield.ts for the
  // bucket-class encoding and the sampling bound).
  const shieldKey = credential
    ? await sha256Hex(credential)
    : `ip:${normalizeClientIp(clientIp ?? "unknown")}`;
  const shielded = await shield(
    sql,
    cfg,
    shieldKey,
    requestId,
    credential ? { kind: "credential", hash: shieldKey } : { kind: "anonymous" },
  );
  if (shielded) return shielded;
  return { handle: (body) => processAgentEvent(sql, cfg, body, credential, requestId, effects) };
}

async function processAgentEvent(
  sql: Sql,
  cfg: IngressConfig,
  body: unknown,
  credential: string | null,
  requestId: string,
  effects: IngressEffects,
): Promise<Answer> {
  const doc: Record<string, unknown> = isPlainObject(body) ? body : {};

  // Grant before digest: the presented credential is resolved before the
  // recursive payload digest runs. A missing or unknown
  // grant is refused with the existing 401 envelope without traversing or
  // hashing the body — only the top-level envelope fields above are read,
  // so the nested payload stays untouched — and without an audit row. The
  // control-byte refusal stays ahead of auth here too, so a grantless
  // hostile envelope keeps its existing 422 before any store touch.
  // Admitted-then-grantless 401s stay at zero rows deliberately: the
  // grantless-deep pins demand exact zero, and depth is unknowable without
  // traversing the payload (forbidden pre-auth), so any per-hit 401 sampling
  // would flake those pins — zero satisfies the bounded pins' lower bound.
  // Throttling repudiation is the sampled outer-shield rows plus counters.
  const grant = credential ? await findGrant(sql, credential) : null;
  if (!grant) {
    warnPreAuthRefusal(requestId);
    if (hasIngressControlBytes(doc.op) || hasIngressControlBytes(doc.idempotency_key)) {
      return {
        status: 422,
        body: {
          reason: "validation_failed",
          message: "The `op` and `idempotency_key` fields must not contain control characters.",
          request_id: requestId,
        },
      };
    }
    return {
      status: 401,
      body: {
        reason: "unauthenticated",
        message: "A valid machine credential is required.",
        request_id: requestId,
      },
    };
  }

  // Granted only from here: the digest may traverse the payload, and an
  // over-deep body keeps its 422 — now attributed to the resolved grant.
  let dig: string;
  try {
    dig = await digest(isPlainObject(body) ? body : {});
  } catch (err) {
    if (err instanceof PayloadTooDeepError) {
      await audit(
        sql,
        grant,
        "unknown",
        null,
        null,
        "unhashable",
        requestId,
        "denied",
        "payload_too_deep",
      );
      return {
        status: 422,
        body: { reason: "payload_too_deep", message: err.message, request_id: requestId },
      };
    }
    throw err;
  }

  const rawOp = doc.op;
  const rawKey = doc.idempotency_key;
  // Sanitised fallbacks: the two denials below run before the control guard,
  // so a hostile value on the other half of an invalid envelope (a NUL key
  // next to a non-string op, a NUL op next to an over-length key, or either
  // under a disabled ingress) must never reach the audit INSERT raw, where
  // PostgreSQL `text` would reject NUL (22021) and turn the denial into a 500.
  const auditOp =
    typeof rawOp === "string" && rawOp !== "" && !hasIngressControlBytes(rawOp)
      ? rawOp.slice(0, 32)
      : "unknown";
  const auditKey =
    typeof rawKey === "string" &&
    rawKey !== "" &&
    rawKey.length <= 255 &&
    !hasIngressControlBytes(rawKey)
      ? rawKey
      : null;
  const deny = async (
    grant: Grant | null,
    op: string,
    key: string | null,
    result: string,
    reason: string,
    status: number,
    message: string,
    eventKey: string | null = null,
  ): Promise<Answer> => {
    await audit(sql, grant, op, eventKey, key, dig, requestId, result, reason);
    return { status, body: { reason, message, request_id: requestId } };
  };

  if (!cfg.enabled) {
    return deny(
      null,
      auditOp,
      auditKey,
      "denied",
      "ingress_disabled",
      404,
      "The agent event ingress is not enabled in this environment.",
    );
  }

  const op = doc.op;
  const idem = doc.idempotency_key;
  if (typeof op !== "string" || typeof idem !== "string" || idem === "" || idem.length > 255) {
    return deny(
      null,
      auditOp,
      auditKey,
      "denied",
      "validation_failed",
      422,
      "The request needs a string `op` and a non-empty string `idempotency_key` (max 255 characters).",
    );
  }

  // Control bytes in the machine envelope never reach the store: PostgreSQL
  // `text` rejects NUL (22021), so auditing the raw value would turn this
  // denial into a 500. Refused before auth, grant, replay, rate-limit and
  // audit — no audit row, no replay write, no hostile byte in any INSERT.
  if (hasIngressControlBytes(op) || hasIngressControlBytes(idem)) {
    return {
      status: 422,
      body: {
        reason: "validation_failed",
        message: "The `op` and `idempotency_key` fields must not contain control characters.",
        request_id: requestId,
      },
    };
  }

  // The grant is resolved above, before the digest: every caller reaching
  // this point is authenticated, so the admission checks below keep their
  // existing grant-attributed audits.
  if (!(OPS as readonly string[]).includes(op))
    return deny(
      grant,
      op,
      idem,
      "denied",
      "forbidden_action",
      403,
      "Unknown operation. Only create, read, update, publish and cancel are admitted.",
    );
  if (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now())
    return deny(
      grant,
      op,
      idem,
      "denied",
      "grant_expired",
      403,
      "The grant has expired. Expiry rejects ingress and dispatch alike.",
    );
  if (grant.disabled_at)
    return deny(
      grant,
      op,
      idem,
      "denied",
      "grant_disabled",
      403,
      "The grant has been disabled by its provisioning owner.",
    );

  // Fail closed: no admitted caller configured means every grant is denied.
  if (cfg.callerAgentId === "" || grant.agent_id !== cfg.callerAgentId) {
    return deny(
      grant,
      op,
      idem,
      "denied",
      "wrong_caller",
      403,
      "This grant is not the admitted caller for the agent event ingress.",
    );
  }
  if (cfg.stagingGuildId !== "" && grant.guild_id !== cfg.stagingGuildId) {
    const prod = cfg.productionGuildId !== "" && grant.guild_id === cfg.productionGuildId;
    return deny(
      grant,
      op,
      idem,
      "denied",
      prod ? "production_guild" : "wrong_audience",
      403,
      prod
        ? "This grant is bound to the production guild, which the agent event ingress never serves."
        : "This grant is not bound to the admitted staging guild.",
    );
  }
  // The guild comes from the grant, never the caller. A supplied guild_id is
  // admitted only when it is a string exactly equal to the grant guild: no
  // String() coercion, so arrays, objects (including JSON null-conversion
  // properties), booleans, numbers and boxed Strings refuse as wrong_guild
  // instead of creating or throwing their way to a 500.
  if (
    doc.guild_id !== undefined &&
    doc.guild_id !== null &&
    (typeof doc.guild_id !== "string" || doc.guild_id !== grant.guild_id)
  ) {
    return deny(
      grant,
      op,
      idem,
      "denied",
      "wrong_guild",
      403,
      "This grant is bound to one guild; the supplied guild is rejected.",
    );
  }

  // Replays are answered from the store without spending rate budget.
  const replay = await lookupReplay(sql, grant.id, idem);
  if (!replay) {
    const limited = await rateLimit(sql, cfg, grant, op as Op, requestId);
    if (limited) {
      if (limited.status === 503 && limited.body.reason === "operation_busy") {
        // Inner-budget lock contention: retryable load refusal, never a rate
        // denial. Audited once as error/operation_busy with the response
        // request_id; the aborted verdict inserted no budget hits.
        await audit(sql, grant, op, null, idem, dig, requestId, "error", "operation_busy");
        return {
          status: limited.status,
          body: { ...limited.body, request_id: requestId },
          ...(limited.headers ? { headers: limited.headers } : {}),
        };
      }
      await audit(sql, grant, op, null, idem, dig, requestId, "denied", "rate_limited");
      return limited;
    }
  }

  let replaying = !!replay;
  let eventKeyIn = replay ? replay.event_key : storedEventKey(doc.event_key);
  try {
    const lockName =
      op === "create" || op === "read"
        ? `agent-event-grant:${grant.id}`
        : `agent-event:${eventKeyIn ?? `owned:${grant.id}`}`;
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
    if ("writeBack" in committed && committed.writeBack)
      await effects.writeBack?.(committed.writeBack);
    // A committed agent create/update/publish/cancel changed guest-visible
    // state, so it retires the anonymous card entries like the moderator
    // store paths (N6). Reads, refusals and rollbacks never reach a 200/201
    // here; a replayed success only drops entries that rebuild on next fetch.
    if (
      (op === "create" || op === "update" || op === "publish" || op === "cancel") &&
      (committed.status === 200 || committed.status === 201)
    ) {
      retireAnonEventCaches();
      await retireHomeGuestCache();
    }
    return { status: committed.status, body: committed.body };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "55P03") {
      // A replay's grant may be held/deleted: do not wait on the same FK again.
      // Bound the error receipt too; an unavailable audit table must not turn
      // a retryable failure into a hung connection or an unaudited success.
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(
            `SET LOCAL lock_timeout = '${Math.max(1, Math.floor(cfg.lockWaitMs))}ms'`,
          );
          await audit(
            tx,
            replaying ? null : grant,
            op,
            eventKeyIn,
            idem,
            dig,
            requestId,
            "error",
            "operation_busy",
          );
        });
      } catch (auditErr) {
        if ((auditErr as { code?: string }).code !== "55P03") throw auditErr;
      }
      return {
        status: 503,
        body: {
          reason: "operation_busy",
          message:
            "Another operation on this event is still running. Retry with the same idempotency key.",
          request_id: requestId,
        },
      };
    }
    throw err;
  }
}
