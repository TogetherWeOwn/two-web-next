import type { Context } from "hono";
import postgres from "postgres";
import type { Env } from "../env";
import { DEFAULT_CONFIG, type IngressConfig, handleAgentEvent } from "./service";

export function ingressConfig(env: Env): IngressConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: env.AGENT_EVENTS_ENABLED === "true" || env.AGENT_EVENTS_ENABLED === "1",
    callerAgentId: env.AGENT_EVENTS_CALLER_AGENT_ID ?? "",
    stagingGuildId: env.AGENT_EVENTS_GUILD_ID || DEFAULT_CONFIG.stagingGuildId,
    productionGuildId: env.AGENT_EVENTS_PRODUCTION_GUILD_ID || DEFAULT_CONFIG.productionGuildId,
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
  const url = c.env.AGENT_DB?.connectionString;
  if (!url) return c.json({ reason: "ingress_unavailable", message: "The agent event store is not configured." }, 503);

  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    // A non-JSON body is answered by the service's audited 422.
  }
  const sql = postgres(url, { max: 1, fetch_types: false, prepare: false });
  try {
    const a = await handleAgentEvent(sql, cfg, body, bearer(c.req.header("authorization")));
    return c.json(a.body, a.status as 200, a.headers);
  } catch (err) {
    console.error("agent-events failed", (err as Error).name);
    return c.json({ reason: "internal_error", message: "The agent event ingress failed." }, 500);
  } finally {
    c.executionCtx.waitUntil(sql.end({ timeout: 2 }));
  }
}
