"use strict";

// Supported-LHR navigation identity and collection-mode match.
//
// A sample is one independent configuration-matched navigation, identified by
// its canonical requested URL plus its navigation timestamp (fetchTime).
// Reusing the same navigation is not made distinct by object identity,
// filenames, changed scores, audit values or changed duration. Distinct
// navigation timestamps with equal scores and durations remain valid.
//
// Required navigation metadata (native Lighthouse fields, not invented IDs):
//   - gatherMode: "navigation" (timespan and missing modes are rejected)
//   - fetchTime: full UTC ISO with time (e.g. 2026-10-24T12:00:01.000Z);
//     missing, null, numeric, unparseable, calendar-invalid (2026-02-30) and
//     date-only values are rejected
//   - requestedUrl: explicit valid URL (no fallback to finalUrl); the request
//     owns its quota slot, and same-origin redirects stay with their request
//   - timing: object with positive finite total and an entries array
//   - configSettings: resolved settings matching the already-selected
//     desktop/mobile collection mode (form factor, screen emulation, throttling
//     method and simulation values, selected categories, skipped audits)
//
// This is admission validation, not cryptographic authenticity or resistance
// to fabricated LHR metadata.
//
// Rejection codes (bounded, stable, safe to log):
//   duplicate_navigation, invalid_identity, invalid_timing,
//   settings_mismatch, invalid_report, unplanned_request, invalid_redirect
// Counts are positive integers; absent codes are omitted. Diagnostics carry
// bounded counts plus a safe next_action and never include report bodies,
// query values, headers, snippets or absolute paths.

// Collection evidence is keyed by the configured URL, never by pathname or by
// upload's median files. A redirect belongs to its request, not its destination.
function reportUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// Full UTC ISO with time: 2026-10-24T12:00:01.000Z (milliseconds optional but
// the trailing Z and the time part are required). Calendar-invalid dates like
// 2026-02-30 parse in JS by rolling over to March, so the value must
// round-trip through Date to prove it names a real navigation instant.
function isValidFetchTime(value) {
  if (typeof value !== "string" || !value) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  try {
    return new Date(ms).toISOString() === value;
  } catch {
    return false;
  }
}

function isValidTiming(timing) {
  if (!timing || typeof timing !== "object" || Array.isArray(timing)) return false;
  if (!Number.isFinite(timing.total) || timing.total <= 0) return false;
  if (!Array.isArray(timing.entries)) return false;
  return true;
}

// Resolved desktop preset defaults (lighthouse/core/config/desktop-config.js
// settings, as resolved by initializeConfig("navigation", desktopConfig)):
// formFactor desktop, 1350x940, simulate, rtt 40, throughput 10240, cpu 1.
// Pinned here synchronously because sampleMatrix is a sync admission check;
// the async resolver path is covered by the fixture helper and the selftests.
const DESKTOP_PRESET_DEFAULTS = Object.freeze({
  formFactor: "desktop",
  throttlingMethod: "simulate",
  throttling: Object.freeze({ rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 }),
  screenEmulation: Object.freeze({
    mobile: false,
    width: 1350,
    height: 940,
    deviceScaleFactor: 1,
    disabled: false,
  }),
});

function sameStringSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

function expectedSettings(collect) {
  const settings = collect?.settings;
  if (!settings || typeof settings !== "object") return null;
  // Desktop: the collect settings carry preset:"desktop" plus the asserted
  // categories/skips; form factor, screen and throttling come from the
  // preset's resolved defaults, never from a `preset` field in the LHR.
  if (settings.preset === "desktop") {
    return {
      profile: "desktop",
      formFactor: DESKTOP_PRESET_DEFAULTS.formFactor,
      throttlingMethod: settings.throttlingMethod ?? DESKTOP_PRESET_DEFAULTS.throttlingMethod,
      throttling: settings.throttling ?? DESKTOP_PRESET_DEFAULTS.throttling,
      screenEmulation: settings.screenEmulation ?? DESKTOP_PRESET_DEFAULTS.screenEmulation,
      onlyCategories: settings.onlyCategories,
      skipAudits: settings.skipAudits ?? [],
      blockedUrlPatterns: settings.blockedUrlPatterns,
    };
  }
  // Mobile (and any explicit non-preset config): the collect settings are the
  // expected resolved values.
  if (!settings.formFactor && !settings.throttling && !settings.screenEmulation) return null;
  return {
    profile: settings.formFactor ?? "mobile",
    formFactor: settings.formFactor ?? "mobile",
    throttlingMethod: settings.throttlingMethod,
    throttling: settings.throttling,
    screenEmulation: settings.screenEmulation,
    onlyCategories: settings.onlyCategories,
    skipAudits: settings.skipAudits ?? [],
    blockedUrlPatterns: settings.blockedUrlPatterns,
  };
}

