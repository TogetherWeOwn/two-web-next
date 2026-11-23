import { databaseOptions, databaseUrl, withPerRequestStatementBound } from "../db/connection";
import type { Env } from "../env";
import { isTrustedHost } from "../http/trust-hosts";
import { createPostgresSessionStore, type SessionStore, type Sql } from "../sessions";
import { handleLiveIngress, type LiveIngressEnv, liveIngressConfig } from "./ingress";
import { resolveLiveSocketSession } from "./socket-session";

export const LIVE_SOCKET_PATH = "/api/discord-live/v1";
export const HUB_SOCKET_URL = "https://live-hub.invalid/socket";
export const SESSION_REF = "X-Live-Session-Ref";
export const SESSION_UNTIL = "X-Live-Session-Until";
export type LiveSocketEnv = LiveIngressEnv &
  Partial<Pick<Env, "SESSION_SECRET" | "DATABASE_URL" | "DB">> & {
    DISCORD_LIVE_SOCKET_ENABLED?: string;
  };

export async function readLiveSocketSession(
  env: LiveSocketEnv,
  ref: string,
): ReturnType<SessionStore["getLive"]> {
  const url = databaseUrl(env);
  if (!url) throw new Error("Live session store unavailable");
  // Initialize the bundled Worker driver only for a session-bearing request.
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, databaseOptions);
  const store = createPostgresSessionStore(withPerRequestStatementBound(sql as unknown as Sql));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Live session read timed out")), 4_000);
  });
  try {
    return await Promise.race([store.getLive(ref), deadline]);
  } finally {
    clearTimeout(timer);
    await sql.end({ timeout: 0 });
  }
}

function refuse(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export async function handleLiveRequest(
  request: Request,
  env: LiveSocketEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== LIVE_SOCKET_PATH) return handleLiveIngress(request, env);
  const config = liveIngressConfig(env);
  const hub = env.DISCORD_LIVE_HUB;
  if (env.DISCORD_LIVE_SOCKET_ENABLED !== "true" || !config || !hub) return refuse(503);
  if (request.method !== "GET") return refuse(405, { Allow: "GET" });
  if (
    url.origin !== config.origin ||
    request.headers.get("origin") !== config.origin ||
    !isTrustedHost(config.origin, [request.headers.get("host"), url.host])
  )
    return refuse(403);
  if (url.search || request.headers.has("sec-websocket-protocol")) return refuse(400);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(426);
  const session = await resolveLiveSocketSession(
    request.headers.get("cookie") ?? "",
    env.SESSION_SECRET,
    (ref) => readLiveSocketSession(env, ref),
  );
  if (session.kind === "refused") return refuse(session.status);

  // Hop over the binding only. No client headers, identity, or cookie reach the hub.
  const headers = new Headers({ Upgrade: "websocket" });
  if (session.kind === "session") {
    headers.set(SESSION_REF, session.ref);
    headers.set(SESSION_UNTIL, String(session.validUntil));
  }
  try {
    const response = await hub.getByName(config.guildId).fetch(HUB_SOCKET_URL, { headers });
    // The response owns the upgraded socket. It must bypass Kit and all cloning.
    return response.status === 101 ? response : refuse(response.status === 429 ? 429 : 503);
  } catch {
    return refuse(503);
  }
}
