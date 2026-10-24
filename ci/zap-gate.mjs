#!/usr/bin/env node
// OWASP ZAP baseline gate (docs/zap-baseline.md).
//   node ci/zap-gate.mjs <report.json> [budget.json] [--format json|markdown]
// High is never exemptible. Budgets only ratchet down; raising one is its own PR.
// Only validated structured evidence decides the gate and one-rescan eligibility.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  budgetBreaches,
  canonicalInteger,
  createVerdict,
  MAX_ALERTS,
  MAX_ERRORS,
  pluginIdentity,
  publicLabel,
  readJsonFile,
  validateBudget,
} from "./zap-verdict.mjs";

const RISK = { 3: "High", 2: "Medium", 1: "Low", 0: "Informational" };

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

export function summarize(report, budget) {
  const failures = [];
  const errors = [];
  const alerts = [];
  let siteCount = 0;
  let errorsTruncated = false;
  const fail = (code, message, site_index, alert_index) => {
    if (errors.length >= MAX_ERRORS) {
      errorsTruncated = true;
      return;
    }
    errors.push({ code, ...(site_index === undefined ? {} : { site_index, alert_index }) });
    failures.push(message);
  };
  const finish = () => {
    const result = createVerdict(alerts, errors, budget);
    if (result.counts[3]) {
      failures.push(`${result.counts[3]} High alert type(s); High is never allowed`);
    }
    for (const { risk, key, max } of budgetBreaches(result.counts, budget)) {
      failures.push(`${result.counts[risk]} ${RISK[risk]} alert type(s) > budget ${key}=${max}`);
    }
    return {
      ...result,
      failures,
      siteCount,
      errors_truncated: errorsTruncated,
      evidence_complete: errors.length === 0,
    };
  };
  const ignoreByPlugin = validateBudget(budget, fail);
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    !Array.isArray(report.site) ||
    report.site.length > MAX_ALERTS
  ) {
    fail("invalid_report", "invalid scan evidence: report must hold a bounded site array");
    return finish();
  }
  siteCount = report.site.length;
  let seen = 0;
  for (let si = 0; si < report.site.length; si++) {
    const site = report.site[si];
    if (!site || typeof site !== "object" || Array.isArray(site) || !Array.isArray(site.alerts)) {
      fail("invalid_site", `invalid scan evidence: site[${si}] must hold an alerts array`, si);
      continue;
    }
    seen += site.alerts.length;
    if (seen > MAX_ALERTS) {
      fail("evidence_limit", `invalid scan evidence: site[${si}] exceeds the alert limit`, si);
      break;
    }
    for (let ai = 0; ai < site.alerts.length; ai++) {
      const alert = site.alerts[ai];
      const invalid = (code, detail) =>
        fail(code, `invalid scan evidence: site[${si}] alerts[${ai}] ${detail}`, si, ai);
      if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
        invalid("invalid_alert", "is malformed");
        continue;
      }
      const pluginId = pluginIdentity(
        alert.pluginid === undefined ? alert.alertRef : alert.pluginid,
      );
      if (pluginId === null) {
        invalid("invalid_identity", "needs a canonical plugin identity");
        continue;
      }
      const risk = canonicalInteger(alert.riskcode);
      if (risk === null || risk > 3) {
        invalid("invalid_risk", "has an unknown risk code");
        continue;
      }
      if (alert.instances !== undefined && !Array.isArray(alert.instances)) {
        invalid("invalid_instances", "has malformed instances");
        continue;
      }
      const instances = alert.instances;
      if (
        instances &&
        instances.some((inst) => !inst || typeof inst !== "object" || Array.isArray(inst))
      ) {
        invalid("invalid_instances", "has malformed instances");
        continue;
      }
      const count = canonicalInteger(alert.count);
      if (count === null) {
        invalid("invalid_count", "needs a declared safe integer count");
        continue;
      }
      const row = {
        alert_id: `zap-${pluginId}`,
        plugin_id: pluginId,
        pluginId, // Existing programmatic summarizer consumers.
        name: publicLabel(pluginId),
        risk,
        count,
      };
      // High alerts are never ignorable: scoped or unscoped ignores do not apply.
      if (risk === 3) {
        alerts.push(row);
        continue;
      }
      const entries = ignoreByPlugin.get(pluginId) ?? [];
      if (entries.some((entry) => !entry.uriPrefix)) continue;
      // Preserve the same-origin, pathname and complete declared-count proofs.
      if (entries.length > 0 && instances?.length > 0) {
        if (count !== instances.length) {
          invalid(
            "incomplete_instances",
            "needs a complete declared instance count for scoped exemption",
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
        alerts.push({ ...row, count: remaining.length });
        continue;
      }
      alerts.push(row);
    }
  }
  return finish();
}

