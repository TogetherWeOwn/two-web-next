import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, writeFile, readFile, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { REMOTE_TARGET, requireRemoteReceipt, type RemoteReceipt } from "./remote-target";

export async function collectRemoteReceipt(token: string, agentId: string, get = providerRead): Promise<RemoteReceipt> {
  if (!token || !agentId) throw new Error("assigned_cloudflare_token_and_agent_required");
  const root = `/accounts/${REMOTE_TARGET.accountId}`;
  const hd = await get(`${root}/hyperdrive/configs/${REMOTE_TARGET.hyperdriveId}`, token);
  const settings = await get(`${root}/workers/scripts/${REMOTE_TARGET.worker}/settings`, token);
  const deployed = await get(`${root}/workers/scripts/${REMOTE_TARGET.worker}/deployments`, token);
  const bindings = settings.bindings ?? [];
  if (bindings.filter((b: any) => b.name === "DB").length !== 1 ||
      !bindings.some((b: any) => b.name === "DB" && b.type === "hyperdrive" && b.id === REMOTE_TARGET.hyperdriveId) ||
      !bindings.some((b: any) => b.name === "APP_URL" && b.type === "plain_text" && b.text === REMOTE_TARGET.appUrl)) {
    throw new Error("deployed_staging_worker_binding_mismatch");
  }
  const versions = deployed.deployments?.[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0].percentage !== 100) throw new Error("single_staging_source_version_required");
  // Do NOT copy origin.password or provider responses into the receipt/config.
  const receipt: RemoteReceipt = {
    observedAt: new Date().toISOString(), executorAgentId: agentId,
    worker: REMOTE_TARGET.worker, sourceVersionId: versions[0].version_id,
    hyperdriveId: hd.id, hyperdriveName: hd.name,
    origin: { host: hd.origin?.host, port: hd.origin?.port, database: hd.origin?.database, user: hd.origin?.user },
    cachingDisabled: hd.caching?.disabled,
    mappingSource: "operator-TOG-9836-current-cloudflare-origin-match",
  };
  requireRemoteReceipt(receipt);
  return receipt;
}

async function providerRead(resource: string, token: string): Promise<any> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${resource}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json() as any;
  if (!response.ok || data.success !== true) {
    const code = Number(data.errors?.[0]?.code);
    throw new Error(`cloudflare_read_denied_http_${response.status}_code_${Number.isFinite(code) ? code : "unknown"}`);
  }
  return data.result;
}

