#!/usr/bin/env node
// OWASP ZAP baseline gate (docs/zap-baseline.md).
//   node ci/zap-gate.mjs <zap traditional-json report> [budget json]
// Fails on any High alert, and on Medium/Low alert counts above the committed
// budget in ci/zap-budget.json (null = not yet enforced, counts reported only).
// Budgets only ratchet down; raising one is its own reviewed PR.
// Fail-closed: missing/malformed scan evidence, unknown risk codes and invalid
// budgets fail instead of passing. High alerts are never ignorable.
// The repo is public: the summary names alerts and counts only, never the
// affected URLs, parameters or evidence, and the full report is never uploaded.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RISK = { 3: "High", 2: "Medium", 1: "Low", 0: "Informational" };
const VALID_RISKS = new Set([0, 1, 2, 3]);

function safeId(value, fallback) {
  const s = String(value ?? fallback ?? "").slice(0, 32);
  return s.trim() === "" ? String(fallback ?? "unknown").slice(0, 32) : s;
}

function parseRisk(raw) {
  // Accept only integer 0-3 as number or numeric string. Reject missing,
  // booleans, empty strings, floats and out-of-range codes fail closed.
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "boolean") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || !VALID_RISKS.has(n)) return null;
  // Reject float-like strings ("2.0") that coerce to int but are not clean codes.
  if (typeof raw === "string" && String(n) !== raw.trim()) {
    // Allow leading zeros? ZAP emits "3", "2", "1", "0" only; be strict.
    return null;
  }
  return n;
}

function parseCount(raw, instancesLength) {
  if (raw === undefined || raw === null) {
    return instancesLength ?? 1;
  }
  if (typeof raw === "boolean") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  if (typeof raw === "string" && String(n) !== raw.trim()) return null;
  return n;
}

function parseHttpUri(raw) {
  // Do not coerce values, resolve relative paths, or let URL repair whitespace
  // and backslashes into apparent evidence. Unproved URIs remain non-exempt.
  if (
    typeof raw !== "string" ||
    !/^https?:\/\/[^/]/i.test(raw) ||
    /[\u0000- \u007f\s\\]/.test(raw) ||
    /%(?![\da-f]{2})/i.test(raw)
  ) {
    return null;
  }
  try {
    const uri = new URL(raw);
    return uri.username || uri.password ? null : uri;
  } catch {
    return null;
  }
}

function validateBudget(budget, failures) {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    failures.push("invalid budget: budget must be an object with maxMedium and maxLow");
    return { valid: false, ignoreByPlugin: new Map() };
  }
  let valid = true;
  for (const key of ["maxMedium", "maxLow"]) {
    const v = budget[key];
    if (v === null) continue; // Explicit report-only, still supported.
    if (!Number.isInteger(v) || v < 0) {
      failures.push(`invalid budget: ${key} must be null or a non-negative integer`);
      valid = false;
    }
  }
  const ignoreByPlugin = new Map();
  if (budget.ignore === undefined) return { valid, ignoreByPlugin };
  if (!Array.isArray(budget.ignore)) {
    failures.push("invalid budget: ignore must be an array");
    return { valid: false, ignoreByPlugin: new Map() };
  }
  for (let i = 0; i < budget.ignore.length; i++) {
    const entry = budget.ignore[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      failures.push(`invalid budget: ignore entry ${i} must be an object`);
      valid = false;
      continue;
    }
    const rawPid = entry.pluginId;
    if (rawPid === undefined || rawPid === null || String(rawPid).trim() === "") {
      failures.push(`invalid budget: ignore entry ${i} needs a pluginId`);
      valid = false;
      continue;
    }
    if (typeof entry.why !== "string" || entry.why.trim() === "") {
      failures.push(`invalid budget: ignore entry ${i} needs a why`);
      valid = false;
      continue;
    }
    if (entry.uriPrefix !== undefined && typeof entry.uriPrefix !== "string") {
      failures.push(`invalid budget: ignore entry ${i} uriPrefix must be a string`);
      valid = false;
      continue;
    }
    const key = String(rawPid);
    if (!ignoreByPlugin.has(key)) ignoreByPlugin.set(key, []);
    ignoreByPlugin.get(key).push(entry);
  }
  return { valid, ignoreByPlugin };
}

