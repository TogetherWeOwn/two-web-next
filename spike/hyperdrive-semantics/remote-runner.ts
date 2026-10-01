import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, writeFile, readFile, mkdir, mkdtemp } from "node:fs/promises";
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

export async function createPreviewWorkspace(runDir: string): Promise<string> {
  const dir = await mkdtemp(path.join(runDir, "preview-"));
  await mkdir(path.join(dir, "home"), { mode: 0o700 });
  await writeFile(path.join(dir, "empty.env"), "", { mode: 0o600, flag: "wx" });
  return dir;
}

export function buildPreviewLaunch(wrangler: string, dir: string, config: string, port: number,
  env: NodeJS.ProcessEnv = process.env) {
  return {
    command: wrangler,
    args: ["dev", "--remote", "--config", config, "--env-file", path.join(dir, "empty.env"),
      "--ip", "127.0.0.1", "--port", String(port), "--inspector-ip", "127.0.0.1", "--inspector-port", "0",
      "--show-interactive-dev-session=false"],
    options: {
      cwd: dir,
      // The outer subreaper owns this group, even after SIGKILL of this runner.
      detached: false,
      // Wrangler 4.143.1's CLI-wide dotenv loader is independent of dev-vars.
      // Isolate cwd AND pass an explicit empty file; do not rely on this flag alone.
      // Source: workers-sdk packages/wrangler/src/{index.ts,config/dot-env.ts}.
      env: { PATH: env.PATH, HOME: path.join(dir, "home"), TMPDIR: dir,
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: REMOTE_TARGET.accountId,
        WRANGLER_SEND_METRICS: "false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_LOG_PATH: dir },
    },
  };
}

export async function main() {
  // Only remote-checks.sh supplies a run-owned snapshot/manifest. Refuse direct
  // execution from a mutable working tree, before reading provider metadata.
  const dir = process.env.W1_REMOTE_RUN_DIR;
  if (!dir) throw new Error("remote_supervised_snapshot_required");
  const root = process.cwd();
  const revision = (await readFile(path.join(root, ".w1-source-revision"), "utf8")).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision) || revision !== process.env.W1_SOURCE_REVISION) {
    throw new Error("remote_source_revision_invalid");
  }
  const wrangler = path.join(root, "node_modules/.bin/wrangler");
  // Read metadata, not `wrangler --version` (another ambient-dotenv CLI entry).
  const wranglerVersion: string = JSON.parse(await readFile(path.join(root, "node_modules/wrangler/package.json"), "utf8")).version;
  const previewDir = await createPreviewWorkspace(dir);
  const receipt = await collectRemoteReceipt(process.env.CLOUDFLARE_API_TOKEN ?? "", process.env.PAPERCLIP_AGENT_ID ?? "");
  const runKey = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join(""); // Ephemeral nonce, not an account grant.
  const config = path.join(previewDir, "wrangler.json");
  const logPath = path.join(dir, "private-wrangler.log");
  await writeFile(config, JSON.stringify(buildPreviewConfig(receipt, root, runKey)), { mode: 0o600 });
  await writeFile(path.join(dir, "preflight.json"), JSON.stringify({ revision, wranglerVersion, ...receipt }, null, 2), { mode: 0o600 });
  const port = await freePort();
  const log = await open(logPath, "w", 0o600);
  const launch = buildPreviewLaunch(wrangler, previewDir, config, port);
  const child = spawn(launch.command, launch.args, { ...launch.options, stdio: ["ignore", log.fd, log.fd] });
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
    if (!exited) {
      child.kill("SIGTERM");
      await Promise.race([exit, delay(10_000)]);
      if (!exited) child.kill("SIGKILL");
    }
    // The independent supervisor always kills/reaps the entire inherited group
    // after this runner exits, including when SIGKILL prevents this finally block.
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
    const safe = /^(cloudflare_read_denied_http_\d+_code_[\w]+|remote_staging_target_not_verified|deployed_staging_worker_binding_mismatch|single_staging_source_version_required|assigned_cloudflare_token_and_agent_required|remote_supervised_snapshot_required|remote_source_revision_invalid)$/.test(message);
    console.error(safe ? message : "remote_staging_runner_failed; no success or cleanup claimed");
    process.exitCode = 1;
  });
}
