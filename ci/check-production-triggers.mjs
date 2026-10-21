// Production trigger drift probe (partial-success detection).
//
// Promoting a Worker Version never applies cron schedules or queue consumers,
// so a green version promotion can still leave production partially deployed:
// the new code serves traffic while the triggers point at the wrong script,
// carry stale settings, or are missing entirely. This probe fails closed on
// any divergence between the reviewed configs and the live trigger state.
//
// Expected topology is derived from the checked-in configs, never hard-coded:
//   - wrangler.jsonc env.production (web): no crons, no consumers, producers only.
//   - wrangler.jobs.jsonc env.production (jobs): both crons, both consumers.
// A reviewed config change flows through automatically; only live drift fails.
//
// Live state comes from read-only Cloudflare REST GETs (schedules per script,
// queue list, consumers per queue). No mutation, no secret values, no DNS:
// the token travels in the environment into fetch headers, never argv, and
// only names, crons and setting numbers are printed. Producers are Worker
// bindings compiled into the promoted version, so versions-promote deploys
// them atomically — only schedules and consumers have a partial-success
// mode, and only those are probed (the producer pins live in the config
// tests).
//
// Exit codes: 0 no drift, 1 drift found (partial success), 2 unreadable input
// or live state (fail closed). Before the one-time production jobs transfer
// (docs/production-jobs-handoff.md) the probe reports exactly the transitional
// diff — consumers and crons still on the web Worker, none on the jobs
// Worker — which the transfer's step-0 record asserts and the post-transfer
// read-back must clear.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readWranglerConfig } from "./wrangler-config.mjs";

const API = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;

export const WEB_SCRIPT = "two-web-next-production";
export const JOBS_SCRIPT = "two-web-jobs-production";

// Wrangler config keys map to Queues API consumer settings: max_batch_size is
// batch_size verbatim, max_batch_timeout is seconds while max_wait_time_ms is
// milliseconds, max_retries is unchanged. Copying the timeout verbatim would
// set a 5 ms wait, so the mapping below is the assertion, not the raw value.
function expectedSettings(consumer) {
  return {
    batch_size: consumer.max_batch_size,
    max_retries: consumer.max_retries,
    max_wait_time_ms: consumer.max_batch_timeout * 1000,
  };
}

// Parse the reviewed configs into the expected live topology. Every field the
// probe asserts is pinned literally here; an unexpected config shape fails
// closed instead of probing against a half-read expectation.
export function readExpectedTopology({ webConfig, jobsConfig }) {
  const fail = (reason) => {
    throw new Error(`Could not derive expected production triggers: ${reason}`);
  };
  const web = webConfig?.env?.production;
  const jobs = jobsConfig?.env?.production;
  if (!web || web.name !== WEB_SCRIPT) fail("web env.production must name two-web-next-production");
  if (!jobs || jobs.name !== JOBS_SCRIPT)
    fail("jobs env.production must name two-web-jobs-production");
  if (!Array.isArray(web.triggers?.crons)) fail("web env.production triggers.crons must be a list");
  if (!Array.isArray(jobs.triggers?.crons))
    fail("jobs env.production triggers.crons must be a list");
  if ((web.queues?.consumers ?? []).length !== 0) fail("web env.production must consume no queue");
  const consumers = jobs.queues?.consumers ?? [];
  if (consumers.length === 0) fail("jobs env.production must consume at least one queue");
  const queues = {};
  for (const consumer of consumers) {
    if (typeof consumer?.queue !== "string" || !consumer.queue)
      fail("consumer queue must name a queue");
    if (queues[consumer.queue]) fail(`duplicate consumer queue ${consumer.queue}`);
    for (const key of ["max_retries", "max_batch_size", "max_batch_timeout"]) {
      if (!Number.isInteger(consumer[key]) || consumer[key] < 0)
        fail(`consumer ${consumer.queue} setting ${key} must be a non-negative integer`);
    }
    queues[consumer.queue] = { consumerScript: JOBS_SCRIPT, settings: expectedSettings(consumer) };
  }
  return {
    scripts: {
      [WEB_SCRIPT]: { crons: [...web.triggers.crons].sort() },
      [JOBS_SCRIPT]: { crons: [...jobs.triggers.crons].sort() },
    },
    queues,
  };
}

async function getJson({ accountId, token, path, fetchImpl }) {
  const response = await fetchImpl(`${API}/accounts/${accountId}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error(`oversized response from ${path}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`unreadable response from ${path}`);
  }
  return { status: response.status, data };
}

