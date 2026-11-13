import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { navigationMetadata } from "../test/lighthouse-navigation-fixtures.mjs";
import { validateGalleryReports } from "./kit-gallery-lighthouse-validate.mjs";

const require = createRequire(import.meta.url);
const { galleryConfig } = require("./kit-gallery-lighthouse-config.cjs");
const { getAllAssertionResults } = require("@lhci/utils/src/assertions.js");
const url = "http://127.0.0.1:4173/archive";

function report(mode, config) {
  const categories = {};
  const audits = {};
  for (const key of Object.keys(config.ci.assert.assertions)) {
    if (key.startsWith("categories:")) categories[key.slice(11)] = { score: 1 };
    else audits[key] = { score: 1, numericValue: 0 };
  }
  return {
    ...navigationMetadata(mode),
    requestedUrl: url,
    finalUrl: url,
    finalDisplayedUrl: url,
    categories,
    audits,
  };
}

for (const mode of ["mobile", "desktop"]) {
  test(`${mode} gallery reports require independent matching samples and budgets`, () => {
    const config = galleryConfig(mode, url);
    const reports = Array.from({ length: config.ci.collect.numberOfRuns }, () =>
      report(mode, config),
    );
    const validate = (input) => validateGalleryReports(input, config, getAllAssertionResults);
    assert.doesNotThrow(() => validate(reports));
    const actualResults = getAllAssertionResults(
      { assertions: config.ci.assert.assertions, includePassedAssertions: true },
      reports,
    );
    for (let index = 0; index < actualResults.length; index++) {
      assert.throws(
        () =>
          validateGalleryReports(reports, config, () =>
            actualResults.filter((_, i) => i !== index),
          ),
        /incomplete|malformed/,
      );
    }
    for (const mutation of [
      (options) => {
        options.unrecognized = true;
      },
      (options) => {
        options.aggregationMethod = "optimistic";
      },
      (options) => {
        delete options.aggregationMethod;
      },
      (options) => {
        options.minScore = Number.NaN;
      },
    ]) {
      const unsupported = structuredClone(config);
      mutation(Object.values(unsupported.ci.assert.assertions)[0][1]);
      assert.throws(
        () => validateGalleryReports(reports, unsupported, getAllAssertionResults),
        /unsupported Lighthouse assertion/,
      );
    }
    const wrongThreshold = structuredClone(actualResults);
    wrongThreshold[0].expected += 1;
    assert.throws(
      () => validateGalleryReports(reports, config, () => wrongThreshold),
      /incomplete/,
    );
    assert.throws(
      () =>
        validateGalleryReports(reports, config, (options) => {
          assert.equal(options.includePassedAssertions, true);
          return [];
        }),
      /malformed/,
    );
    for (const results of [[], [{}], [{ level: "error" }], [{ level: "unknown", passed: true }]]) {
      assert.throws(() => validateGalleryReports(reports, config, () => results), /malformed/);
    }
    assert.throws(() => validate(reports.slice(1)), /count/);
    assert.throws(() => validate([...reports, reports[0]]), /count/);
    assert.throws(() => validate(reports.map(() => reports[0])), /identity or profile/);
    const foreign = structuredClone(reports);
    foreign[0].requestedUrl = "http://127.0.0.1:4173/other";
    assert.throws(() => validate(foreign), /identity or profile/);
    const missingFinalUrl = structuredClone(reports);
    delete missingFinalUrl[0].finalUrl;
    assert.throws(() => validate(missingFinalUrl), /identity or profile/);
    for (const field of ["finalUrl", "finalDisplayedUrl"]) {
      const redirected = structuredClone(reports);
      redirected[0][field] = "http://127.0.0.1:4173/other";
      assert.throws(() => validate(redirected), /identity or profile/);
    }
    const wrongProfile = structuredClone(reports);
    wrongProfile[0].configSettings.formFactor = mode === "mobile" ? "desktop" : "mobile";
    assert.throws(() => validate(wrongProfile), /identity or profile/);
    if (mode === "mobile") {
      for (const value of [undefined, null, "0", Number.NaN]) {
        const malformed = structuredClone(reports);
        malformed[0].audits["largest-contentful-paint"].numericValue = value;
        assert.throws(() => validate(malformed), /missing Lighthouse audit/);
      }
    }
    const failed = structuredClone(reports);
    if (mode === "mobile") {
      for (const item of failed) item.audits["largest-contentful-paint"].numericValue = 10000;
    } else {
      for (const item of failed) item.categories.performance.score = 0;
    }
    assert.throws(() => validate(failed), /assertions failed/);
  });
}
