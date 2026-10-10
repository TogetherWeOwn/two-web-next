import type { Sql } from "postgres";
import { sha256Hex } from "../bot/signer";
import { retireAnonEventCaches } from "../events/anon-cache";
import type { Answer, Grant, IngressConfig, IngressEffects, Op } from "./types";
import { OPS } from "./types";
import { digest, isPlainObject, PayloadTooDeepError, storedEventKey, ulid } from "./payload";
import { audit } from "./audit";
import { checkGrant, findGrant } from "./grants";
import { shield } from "./shield";
import { lookupReplay, replayAnswer } from "./idempotency";
import { rateLimit } from "./rate-limit";
import { execute } from "./dispatch";

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

async function processAgentEvent(
  sql: Sql,
  cfg: IngressConfig,
  body: unknown,
  credential: string | null,
  requestId: string,
  effects: IngressEffects,
): Promise<Answer> {
  const doc: Record<string, unknown> = isPlainObject(body) ? body : {};
  let dig: string;
  try {
    dig = await digest(isPlainObject(body) ? body : {});
  } catch (err) {
    if (err instanceof PayloadTooDeepError) {
      await audit(
        sql,
        null,
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
  const auditOp = typeof rawOp === "string" && rawOp !== "" ? rawOp.slice(0, 32) : "unknown";
  const auditKey =
    typeof rawKey === "string" && rawKey !== "" && rawKey.length <= 255 ? rawKey : null;
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

  const grant = credential ? await findGrant(sql, credential) : null;
  if (!grant)
    return deny(
      null,
      op,
      idem,
      "denied",
      "unauthenticated",
      401,
      "A valid machine credential is required.",
    );

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
  // The guild comes from the grant, never the caller.
  if (
    doc.guild_id !== undefined &&
    doc.guild_id !== null &&
    String(doc.guild_id) !== grant.guild_id
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
    const limited = await rateLimit(sql, cfg, grant, op as Op);
    if (limited) {
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
    )
      retireAnonEventCaches();
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