// Read-only live trigger state. `schedules[script]` is the sorted cron list,
// [] when the script holds no schedules, or null when the script has no
// schedules endpoint (not deployed). `consumers[queue]` is the live consumer
// list, or null when the queue itself is missing. Anything else unreadable
// throws: an unreadable probe never reports clean.
export async function fetchLiveState({ accountId, token, expected, fetchImpl = fetch }) {
  if (!accountId || !token) throw new Error("CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  const live = { schedules: {}, consumers: {} };
  for (const script of Object.keys(expected.scripts)) {
    const { status, data } = await getJson({
      accountId,
      token,
      path: `/workers/scripts/${script}/schedules`,
      fetchImpl,
    });
    if (data?.success === true) {
      const schedules = data.result?.schedules;
      if (!Array.isArray(schedules)) throw new Error(`unreadable schedules for ${script}`);
      const crons = schedules.map((entry) => entry?.cron);
      if (!crons.every((cron) => typeof cron === "string")) {
        throw new Error(`unreadable schedules for ${script}`);
      }
      live.schedules[script] = crons.sort();
    } else if (status === 404) {
      live.schedules[script] = null;
    } else {
      throw new Error(
        `schedules unreadable for ${script}: ${JSON.stringify(data?.errors ?? data)}`,
      );
    }
  }
  const { data: queueData } = await getJson({
    accountId,
    token,
    path: "/queues?per_page=100",
    fetchImpl,
  });
  if (queueData?.success !== true || !Array.isArray(queueData.result)) {
    throw new Error(`queue list unreadable: ${JSON.stringify(queueData?.errors ?? queueData)}`);
  }
  // One bounded page must cover the account: a truncated list could miss a
  // production queue and misreport it as missing live.
  const total = queueData.result_info?.total_count;
  if (Number.isInteger(total) && queueData.result.length < total) {
    throw new Error(`queue list truncated: ${queueData.result.length} of ${total} read`);
  }
  const ids = {};
  for (const queue of queueData.result) {
    const name = queue?.queue_name ?? queue?.name;
    const id = queue?.queue_id ?? queue?.id;
    if (typeof name === "string" && typeof id === "string") ids[name] = id;
  }
  for (const name of Object.keys(expected.queues)) {
    const id = ids[name];
    if (!id) {
      live.consumers[name] = null;
      continue;
    }
    const { data } = await getJson({
      accountId,
      token,
      path: `/queues/${id}/consumers`,
      fetchImpl,
    });
    if (data?.success !== true || !Array.isArray(data.result)) {
      throw new Error(`consumers unreadable for ${name}: ${JSON.stringify(data?.errors ?? data)}`);
    }
    live.consumers[name] = data.result.map((entry) => ({
      script: entry?.script ?? entry?.script_name ?? null,
      settings: {
        batch_size: entry?.settings?.batch_size,
        max_retries: entry?.settings?.max_retries,
        max_wait_time_ms: entry?.settings?.max_wait_time_ms,
      },
    }));
  }
  return live;
}

// Pure drift detection: every divergence between the reviewed expectation and
// the live read-back becomes one human-readable line. Empty means the live
// triggers exactly match the reviewed topology. Extra live settings outside
// the three pinned consumer fields are ignored; a missing queue, a missing
// script endpoint, a wrong owner, a doubled consumer or a stale cron all fail.
export function detectTriggerDrift(expected, live) {
  const drift = [];
  for (const [script, want] of Object.entries(expected.scripts)) {
    const got = live.schedules?.[script];
    if (got === null || got === undefined) {
      drift.push(`${script}: schedules unreadable (script not deployed?)`);
    } else if (JSON.stringify([...got].sort()) !== JSON.stringify(want.crons)) {
      drift.push(`${script}: crons [${[...got].sort().join(", ")}] != [${want.crons.join(", ")}]`);
    }
  }
  for (const [name, want] of Object.entries(expected.queues)) {
    const got = live.consumers?.[name];
    if (got === null || got === undefined) {
      drift.push(`${name}: queue missing live`);
      continue;
    }
    if (got.length !== 1) {
      const owners = got.map((entry) => entry.script ?? "?").join(", ");
      drift.push(
        `${name}: want exactly one consumer (${want.consumerScript}), got ${got.length} [${owners}]`,
      );
      continue;
    }
    const [only] = got;
    if (only.script !== want.consumerScript) {
      drift.push(`${name}: consumer on ${only.script ?? "?"} != ${want.consumerScript}`);
      continue;
    }
    for (const [key, value] of Object.entries(want.settings)) {
      if (only.settings[key] !== value) {
        drift.push(
          `${name}: consumer setting ${key} is ${JSON.stringify(only.settings[key])} != ${JSON.stringify(value)}`,
        );
      }
    }
  }
  return drift;
}

function repoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export async function main({ env = process.env, fetchImpl = fetch, root = repoRoot() } = {}) {
  const webConfig = readWranglerConfig(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  const jobsConfig = readWranglerConfig(readFileSync(join(root, "wrangler.jobs.jsonc"), "utf8"));
  const expected = readExpectedTopology({ webConfig, jobsConfig });
  const live = await fetchLiveState({
    accountId: env.CF_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    expected,
    fetchImpl,
  });
  return detectTriggerDrift(expected, live);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((drift) => {
      if (drift.length === 0) {
        console.log("Production triggers match the reviewed configs: no drift.");
      } else {
        console.error("::error::production trigger drift (partial success):");
        for (const line of drift) console.error(`::error::  ${line}`);
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(`::error::${error.message}`);
      process.exitCode = 2;
    });
}
