// Ephemeral wrangler dev --remote preview only. Never mount in the application.
import { runFixedStagingChecks, StagingCheckFailure, type SchemaState } from "./staging-checks";
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

// Fixed enum of failed predicates. Never values, hosts or credentials.
export function refusalReasons(env: Env, now = Date.now()): string[] {
  const reasons: string[] = [];
  let receipt: RemoteReceipt | undefined;
  try { receipt = JSON.parse(env.PREFLIGHT ?? ""); } catch { reasons.push("receipt_unparseable"); }
  if (receipt) {
    try { requireRemoteReceipt(receipt, now); } catch {
      const age = now - Date.parse(receipt?.observedAt);
      reasons.push(!Number.isFinite(age) || age < 0 || age > 300_000 ? "receipt_stale_or_unparseable_time" : "receipt_target_mismatch");
    }
  }
  const db = env.DB;
  if (!db || typeof db.connect !== "function") reasons.push("binding_missing_or_not_hyperdrive");
  else {
    if (!db.host) reasons.push("binding_host_missing");
    else if (db.host === "agent-testdb" || db.host.endsWith(".neon.tech")) reasons.push("binding_host_direct_or_local");
    if (db.database !== REMOTE_TARGET.database) reasons.push("binding_database_mismatch");
    if (db.user !== REMOTE_TARGET.user) reasons.push("binding_user_mismatch");
    if (!db.password) reasons.push("binding_password_missing");
    if (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535) reasons.push("binding_port_invalid");
  }
  return reasons;
}

async function execute(env: Env): Promise<Response> {
  const refusal = refusalReasons(env);
  if (refusal.length) {
    return Response.json({ ok: false, error: "remote_staging_preflight_refused", cleanup: true, refusal }, { status: 412 });
  }
  const receipt = JSON.parse(env.PREFLIGHT!) as RemoteReceipt;
  let state: Partial<SchemaState> = { created: false, cleanup: true };
  try {
    const result = await runFixedStagingChecks(() => openHyperdriveClient(env.DB!), (next) => {
      state = next;
      // Only the owned synthetic schema/status, never driver errors or credentials.
      console.info("W1_SCHEMA " + JSON.stringify(state));
    });
    return Response.json({ ...result, path: "wrangler-remote-hyperdrive-neon-staging", preflight: receipt });
  } catch (err) {
    const evidence = err instanceof StagingCheckFailure ? err.result : state;
    return Response.json({ ...evidence, ok: false, error: "remote_staging_probe_failed", preflight: receipt }, { status: 500 });
  }
}

export default createRemoteProbe();
