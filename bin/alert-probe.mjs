#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const STAGING_URL = "https://next.togetherweown.com";
export const PROBE_FINGERPRINT = createHash("sha256").update("AlertProbeError@/__probe/alert").digest("hex");

// Wrangler JSON is pretty-printed and may end in a partial event while tailing.
// Extract balanced objects without mistaking braces in log strings for framing.
export function tailObjects(text) {
  const objects = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c !== "{") continue;
      start = i; depth = 1; quoted = false; escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch { /* Ignore CLI banners. */ }
      start = -1;
    }
  }
  return objects;
}

export function probeReceipts(text, since) {
  const receipts = new Map();
  for (const trace of tailObjects(text)) {
    if (trace.scriptName !== "two-web-next-alerts") continue;
    for (const log of trace.logs ?? []) {
      for (const message of log.message ?? []) {
        let line;
        try { line = typeof message === "string" ? JSON.parse(message) : null; } catch { continue; }
        if (!line || line.delivery !== "ops.alert.delivered" || !(Date.parse(line.timestamp) >= since)) continue;
        if (line.event === "error.alert" && line.route === "/__probe/alert" && line.fingerprint === PROBE_FINGERPRINT)
          receipts.set("error.alert", { event: line.event, fingerprint: line.fingerprint, timestamp: line.timestamp });
        if (line.event === "queue.failing" && line.job === "AlertProbe" && line.fingerprint === "queue.failing@AlertProbe" && line.attempts >= 1)
          receipts.set("queue.failing", { event: line.event, fingerprint: line.fingerprint, timestamp: line.timestamp });
      }
    }
  }
  return receipts;
}

export async function runProbe({
  baseUrl = STAGING_URL, token, receiptFile, timeoutMs = 90_000,
  fetch: send = fetch, read = readFile, now = Date.now, pause = sleep,
}) {
  if (baseUrl !== STAGING_URL) throw new Error("Refusing non-staging alert probe target");
  if (!token) throw new Error("QA_AUTH_TOKEN is required; do not pass it as a CLI argument");
  if (!receiptFile) throw new Error("--receipt-file is required; connect wrangler tail before running the probe");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("Timeout must be 1–300000 ms");
  await read(receiptFile, "utf8"); // Fail before sending if the receipt stream is inaccessible.
  const since = now();
  const response = await send(`${baseUrl}/__probe/alert`, {
    method: "POST", headers: { origin: baseUrl, "X-TWO-QA-Auth": token },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (response.status !== 500) throw new Error(`Probe refused or unavailable (HTTP ${response.status}); no delivery claimed`);
  while (now() - since < timeoutMs) {
    const receipts = probeReceipts(await read(receiptFile, "utf8"), since);
    if (receipts.size === 2) return { target: baseUrl, since: new Date(since).toISOString(), receipts: [...receipts.values()] };
    await pause(1000);
  }
  throw new Error("No confirmed delivery for BOTH probe alerts before timeout (check Tail secret/attachment, mute window and queue)");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--receipt-file") throw new Error("Usage: node bin/alert-probe.mjs --receipt-file <connected-tail-json-file>");
  const result = await runProbe({ token: process.env.QA_AUTH_TOKEN, receiptFile: args[1] });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print fetch exceptions: they may contain request headers or credentials.
    console.error("Alert probe failed. Check staging QA gate, connected receipt file, Tail secret, mute window and queue; no delivery claimed.");
    process.exitCode = 1;
  });
}
