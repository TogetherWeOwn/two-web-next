import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { navigationMetadata } from "./lighthouse-navigation-fixtures.mjs";
import { main as desktopMain } from "../ci/lighthouse-quality-run.mjs";
import { main as mobileMain } from "../ci/lighthouse-origin-run.mjs";

// Acceptance-owned: exercise the real collectors, filesystem readers and summary
// CLI. Only LHCI/HTTP are replaced; no browser, network or database is used.
const require = createRequire(import.meta.url);
const mobileConfig = require("../ci/lighthouserc.cjs").ci;
const originLib = require("../ci/lighthouse-origin-lib.cjs");
const ORIGIN = "https://togetherweown.com";
const EVENT = "/e/01JAAAAAAAAAAAAAAAAAAAAAAA";
const ASSERTION_FAILURE = "Assertion failed. Exiting with status code 1.";
const summaryScript = fileURLToPath(new URL("../ci/lighthouse-summary.mjs", import.meta.url));

function desktopCollect(env = {}) {
  const saved = process.env.QUALITY_ORIGIN;
  try {
    if (env.QUALITY_ORIGIN) process.env.QUALITY_ORIGIN = env.QUALITY_ORIGIN;
    else delete process.env.QUALITY_ORIGIN;
    delete require.cache[require.resolve("../ci/lighthouserc.quality.cjs")];
    return structuredClone(require("../ci/lighthouserc.quality.cjs").ci.collect);
  } finally {
    if (saved === undefined) delete process.env.QUALITY_ORIGIN;
    else process.env.QUALITY_ORIGIN = saved;
    delete require.cache[require.resolve("../ci/lighthouserc.quality.cjs")];
  }
}

// Read the actual collection configuration, not either collector's completeness
// helper. Independently replace/drop only the fixture event for origin runs.
function profile(kind, deployed = false, event = true) {
  const env = deployed ? { QUALITY_ORIGIN: ORIGIN } : {};
  const collect = kind === "desktop" ? desktopCollect(env) : mobileConfig.collect;
  const urls =
    kind === "desktop"
      ? collect.url
      : collect.url.flatMap((url) => {
          const parsed = new URL(url);
          const path = parsed.pathname + parsed.search;
          return path.startsWith("/e/") ? (event ? [ORIGIN + EVENT] : []) : [ORIGIN + path];
        });
  return { kind, env, event, urls, quota: collect.numberOfRuns };
}

function report(url, changes = {}, p = { kind: "mobile" }) {
  return {
    ...navigationMetadata(p.kind, { deployed: Boolean(p.env?.QUALITY_ORIGIN) }),
    requestedUrl: url,
    finalUrl: url,
    finalDisplayedUrl: url,
    categories: Object.fromEntries(
      ["performance", "accessibility", "best-practices", "seo"].map((id) => [
        id,
        { score: 1, auditRefs: [] },
      ]),
    ),
    audits: Object.fromEntries([
      ["largest-contentful-paint", { numericValue: 900 }],
      ["cumulative-layout-shift", { numericValue: 0 }],
      ["server-response-time", { numericValue: 100 }],
      ["total-blocking-time", { numericValue: 10 }],
      ["first-contentful-paint", { numericValue: 800 }],
    ]),
    ...changes,
  };
}

const complete = (p) =>
  p.urls.flatMap((url) => Array.from({ length: p.quota }, () => report(url, {}, p)));
const thinUrl = (p) => p.urls.at(-1);
const without = (reports, url) => reports.filter((r) => r.requestedUrl !== url);
function thin(p, count = p.quota - 1) {
  return [
    ...without(complete(p), thinUrl(p)),
    ...Array.from({ length: count }, () => report(thinUrl(p), {}, p)),
  ];
}
function uneven(p) {
  // The total is exactly full; a surplus for the first URL cannot buy a sample
  // for the last URL. This catches aggregate-only admission, even on exit 0.
  return [...thin(p), report(p.urls[0], {}, p)];
}

function impostors(p) {
  return [
    [
      "foreign origin",
      (url) => report(new URL(new URL(url).pathname, "https://unrelated.example").href, {}, p),
    ],
    [
      "foreign redirect",
      (url) => {
        const final = new URL(new URL(url).pathname, "https://unrelated.example").href;
        return report(url, { finalUrl: final, finalDisplayedUrl: final }, p);
      },
    ],
    ["unplanned path", () => report(`${new URL(p.urls[0]).origin}/not-planned`, {}, p)],
    ["unplanned query", (url) => report(`${url}?unplanned=1`, {}, p)],
    ["malformed report shape", (url) => ({ requestedUrl: url, finalUrl: url, categories: {} })],
    ["malformed JSON", () => '{"categories":'],
    [
      "runtime error",
      (url) =>
        report(url, { runtimeError: { code: "NO_NAVSTART", message: "navigation failed" } }, p),
    ],
  ];
}

