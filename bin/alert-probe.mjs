#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const STAGING_URL = "https://next.togetherweown.com";
export const ALERT_PROBE_HEADER = "X-TWO-Alert-Probe";
const PROBE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PROBE_FINGERPRINT = createHash("sha256")
  .update("AlertProbeError@/__probe/alert")
  .digest("hex");

// Wrangler JSON is pretty-printed and may end in a partial event while tailing.
// Extract balanced objects without mistaking braces in log strings for framing.
export function tailObjects(text, after = 0) {
  const objects = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c !== "{") continue;
      start = i;
      depth = 1;
      quoted = false;
      escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      // Scan from the file start for framing, but exclude even partial baseline objects.
      try {
        if (start >= after) objects.push(JSON.parse(text.slice(start, i + 1)));
      } catch {
        /* Ignore CLI banners. */
      }
      start = -1;
    }
  }
  return objects;
}

export function probeReceipts(text, probeId, after = 0) {
  const receipts = new Map();
  for (const trace of tailObjects(text, after)) {
    if (trace.scriptName !== "two-web-next-alerts") continue;
    for (const log of trace.logs ?? []) {
      for (const message of log.message ?? []) {
        let line;
        try {
          line = typeof message === "string" ? JSON.parse(message) : null;
        } catch {
          continue;
        }
        if (
          !line ||
          line.delivery !== "ops.alert.delivered" ||
          line.probeId !== probeId ||
          typeof line.timestamp !== "string" ||
          !Number.isFinite(Date.parse(line.timestamp))
        )
          continue;
        if (
          line.event === "error.alert" &&
          line.route === "/__probe/alert" &&
          line.fingerprint === PROBE_FINGERPRINT
        )
          receipts.set("error.alert", {
            event: line.event,
            fingerprint: line.fingerprint,
            timestamp: line.timestamp,
          });
        if (
          line.event === "queue.failing" &&
          line.job === "AlertProbe" &&
          line.fingerprint === "queue.failing@AlertProbe" &&
          Number.isSafeInteger(line.attempts) &&
          line.attempts >= 1
        )
          receipts.set("queue.failing", {
            event: line.event,
            fingerprint: line.fingerprint,
            timestamp: line.timestamp,
          });
      }
    }
  }
  return receipts;
}

export async function runProbe({
  baseUrl = STAGING_URL,
  token,
  receiptFile,
  timeoutMs = 90_000,
  // https://nodejs.org/api/crypto.html#cryptorandomuuidoptions
  probeId = randomUUID(),
  fetch: send = fetch,
  read = readFile,
  now = Date.now,
  pause = sleep,
}) {
  if (baseUrl !== STAGING_URL) throw new Error("Refusing non-staging alert probe target");
  if (!token) throw new Error("QA_AUTH_TOKEN is required; do not pass it as a CLI argument");
  if (!receiptFile)
    throw new Error("--receipt-file is required; connect wrangler tail before running the probe");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
    throw new Error("Timeout must be 1–300000 ms");
  if (typeof probeId !== "string" || !PROBE_ID.test(probeId)) throw new Error("Invalid probe ID");
  const baseline = await read(receiptFile, "utf8"); // Fail before sending if the stream is inaccessible.
  const since = now();
  const response = await send(`${baseUrl}/__probe/alert`, {
    method: "POST",
    headers: { origin: baseUrl, "X-TWO-QA-Auth": token, [ALERT_PROBE_HEADER]: probeId },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  // Response disposal is inert to the verdict: attempt cleanup once without
  // letting a sync throw, a rejection (including a late one), or a
  // never-settling cancel alter the expected status or receipt outcome.
  // Disposal diagnostics are never surfaced; they may carry request material.
  try {
    const disposal = response.body?.cancel();
    if (disposal && typeof disposal.then === "function") {
      disposal.then(undefined, () => {
        // Swallow disposal rejections, including late ones.
      });
    }
  } catch {
    // Swallow synchronous disposal throws; the verdict below decides.
  }
  if (response.status !== 500)
    throw new Error(`Probe refused or unavailable (HTTP ${response.status}); no delivery claimed`);
  while (now() - since < timeoutMs) {
    const text = await read(receiptFile, "utf8");
    if (!text.startsWith(baseline))
      throw new Error("Receipt stream changed; reconnect and restart the probe");
    const receipts = probeReceipts(text, probeId, baseline.length);
    if (receipts.size === 2)
      return {
        target: baseUrl,
        probeId,
        since: new Date(since).toISOString(),
        receipts: [...receipts.values()],
      };
    await pause(1000);
  }
  throw new Error(
    "No confirmed delivery for BOTH probe alerts before timeout (check Tail secret/attachment, mute window and queue)",
  );
}

const USAGE = `Usage: node bin/alert-probe.mjs --receipt-file <connected-tail-json-file> [--dry-run] [--help]

Post the staging alert probe and wait for both Tail receipts. --dry-run
validates the receipt file plus QA_AUTH_TOKEN presence without sending.
--help prints this usage to stdout and sends nothing. Flags may appear in any
position; --help wins everywhere and is never parsed as a receipt path. A
flag-shaped --receipt-file value is rejected. Exit 0 on success, 2 on
mis-invocation or missing inputs, 1 on delivery failure.`;

const FAILURE_LINE =
  "Alert probe failed. Check staging QA gate, connected receipt file, Tail secret, mute window and queue; no delivery claimed.";

export function parseAlertArgs(args) {
  if (args.includes("--help")) return { help: true };
  let receiptFile;
  let dryRun = false;
  let seenReceipt = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--receipt-file") {
      const value = args[i + 1];
      if (seenReceipt || value === undefined || value.startsWith("--")) throw new Error(USAGE);
      seenReceipt = true;
      receiptFile = value;
      i++;
      continue;
    }
    throw new Error(USAGE);
  }
  if (!receiptFile) throw new Error(USAGE);
  return { help: false, receiptFile, dryRun };
}

export async function main({
  args = process.argv.slice(2),
  env = process.env,
  probe = runProbe,
  readImpl = readFile,
} = {}) {
  let parsed;
  try {
    parsed = parseAlertArgs(args);
  } catch {
    console.error(`${USAGE}\ncode=usage`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  if (parsed.dryRun) {
    if (!env.QA_AUTH_TOKEN) {
      console.error(
        "alert-probe dry-run failed: QA_AUTH_TOKEN is required; no delivery claimed. code=missing_token",
      );
      process.exitCode = 2;
      return;
    }
    try {
      await readImpl(parsed.receiptFile, "utf8");
    } catch {
      console.error(
        "alert-probe dry-run failed: cannot read receipt file; no delivery claimed. code=unreadable_receipt",
      );
      process.exitCode = 2;
      return;
    }
    console.log(
      JSON.stringify(
        { code: "dry_run.ok", dry_run: true, mode: "dry-run", receipt_file: parsed.receiptFile },
        null,
        2,
      ),
    );
    return;
  }
  if (!env.QA_AUTH_TOKEN) {
    console.error(`${FAILURE_LINE} code=missing_token`);
    process.exitCode = 2;
    return;
  }
  try {
    await readImpl(parsed.receiptFile, "utf8");
  } catch {
    console.error(`${FAILURE_LINE} code=unreadable_receipt`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await probe({
      token: env.QA_AUTH_TOKEN,
      receiptFile: parsed.receiptFile,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Never print fetch exceptions: they may contain request headers or credentials.
    console.error(`${FAILURE_LINE} code=delivery_failed`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
