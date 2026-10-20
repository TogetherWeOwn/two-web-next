"use strict";

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
  for (const lhr of lhrs) {
    if (!lhr || typeof lhr !== "object" || lhr.runtimeError) continue;
    const requested = reportUrl(lhr.requestedUrl ?? lhr.finalUrl ?? lhr.finalDisplayedUrl);
    const row = byUrl.get(requested);
    if (!row) continue;
    if (
      !categories.every((category) => {
        const score = lhr.categories?.[category]?.score;
        return Number.isFinite(score) && score >= 0 && score <= 1;
      })
    )
      continue;
    // Same-origin redirects are valid evidence. Malformed/foreign destinations
    // are not, even if another URL field happens to match the plan.
    if (
      [lhr.finalUrl, lhr.finalDisplayedUrl].some((value) => {
        if (value === undefined) return false;
        const final = reportUrl(value);
        return !final || new URL(final).origin !== new URL(requested).origin;
      })
    )
      continue;
    row.runs.push(lhr);
  }
  return { rows, complete: rows.every((row) => row.runs.length >= row.quota) };
}

function evidenceLines(matrix) {
  return matrix.rows.map(
    ({ url, quota, runs }) =>
      `- ${url}: ${runs.length}/${quota} runs${runs.length === 0 ? " (no run completed)" : ""}`,
  );
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

module.exports = { reportUrl, sampleMatrix, evidenceLines, assertionsByUrl };