function withDir(fn) {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(),
      "lh-quorum-",
    ),
  );
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeReports(dir, reports, attempt = 1) {
  mkdirSync(dir, { recursive: true });
  reports.forEach((r, i) =>
    writeFileSync(
      join(dir, `lhr-${attempt * 10000 + i}.json`),
      typeof r === "string" ? r : JSON.stringify(r),
    ),
  );
}
function writeMedians(dir, reports) {
  mkdirSync(dir, { recursive: true });
  const seen = new Set();
  for (const r of reports) {
    if (typeof r !== "object" || !r.categories || seen.has(r.requestedUrl)) continue;
    seen.add(r.requestedUrl);
    writeFileSync(join(dir, `route-${seen.size}.json`), JSON.stringify(r));
  }
}
const textIfExists = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

async function collect(p, attempts) {
  return withDir(async (root) => {
    const dir = join(root, ".lighthouseci");
    const qualityDir = join(dir, "quality");
    const logFile = join(dir, "collect.log");
    const diagnosisFile = join(dir, "diagnosis.md");
    const lines = [];
    let calls = 0;
    const launch = async () => {
      const attempt = attempts[Math.min(calls++, attempts.length - 1)];
      expect(calls, "the existing single-retry limit must not grow").toBeLessThanOrEqual(2);
      writeReports(dir, attempt.reports, calls);
      writeMedians(qualityDir, attempt.reports);
      writeFileSync(join(dir, "assertion-results.json"), JSON.stringify(attempt.assertions ?? []));
      return {
        exitCode: attempt.exitCode ?? 0,
        output: attempt.output ?? "fixture collection finished",
      };
    };
    // Discovery is the only HTTP seam: unexpected requests fail rather than
    // falling through to real fetch. The origin is a string fixture only.
    const fetchImpl = async (input, init) => {
      const url = new URL(input);
      expect(url.origin).toBe(ORIGIN);
      expect(init.method).toBe("GET");
      let body;
      if (url.pathname === "/events.rss") {
        body = `<rss><channel>${p.event ? `<item><title>Community night</title><link>${ORIGIN}${EVENT}</link></item>` : ""}</channel></rss>`;
      } else if (p.event && url.pathname === EVENT) body = "<h1>Community night</h1>";
      else if (!p.event && url.pathname === "/events") body = "<p>No events</p>";
      else throw new Error(`Unexpected fixture request: ${url}`);
      return { status: 200, text: async () => body };
    };
    const options = {
      env: { ...p.env, LIGHTHOUSE_SUMMARY_ALLOW_EMPTY: "1" },
      logFile,
      diagnosisFile,
      log: (line) => lines.push(line),
    };
    const code =
      p.kind === "desktop"
        ? await desktopMain([], { ...options, run: launch, qualityDir, lhciDir: dir })
        : await mobileMain([ORIGIN], { ...options, lhci: launch, fetchImpl, dir });
    const summaryJson = textIfExists(join(dir, "watch-summary.json"));
    return {
      code,
      calls,
      lines: lines.join("\n"),
      diagnosis: textIfExists(diagnosisFile),
      summary: summaryJson ? JSON.parse(summaryJson) : null,
    };
  });
}

function evidenceLine(text, url, actual, quota) {
  const parsed = new URL(url);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const route = new RegExp(
    `(?:^|[\\s|*\x60])(?:${escape(url)}|${escape(parsed.pathname + parsed.search)})(?=$|[\\s|:*\x60])`,
  );
  const count = new RegExp(`\\b${actual}\\s*/\\s*${quota}\\b`);
  const line = text.split("\n").find((line) => route.test(line) && count.test(line));
  expect(line, `diagnostic must name ${url} with ${actual}/${quota} samples`).toBeDefined();
}

async function withCollectionConfig(change, fn) {
  // Test-only in-memory config variants prove the collectors consume the config
  // rather than a second hard-coded quota or pathname-only route inventory.
  const saved = structuredClone(mobileConfig.collect);
  try {
    Object.assign(mobileConfig.collect, change);
    return await fn();
  } finally {
    Object.assign(mobileConfig.collect, saved);
  }
}