export function summarize(report, budget) {
  const failures = [];
  const { ignoreByPlugin } = validateBudget(budget, failures);

  const alerts = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    failures.push("invalid scan evidence: report must be an object with a site array");
    return { alerts, counts: { 3: 0, 2: 0, 1: 0, 0: 0 }, failures, siteCount: 0 };
  }
  if (!Array.isArray(report.site)) {
    failures.push("invalid scan evidence: report must be an object with a site array");
    return { alerts, counts: { 3: 0, 2: 0, 1: 0, 0: 0 }, failures, siteCount: 0 };
  }
  const siteCount = report.site.length;
  for (let si = 0; si < report.site.length; si++) {
    const site = report.site[si];
    if (!site || typeof site !== "object" || Array.isArray(site) || !Array.isArray(site.alerts)) {
      failures.push(`invalid scan evidence: site ${si} must hold an alerts array`);
      continue;
    }
    for (let ai = 0; ai < site.alerts.length; ai++) {
      const alert = site.alerts[ai];
      if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
        failures.push(`invalid scan evidence: site ${si} alert ${ai} is malformed`);
        continue;
      }
      const rawPid = alert.pluginid ?? alert.alertRef;
      if (rawPid === undefined || rawPid === null || String(rawPid).trim() === "") {
        failures.push(`invalid scan evidence: site ${si} alert ${ai} is missing plugin identity`);
        continue;
      }
      const pluginId = String(rawPid);
      const label = safeId(pluginId, `site ${si} alert ${ai}`);
      const risk = parseRisk(alert.riskcode);
      if (risk === null) {
        failures.push(`invalid scan evidence: alert ${label} has an unknown risk code`);
        continue;
      }
      if (
        "instances" in alert &&
        alert.instances !== undefined &&
        !Array.isArray(alert.instances)
      ) {
        failures.push(`invalid scan evidence: alert ${label} has malformed instances`);
        continue;
      }
      const instances = Array.isArray(alert.instances) ? alert.instances : undefined;
      if (
        instances &&
        instances.some((inst) => !inst || typeof inst !== "object" || Array.isArray(inst))
      ) {
        failures.push(`invalid scan evidence: alert ${label} has malformed instances`);
        continue;
      }
      const count = parseCount(alert.count ?? alert.instances?.length ?? 1, undefined);
      if (count === null) {
        failures.push(`invalid scan evidence: alert ${label} has an invalid count`);
        continue;
      }
      const name = String(alert.name ?? alert.alert ?? "unknown").slice(0, 200);

      // High alerts are never ignorable: scoped or unscoped ignores do not apply.
      if (risk === 3) {
        alerts.push({ pluginId, name, risk, count });
        continue;
      }

      const entries = ignoreByPlugin.get(pluginId) ?? [];
      // Unscoped entries ignore the whole alert (legacy behavior, Medium/Low only).
      if (entries.some((entry) => !entry.uriPrefix)) continue;
      // Scoped subtraction needs a declared count and a complete instance list.
      // Reject inconsistent evidence rather than silently losing unseen residuals.
      if (entries.length > 0 && Array.isArray(instances) && instances.length > 0) {
        if (
          !["string", "number"].includes(typeof alert.count) ||
          !Number.isSafeInteger(count) ||
          count !== instances.length
        ) {
          failures.push(
            `invalid scan evidence: site ${si} alert ${ai} needs a complete declared instance count for scoped exemption`,
          );
          continue;
        }
        const siteUri = parseHttpUri(site["@name"]);
        const remaining = instances.filter((instance) => {
          const uri = parseHttpUri(instance.uri);
          return !(
            siteUri &&
            uri &&
            uri.origin === siteUri.origin &&
            entries.some((entry) => uri.pathname.startsWith(entry.uriPrefix))
          );
        });
        if (remaining.length === 0) continue;
        alerts.push({ pluginId, name, risk, count: remaining.length });
        continue;
      }
      alerts.push({
        pluginId,
        name,
        risk,
        count,
      });
    }
  }
  const counts = { 3: 0, 2: 0, 1: 0, 0: 0 };
  for (const a of alerts) counts[a.risk] = (counts[a.risk] ?? 0) + 1;
  if (counts[3] > 0) failures.push(`${counts[3]} High alert type(s); High is never allowed`);
  for (const [risk, key] of [
    [2, "maxMedium"],
    [1, "maxLow"],
  ]) {
    const max = budget?.[key];
    if (
      max !== null &&
      max !== undefined &&
      Number.isInteger(max) &&
      max >= 0 &&
      counts[risk] > max
    ) {
      failures.push(`${counts[risk]} ${RISK[risk]} alert type(s) > budget ${key}=${max}`);
    }
  }
  return { alerts, counts, failures, siteCount };
}

export function markdown({ alerts, counts, failures, siteCount }) {
  const rows = alerts
    .sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name))
    .map((a) => `| ${RISK[a.risk] ?? a.risk} | ${a.pluginId} | ${a.name} | ${a.count} |`);
  const scanned =
    Number.isInteger(siteCount) && siteCount >= 0 ? `Scanned ${siteCount} site(s)` : null;
  return [
    "## ZAP baseline (staging, passive)",
    "",
    `High ${counts[3]} · Medium ${counts[2]} · Low ${counts[1]} · Info ${counts[0]} (alert types)`,
    ...(scanned ? [scanned] : []),
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
  let report;
  let budget;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    console.error("invalid scan evidence: report file is missing or not valid JSON");
    process.exit(1);
  }
  try {
    budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  } catch {
    console.error("invalid budget: budget file is missing or not valid JSON");
    process.exit(1);
  }
  const result = summarize(report, budget);
  const md = markdown(result);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(result.failures.length ? 1 : 0);
}
