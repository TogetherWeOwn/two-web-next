// Legacy public-page thresholds and mid-range phone profile, unchanged.
// Threshold changes need a separate owner-approved PR, never a green-build fix.
const paths = ["/", "/events", "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV", "/join", "/about"];

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
        "largest-contentful-paint": [
          "error",
          { maxNumericValue: 2000, aggregationMethod: "median" },
        ],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1, aggregationMethod: "median" }],
        "server-response-time": ["error", { maxNumericValue: 600, aggregationMethod: "median" }],
        "total-blocking-time": ["warn", { maxNumericValue: 300, aggregationMethod: "median" }],
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