const mainProfiles = [profile("desktop"), profile("mobile")];
for (const p of mainProfiles) {
  describe(`${p.kind} configured per-URL sample quorum`, () => {
    it("accepts complete evidence once, including upload's one median per route", async () => {
      const result = await collect(p, [{ reports: complete(p) }]);
      expect(result.code).toBe(0);
      expect(result.calls).toBe(1);
      expect(result.lines).toMatch(/collect complete/i);
    });

    it("accepts a surplus once every planned URL has met its quota", async () => {
      const result = await collect(p, [{ reports: [...complete(p), report(p.urls[0], {}, p)] }]);
      expect(result.code).toBe(0);
      expect(result.calls).toBe(1);
    });

    it("retries exit-zero zero evidence once, then fails with every planned route missing", async () => {
      const result = await collect(p, [{ reports: [] }]);
      expect(result.code).not.toBe(0);
      expect(result.calls).toBe(2);
      expect(result.diagnosis).toMatch(/COLLECT FAILURE/);
      for (const url of p.urls) evidenceLine(result.diagnosis, url, 0, p.quota);
      expect(result.lines).not.toMatch(/collect complete/i);
    });

    it("rejects full aggregate totals when one URL is thin and another has excess", async () => {
      const reports = uneven(p);
      expect(reports).toHaveLength(p.urls.length * p.quota);
      const result = await collect(p, [{ reports }]);
      expect(result.code).not.toBe(0);
      expect(result.calls).toBe(2);
      expect(result.diagnosis).toMatch(/COLLECT FAILURE/);
      expect(result.diagnosis).not.toMatch(/BUDGET BREACH|UNCLASSIFIED STEP FAILURE/);
      evidenceLine(result.diagnosis, thinUrl(p), p.quota - 1, p.quota);
      if (result.summary) {
        const row = result.summary.rows.find((row) => row.url === thinUrl(p));
        expect(row.verdict).toBe("fail");
        expect(row.runs).toBe(p.quota - 1);
      }
    });

    for (const [name, first] of [
      ["zero", []],
      ["uneven", uneven(p)],
    ]) {
      it(`recovers from exit-zero ${name} evidence on the one permitted retry`, async () => {
        const result = await collect(p, [{ reports: first }, { reports: complete(p) }]);
        expect(result.code).toBe(0);
        expect(result.calls).toBe(2);
        expect(result.lines).toMatch(/retrying/i);
      });
    }

    it("never combines complementary incomplete attempts into a complete run", async () => {
      const first = without(complete(p), thinUrl(p));
      const second = without(complete(p), p.urls[0]);
      const result = await collect(p, [{ reports: first }, { reports: second }]);
      expect(result.code).not.toBe(0);
      expect(result.calls).toBe(2);
      evidenceLine(result.diagnosis, p.urls[0], 0, p.quota);
      expect(result.lines).not.toMatch(/collect complete/i);
    });

    it("does not retry a complete genuine assertion failure", async () => {
      const result = await collect(p, [
        {
          reports: complete(p).map((r) =>
            r.requestedUrl === p.urls[0]
              ? {
                  ...r,
                  categories: { ...r.categories, performance: { score: 0.4, auditRefs: [] } },
                  audits: { ...r.audits, "largest-contentful-paint": { numericValue: 5000 } },
                }
              : r,
          ),
          exitCode: 1,
          output: ASSERTION_FAILURE,
          assertions: [
            {
              url: p.urls[0],
              auditId: p.kind === "desktop" ? "categories:performance" : "largest-contentful-paint",
              level: "error",
              actual: p.kind === "desktop" ? 0.4 : 5000,
              expected:
                p.kind === "desktop"
                  ? require("../ci/quality-budget.json").categories.performance
                  : 2000,
            },
          ],
        },
      ]);
      expect(result.code).toBe(1);
      expect(result.calls).toBe(1);
      expect(result.diagnosis).toMatch(/BUDGET BREACH/);
      expect(result.diagnosis).not.toMatch(/COLLECT FAILURE/);
    });

    it("does not retry a full-evidence non-assertion step failure", async () => {
      const result = await collect(p, [
        { reports: complete(p), exitCode: 7, output: "upload failed" },
      ]);
      expect(result.code).toBe(7);
      expect(result.calls).toBe(1);
      expect(result.diagnosis).toMatch(/UNCLASSIFIED STEP FAILURE/);
      expect(result.diagnosis).not.toMatch(/BUDGET BREACH/);
    });

    for (const [name, filler] of impostors(p)) {
      it(`does not let ${name} fill a missing planned sample`, async () => {
        const result = await collect(p, [{ reports: [...thin(p), filler(thinUrl(p))] }]);
        expect(result.code).not.toBe(0);
        expect(result.calls).toBe(2);
        expect(result.diagnosis).toMatch(/COLLECT FAILURE/);
        evidenceLine(result.diagnosis, thinUrl(p), p.quota - 1, p.quota);
        if (result.summary) {
          const row = result.summary.rows.find((r) => r.url === thinUrl(p));
          expect(row.runs).toBe(p.quota - 1);
          expect(row.verdict).toBe("fail");
        }
      });
    }

    it("accepts the configured quota when it is smaller than the usual three runs", async () => {
      await withCollectionConfig({ numberOfRuns: 2 }, async () => {
        const configured = profile(p.kind);
        const result = await collect(configured, [{ reports: complete(configured) }]);
        expect(result.code).toBe(0);
        expect(result.calls).toBe(1);
      });
    });

    it("enforces a larger configured quota instead of assuming three samples", async () => {
      await withCollectionConfig({ numberOfRuns: 4 }, async () => {
        const configured = profile(p.kind);
        const result = await collect(configured, [{ reports: uneven(configured) }]);
        expect(result.code).not.toBe(0);
        expect(result.calls).toBe(2);
        evidenceLine(result.diagnosis, thinUrl(configured), 3, 4);
      });
    });

    it("does not conflate distinct planned URLs sharing a pathname", async () => {
      const variant = `${mobileConfig.collect.url.at(-1)}?view=compact`;
      await withCollectionConfig({ url: [...mobileConfig.collect.url, variant] }, async () => {
        const configured = profile(p.kind);
        const canonical = configured.urls.at(-2);
        const reports = complete(configured);
        reports.splice(
          reports.findIndex((r) => r.requestedUrl === canonical),
          1,
        );
        reports.push(report(configured.urls.at(-1), {}, configured));
        const result = await collect(configured, [{ reports }]);
        expect(result.code).not.toBe(0);
        expect(result.calls).toBe(2);
        evidenceLine(result.diagnosis, canonical, configured.quota - 1, configured.quota);
      });
    });

    it("credits a redirected report to its requested URL, not to another planned URL", async () => {
      const reports = complete(p).map((r) =>
        r.requestedUrl === p.urls[0]
          ? {
              ...r,
              finalUrl: thinUrl(p),
              finalDisplayedUrl: thinUrl(p),
            }
          : r,
      );
      const result = await collect(p, [{ reports }]);
      expect(result.code).toBe(0);
      expect(result.calls).toBe(1);
    });

    it("does not use a redirect destination to fill a different missing requested URL", async () => {
      const reports = uneven(p).map((r) =>
        r.requestedUrl === p.urls[0]
          ? {
              ...r,
              finalUrl: thinUrl(p),
              finalDisplayedUrl: thinUrl(p),
            }
          : r,
      );
      const result = await collect(p, [{ reports }]);
      expect(result.code).not.toBe(0);
      expect(result.calls).toBe(2);
      evidenceLine(result.diagnosis, thinUrl(p), p.quota - 1, p.quota);
    });
  });
}

