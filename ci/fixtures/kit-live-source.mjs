// The installed Worker uses this in the loopback fixture only. The Durable
// Object still handles the signed ingress, sockets, and alarms itself.
const controlPath = "/__fixture/live-source";
const actionsPath = "/internal/actions";

async function serveSnapshot(url, request, env, kv) {
  if (url !== env.BOT_ENDPOINT_URL + actionsPath || request.method !== "POST") {
    return new Response(null, { status: 400 });
  }
  const headers = new Headers(request.headers);
  const timestamp = headers.get("X-TWO-Timestamp");
  const nonce = headers.get("X-TWO-Nonce");
  const signature = /^sha256=([a-f0-9]{64})$/.exec(headers.get("X-TWO-Signature") ?? "");
  if (
    headers.get("X-TWO-Key-Id") !== env.DISCORD_LIVE_SNAPSHOT_KEY_ID ||
    !/^[1-9]\d*$/.test(timestamp ?? "") ||
    !/^[a-f0-9]{32}$/.test(nonce ?? "") ||
    !signature
  ) {
    return new Response(null, { status: 401 });
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.DISCORD_LIVE_SNAPSHOT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(request.body));
  const canonical = ["POST", actionsPath, timestamp, nonce, new Uint8Array(digest).toHex()].join(
    "\n",
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.fromHex(signature[1]),
      encoder.encode(canonical),
    ))
  ) {
    return new Response(null, { status: 401 });
  }
  const action = JSON.parse(request.body);
  const snapshot = kv.get("fixture-snapshot");
  return action.action === "live.snapshot" && action.guild_id === env.DISCORD_GUILD_ID && snapshot
    ? Response.json(snapshot)
    : new Response(null, { status: 503 });
}

export function fixtureHub(InstalledHub) {
  return class LiveGuildHub extends InstalledHub {
    constructor(ctx, env) {
      const kv = ctx.storage.kv;
      super(ctx, env, (url, request) => serveSnapshot(url, request, env, kv));
      this.kv = kv;
      this.generation = (kv.get("fixture-generation") ?? 0) + 1;
      kv.put("fixture-generation", this.generation);
    }

    async fetch(request) {
      if (new URL(request.url).pathname !== controlPath) return super.fetch(request);
      if (request.method === "POST") this.kv.put("fixture-snapshot", await request.json());
      return Response.json({ generation: this.generation });
    }
  };
}

export function controlledFetch(fetch) {
  return (request, env, context) =>
    new URL(request.url).pathname === controlPath
      ? env.DISCORD_LIVE_HUB.getByName(env.DISCORD_GUILD_ID).fetch(request)
      : fetch(request, env, context);
}