function settingsMatch(configSettings, expected) {
  if (!expected) return true;
  if (!configSettings || typeof configSettings !== "object" || Array.isArray(configSettings)) {
    return false;
  }
  if (configSettings.formFactor !== expected.formFactor) return false;
  if (
    expected.throttlingMethod !== undefined &&
    configSettings.throttlingMethod !== expected.throttlingMethod
  ) {
    return false;
  }
  const actualThrottle = configSettings.throttling;
  const expectedThrottle = expected.throttling;
  if (!actualThrottle || typeof actualThrottle !== "object" || Array.isArray(actualThrottle)) {
    return false;
  }
  if (!expectedThrottle || typeof expectedThrottle !== "object") return false;
  for (const key of ["rttMs", "throughputKbps", "cpuSlowdownMultiplier"]) {
    if (expectedThrottle[key] !== undefined && actualThrottle[key] !== expectedThrottle[key]) {
      return false;
    }
  }
  const actualScreen = configSettings.screenEmulation;
  const expectedScreen = expected.screenEmulation;
  if (!actualScreen || typeof actualScreen !== "object" || Array.isArray(actualScreen)) {
    return false;
  }
  if (!expectedScreen || typeof expectedScreen !== "object") return false;
  for (const key of ["mobile", "width", "height", "deviceScaleFactor", "disabled"]) {
    if (expectedScreen[key] !== undefined && actualScreen[key] !== expectedScreen[key]) {
      return false;
    }
  }
  if (expected.onlyCategories !== undefined) {
    if (!sameStringSet(configSettings.onlyCategories, expected.onlyCategories)) return false;
  }
  if (!sameStringSet(configSettings.skipAudits ?? [], expected.skipAudits ?? [])) return false;
  // Blocked patterns only constrain deployed runs that configure them; a
  // fixture run (no patterns configured) accepts the resolver default null.
  if (expected.blockedUrlPatterns !== undefined) {
    if (!sameStringSet(configSettings.blockedUrlPatterns ?? [], expected.blockedUrlPatterns)) {
      return false;
    }
  }
  return true;
}

function bump(counts, code) {
  counts[code] = (counts[code] ?? 0) + 1;
}

function nextActionFor(matrix) {
  if (matrix.complete && Object.keys(matrix.rejectionCounts).length === 0) {
    return "next_action: none; collection complete.";
  }
  if (matrix.complete) {
    const codes = Object.keys(matrix.rejectionCounts).sort().join(",");
    return `next_action: collection complete; rejected extras ignored (${codes}).`;
  }
  const codes = Object.keys(matrix.rejectionCounts).sort().join(",");
  const hint = codes ? ` (${codes})` : "";
  return (
    "next_action: collect fresh independent navigations with the configured " +
    `profile for the short routes; do not reuse report files${hint}.`
  );
}

function sampleMatrix(lhrs, collect) {
  const quota = collect.numberOfRuns;
  if (!Number.isInteger(quota) || quota < 1 || !collect.url?.length) {
    throw new Error("Lighthouse collection needs planned URLs and a positive sample quota.");
  }
  const rows = collect.url.map((value) => {
    const url = reportUrl(value);
    if (!url) throw new Error("Invalid planned Lighthouse URL.");
    return { url, quota, runs: [] };
  });
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  if (byUrl.size !== rows.length) throw new Error("Duplicate planned Lighthouse URL.");
  const categories = collect.settings?.onlyCategories ?? ["performance"];
  const expected = expectedSettings(collect);
  const rejectionCounts = {};
  const seenNavigations = new Set();
  for (const lhr of lhrs) {
    // Malformed inputs (unparsed leftovers, null, arrays, crashed runs) are
    // missing evidence with a bounded code, never a crash or a silent skip.
    if (!lhr || typeof lhr !== "object" || Array.isArray(lhr) || lhr.runtimeError) {
      bump(rejectionCounts, "invalid_report");
      continue;
    }
    // Navigation identity: explicit requested URL plus a real navigation
    // timestamp. No fallback to finalUrl: a report without its request cannot
    // prove which planned slot it fills.
    const requested = reportUrl(lhr.requestedUrl);
    if (lhr.gatherMode !== "navigation" || !isValidFetchTime(lhr.fetchTime) || !requested) {
      bump(rejectionCounts, "invalid_identity");
      continue;
    }
    if (!isValidTiming(lhr.timing)) {
      bump(rejectionCounts, "invalid_timing");
      continue;
    }
    if (!settingsMatch(lhr.configSettings, expected)) {
      bump(rejectionCounts, "settings_mismatch");
      continue;
    }
    if (
      !categories.every((category) => {
        const score = lhr.categories?.[category]?.score;
        return Number.isFinite(score) && score >= 0 && score <= 1;
      })
    ) {
      bump(rejectionCounts, "invalid_report");
      continue;
    }
    const row = byUrl.get(requested);
    if (!row) {
      bump(rejectionCounts, "unplanned_request");
      continue;
    }
    // Same-origin redirects are valid evidence. Malformed/foreign destinations
    // are not, even if another URL field happens to match the plan.
    if (
      [lhr.finalUrl, lhr.finalDisplayedUrl].some((value) => {
        if (value === undefined) return false;
        const final = reportUrl(value);
        return !final || new URL(final).origin !== new URL(requested).origin;
      })
    ) {
      bump(rejectionCounts, "invalid_redirect");
      continue;
    }
    // One navigation fills one quota slot: the same requested URL plus the
    // same navigation timestamp is a duplicate even when scores, audits,
    // durations or filenames differ.
    const identity = `${requested} ${lhr.fetchTime}`;
    if (seenNavigations.has(identity)) {
      bump(rejectionCounts, "duplicate_navigation");
      continue;
    }
    seenNavigations.add(identity);
    row.runs.push(lhr);
  }
  const matrix = { rows, complete: rows.every((row) => row.runs.length >= row.quota) };
  matrix.rejectionCounts = rejectionCounts;
  matrix.next_action = nextActionFor(matrix);
  return matrix;
}

