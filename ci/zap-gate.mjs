#!/usr/bin/env node
// OWASP ZAP baseline gate (docs/zap-baseline.md).
//   node ci/zap-gate.mjs <zap traditional-json report> [budget json]
// Fails on any High alert, and on Medium/Low alert counts above the committed
// budget in ci/zap-budget.json (null = not yet enforced, counts reported only).
// Budgets only ratchet down; raising one is its own reviewed PR.
// The repo is public: the summary names alerts and counts only, never the
// affected URLs, parameters or evidence, and the full report is never uploaded.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RISK = { 3: "High", 2: "Medium", 1: "Low", 0: "Informational" };

export function summarize(report, budget) {
  const ignore = new Set((budget.ignore ?? []).map((entry) => String(entry.pluginId)));
  const alerts = [];
  for (const site of report.site ?? []) {
    for (const alert of site.alerts ?? []) {
      const pluginId = String(alert.pluginid ?? alert.alertRef ?? "");
      if (ignore.has(pluginId)) continue;
      alerts.push({
        pluginId,
        name: String(alert.name ?? alert.alert ?? "unknown"),
        risk: Number(alert.riskcode ?? 0),
        count: Number(alert.count ?? alert.instances?.length ?? 1),
      });
    }
  }
  const counts = { 3: 0, 2: 0, 1: 0, 0: 0 };
  for (const a of alerts) counts[a.risk] = (counts[a.risk] ?? 0) + 1;
  const failures = [];
  if (counts[3] > 0) failures.push(`${counts[3]} High alert type(s); High is never allowed`);
  for (const [risk, key] of [
    [2, "maxMedium"],
    [1, "maxLow"],
  ]) {
    const max = budget[key];
    if (max !== null && max !== undefined && counts[risk] > max) {
      failures.push(`${counts[risk]} ${RISK[risk]} alert type(s) > budget ${key}=${max}`);
    }
  }
  return { alerts, counts, failures };
}

export function markdown({ alerts, counts, failures }) {
  const rows = alerts
    .sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name))
    .map((a) => `| ${RISK[a.risk] ?? a.risk} | ${a.pluginId} | ${a.name} | ${a.count} |`);
  return [
    "## ZAP baseline (staging, passive)",
    "",
    `High ${counts[3]} · Medium ${counts[2]} · Low ${counts[1]} · Info ${counts[0]} (alert types)`,
    "",
    failures.length ? `**FAIL:** ${failures.join("; ")}` : "**PASS**",
    "",
    "| Risk | Plugin | Alert | Instances |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, budgetPath = "ci/zap-budget.json"] = process.argv.slice(2);
  if (!reportPath) {
    console.error("usage: node ci/zap-gate.mjs <report.json> [budget.json]");
    process.exit(2);
  }
  const result = summarize(
    JSON.parse(readFileSync(reportPath, "utf8")),
    JSON.parse(readFileSync(budgetPath, "utf8")),
  );
  const md = markdown(result);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(result.failures.length ? 1 : 0);
}
