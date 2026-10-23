#!/usr/bin/env node
// Real-user Core Web Vitals gate (docs/rum-web-vitals.md). Reads the last 24 h of
// Cloudflare Web Analytics (RUM) for the production site via the GraphQL
// Analytics API and fails when a p75 exceeds its budget in ci/rum-budget.json.
// Needs a READ-ONLY token (Account Analytics: Read) in CF_ANALYTICS_READ_TOKEN
// plus the repo variables CF_RUM_ACCOUNT_ID and CF_RUM_SITE_TAG; until they exist it reports
// "not configured" and exits 0, so setup never raises a false alarm.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const QUERY = `query ($account: String!, $site: String!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rumWebVitalsEventsAdaptiveGroups(limit: 1, filter: { siteTag: $site, datetime_geq: $since, datetime_lt: $until }) {
      count
      quantiles { largestContentfulPaintP75 cumulativeLayoutShiftP75 interactionToNextPaintP75 }
    }
  } }
}`;

// One total deadline for headers and body, even when the transport ignores abort.
export const RUM_TRANSPORT_TIMEOUT_MS = 10_000;
// Limit decoded response bytes before JSON parsing; the query returns at most one group.
export const RUM_MAX_RESPONSE_BYTES = 64 * 1024;

const DEFAULT_MIN_SAMPLES = 50;
const P75_FIELDS = [
  "largestContentfulPaintP75",
  "cumulativeLayoutShiftP75",
  "interactionToNextPaintP75",
];

export function evaluate(quantiles, budget, count) {
  // Cloudflare returns LCP/INP p75 in microseconds (CLS is unitless) and a
  // negative value means N/A (no data for that metric that day).
  const microsToMs = (v) => (typeof v === "number" && v >= 0 ? v / 1000 : null);
  const unitless = (v) => (typeof v === "number" && v >= 0 ? v : null);
  const metrics = [
    ["LCP p75 (ms)", microsToMs(quantiles?.largestContentfulPaintP75), budget.lcpMs],
    ["CLS p75", unitless(quantiles?.cumulativeLayoutShiftP75), budget.cls],
    ["INP p75 (ms)", microsToMs(quantiles?.interactionToNextPaintP75), budget.inpMs],
  ];
  const minSamples = budget.minSamples ?? DEFAULT_MIN_SAMPLES;
  const rows = metrics.map(([name, value, max]) => ({
    name,
    value,
    max,
    ok: value === null || count < minSamples || value <= max,
  }));
  return { rows, enoughData: count >= minSamples, failed: rows.filter((r) => !r.ok) };
}

// Throws a bounded "Response invalid: <reason>" instead of collapsing broken data to zero samples.
export function admitRumResponse(body, minSamples = DEFAULT_MIN_SAMPLES) {
  const invalid = (reason) => {
    throw new Error(`Response invalid: ${reason}`);
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    invalid("empty response");
  }
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    invalid("missing data");
  }
  const viewer = data.viewer;
  if (!viewer || typeof viewer !== "object" || Array.isArray(viewer)) {
    invalid("missing viewer");
  }
  const accounts = viewer.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    invalid("malformed accounts");
  }
  const account = accounts[0];
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    invalid("malformed accounts");
  }
  const groups = account.rumWebVitalsEventsAdaptiveGroups;
  if (!Array.isArray(groups)) {
    invalid("malformed groups");
  }
  if (groups.length === 0) {
    return { count: 0, quantiles: undefined };
  }
  const group = groups[0];
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    invalid("malformed groups");
  }
  if (!Number.isInteger(group.count) || group.count < 0) {
    invalid("invalid count");
  }
  const quantiles = group.quantiles;
  if (
    quantiles !== undefined &&
    quantiles !== null &&
    (typeof quantiles !== "object" || Array.isArray(quantiles))
  ) {
    invalid("malformed quantiles");
  }
  const budgetEnforced = group.count > 0 && group.count >= minSamples;
  if (budgetEnforced && !P75_FIELDS.every((field) => Number.isFinite(quantiles?.[field]))) {
    invalid("malformed quantiles");
  }
  return { count: group.count, quantiles };
}

function tableLines(rows) {
  return [
    "| Metric | p75 | Budget | |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (r) => `| ${r.name} | ${r.value ?? "n/a"} | ${r.max} | ${r.ok ? "ok" : "**over**"} |`,
    ),
  ];
}

function cancelBody(target) {
  try {
    // Cleanup must never hold settlement hostage or surface a late rejection.
    void Promise.resolve(target?.cancel()).catch(() => undefined);
  } catch {
    // A throwing disposal is also best-effort; the classified outcome is unchanged.
  }
}

async function queryRum(fetchImpl, options, timeoutMs, maxResponseBytes) {
  const controller = new AbortController();
  let res;
  let reader;
  let stopped = false;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  // Transport work never emits: only the winner below may reach the summary path.
  const transport = (async () => {
    try {
      res = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
        ...options,
        signal: controller.signal,
      });
    } catch {
      return { kind: "query-failed" };
    }
    if (stopped) {
      // Headers may arrive after the deadline when an injected fetch ignores abort.
      cancelBody(res?.body);
      return { kind: "timeout" };
    }
    let body;
    let jsonFailed = false;
    try {
      reader = res.body.getReader();
      const bytes = new Uint8Array(maxResponseBytes);
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (stopped) return { kind: "timeout" };
        if (done) break;
        if (value.byteLength > maxResponseBytes - length) {
          return { kind: "response-too-large" };
        }
        bytes.set(value, length);
        length += value.byteLength;
      }
      body = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    } catch {
      jsonFailed = true;
    }
    return { res, body, jsonFailed };
  })();
  let result;
  try {
    // Promise.race observes late transport failures as well as timely completion.
    result = await Promise.race([transport, deadline]);
    return result;
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (result?.kind || result?.jsonFailed) {
      controller.abort();
      cancelBody(reader ?? res?.body);
    }
    try {
      reader?.releaseLock();
    } catch {
      // An uncooperative reader cannot delay or replace the settled outcome.
    }
  }
}

// Summaries are bounded fixed-shape strings: no provider payloads, credentials or identity.
export async function runRumCheck({
  env = process.env,
  fetchImpl = fetch,
  budget,
  onSummary,
  timeoutMs = RUM_TRANSPORT_TIMEOUT_MS,
  maxResponseBytes = RUM_MAX_RESPONSE_BYTES,
} = {}) {
  const { CF_ANALYTICS_READ_TOKEN: token, CF_RUM_ACCOUNT_ID: account, CF_RUM_SITE_TAG: site } = env;
  const emit =
    onSummary ??
    ((md) => {
      console.log(md);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    });
  if (!token || !account || !site) {
    const summary =
      "## Real-user Web Vitals\n\nNot configured (needs secret CF_ANALYTICS_READ_TOKEN and variables CF_RUM_ACCOUNT_ID, CF_RUM_SITE_TAG). Skipped.";
    emit(summary);
    return { code: 0, kind: "skipped", summary };
  }
  const resolvedBudget = budget ?? JSON.parse(readFileSync("ci/rum-budget.json", "utf8"));
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 3600 * 1000);
  const result = await queryRum(
    fetchImpl,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        variables: { account, site, since: since.toISOString(), until: until.toISOString() },
      }),
    },
    timeoutMs,
    maxResponseBytes,
  );
  if (result.kind) {
    const reason = {
      timeout: "Query timed out.",
      "response-too-large": "Response too large.",
      "query-failed": "Query failed (network error).",
    }[result.kind];
    const summary = `## Real-user Web Vitals\n\n${reason} Budgets not evaluated.`;
    emit(summary);
    return { code: 1, kind: result.kind, summary };
  }
  const { res, body, jsonFailed } = result;
  const errorCount = Array.isArray(body?.errors) ? body.errors.length : 0;
  if (!res.ok || errorCount > 0) {
    // Provider error text is omitted on purpose; a non-JSON gateway page keeps its HTTP status.
    const summary = `## Real-user Web Vitals\n\nQuery failed (HTTP ${res.status}, ${errorCount} GraphQL error(s)). Budgets not evaluated.`;
    emit(summary);
    return { code: 1, kind: "query-failed", summary };
  }
  if (jsonFailed) {
    const summary =
      "## Real-user Web Vitals\n\nResponse invalid: invalid JSON. Expected GraphQL data.viewer.accounts[0].rumWebVitalsEventsAdaptiveGroups[0] with a non-negative integer count. Budgets not evaluated.";
    emit(summary);
    return { code: 1, kind: "invalid-response", summary };
  }
  let admitted;
  try {
    admitted = admitRumResponse(body, resolvedBudget.minSamples ?? DEFAULT_MIN_SAMPLES);
  } catch (err) {
    const reason = String(err?.message ?? "Response invalid").replace(/^Response invalid:\s*/, "");
    const summary = `## Real-user Web Vitals\n\nResponse invalid: ${reason.slice(0, 120)}. Expected GraphQL data.viewer.accounts[0].rumWebVitalsEventsAdaptiveGroups[0] with a non-negative integer count. Budgets not evaluated.`;
    emit(summary);
    return { code: 1, kind: "invalid-response", summary };
  }
  const { rows, enoughData, failed } = evaluate(admitted.quantiles, resolvedBudget, admitted.count);
  const summary = [
    "## Real-user Web Vitals (production, last 24 h)",
    "",
    `${admitted.count} sample(s)${enoughData ? "" : ` — below minSamples=${resolvedBudget.minSamples ?? DEFAULT_MIN_SAMPLES}, budgets not enforced`}`,
    "",
    ...tableLines(rows),
  ].join("\n");
  emit(summary);
  if (failed.length) {
    return { code: 1, kind: "over-budget", summary };
  }
  return { code: 0, kind: enoughData ? "pass" : "insufficient", summary };
}

async function main() {
  const { code } = await runRumCheck();
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
