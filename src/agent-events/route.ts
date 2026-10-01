import type { Context } from "hono";
import postgres from "postgres";
import type { Env } from "../env";
import { DEFAULT_CONFIG, type IngressConfig, handleAgentEvent } from "./service";
import { databaseOptions, databaseUrl } from "../db/connection";
import { dispatchWriteBack } from "../admin/writeback";
import { signedEventReader } from "../bot/event-read";

// In-process fixture seam only; deployed ingress uses the same DB as public events.
export type EnvWithAgentStore = Env & { AGENT_EVENT_SQL?: postgres.Sql };

export function ingressConfig(env: Env): IngressConfig {
  const routePerMinute = Number(env.AGENT_EVENTS_ROUTE_PER_MINUTE);
  return {
    ...DEFAULT_CONFIG,
    enabled: env.AGENT_EVENTS_ENABLED === "true" || env.AGENT_EVENTS_ENABLED === "1",
    callerAgentId: env.AGENT_EVENTS_CALLER_AGENT_ID ?? "",
    stagingGuildId: env.AGENT_EVENTS_GUILD_ID || DEFAULT_CONFIG.stagingGuildId,
    productionGuildId: env.AGENT_EVENTS_PRODUCTION_GUILD_ID || DEFAULT_CONFIG.productionGuildId,
    routePerMinute: Number.isInteger(routePerMinute) && routePerMinute > 0 ? routePerMinute : DEFAULT_CONFIG.routePerMinute,
  };
}

function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m ? m[1]! : null;
}

// No session, no cookie, no user: a machine caller never answers to browser middleware.
export async function agentEventsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header("cache-control", "no-store");
  const cfg = ingressConfig(c.env);
  if (!cfg.enabled) {
    return c.json({ reason: "ingress_disabled", message: "The agent event ingress is not enabled in this environment." }, 404);
  }
  const injected = (c.env as EnvWithAgentStore).AGENT_EVENT_SQL;
  const url = databaseUrl(c.env);
  if (!injected && !url) return c.json({ reason: "ingress_unavailable", message: "The agent event store is not configured." }, 503);

  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    // A non-JSON body is answered by the service's audited 422.
  }
  const sql = injected ?? postgres(url!, databaseOptions);
  try {
    // Anonymous shield bucket: Cloudflare's client address header. A machine
    // caller always presents a credential, so this only keys floods without one.
    const ip = c.req.header("cf-connecting-ip") ?? null;
    const a = await handleAgentEvent(sql, cfg, body, bearer(c.req.header("authorization")), ip, {
      writeBack: (wb) => dispatchWriteBack(c.env, wb),
      readEvent: signedEventReader({ baseUrl: c.env.BOT_ENDPOINT_URL, keyId: c.env.BOT_KEY_ID, secret: c.env.BOT_SHARED_SECRET }),
    });
    return c.json(a.body, a.status as 200, a.headers);
  } catch (err) {
    console.error("agent-events failed", (err as Error).name);
    return c.json({ reason: "internal_error", message: "The agent event ingress failed." }, 500);
  } finally {
    if (!injected) c.executionCtx.waitUntil(sql.end({ timeout: 2 }));
  }
}
