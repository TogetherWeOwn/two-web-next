import { isTrustedHost } from "../http/trust-hosts";
import { LIVE_INGEST_PATH, verifyLiveIngress } from "./transport";
import { decodeLiveDelta, liveId } from "./wire";

export type LiveIngressEnv = {
  APP_URL?: string;
  DISCORD_GUILD_ID?: string;
  BOT_ENDPOINT_URL?: string;
  DISCORD_LIVE_INGEST_ENABLED?: string;
  DISCORD_LIVE_INGEST_KEY_ID?: string;
  DISCORD_LIVE_INGEST_SECRET?: string;
  DISCORD_LIVE_SNAPSHOT_KEY_ID?: string;
  DISCORD_LIVE_SNAPSHOT_SECRET?: string;
  DISCORD_LIVE_HUB?: DurableObjectNamespace;
};

export const HUB_INGEST_URL = "https://live-hub.invalid/ingest";

function httpsOrigin(value = ""): string | undefined {
  const url = URL.parse(value);
  if (url?.protocol === "https:" && url.href === `${url.origin}/`) return url.origin;
}

export function liveIngressConfig(env: LiveIngressEnv) {
  const origin = httpsOrigin(env.APP_URL);
  const botOrigin = httpsOrigin(env.BOT_ENDPOINT_URL);
  const guild = liveId.safeParse(env.DISCORD_GUILD_ID);
  const ingressKeyId = env.DISCORD_LIVE_INGEST_KEY_ID ?? "";
  const snapshotKeyId = env.DISCORD_LIVE_SNAPSHOT_KEY_ID ?? "";
  const ingressSecret = env.DISCORD_LIVE_INGEST_SECRET;
  const snapshotSecret = env.DISCORD_LIVE_SNAPSHOT_SECRET;
  const validKeyId = /^[\w.:-]{1,128}$/;
  if (
    env.DISCORD_LIVE_INGEST_ENABLED !== "true" ||
    !origin ||
    !botOrigin ||
    !guild.success ||
    !validKeyId.test(ingressKeyId) ||
    !validKeyId.test(snapshotKeyId) ||
    !ingressSecret ||
    !snapshotSecret ||
    ingressSecret === snapshotSecret
  )
    return null;
  return {
    origin,
    guildId: guild.data,
    ingress: { keyId: ingressKeyId, secret: ingressSecret },
    snapshot: {
      keyId: snapshotKeyId,
      secret: snapshotSecret,
      origin: botOrigin,
      guildId: guild.data,
    },
  };
}

function result(status: number): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleLiveIngress(
  request: Request,
  env: LiveIngressEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== LIVE_INGEST_PATH) return null;
  const config = liveIngressConfig(env);
  const hub = env.DISCORD_LIVE_HUB;
  if (!config || !hub) return result(503);
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "POST", "Cache-Control": "no-store" },
    });
  }
  if (url.origin !== config.origin) return result(401);
  if (!isTrustedHost(config.origin, [request.headers.get("host"), url.host])) return result(401);
  const verified = await verifyLiveIngress(request, config.ingress);
  if (verified.status !== 200) return result(verified.status);
  if (!decodeLiveDelta(verified.bytes, config.guildId)) return result(400);

  try {
    const reply = await hub.getByName(config.guildId).fetch(HUB_INGEST_URL, {
      method: "POST",
      body: verified.bytes,
      redirect: "manual",
    });
    // Never surface object response bodies, headers, or exception details.
    void reply.body?.cancel().catch(() => {});
    return result(reply.status === 204 || reply.status === 409 ? reply.status : 503);
  } catch {
    return result(503);
  }
}
