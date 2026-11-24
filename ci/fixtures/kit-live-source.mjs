// The installed Worker uses this in the loopback fixture only. The Durable
// Object still handles the signed ingress, sockets, and alarms itself.
const controlPath = "/__fixture/live-source";
const actionsPath = "/internal/actions";

async function serveSnapshot(url, request, env, kv, held) {
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
    !signature ||
    typeof request.body !== "string"
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
  if (action.action !== "live.snapshot" || action.guild_id !== env.DISCORD_GUILD_ID || !snapshot)
    return new Response(null, { status: 503 });
  // Keep the timer in the pull's request context and under its abort signal.
  while (held() && !request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 20));
  request.signal.throwIfAborted();
  return Response.json(snapshot);
}

export function fixtureHub(InstalledHub) {
  return class LiveGuildHub extends InstalledHub {
    constructor(ctx, env) {
      const kv = ctx.storage.kv;
      super(ctx, env, async (url, request) => {
        const response = await serveSnapshot(url, request, env, kv, () => this.held);
        if (response.ok && this.holdSessionAfterPull) {
          this.holdSessionAfterPull = false;
          this.sessionRead = "hold";
        }
        return response;
      });
      this.kv = kv;
      this.generation = (kv.get("fixture-generation") ?? 0) + 1;
      kv.put("fixture-generation", this.generation);
    }

    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== controlPath) {
        this.firstEvent ??= request.method === "POST" ? "ingress" : "upgrade";
        return super.fetch(request);
      }
      this.firstEvent ??= "control";
      const sessionRead = url.searchParams.get("session");
      if (sessionRead) this.sessionRead = sessionRead;
      if (request.method === "POST") {
        this.kv.put("fixture-snapshot", await request.json());
        this.held = url.searchParams.has("hold");
        this.holdSessionAfterPull = url.searchParams.has("hold-session-after-pull");
      } else if (request.method === "DELETE") {
        this.held = false;
      }
      return Response.json({
        generation: this.generation,
        firstEvent: this.firstEvent,
        alarms: this.kv.get("fixture-alarms") ?? [],
        sessionRead: this.sessionRead,
      });
    }

    async readSocketSession(ref) {
      if (this.sessionRead !== "hold") return super.readSocketSession(ref);
      this.sessionRead = "waiting";
      const deadline = Date.now() + 4_000;
      while (this.sessionRead === "waiting" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const result = this.sessionRead;
      this.sessionRead = undefined;
      if (result !== "release") throw new Error("Synthetic session read failed");
      return super.readSocketSession(ref);
    }

    webSocketMessage(socket, message) {
      this.firstEvent ??= "message";
      return super.webSocketMessage(socket, message);
    }

    webSocketClose(socket) {
      this.firstEvent ??= "close";
      return super.webSocketClose(socket);
    }

    alarm() {
      this.firstEvent ??= "alarm";
      const alarms = this.kv.get("fixture-alarms") ?? [];
      this.kv.put("fixture-alarms", [
        ...alarms.slice(-1),
        { generation: this.generation, at: Date.now() },
      ]);
      return super.alarm();
    }
  };
}

export function controlledFetch(fetch) {
  return (request, env, context) =>
    new URL(request.url).pathname === controlPath
      ? env.DISCORD_LIVE_HUB.getByName(env.DISCORD_GUILD_ID).fetch(request)
      : fetch(request, env, context);
}
