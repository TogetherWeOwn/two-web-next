// Web quality gate (owner request 2026-10-10): Lighthouse category scores on the same fixture worker and
// routes as ci/lighthouserc.cjs (which keeps the mobile performance metrics). Desktop preset, 3 runs, median.
// Minimum scores live in ci/quality-budget.json so a loosening is a visible, reviewed diff.
// QUALITY_ORIGIN=<allowlisted origin> measures a deployed site instead (staging after every deploy, nightly drift):
// the DB-free routes only, since the fixture event key exists only on the fixture worker.
const base = require("./lighthouserc.cjs").ci;
const budget = require("./quality-budget.json");
const { requireAllowedOrigin } = require("./lighthouse-origin-lib.cjs");

const deployed = process.env.QUALITY_ORIGIN
  ? requireAllowedOrigin(process.env.QUALITY_ORIGIN)
  : null;
const collect = deployed
  ? {
      url: ["/", "/events", "/join", "/about", "/faq", "/rules", "/privacy"].map(
        (p) => deployed + p,
      ),
      numberOfRuns: base.collect.numberOfRuns,
    }
  : base.collect;

const assertions = {};
for (const [category, minScore] of Object.entries(budget.categories)) {
  assertions[`categories:${category}`] = ["error", { minScore, aggregationMethod: "median-run" }];
}

// Deployed staging sits behind the platform bot-management script (cdn-cgi
// challenge bundle), which trips the third-party `deprecations` audit on every
// route. Skip it on deployed-origin runs only; fixture-worker runs keep the
// strict audit so app-code regressions still fail. Category floors in
// quality-budget.json are untouched.
const baseSkipAudits = ["uses-http2", "canonical", "is-crawlable"];
const skipAudits = deployed ? [...baseSkipAudits, "deprecations"] : baseSkipAudits;

module.exports = {
  ci: {
    collect: {
      ...collect,
      settings: {
        preset: "desktop",
        chromeFlags: "--no-sandbox --disable-dev-shm-usage",
        onlyCategories: Object.keys(budget.categories),
        // is-crawlable: the fixture worker and staging send X-Robots-Tag noindex by design (src/headers.ts,
        // test/events.test.ts); production indexability is covered by those unit tests, not by this gate.
        skipAudits,
      },
    },
    assert: { assertions },
    upload: {
      target: "filesystem",
      outputDir: "./.lighthouseci/quality",
      reportFilenamePattern: "%%PATHNAME%%-report.%%EXTENSION%%",
    },
  },
};
