// Ephemeral wrangler dev --remote preview only. Never mount in the application.
import { runFixedStagingChecks } from "./staging-checks";
import { openHyperdriveClient } from "./staging-probe";
import { REMOTE_TARGET, requireRemoteReceipt, type RemoteReceipt } from "./remote-target";

type Env = { DB?: Hyperdrive; RUN_KEY?: string; PREFLIGHT?: string };

export function createRemoteProbe() {
  let invocation: Promise<Response> | undefined;
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (!env.RUN_KEY || !/^[a-f0-9]{64}$/.test(env.RUN_KEY) ||
          request.headers.get("X-W1-Run-Key") !== env.RUN_KEY) return new Response(null, { status: 404 });
      if (request.method === "GET" && url.pathname === "/ready") return new Response("ready");
      if (request.method !== "POST" || url.pathname !== "/run" || url.search ||
          (await request.text()) !== "") return new Response(null, { status: 404 });
      // One set of rows per preview isolate; replay returns the same result.
      invocation ??= execute(env);
      return (await invocation).clone();
    },
  };
}

async function execute(env: Env): Promise<Response> {
  let receipt: RemoteReceipt;
  try {
    receipt = JSON.parse(env.PREFLIGHT ?? "");
    requireRemoteReceipt(receipt);
    const db = env.DB;
    if (!db || typeof db.connect !== "function" || !db.host ||
        db.host === "agent-testdb" || db.host.endsWith(".neon.tech") ||
        db.database !== REMOTE_TARGET.database || db.user !== REMOTE_TARGET.user ||
        !db.password || !Number.isInteger(db.port) || db.port < 1 || db.port > 65535) throw new Error("runtime_binding_required");
  } catch {
    return Response.json({ ok: false, error: "remote_staging_preflight_refused", cleanup: true }, { status: 412 });
  }
  let state: { schema?: string; created: boolean; cleanup: boolean } = { created: false, cleanup: true };
  try {
    const result = await runFixedStagingChecks(() => openHyperdriveClient(env.DB!), (next) => {
      state = next;
      // Only the owned synthetic schema/status, never driver errors or credentials.
      console.info("W1_SCHEMA " + JSON.stringify(state));
    });
    return Response.json({ ...result, path: "wrangler-remote-hyperdrive-neon-staging", preflight: receipt });
  } catch {
    return Response.json({ ok: false, error: "remote_staging_probe_failed", ...state, preflight: receipt }, { status: 500 });
  }
}

export default createRemoteProbe();