export function buildPreviewConfig(receipt: RemoteReceipt, root: string, runKey: string) {
  requireRemoteReceipt(receipt);
  if (!/^[a-f0-9]{64}$/.test(runKey)) throw new Error("invalid_run_key");
  return {
    name: "two-web-next-w1-remote-preview", account_id: REMOTE_TARGET.accountId,
    main: path.join(root, "spike/hyperdrive-semantics/remote-worker.ts"),
    compatibility_date: "2026-09-29", compatibility_flags: ["nodejs_compat"],
    workers_dev: false, preview_urls: false, routes: [],
    hyperdrive: [{ binding: "DB", id: REMOTE_TARGET.hyperdriveId }],
    vars: { PREFLIGHT: JSON.stringify(receipt), RUN_KEY: runKey },
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

export async function main() {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR;
  if (!scratch) throw new Error("paperclip_run_scratch_required");
  const root = process.cwd();
  const wrangler = path.join(root, "node_modules/.bin/wrangler");
  const receipt = await collectRemoteReceipt(process.env.CLOUDFLARE_API_TOKEN ?? "", process.env.PAPERCLIP_AGENT_ID ?? "");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const wranglerVersion = execFileSync(wrangler, ["--version"], { encoding: "utf8" }).trim();
  const dir = path.join(scratch, "w1-remote");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const runKey = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join(""); // Ephemeral nonce, not an account grant.
  const config = path.join(dir, "wrangler.json");
  const logPath = path.join(dir, "private-wrangler.log");
  await writeFile(config, JSON.stringify(buildPreviewConfig(receipt, root, runKey)), { mode: 0o600 });
  await writeFile(path.join(dir, "preflight.json"), JSON.stringify({ revision, wranglerVersion, ...receipt }, null, 2), { mode: 0o600 });
  const port = await freePort();
  const log = await open(logPath, "w", 0o600);
  const child = spawn(wrangler, ["dev", "--remote", "--config", config, "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-ip", "127.0.0.1", "--inspector-port", "0", "--show-interactive-dev-session=false"], {
    detached: true, stdio: ["ignore", log.fd, log.fd],
    // No ambient PG/Neon URL, QA token, alternate CF credential or dev.vars.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: dir,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: REMOTE_TARGET.accountId,
      WRANGLER_SEND_METRICS: "false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_LOG_PATH: dir },
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => { child.once("exit", () => { exited = true; resolve(); }); child.once("error", () => { exited = true; resolve(); }); });
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 480_000);
  let result: any = { ok: false, error: "remote_preview_failed", cleanup: "not_verified" };
  try {
    const url = `http://127.0.0.1:${port}`;
    const headers = { "X-W1-Run-Key": runKey };
    let ready = false;
    for (let i = 0; i < 90 && !exited && !abort.signal.aborted; i++) {
      try {
        const r = await fetch(url + "/ready", { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) });
        if (r.ok && await r.text() === "ready") { ready = true; break; }
      } catch { /* Only local readiness retries; no provider/auth retry or CI polling. */ }
      await delay(1000, undefined, { signal: abort.signal });
    }
    if (!ready) throw new Error("remote_preview_not_ready");
    // Re-read the origin immediately before SQL, not just before preview startup.
    const current = await collectRemoteReceipt(process.env.CLOUDFLARE_API_TOKEN ?? "", receipt.executorAgentId);
    if (current.hyperdriveId !== receipt.hyperdriveId || JSON.stringify(current.origin) !== JSON.stringify(receipt.origin)) throw new Error("remote_binding_changed");
    requireRemoteReceipt(receipt);
    const response = await fetch(url + "/run", { method: "POST", headers, signal: abort.signal });
    result = await response.json();
    if (!response.ok) result.ok = false;
  } catch (err) {
    // Only known local/provider code strings, never arbitrary driver/network errors.
    const message = err instanceof Error ? err.message : "";
    result.error = /^(remote_[a-z_]+|cloudflare_read_denied_http_\d+_code_[\w]+)$/.test(message) ? message : "remote_preview_failed";
  } finally {
    clearTimeout(timer); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
      await Promise.race([exit, delay(10_000)]);
      // Also kill descendants when the main Wrangler process has already exited.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process group is gone. */ }
    }
    await log.close();
    if (result.cleanup === "not_verified") {
      const logText = await readFile(logPath, "utf8");
      const states = [...logText.matchAll(/W1_SCHEMA (\{[^\n]+\})/g)];
      const last = states.at(-1)?.[1];
      if (last) {
        try {
          const state = JSON.parse(last);
          if (/^w1_staging_[a-f0-9]{32}$/.test(state.schema)) result.schema = state.schema;
        } catch { /* No cleanup claim from truncated logs. */ }
      }
    }
  }
  const evidence = { revision, wranglerVersion, runtime: "ephemeral-remote-preview-not-deployed-worker", receipt, result };
  await writeFile(path.join(dir, "result.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
  return result.ok === true && result.cleanup === true ? 0 : 1;
}

if (process.argv[2] === "--run") {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    const message = err instanceof Error ? err.message : "";
    const safe = /^(cloudflare_read_denied_http_\d+_code_[\w]+|remote_staging_target_not_verified|deployed_staging_worker_binding_mismatch|single_staging_source_version_required|assigned_cloudflare_token_and_agent_required|paperclip_run_scratch_required)$/.test(message);
    console.error(safe ? message : "remote_staging_runner_failed; no success or cleanup claimed");
    process.exitCode = 1;
  });
}