for (const p of [profile("desktop", true), profile("mobile", false, false)]) {
  describe(`${p.kind} alternate collection plan`, () => {
    it("accepts exactly the configured deployed/skipped-event URL matrix", async () => {
      const result = await collect(p, [{ reports: complete(p) }]);
      expect(result.code).toBe(0);
      expect(result.calls).toBe(1);
      if (result.summary)
        expect(result.summary.rows.find((r) => r.path === "/e/<key>").verdict).toBe("skipped");
    });
    it("still requires every configured URL, with no hard-coded fixture event quota", async () => {
      const result = await collect(p, [{ reports: uneven(p) }]);
      expect(result.code).not.toBe(0);
      expect(result.calls).toBe(2);
      evidenceLine(result.diagnosis, thinUrl(p), p.quota - 1, p.quota);
    });
  });
}

const mobile = profile("mobile");
const routeRows = (lhrs, assertions = []) =>
  originLib.summarizeRoutes({ origin: ORIGIN, eventPath: EVENT, lhrs, assertions });
describe("origin route-library completeness and redirect attribution", () => {
  for (const url of mobile.urls) {
    it(`marks ${new URL(url).pathname} thin even when every other URL has enough runs`, () => {
      const lhrs = complete(mobile);
      lhrs.splice(
        lhrs.findIndex((r) => r.requestedUrl === url),
        1,
      );
      const row = routeRows(lhrs).find((r) => r.url === url);
      expect(row.runs).toBe(mobile.quota - 1);
      expect(row.verdict).toBe("fail");
    });
  }

  it("keeps a final-URL assertion on its redirected requested route", () => {
    const requested = mobile.urls.find((url) => new URL(url).pathname === "/events");
    const final = `${ORIGIN}/events/`;
    const lhrs = complete(mobile).map((r) =>
      r.requestedUrl === requested ? { ...r, finalUrl: final, finalDisplayedUrl: final } : r,
    );
    const rows = routeRows(lhrs, [
      { url: final, auditId: "server-response-time", level: "error", actual: 900, expected: 600 },
    ]);
    const row = rows.find((r) => r.url === requested);
    expect(row.runs).toBe(mobile.quota);
    expect(row.verdict).toBe("fail");
    expect(row.failed).toContainEqual({
      audit: "server-response-time",
      level: "error",
      actual: 900,
      expected: 600,
    });
    expect(rows.filter((r) => r.verdict === "fail")).toHaveLength(1);
  });

  it("does not discard a real final-URL assertion when multiple requests share that final URL", () => {
    const redirected = mobile.urls.slice(0, 2);
    const final = `${ORIGIN}/canonical-target`;
    const lhrs = complete(mobile).map((r) =>
      redirected.includes(r.requestedUrl) ? { ...r, finalUrl: final, finalDisplayedUrl: final } : r,
    );
    const rows = routeRows(lhrs, [
      { url: final, auditId: "server-response-time", level: "error", actual: 900, expected: 600 },
    ]);
    for (const url of redirected) {
      const row = rows.find((r) => r.url === url);
      expect(row.verdict, `the shared final URL must not hide a failure for ${url}`).toBe("fail");
      expect(row.failed.some((failure) => failure.audit === "server-response-time")).toBe(true);
    }
  });
});