function evidenceLines(matrix) {
  const lines = matrix.rows.map(
    ({ url, quota, runs }) =>
      `- ${url}: ${runs.length}/${quota} runs${runs.length === 0 ? " (no run completed)" : ""}`,
  );
  const counts = matrix.rejectionCounts ?? {};
  const codes = Object.keys(counts).sort();
  if (codes.length > 0) {
    const summary = codes.map((code) => `${code}=${counts[code]}`).join(", ");
    lines.push(`- rejected: ${summary}`);
  }
  const action = matrix.next_action ?? nextActionFor(matrix);
  // Bounded by construction: counts and one fixed remediation line, never
  // report contents. Callers slice defensively anyway.
  lines.push(`- ${action}`);
  return lines;
}

// LHCI assertions can name a final URL shared by multiple requested URLs. Fan
// out to all affected requests rather than overwriting the earlier mapping.
function assertionsByUrl(matrix, assertions) {
  const targets = new Map();
  for (const row of matrix.rows) {
    for (const url of [
      row.url,
      ...row.runs.flatMap((lhr) => [lhr.finalUrl, lhr.finalDisplayedUrl]),
    ]) {
      const key = reportUrl(url);
      if (!key) continue;
      if (!targets.has(key)) targets.set(key, new Set());
      targets.get(key).add(row.url);
    }
  }
  const failures = new Map(matrix.rows.map((row) => [row.url, []]));
  for (const failure of assertions) {
    if (failure.passed === true) continue;
    const urls = targets.get(reportUrl(failure.url));
    for (const url of urls ?? []) failures.get(url).push(failure);
  }
  return failures;
}

// Read-only fixture verification: count top-level per-run reports without
// clearing, rewriting, archiving or launching anything. Nested attempt
// archives are never read as current evidence. Malformed files get a bounded
// invalid_report count rather than disappearing from diagnostics.
function checkFixtureDirectory(dir, collect, profile) {
  const { readdirSync, readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const LHR_FILE_REGEX = /^lhr-\d+\.json$/;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const lhrs = [];
  let invalidReports = 0;
  for (const name of names.sort()) {
    if (!LHR_FILE_REGEX.test(name)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      invalidReports += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      invalidReports += 1;
      continue;
    }
    lhrs.push(parsed);
  }
  const matrix = sampleMatrix(lhrs, collect);
  const rejectionCounts = { ...matrix.rejectionCounts };
  if (invalidReports > 0) {
    rejectionCounts.invalid_report = (rejectionCounts.invalid_report ?? 0) + invalidReports;
  }
  const withLoader = { ...matrix, rejectionCounts };
  withLoader.next_action = nextActionFor(withLoader);
  const rows = withLoader.rows.map(({ url, quota, runs }) => ({
    url,
    quota,
    runs: runs.length,
  }));
  return {
    schemaVersion: 1,
    profile,
    code: withLoader.complete ? "collection_complete" : "incomplete_collection",
    complete: withLoader.complete,
    rows,
    rejectionCounts,
    next_action: withLoader.next_action.replace(/^next_action:\s*/, ""),
  };
}

// Strict check-fixture flag parsing: exactly --check-fixture <dir> --format
// json, no collection overrides, no unknown flags. Returns { ok, dir } or
// { ok: false }. Callers fail with invalid_arguments before any collection or
// network action.
function parseCheckFixtureArgs(flags) {
  if (!Array.isArray(flags) || flags.length !== 4) return { ok: false };
  const [check, dir, format, value] = flags;
  if (check !== "--check-fixture" || format !== "--format" || value !== "json") {
    return { ok: false };
  }
  if (typeof dir !== "string" || !dir || dir.startsWith("--")) return { ok: false };
  return { ok: true, dir };
}

function invalidArgumentsResult(profile) {
  return {
    schemaVersion: 1,
    profile,
    code: "invalid_arguments",
    complete: false,
    rows: [],
    rejectionCounts: {},
    next_action:
      "check fixture flags: --check-fixture <directory> --format json; no collection overrides.",
  };
}

module.exports = {
  reportUrl,
  sampleMatrix,
  evidenceLines,
  assertionsByUrl,
  isValidFetchTime,
  isValidTiming,
  expectedSettings,
  settingsMatch,
  nextActionFor,
  checkFixtureDirectory,
  parseCheckFixtureArgs,
  invalidArgumentsResult,
};
