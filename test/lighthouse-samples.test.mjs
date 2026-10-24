import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  loadAssertions,
  expectedLhrs,
  main as desktopMain,
} from "../ci/lighthouse-quality-run.mjs";
import { navigationMetadata } from "./lighthouse-navigation-fixtures.mjs";

const require = createRequire(import.meta.url);
const { sampleMatrix, assertionsByUrl } = require("../ci/lighthouse-samples.cjs");
const url = "https://example.test/events";
const collect = { url: [url], numberOfRuns: 1 };
const report = {
  ...navigationMetadata("mobile"),
  requestedUrl: url,
  finalUrl: url,
  finalDisplayedUrl: url,
  categories: { performance: { score: 1 } },
};
const freshReport = (overrides = {}) => ({
  ...navigationMetadata("mobile"),
  requestedUrl: url,
  finalUrl: url,
  finalDisplayedUrl: url,
  categories: { performance: { score: 1 } },
  ...overrides,
});

it.each([
  null,
  [],
  {},
  { ...report, categories: { performance: { score: null } } },
  { ...report, categories: { performance: { score: "1" } } },
  { ...report, finalUrl: null },
  { ...report, requestedUrl: `${url}?other=1` },
])("does not count malformed or unplanned report %j", (lhr) => {
  expect(sampleMatrix([lhr], collect).complete).toBe(false);
});

it("requires an explicit requested URL and never substitutes final for an unplanned request", () => {
  // Final-only reports are not navigation identity: without requestedUrl the
  // report cannot prove which planned slot it fills.
  expect(
    sampleMatrix([{ ...freshReport(), requestedUrl: undefined, finalUrl: url }], collect).complete,
  ).toBe(false);
  expect(
    sampleMatrix([{ ...freshReport(), requestedUrl: `${url}/other`, finalUrl: url }], collect)
      .complete,
  ).toBe(false);
  expect(sampleMatrix([freshReport()], collect).complete).toBe(true);
});

it("fans a final-URL error out to both its redirecting request and its planned destination", () => {
  const other = `${url}?view=compact`;
  const matrix = sampleMatrix(
    [
      { ...freshReport(), finalUrl: other, finalDisplayedUrl: other },
      { ...freshReport(), requestedUrl: other, finalUrl: other, finalDisplayedUrl: other },
    ],
    { ...collect, url: [url, other] },
  );
  const error = { url: other, level: "error", auditId: "server-response-time" };
  const failures = assertionsByUrl(matrix, [error]);
  expect(failures.get(url)).toEqual([error]);
  expect(failures.get(other)).toEqual([error]);
});

it("retains failed assertions but does not turn LHCI's passed error-level results into failures", () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(), "lh-assertions-"));
  try {
    const failed = { url, level: "error", passed: false, auditId: "server-response-time" };
    writeFileSync(
      join(root, "assertion-results.json"),
      JSON.stringify([{ ...failed, passed: true }, failed]),
    );
    expect(loadAssertions(root)).toEqual([failed]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["passing results", JSON.stringify([{ url, level: "error", passed: true }]), 0],
  ["unreadable results", "{truncated", 1],
  [
    "failed result without a process failure",
    JSON.stringify([{ url, level: "error", passed: false }]),
    1,
  ],
])(
  "desktop admits full collection with %s truthfully without retry",
  async (_name, assertions, expected) => {
    const root = mkdtempSync(
      join(process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(), "lh-full-assertions-"),
    );
    try {
      const { collect: plan } = expectedLhrs({ env: {} });
      let calls = 0;
      const result = await desktopMain([], {
        env: {},
        lhciDir: root,
        qualityDir: join(root, "quality"),
        logFile: join(root, "collect.log"),
        diagnosisFile: join(root, "diagnosis.md"),
        log: () => {},
        run: async () => {
          calls++;
          let id = 0;
          for (const requestedUrl of plan.url) {
            for (let i = 0; i < plan.numberOfRuns; i++) {
              writeFileSync(
                join(root, `lhr-${id++}.json`),
                JSON.stringify({
                  ...navigationMetadata("desktop"),
                  requestedUrl,
                  finalUrl: requestedUrl,
                  finalDisplayedUrl: requestedUrl,
                  categories: Object.fromEntries(
                    plan.settings.onlyCategories.map((category) => [category, { score: 1 }]),
                  ),
                }),
              );
            }
          }
          writeFileSync(join(root, "assertion-results.json"), assertions);
          return { exitCode: 0, output: "fixture" };
        },
      });
      expect(result).toBe(expected);
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("does not let local empty-summary opt-in waive an existing unreadable collection file", () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(), "lh-malformed-"));
  try {
    mkdirSync(join(root, ".lighthouseci"));
    writeFileSync(join(root, ".lighthouseci/lhr-1.json"), "{truncated");
    const env = { ...process.env, LIGHTHOUSE_SUMMARY_ALLOW_EMPTY: "1" };
    delete env.QUALITY_ORIGIN;
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../ci/lighthouse-summary.mjs", import.meta.url))],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
