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
  const minSamples = budget.minSamples ?? 50;
  const rows = metrics.map(([name, value, max]) => ({
    name,
    value,
    max,
    ok: value === null || count < minSamples || value <= max,
  }));
  return { rows, enoughData: count >= minSamples, failed: rows.filter((r) => !r.ok) };
}

async function main() {
  const {
    CF_ANALYTICS_READ_TOKEN: token,
    CF_RUM_ACCOUNT_ID: account,
    CF_RUM_SITE_TAG: site,
  } = process.env;
  const summary = (md) => {
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  };
  if (!token || !account || !site) {
    summary(
      "## Real-user Web Vitals\n\nNot configured (needs secret CF_ANALYTICS_READ_TOKEN and variables CF_RUM_ACCOUNT_ID, CF_RUM_SITE_TAG). Skipped.",
    );
    return 0;
  }
  const budget = JSON.parse(readFileSync("ci/rum-budget.json", "utf8"));
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 3600 * 1000);
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { account, site, since: since.toISOString(), until: until.toISOString() },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    summary(
      `## Real-user Web Vitals\n\nQuery failed (HTTP ${res.status}): ${(body.errors ?? []).map((e) => e.message).join("; ")}`,
    );
    return 1;
  }
  const group = body.data?.viewer?.accounts?.[0]?.rumWebVitalsEventsAdaptiveGroups?.[0];
  const count = group?.count ?? 0;
  const { rows, enoughData, failed } = evaluate(group?.quantiles, budget, count);
  summary(
    [
      "## Real-user Web Vitals (production, last 24 h)",
      "",
      `${count} sample(s)${enoughData ? "" : ` — below minSamples=${budget.minSamples ?? 50}, budgets not enforced`}`,
      "",
      "| Metric | p75 | Budget | |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        (r) => `| ${r.name} | ${r.value ?? "n/a"} | ${r.max} | ${r.ok ? "ok" : "**over**"} |`,
      ),
    ].join("\n"),
  );
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