export function markdown({
  alerts,
  counts,
  failures,
  siteCount,
  evidence_complete,
  errors_truncated,
}) {
  const rows = [...alerts]
    .sort((a, b) => b.risk - a.risk || a.plugin_id.localeCompare(b.plugin_id))
    .slice(0, 25)
    .map((a) => `| ${RISK[a.risk]} | ${a.plugin_id} | ${a.name} | ${a.count} |`);
  return [
    "## ZAP baseline (staging, passive)",
    "",
    `High ${counts[3]} · Medium ${counts[2]} · Low ${counts[1]} · Info ${counts[0]} (alert types)`,
    `Scanned ${siteCount} site(s)`,
    ...(evidence_complete === false
      ? ["Evidence incomplete: counts cover validated rows only."]
      : []),
    "",
    failures.length ? `**FAIL:** ${failures.slice(0, 10).join("; ")}` : "**PASS**",
    ...(failures.length > 10 || errors_truncated
      ? ["Additional fixed diagnostics omitted; consult the JSON verdict."]
      : []),
    "",
    "| Risk | Plugin | Alert | Instances |",
    "| --- | --- | --- | --- |",
    ...rows,
    ...(alerts.length > 25 ? ["Additional alert rows omitted; consult the JSON verdict."] : []),
    "",
  ].join("\n");
}

function publicVerdict(result) {
  const { failures: _failures, siteCount, alerts, ...rest } = result;
  return {
    ...rest,
    site_count: siteCount,
    alerts: alerts.map(({ pluginId: _pluginId, ...row }) => row),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const paths = [];
  let format = "markdown";
  let seenFormat = false;
  let invalidArgs = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && !seenFormat) {
      seenFormat = true;
      format = args[++i];
      if (!["json", "markdown"].includes(format)) invalidArgs = true;
    } else if (args[i].startsWith("-")) {
      invalidArgs = true;
    } else {
      paths.push(args[i]);
    }
  }
  let result;
  let exit;
  if (invalidArgs || paths.length < 1 || paths.length > 2) {
    result = {
      ...summarize({ site: [] }, { maxMedium: null, maxLow: null }),
      verdict: "FAIL",
      retryable: false,
      error_code: "invalid_arguments",
      next_action: "check_usage",
      errors: [{ code: "invalid_arguments" }],
      failures: [
        "usage: node ci/zap-gate.mjs <report.json> [budget.json] [--format json|markdown]",
      ],
    };
    exit = 2;
  } else {
    let report;
    let budget;
    try {
      report = readJsonFile(paths[0]);
      budget = readJsonFile(paths[1] ?? "ci/zap-budget.json");
      result = summarize(report, budget);
    } catch {
      result = summarize(null, { maxMedium: null, maxLow: null });
    }
    exit = result.verdict === "PASS" ? 0 : 1;
  }
  let md = markdown(result);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    } catch {
      if (exit !== 2) {
        // Rebuild from named fields instead of `...result`: a self-spread
        // rebinds the same keys here, but the static timeout-ledger check
        // cannot resolve a variable spread into its own rebinding.
        const prior = result;
        result = {
          ...createVerdict(
            prior.alerts,
            [...prior.errors.slice(0, MAX_ERRORS - 1), { code: "summary_unavailable" }],
            null,
          ),
          failures: [...prior.failures, "invalid scan evidence: summary output unavailable"],
          siteCount: prior.siteCount,
          errors_truncated: prior.errors_truncated,
          evidence_complete: false,
        };
        md = markdown(result);
        exit = 1;
      }
      console.error("ZAP summary unavailable; repair the summary destination before continuing.");
    }
  }
  const jsonRequested =
    format === "json" || args.some((arg, i) => arg === "--format" && args[i + 1] === "json");
  console.log(jsonRequested ? JSON.stringify(publicVerdict(result)) : md);
  process.exit(exit);
}
