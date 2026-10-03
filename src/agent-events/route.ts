import type { Context, MiddlewareHandler } from "hono";
import postgres from "postgres";
import type { Env } from "../env";
import { databaseOptions, databaseUrl } from "../db/connection";
import { dispatchWriteBack } from "../admin/writeback";
import { signedEventReader } from "../bot/event-read";
import { isDatabaseUnavailable } from "../db/errors";
import {
  DEFAULT_CONFIG,
  type IngressConfig,
  type Answer,
  type IngressEffects,
  admitAgentEvent,
} from "./service";

type IngressEnv = {
  Bindings: Env;
  Variables: { agentEventHandler: (body: unknown) => Promise<Answer> };
};

// In-process fixture seam only; deployed ingress uses its own binding, then the shared DB.
export type EnvWithAgentStore = Env & { AGENT_EVENT_SQL?: postgres.Sql };

export function ingressConfig(env: Env): IngressConfig {
  const routePerMinute = Number(env.AGENT_EVENTS_ROUTE_PER_MINUTE);
  return {
    ...DEFAULT_CONFIG,
    enabled: env.AGENT_EVENTS_ENABLED === "true" || env.AGENT_EVENTS_ENABLED === "1",
    callerAgentId: env.AGENT_EVENTS_CALLER_AGENT_ID ?? "",
    stagingGuildId: env.AGENT_EVENTS_GUILD_ID || DEFAULT_CONFIG.stagingGuildId,
    productionGuildId: env.AGENT_EVENTS_PRODUCTION_GUILD_ID || DEFAULT_CONFIG.productionGuildId,
    routePerMinute:
      Number.isInteger(routePerMinute) && routePerMinute > 0
        ? routePerMinute
        : DEFAULT_CONFIG.routePerMinute,
  };
}

function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m ? m[1]! : null;
}

// No session, no cookie, no user: a machine caller never answers to browser middleware.
export const agentEventsAdmission: MiddlewareHandler<IngressEnv> = async (c, next) => {
  c.header("cache-control", "no-store");
  const cfg = ingressConfig(c.env);
  if (!cfg.enabled) {
    return c.json(
      {
        reason: "ingress_disabled",
        message: "The agent event ingress is not enabled in this environment.",
      },
      404,
    );
  }
  const injected = (c.env as EnvWithAgentStore).AGENT_EVENT_SQL;
  // The dedicated binding wins where configured; otherwise the ingress acts on
  // the same rows as public events through the shared database URL.
  const url = injected ? undefined : (c.env.AGENT_DB?.connectionString ?? databaseUrl(c.env));
  if (!injected && !url)
    return c.json(
      { reason: "ingress_unavailable", message: "The agent event store is not configured." },
      503,
    );

  // Release idle sockets even if an admitted upload never reaches EOF.
  const sql = injected ?? postgres(url!, databaseOptions);
  try {
    // Admit before the transport limiter reads. The bound handler cannot charge
    // a second shield hit when the parsed body reaches the service.
    const ip = c.req.header("cf-connecting-ip") ?? null;
    // Effects ride the admitted handler: publish/cancel/update dispatch the same
    // write-back the admin path uses, and read observes through the signed bot
    // client (fail-closed when unconfigured).
    const effects: IngressEffects = {
      writeBack: (wb) => dispatchWriteBack(c.env, wb),
      readEvent: signedEventReader({
        baseUrl: c.env.BOT_ENDPOINT_URL,
        keyId: c.env.BOT_KEY_ID,
        secret: c.env.BOT_SHARED_SECRET,
      }),
    };
    const admitted = await admitAgentEvent(
      sql,
      cfg,
      bearer(c.req.header("authorization")),
      ip,
      effects,
    );
    if (!("handle" in admitted))
      return c.json(admitted.body, admitted.status as 200, admitted.headers);
    c.set("agentEventHandler", admitted.handle);
    await next();
  } catch (err) {
    console.error("agent-events failed", (err as Error).name);
    if (isDatabaseUnavailable(err)) {
      c.header("cache-control", "no-store, private");
      c.header("Vary", "Accept");
      return c.json(
        {
          reason: "ingress_unavailable",
          message: "The agent event store is temporarily unavailable. Try again shortly.",
        },
        503,
      );
    }
    return c.json({ reason: "internal_error", message: "The agent event ingress failed." }, 500);
  } finally {
    // Also close on 413, source failures, and shield refusals. Never close the
    // injected fixture client; its owner manages its lifecycle.
    if (!injected) c.executionCtx.waitUntil(sql.end({ timeout: 2 }));
  }
};

export async function agentEventsRoute(c: Context<IngressEnv>): Promise<Response> {
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    // A non-JSON body is answered by the service's audited 422.
  }
  try {
    const a = await c.get("agentEventHandler")(body);
    return c.json(a.body, a.status as 200, a.headers);
  } catch (err) {
    console.error("agent-events failed", (err as Error).name);
    if (isDatabaseUnavailable(err)) {
      c.header("cache-control", "no-store, private");
      c.header("Vary", "Accept");
      return c.json(
        {
          reason: "ingress_unavailable",
          message: "The agent event store is temporarily unavailable. Try again shortly.",
        },
        503,
      );
    }
    return c.json({ reason: "internal_error", message: "The agent event ingress failed." }, 500);
  }
}
