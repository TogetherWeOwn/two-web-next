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
        version: 1,
        tool: "alert-probe",
        mode: "report",
        ok: true,
        code: "ALERT_PROBE_OK",
        next: "No action: both probe alerts confirmed delivered; rerun after the next staging deploy.",
        checks: [
          { id: "error-alert-delivered", label: "error.alert delivered", ok: true },
          { id: "queue-failing-delivered", label: "queue.failing delivered", ok: true },
        ],
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

const USAGE = "Usage: node bin/alert-probe.mjs --receipt-file <connected-tail-json-file>";

const HELP = `Usage: node bin/alert-probe.mjs --receipt-file <connected-tail-json-file> [--help]

Staging-only operator probe: confirmed delivery of both synthetic alert
receipts (error.alert and queue.failing) for one probe ID.

Environment:
  QA_AUTH_TOKEN  staging QA login token (required; never pass it as a CLI argument)

Arguments:
  --receipt-file <path>  connected wrangler tail JSON file (required)

The probe target is pinned to ${STAGING_URL}. Output is one JSON verdict
on stdout: version, tool, mode, ok, code, next and checks (stable kebab
ids). Failures print one generic line to stderr and claim nothing.

Exit codes:
  exit 0  both probe alerts confirmed delivered (or --help printed)
  exit 1  the probe was refused, timed out, or errored; no delivery claimed
  exit 2  wrong arguments; static usage on stderr

See docs/probe-cli-contract.md for the shared probe CLI contract.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    // Discovery only: usage to stdout, exit 0, zero side effects — no token
    // read, no receipt-file read, no probe. Checked before the argv refusal
    // so --help is never parsed as a positional.
    console.log(HELP);
    return;
  }
  if (args.length !== 2 || args[0] !== "--receipt-file" || args[1].startsWith("-")) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const result = await runProbe({ token: process.env.QA_AUTH_TOKEN, receiptFile: args[1] });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print fetch exceptions: they may contain request headers or credentials.
    console.error(
      "Alert probe failed. Check staging QA gate, connected receipt file, Tail secret, mute window and queue; no delivery claimed.",
    );
    process.exitCode = 1;
  });
}
