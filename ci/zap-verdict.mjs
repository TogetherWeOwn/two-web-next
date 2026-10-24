// Shared validated ZAP verdict contract. Report text is never policy or presentation.
import { closeSync, openSync, readSync } from "node:fs";

export function readJsonFile(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const length = readSync(fd, buffer, size, buffer.length - size, null);
      if (!length) break;
      size += length;
    }
    if (size > MAX_INPUT_BYTES) throw new Error("input_limit");
    return JSON.parse(buffer.toString("utf8", 0, size));
  } finally {
    closeSync(fd);
  }
}

export const MAX_ALERTS = 1000;
export const MAX_ERRORS = 20;
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export function canonicalInteger(raw) {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function pluginIdentity(raw) {
  const value = canonicalInteger(raw);
  return value !== null && value > 0 ? String(value) : null;
}

export function publicLabel(pluginId) {
  // Even a syntactically innocent report name may contain a URL, parameter or
  // credential. Use reviewed labels, not a blacklist over arbitrary report text.
  const labels = {
    10062: "PII Disclosure",
    10096: "Timestamp Disclosure",
    40012: "Cross Site Scripting",
  };
  return labels[pluginId] ?? `ZAP alert ${pluginId}`;
}

export function validateBudget(budget, fail) {
  const ignoreByPlugin = new Map();
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    fail("invalid_budget", "invalid budget: budget must be an object with maxMedium and maxLow");
    return ignoreByPlugin;
  }
  for (const key of ["maxMedium", "maxLow"]) {
    const value = budget[key];
    if (value === null) continue; // Explicit report-only, still supported.
    if (typeof value !== "number" || canonicalInteger(value) === null) {
      fail("invalid_budget", `invalid budget: ${key} must be null or a non-negative safe integer`);
    }
  }
  if (budget.ignore === undefined) return ignoreByPlugin;
  if (!Array.isArray(budget.ignore) || budget.ignore.length > MAX_ALERTS) {
    fail("invalid_budget", "invalid budget: ignore must be a bounded array");
    return ignoreByPlugin;
  }
  for (let i = 0; i < budget.ignore.length; i++) {
    const entry = budget.ignore[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("invalid_budget", `invalid budget: ignore entry ${i} must be an object`);
      continue;
    }
    const pluginId = pluginIdentity(entry.pluginId);
    if (pluginId === null) {
      fail("invalid_budget", `invalid budget: ignore entry ${i} needs a canonical pluginId`);
      continue;
    }
    if (typeof entry.why !== "string" || entry.why.trim() === "") {
      fail("invalid_budget", `invalid budget: ignore entry ${i} needs a why`);
      continue;
    }
    if (entry.uriPrefix !== undefined && typeof entry.uriPrefix !== "string") {
      fail("invalid_budget", `invalid budget: ignore entry ${i} uriPrefix must be a string`);
      continue;
    }
    if (!ignoreByPlugin.has(pluginId)) ignoreByPlugin.set(pluginId, []);
    ignoreByPlugin.get(pluginId).push(entry);
  }
  return ignoreByPlugin;
}

export function budgetBreaches(counts, budget) {
  return [
    [2, "maxMedium"],
    [1, "maxLow"],
  ].flatMap(([risk, key]) => {
    const max = budget?.[key];
    return typeof max === "number" && canonicalInteger(max) !== null && counts[risk] > max
      ? [{ risk, key, max }]
      : [];
  });
}

// Internal constructor: callers supply admitted rows and validation errors.
export function createVerdict(alerts, errors, budget) {
  const counts = { 3: 0, 2: 0, 1: 0, 0: 0 };
  for (const alert of alerts) counts[alert.risk]++;
  const overBudget = budgetBreaches(counts, budget).length > 0;
  const highs = alerts.filter((alert) => alert.risk === 3);
  let error_code = "ok";
  let next_action = "none";
  if (errors.length) {
    error_code = "invalid_evidence";
    next_action = "repair_evidence";
  } else if (overBudget) {
    error_code = "budget_exceeded";
    next_action = "fix_findings";
  } else if (highs.length === 1 && highs[0].plugin_id === "10062") {
    error_code = "pii_high";
    next_action = "rescan_once";
  } else if (highs.length) {
    error_code = "high_alert";
    next_action = "fix_findings";
  }
  return {
    schema_version: 1,
    gate_id: "zap-baseline",
    verdict: error_code === "ok" ? "PASS" : "FAIL",
    retryable: error_code === "pii_high",
    error_code,
    next_action,
    alerts,
    errors,
    counts,
  };
}

export function validRetryVerdict(value, budget) {
  let validPolicy = true;
  validateBudget(budget, () => {
    validPolicy = false;
  });
  if (
    !validPolicy ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema_version !== 1 ||
    value.gate_id !== "zap-baseline" ||
    !Array.isArray(value.alerts) ||
    value.alerts.length > MAX_ALERTS ||
    !Array.isArray(value.errors) ||
    value.errors.length !== 0 ||
    (value.errors_truncated !== undefined && value.errors_truncated !== false) ||
    (value.evidence_complete !== undefined && value.evidence_complete !== true) ||
    (value.site_count !== undefined &&
      (typeof value.site_count !== "number" ||
        canonicalInteger(value.site_count) === null ||
        value.site_count === 0 ||
        value.site_count > MAX_ALERTS))
  ) {
    return false;
  }
  for (const alert of value.alerts) {
    if (
      !alert ||
      typeof alert !== "object" ||
      Array.isArray(alert) ||
      typeof alert.plugin_id !== "string" ||
      pluginIdentity(alert.plugin_id) !== alert.plugin_id ||
      alert.alert_id !== `zap-${alert.plugin_id}` ||
      typeof alert.risk !== "number" ||
      canonicalInteger(alert.risk) === null ||
      alert.risk > 3 ||
      typeof alert.count !== "number" ||
      canonicalInteger(alert.count) === null ||
      typeof alert.name !== "string" ||
      alert.name.length > 160 ||
      /[^ -~]/.test(alert.name)
    ) {
      return false;
    }
  }
  // Recompute under the committed budgets, not policy or retry claims supplied
  // by the file. Names and Markdown never participate in this decision.
  const expected = createVerdict(value.alerts, [], budget);
  if (
    !expected.retryable ||
    ["verdict", "retryable", "error_code", "next_action"].some(
      (key) => value[key] !== expected[key],
    )
  ) {
    return false;
  }
  if (
    value.counts !== undefined &&
    (!value.counts ||
      typeof value.counts !== "object" ||
      Array.isArray(value.counts) ||
      [0, 1, 2, 3].some((risk) => value.counts[risk] !== expected.counts[risk]))
  ) {
    return false;
  }
  return true;
}
