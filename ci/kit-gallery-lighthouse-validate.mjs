// Admission and budget checks for raw gallery Lighthouse reports. This checks
// report metadata and LHCI assertions, not authenticity of the report producer.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sampleMatrix } = require("./lighthouse-samples.cjs");

export function validateGalleryReports(reports, config, getAllAssertionResults) {
  const { collect, assert } = config.ci;
  if (!Array.isArray(reports) || reports.length !== collect.url.length * collect.numberOfRuns)
    throw new Error("incorrect Lighthouse report count");
  const matrix = sampleMatrix(reports, collect);
  // The shared matrix permits same-origin redirects, but an unrelated page on
  // the gallery server cannot supply performance evidence for the gallery.
  if (
    !matrix.complete ||
    Object.keys(matrix.rejectionCounts).length ||
    matrix.rows.some((row) => row.runs.length !== row.quota) ||
    reports.some(
      (report) =>
        report.finalUrl !== report.requestedUrl ||
        (report.finalDisplayedUrl !== undefined &&
          report.finalDisplayedUrl !== report.requestedUrl),
    )
  )
    throw new Error("invalid Lighthouse navigation identity or profile");

  // Do not silently ignore assertion options that alter LHCI evaluation. Keep
  // this allowlist aligned with the inherited profiles, and review additions.
  for (const [key, entry] of Object.entries(assert.assertions)) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !["error", "warn"].includes(entry[0]) ||
      !entry[1] ||
      typeof entry[1] !== "object" ||
      Array.isArray(entry[1])
    )
      throw new Error(`unsupported Lighthouse assertion: ${key}`);
    const options = entry[1];
    const thresholds = ["minScore", "maxNumericValue"].filter(
      (name) => options[name] !== undefined,
    );
    if (
      Object.keys(options).some(
        (name) => !["minScore", "maxNumericValue", "aggregationMethod"].includes(name),
      ) ||
      !["median", "median-run"].includes(options.aggregationMethod) ||
      thresholds.length !== 1 ||
      !Number.isFinite(options[thresholds[0]]) ||
      (thresholds[0] === "minScore" && (options.minScore < 0 || options.minScore > 1))
    )
      throw new Error(`unsupported Lighthouse assertion options: ${key}`);
  }

  // Require the inputs to every configured assertion on every sample. Missing
  // values must not become a passing median or a silently omitted assertion.
  for (const report of reports) {
    for (const [key, [, options]] of Object.entries(assert.assertions)) {
      if (key.startsWith("categories:")) {
        const score = report.categories?.[key.slice("categories:".length)]?.score;
        if (!Number.isFinite(score) || score < 0 || score > 1)
          throw new Error(`missing Lighthouse category: ${key}`);
      } else {
        const audit = report.audits?.[key];
        if (
          !audit ||
          (options.maxNumericValue !== undefined && !Number.isFinite(audit.numericValue)) ||
          (options.minScore !== undefined &&
            (!Number.isFinite(audit.score) || audit.score < 0 || audit.score > 1))
        )
          throw new Error(`missing Lighthouse audit: ${key}`);
      }
    }
  }
  // LHCI omits passing results by default, making a clean run indistinguishable
  // from an assertion engine that evaluated nothing.
  const results = getAllAssertionResults(
    { assertions: assert.assertions, includePassedAssertions: true },
    reports,
  );
  if (
    !Array.isArray(results) ||
    results.length === 0 ||
    results.some(
      (result) =>
        !result ||
        typeof result !== "object" ||
        typeof result.passed !== "boolean" ||
        !["error", "warn", "off"].includes(result.level) ||
        (result.level === "error" && !result.passed),
    )
  )
    throw new Error("Lighthouse assertions failed or were malformed");
  // LHCI identifies category results by auditId plus auditProperty, and the
  // threshold by name. Check every configured threshold for every final URL;
  // a nonempty but incomplete result array is not evidence of evaluation.
  for (const url of new Set(reports.map((report) => report.finalUrl))) {
    for (const [key, [level, options]] of Object.entries(assert.assertions)) {
      const [auditId, auditProperty] = key.split(":");
      const thresholds = ["minScore", "maxNumericValue"].filter(
        (name) => options[name] !== undefined,
      );
      if (level === "off" || thresholds.length === 0 || key.split(":").length > 2)
        throw new Error(`unsupported Lighthouse assertion: ${key}`);
      for (const name of thresholds) {
        const matches = results.filter(
          (result) =>
            result.url === url &&
            result.auditId === auditId &&
            result.auditProperty === auditProperty &&
            result.name === name &&
            result.level === level &&
            result.expected === options[name],
        );
        if (matches.length !== 1)
          throw new Error(`incomplete Lighthouse assertion: ${key} ${name}`);
      }
    }
  }
  return { reports, assertions: results };
}
