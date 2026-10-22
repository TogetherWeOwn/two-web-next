// Legacy public-page thresholds and mid-range phone profile.
// Threshold changes need a separate owner-approved PR, never a green-build fix. The mobile performance
// category floor comes from ci/quality-budget.json (owner-approved web quality gate, 2026-10-10).
const budget = require("./quality-budget.json");
const paths = [
  "/",
  "/events",
  "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "/join",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
  "/members/100000000000000111/links",
];

module.exports = {
  ci: {
    collect: {
      url: paths.map((path) => `http://127.0.0.1:8787${path}`),
      startServerCommand: "node ci/lighthouse-admission.cjs",
      startServerReadyPattern: "Lighthouse fixture content admitted",
      startServerReadyTimeout: 60000,
      numberOfRuns: 3,
      settings: {
        chromeFlags: "--no-sandbox --disable-dev-shm-usage",
        formFactor: "mobile",
        screenEmulation: {
          mobile: true,
          width: 412,
          height: 823,
          deviceScaleFactor: 1.75,
          disabled: false,
        },
        throttlingMethod: "simulate",
        throttling: {
          rttMs: 150,
          throughputKbps: 1638.4,
          cpuSlowdownMultiplier: 4,
          requestLatencyMs: 562.5,
          downloadThroughputKbps: 1474.56,
          uploadThroughputKbps: 675,
        },
        onlyCategories: ["performance"],
        skipAudits: ["uses-http2", "canonical"],
      },
    },
    assert: {
      assertions: {
        "categories:performance": [
          "error",
          { minScore: budget.mobilePerformance, aggregationMethod: "median-run" },
        ],
        "largest-contentful-paint": [
          "error",
          { maxNumericValue: 2000, aggregationMethod: "median" },
        ],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1, aggregationMethod: "median" }],
        "server-response-time": ["error", { maxNumericValue: 600, aggregationMethod: "median" }],
        "total-blocking-time": ["error", { maxNumericValue: 200, aggregationMethod: "median" }],
        "first-contentful-paint": ["warn", { maxNumericValue: 1800, aggregationMethod: "median" }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: "./.lighthouseci/reports",
      reportFilenamePattern: "%%PATHNAME%%-report.%%EXTENSION%%",
    },
  },
};