async function summary(p, reports, { allowEmpty = false, uploadedReports = reports } = {}) {
  return withDir((root) => {
    const dir = join(root, ".lighthouseci");
    writeReports(dir, reports);
    writeMedians(join(dir, "quality"), uploadedReports);
    const env = { ...process.env, ...p.env };
    if (!p.env.QUALITY_ORIGIN) delete env.QUALITY_ORIGIN;
    if (allowEmpty) env.LIGHTHOUSE_SUMMARY_ALLOW_EMPTY = "1";
    else delete env.LIGHTHOUSE_SUMMARY_ALLOW_EMPTY;
    const run = spawnSync(process.execPath, [summaryScript], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(run.error).toBeUndefined();
    expect(run.signal).toBeNull();
    return {
      code: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      artifact: textIfExists(join(dir, "quality-summary.md")),
    };
  });
}

describe("desktop summary completeness is not a nonempty-report check", () => {
  for (const p of [profile("desktop"), profile("desktop", true)]) {
    const mode = p.env.QUALITY_ORIGIN ? "deployed" : "fixture";
    it(`${mode}: accepts full per-run evidence plus one uploaded median per route`, async () => {
      const result = await summary(p, complete(p));
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.artifact).toContain("Lighthouse quality");
    });
    it(`${mode}: refuses a nonempty set with a missing planned URL`, async () => {
      const result = await summary(p, without(complete(p), thinUrl(p)));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/::error::/);
      evidenceLine(result.artifact, thinUrl(p), 0, p.quota);
    });
    it(`${mode}: refuses thin evidence despite full aggregate count and high category scores`, async () => {
      const result = await summary(p, uneven(p));
      expect(result.code).not.toBe(0);
      evidenceLine(result.artifact, thinUrl(p), p.quota - 1, p.quota);
    });
    it(`${mode}: uploaded medians alone do not establish a per-run quorum`, async () => {
      const result = await summary(p, [], { uploadedReports: complete(p) });
      expect(result.code).not.toBe(0);
      evidenceLine(result.artifact, thinUrl(p), 0, p.quota);
    });
    for (const [name, filler] of impostors(p)) {
      it(`${mode}: does not count ${name} as a planned sample`, async () => {
        const result = await summary(p, [...thin(p), filler(thinUrl(p))]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/::error::/);
        evidenceLine(result.artifact, thinUrl(p), p.quota - 1, p.quota);
      });
    }
  }
  it("keeps the explicit local empty-summary opt-in", async () => {
    const result = await summary(profile("desktop"), [], { allowEmpty: true });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.artifact).toMatch(/No quality reports/);
  });
  it("still fails closed for zero reports without the opt-in", async () => {
    const result = await summary(profile("desktop"), []);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/::error::/);
  });
  it("does not apply the empty-summary opt-in to a nonempty partial collection", async () => {
    const p = profile("desktop");
    const result = await summary(p, thin(p), { allowEmpty: true });
    expect(result.code).not.toBe(0);
    evidenceLine(result.artifact, thinUrl(p), p.quota - 1, p.quota);
  });
});
