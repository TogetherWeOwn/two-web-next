import childProcess, { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main as mobileMain } from "../ci/lighthouse-origin-run.mjs";
import {
  expectedLhrs,
  loadCollectedLhrs,
  main as desktopMain,
} from "../ci/lighthouse-quality-run.mjs";
import { navigationMetadata } from "./lighthouse-navigation-fixtures.mjs";

// Fail closed even if a regression bypasses a runner's injected seams. Only the
// explicit summary Node subprocess below is allowed; LHCI/Chrome never launch.
let blockedSpawn;
const blockedFetch = vi.fn(() => {
  throw new Error("Unexpected real fetch in offline acceptance");
});
beforeAll(() => {
  blockedSpawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
    throw new Error("Unexpected LHCI/browser process in offline acceptance");
  });
  syncBuiltinESMExports();
  vi.stubGlobal("fetch", blockedFetch);
});
afterEach(() => {
  expect(blockedSpawn).not.toHaveBeenCalled();
  expect(blockedFetch).not.toHaveBeenCalled();
});
afterAll(() => {
  blockedSpawn.mockRestore();
  syncBuiltinESMExports();
  vi.unstubAllGlobals();
});

const require = createRequire(import.meta.url);
const { sampleMatrix, evidenceLines } = require("../ci/lighthouse-samples.cjs");
const originLib = require("../ci/lighthouse-origin-lib.cjs");
const { getAllAssertionResults } = require("@lhci/utils/src/assertions.js");
const ORIGIN = "https://togetherweown.com";
const mobileCollect = originLib.buildConfig({ origin: ORIGIN }).ci.collect;
const desktopCollect = expectedLhrs({ env: { QUALITY_ORIGIN: ORIGIN } }).collect;
const summaryScript = fileURLToPath(new URL("../ci/lighthouse-summary.mjs", import.meta.url));
const SECRET_MARKER = "FIXTURE_MUST_NOT_APPEAR";
const profiles = [
  { kind: "mobile", collect: mobileCollect },
  { kind: "desktop", collect: desktopCollect },
];

// Independent acceptance surface (v1): the existing runners gain a read-only
// --check-fixture <directory> --format json path. Mobile keeps its origin arg;
// desktop keeps QUALITY_ORIGIN. No collection overrides are valid in this mode.
// JSON: schemaVersion, profile, code, complete, rows[].{url,quota,runs},
// rejectionCounts (fixed codes, positive integer counts), next_action.
// Required rejection codes exercised here: duplicate_navigation,
// invalid_identity, invalid_timing, settings_mismatch. Other invalid inputs may
// use additional bounded codes; they must never become attacker-controlled keys.
// These are admission tests, not signatures or proof against forged LHRs.
function report(p, url = p.collect.url[0]) {
  return {
    ...navigationMetadata(p.kind, { deployed: true }),
    requestedUrl: url,
    finalUrl: url,
    finalDisplayedUrl: url,
    categories: Object.fromEntries(
      ["performance", "accessibility", "best-practices", "seo"].map((id) => [
        id,
        { score: 1, auditRefs: [] },
      ]),
    ),
    audits: Object.fromEntries(
      Object.entries({
        "largest-contentful-paint": 1000,
        "cumulative-layout-shift": 0,
        "server-response-time": 100,
        "total-blocking-time": 50,
        "first-contentful-paint": 900,
      }).map(([id, numericValue]) => [id, { numericValue }]),
    ),
  };
}
const full = (p) =>
  p.collect.url.flatMap((url) =>
    Array.from({ length: p.collect.numberOfRuns }, () => report(p, url)),
  );
const oneRoute = (p) => ({ ...p.collect, url: [p.collect.url[0]] });
const copies = (r) => [r, structuredClone(r), JSON.parse(JSON.stringify(r))];

function withDir(fn) {
  const root = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(),
      "lh-identity-",
    ),
  );
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}
function writeReports(dir, reports) {
  mkdirSync(dir, { recursive: true });
  reports.forEach((r, i) =>
    writeFileSync(join(dir, `lhr-${1000 + i}.json`), typeof r === "string" ? r : JSON.stringify(r)),
  );
}
const textAt = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
function tree(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? tree(path).map(([name, hash]) => [`${entry.name}/${name}`, hash])
        : [[entry.name, createHash("sha256").update(readFileSync(path)).digest("hex")]];
    });
}
async function runCollector(p, steps) {
  return withDir(async (root) => {
    const dir = join(root, ".lighthouseci");
    const qualityDir = join(dir, "quality");
    const logs = [];
    let calls = 0;
    const launch = async () => {
      const step = steps[Math.min(calls++, steps.length - 1)];
      expect(calls, "a third attempt is never permitted").toBeLessThanOrEqual(2);
      writeReports(dir, step.reports);
      mkdirSync(qualityDir, { recursive: true });
      const medians = new Map(
        step.reports.filter((r) => typeof r === "object").map((r) => [r.requestedUrl, r]),
      );
      [...medians.values()].forEach((r, i) =>
        writeFileSync(join(qualityDir, `median-${i}.json`), JSON.stringify(r)),
      );
      writeFileSync(join(dir, "assertion-results.json"), JSON.stringify(step.assertions ?? []));
      return { exitCode: step.exitCode ?? 0, output: step.output ?? "offline fixture complete" };
    };
    const fetchImpl = async (input, init) => {
      const url = new URL(input);
      expect(url.origin).toBe(ORIGIN);
      expect(init.method).toBe("GET");
      expect(["/events.rss", "/events"]).toContain(url.pathname);
      return { status: 200, text: async () => "" };
    };
    const options = {
      env: { QUALITY_ORIGIN: ORIGIN },
      log: (line) => logs.push(String(line)),
      logFile: join(root, "collect.log"),
      diagnosisFile: join(root, "diagnosis.md"),
    };
    const code =
      p.kind === "mobile"
        ? await mobileMain([ORIGIN], { ...options, dir, lhci: launch, fetchImpl })
        : await desktopMain([], { ...options, lhciDir: dir, qualityDir, run: launch });
    const summary = textAt(join(dir, "watch-summary.json"));
    const archives =
      p.kind === "mobile"
        ? [1, 2]
            .filter((n) => existsSync(join(dir, "mobile-attempts", `attempt-${n}`)))
            .map((n) => {
              const path = join(dir, "mobile-attempts", `attempt-${n}`);
              return {
                reports: loadCollectedLhrs(path),
                manifest: JSON.parse(textAt(join(path, "manifest.json"))),
              };
            })
        : [];
    return {
      code,
      calls,
      logs: logs.join("\n"),
      diagnosis: textAt(join(root, "diagnosis.md")),
      summary: summary ? JSON.parse(summary) : null,
      archives,
    };
  });
}

for (const p of profiles) {
  describe(`${p.kind} independent navigation admission`, () => {
    it("CONTROL: equal scores and equal durations from distinct navigations satisfy every configured quota", () => {
      const reports = full(p);
      expect(new Set(reports.map((r) => r.fetchTime)).size).toBe(reports.length);
      const matrix = sampleMatrix(reports, p.collect);
      expect(matrix.complete).toBe(true);
      expect(matrix.rows.map((row) => row.runs.length)).toEqual(p.collect.url.map(() => 3));
    });

    for (const [name, duplicate] of [
      ["the same reference", (r) => [r, r, r]],
      ["separately parsed copies", copies],
      [
        "changed scores and audit values on the same navigation",
        (r) =>
          copies(r).map((copy, i) => ({
            ...copy,
            categories: { ...copy.categories, performance: { score: 0.8 + i * 0.1 } },
            audits: { ...copy.audits, "server-response-time": { numericValue: 100 + i } },
            timing: {
              total: 1000 + i,
              entries: [{ name: "lh:runner:run", startTime: 0, duration: 1000 + i }],
            },
          })),
      ],
    ]) {
      it(`RED: ${name} cannot manufacture three samples`, () => {
        const matrix = sampleMatrix(duplicate(report(p)), oneRoute(p));
        expect(matrix.rows[0].runs).toHaveLength(1);
        expect(matrix.complete).toBe(false);
        expect(matrix.rejectionCounts).toEqual({ duplicate_navigation: 2 });
      });
    }

    for (const [name, change] of [
      [
        "missing fetchTime",
        (r) => {
          delete r.fetchTime;
        },
      ],
      [
        "null fetchTime",
        (r) => {
          r.fetchTime = null;
        },
      ],
      [
        "numeric fetchTime",
        (r) => {
          r.fetchTime = 1792843200000;
        },
      ],
      [
        "unparseable fetchTime",
        (r) => {
          r.fetchTime = SECRET_MARKER;
        },
      ],
      [
        "calendar-invalid fetchTime",
        (r) => {
          r.fetchTime = "2026-02-30T12:00:00.000Z";
        },
      ],
      [
        "date without navigation time",
        (r) => {
          r.fetchTime = "2026-10-24";
        },
      ],
      [
        "missing navigation mode",
        (r) => {
          delete r.gatherMode;
        },
      ],
      [
        "timespan rather than navigation",
        (r) => {
          r.gatherMode = "timespan";
        },
      ],
      [
        "missing requestedUrl even when finalUrl matches",
        (r) => {
          delete r.requestedUrl;
        },
      ],
    ]) {
      it(`RED: ${name} is not navigation identity`, () => {
        const reports = Array.from({ length: 3 }, () => report(p));
        reports.forEach(change);
        const matrix = sampleMatrix(reports, oneRoute(p));
        expect(matrix.rows[0].runs).toHaveLength(0);
        expect(matrix.complete).toBe(false);
        expect(matrix.rejectionCounts).toEqual({ invalid_identity: 3 });
      });
    }

    for (const value of [undefined, null, 0, -1, Infinity, NaN, "1000"]) {
      it(`RED: timing.total=${String(value)} cannot satisfy a navigation quota`, () => {
        const reports = Array.from({ length: 3 }, () => report(p));
        reports.forEach((r) => {
          r.timing.total = value;
        });
        const matrix = sampleMatrix(reports, oneRoute(p));
        expect(matrix.rows[0].runs).toHaveLength(0);
        expect(matrix.rejectionCounts).toEqual({ invalid_timing: 3 });
      });
    }

    for (const [name, change] of [
      [
        "missing timing",
        (r) => {
          delete r.timing;
        },
      ],
      [
        "array timing",
        (r) => {
          r.timing = [];
        },
      ],
    ]) {
      it(`RED: ${name} is rejected without crashing`, () => {
        const reports = Array.from({ length: 3 }, () => report(p));
        reports.forEach(change);
        const matrix = sampleMatrix(reports, oneRoute(p));
        expect(matrix.rows[0].runs).toHaveLength(0);
        expect(matrix.rejectionCounts).toEqual({ invalid_timing: 3 });
      });
    }

    for (const [name, change] of [
      [
        "missing configSettings",
        (s) => {
          s.configSettings = undefined;
        },
      ],
      [
        "missing throttling",
        (s) => {
          delete s.configSettings.throttling;
        },
      ],
      [
        "missing screen emulation",
        (s) => {
          delete s.configSettings.screenEmulation;
        },
      ],
      [
        "wrong category selection",
        (s) => {
          s.configSettings.onlyCategories = ["seo"];
        },
      ],
      [
        "skipped asserted audit",
        (s) => {
          s.configSettings.skipAudits.push("server-response-time");
        },
      ],
      [
        "other form factor",
        (s) => {
          s.configSettings.formFactor = p.kind === "mobile" ? "desktop" : "mobile";
        },
      ],
      [
        "other throttling method",
        (s) => {
          s.configSettings.throttlingMethod = "provided";
        },
      ],
      [
        "other CPU slowdown",
        (s) => {
          s.configSettings.throttling.cpuSlowdownMultiplier += 1;
        },
      ],
      [
        "other network latency",
        (s) => {
          s.configSettings.throttling.rttMs += 1;
        },
      ],
      [
        "other network throughput",
        (s) => {
          s.configSettings.throttling.throughputKbps += 1;
        },
      ],
      [
        "other screen width",
        (s) => {
          s.configSettings.screenEmulation.width += 1;
        },
      ],
      [
        "other screen height",
        (s) => {
          s.configSettings.screenEmulation.height += 1;
        },
      ],
      [
        "other pixel ratio",
        (s) => {
          s.configSettings.screenEmulation.deviceScaleFactor += 1;
        },
      ],
      [
        "other mobile screen flag",
        (s) => {
          s.configSettings.screenEmulation.mobile = !s.configSettings.screenEmulation.mobile;
        },
      ],
      [
        "disabled screen emulation",
        (s) => {
          s.configSettings.screenEmulation.disabled = true;
        },
      ],
    ]) {
      it(`RED: ${name} cannot be used as the selected profile`, () => {
        const reports = Array.from({ length: 3 }, () => report(p));
        reports.forEach(change);
        const matrix = sampleMatrix(reports, oneRoute(p));
        expect(matrix.rows[0].runs).toHaveLength(0);
        expect(matrix.complete).toBe(false);
        expect(matrix.rejectionCounts).toEqual({ settings_mismatch: 3 });
      });
    }

    it("CONTROL: a same-origin redirect is credited only to its requested route", () => {
      const [a, b] = p.collect.url;
      const reports = Array.from({ length: 3 }, () => ({
        ...report(p, a),
        finalUrl: b,
        finalDisplayedUrl: b,
      }));
      const matrix = sampleMatrix(reports, { ...p.collect, url: [a, b] });
      expect(matrix.rows.map((row) => row.runs.length)).toEqual([3, 0]);
      expect(matrix.complete).toBe(false);
      expect(sampleMatrix(reports, { ...p.collect, url: [a] }).complete).toBe(true);
    });

    it("CONTROL: foreign/unplanned requests and foreign redirects never pay a planned quota", () => {
      const a = p.collect.url[0];
      const reports = [
        report(p, `${ORIGIN}/not-planned`),
        report(p, `${a}?unplanned=${SECRET_MARKER}`),
        report(p, "https://unrelated.example/"),
        { ...report(p, a), finalUrl: "https://unrelated.example/" },
        { ...report(p, a), finalDisplayedUrl: "not a URL" },
        { ...report(p, a), runtimeError: { code: "NO_NAVSTART", message: SECRET_MARKER } },
      ];
      const matrix = sampleMatrix(reports, oneRoute(p));
      expect(matrix.complete).toBe(false);
      expect(matrix.rows[0].runs).toHaveLength(0);
    });

    it("RED: a renamed identical report file does not establish another navigation", async () => {
      await withDir((dir) => {
        writeReports(dir, copies(report(p)));
        const loaded = loadCollectedLhrs(dir);
        const matrix = sampleMatrix(loaded, oneRoute(p));
        expect(matrix.rows[0].runs).toHaveLength(1);
        expect(matrix.rejectionCounts).toEqual({ duplicate_navigation: 2 });
      });
    });

    it("RED: diagnostics carry bounded counts and remediation, never rejected report contents", () => {
      const r = report(p);
      r.audits.private = {
        details: {
          items: [{ node: { snippet: SECRET_MARKER }, headers: { Authorization: SECRET_MARKER } }],
        },
      };
      const matrix = sampleMatrix(Array(1001).fill(r), oneRoute(p));
      expect(matrix.rejectionCounts).toEqual({ duplicate_navigation: 1000 });
      const text = evidenceLines(matrix).join("\n");
      expect(text).toMatch(/duplicate_navigation[^\n]*1000|1000[^\n]*duplicate_navigation/);
      expect(text).toMatch(/next_action/);
      expect(text).not.toContain(SECRET_MARKER);
      expect(text.length).toBeLessThan(2048);
    });

    it("CONTROL: distinct truthful equal-score files pass the real collector once", async () => {
      const result = await runCollector(p, [{ reports: full(p) }]);
      expect(result.code).toBe(0);
      expect(result.calls).toBe(1);
    });

    for (const [name, transform] of [
      ["duplicate files", (reports) => reports.flatMap((r, i) => (i % 3 ? [] : copies(r)))],
      [
        "wrong collection profile",
        (reports) =>
          reports.map((r) => ({
            ...r,
            configSettings: navigationMetadata(p.kind === "mobile" ? "desktop" : "mobile")
              .configSettings,
          })),
      ],
    ]) {
      it(`RED: collectors retry ${name} only once and then fail closed`, async () => {
        const result = await runCollector(p, [{ reports: transform(full(p)) }]);
        expect(result.calls).toBe(2);
        expect(result.code).toBe(1);
        expect(result.diagnosis).toMatch(/COLLECT FAILURE/);
        expect(result.diagnosis).toContain(
          name === "duplicate files" ? "duplicate_navigation" : "settings_mismatch",
        );
        expect(result.diagnosis).toMatch(/next_action/);
        if (result.summary) {
          expect(result.summary.schemaVersion).toBe(1);
          expect(result.summary.rejectionCounts).toEqual(
            name === "duplicate files"
              ? { duplicate_navigation: p.collect.url.length * 2 }
              : { settings_mismatch: p.collect.url.length * 3 },
          );
          expect(
            result.summary.rows.filter((r) => r.verdict !== "skipped").map((r) => r.runs),
          ).toEqual(p.collect.url.map(() => (name === "duplicate files" ? 1 : 0)));
        }
      });
    }

    it("RED: rejected first-attempt copies cannot prevent recovery on one complete fresh retry", async () => {
      const first = full(p).flatMap((r, i) => (i % 3 ? [] : copies(r)));
      const result = await runCollector(p, [{ reports: first }, { reports: full(p) }]);
      expect(result.code).toBe(0);
      expect(result.calls).toBe(2);
    });

    it("CONTROL: complementary short attempts are never combined", async () => {
      const first = full(p).filter((_, i) => i % 3 !== 2);
      const second = full(p).filter((_, i) => i % 3 === 2);
      const result = await runCollector(p, [{ reports: first }, { reports: second }]);
      expect(result.code).toBe(1);
      expect(result.calls).toBe(2);
      expect(result.diagnosis).toMatch(/COLLECT FAILURE/);
      if (p.kind === "mobile") {
        expect(result.archives).toHaveLength(2);
        expect(result.archives.map((a) => a.reports.length)).toEqual([14, 7]);
        expect(result.archives.map((a) => a.manifest.attempt)).toEqual([1, 2]);
        expect(
          result.summary.rows
            .filter((r) => r.verdict !== "skipped")
            .every((r) => r.runs === 1 && r.verdict === "fail"),
        ).toBe(true);
      }
    });

    it("CONTROL: a complete genuine assertion breach stays red with no noise retry", async () => {
      const reports = full(p);
      for (const r of reports) {
        if (p.kind === "mobile") r.audits["server-response-time"].numericValue = 754.261;
        else r.categories.accessibility.score = 0.5;
      }
      const assertConfig =
        p.kind === "mobile"
          ? require("../ci/lighthouserc.cjs").ci.assert
          : require("../ci/lighthouserc.quality.cjs").ci.assert;
      const assertions = getAllAssertionResults(assertConfig, reports);
      expect(assertions.some((a) => a.passed === false && a.level === "error")).toBe(true);
      const result = await runCollector(p, [
        {
          reports,
          assertions,
          exitCode: 1,
          output: "Assertion failed. Exiting with status code 1.",
        },
      ]);
      expect(result.code).toBe(1);
      expect(result.calls).toBe(1);
      expect(result.diagnosis).toMatch(/BUDGET BREACH/);
      expect(result.diagnosis).not.toMatch(/COLLECT FAILURE|transient\/infra suspected/);
      if (p.kind === "mobile") {
        expect(result.summary.rows.find((r) => r.path === "/events").verdict).toBe("fail");
        expect(
          result.summary.rows.find((r) => r.path === "/events").medians["server-response-time"],
        ).toBe(754.261);
      }
    });
  });
}

it("RED: the desktop summary CLI refuses cloned per-run files even with complete uploaded medians", async () => {
  const p = profiles[1];
  await withDir((root) => {
    const dir = join(root, ".lighthouseci");
    const qualityDir = join(dir, "quality");
    const run = (reports) => {
      rmSync(dir, { recursive: true, force: true });
      writeReports(dir, reports);
      mkdirSync(qualityDir, { recursive: true });
      full(p)
        .filter((_, i) => i % 3 === 0)
        .forEach((r, i) => writeFileSync(join(qualityDir, `median-${i}.json`), JSON.stringify(r)));
      return spawnSync(process.execPath, [summaryScript], {
        cwd: root,
        env: { PATH: process.env.PATH, QUALITY_ORIGIN: ORIGIN },
        encoding: "utf8",
        timeout: 10000,
      });
    };
    const valid = run(full(p));
    expect(valid.status, valid.stderr).toBe(0);
    const duplicate = run(full(p).flatMap((r, i) => (i % 3 ? [] : copies(r))));
    expect(duplicate.status, duplicate.stderr).toBe(1);
    expect(duplicate.stdout).toContain("duplicate_navigation");
    expect(duplicate.stdout).toMatch(/next_action/);
    expect(duplicate.stdout).toMatch(/COLLECT FAILURE/);
  });
});

for (const p of profiles) {
  describe(`${p.kind} read-only fixture verification`, () => {
    async function fixture(args, reports, check) {
      return withDir(async (root) => {
        const dir = join(root, "input");
        writeReports(dir, reports);
        // A complete prior attempt is present but can never fill root quotas.
        writeReports(join(dir, "mobile-attempts", "attempt-1"), full(p));
        const before = tree(dir);
        let launches = 0;
        let fetches = 0;
        const logs = [];
        const options = {
          env: { QUALITY_ORIGIN: ORIGIN },
          dir,
          lhciDir: dir,
          qualityDir: join(dir, "quality"),
          logFile: join(dir, "collect.log"),
          diagnosisFile: join(dir, "diagnosis.md"),
          log: (line) => logs.push(String(line)),
          run: async () => {
            launches++;
            return { exitCode: 0, output: "must not collect" };
          },
          lhci: async () => {
            launches++;
            return { exitCode: 0, output: "must not collect" };
          },
          fetchImpl: async () => {
            fetches++;
            return { status: 200, text: async () => "" };
          },
        };
        const argv = args(dir);
        const code =
          p.kind === "mobile"
            ? await mobileMain([ORIGIN, ...argv], options)
            : await desktopMain(argv, options);
        expect(launches, "fixture checking/invalid fixture flags must not launch LHCI").toBe(0);
        expect(fetches, "fixture checking/invalid fixture flags must not discover URLs").toBe(0);
        expect(
          tree(dir),
          "fixture checking must not clear, rewrite or archive input reports",
        ).toEqual(before);
        const output = logs.join("\n");
        expect(
          output,
          "fixture verification needs one versioned JSON result, not collection/usage chatter",
        ).toMatch(/^\s*\{/);
        const value = JSON.parse(output);
        expect(value.schemaVersion).toBe(1);
        expect(value.profile).toBe(p.kind);
        expect(typeof value.next_action).toBe("string");
        expect(value.next_action.length).toBeGreaterThan(0);
        expect(value.next_action.length).toBeLessThan(512);
        const publicText = JSON.stringify(value);
        expect(publicText).not.toContain(root);
        expect(publicText).not.toContain(SECRET_MARKER);
        expect(publicText).not.toMatch(/Authorization|snippet|configSettings|"audits"/);
        await check({ code, value });
      });
    }
    const flags = (dir) => ["--check-fixture", dir, "--format", "json"];
    it("RED: valid reports produce versioned JSON without collection or writes", async () => {
      await fixture(flags, full(p), ({ code, value }) => {
        expect(code).toBe(0);
        expect(value.code).toBe("collection_complete");
        expect(value.complete).toBe(true);
        expect(value.rejectionCounts).toEqual({});
        expect(value.rows.map(({ url, quota, runs }) => ({ url, quota, runs }))).toEqual(
          p.collect.url.map((url) => ({ url, quota: 3, runs: 3 })),
        );
      });
    });
    it("RED: mixed rejected reports expose exact stable counts, not private evidence", async () => {
      const reports = full(p);
      const extra = report(p);
      delete extra.fetchTime;
      extra.audits.private = { details: { items: [{ node: { snippet: SECRET_MARKER } }] } };
      const wrong = report(p);
      wrong.configSettings.formFactor = "other";
      const timing = report(p);
      timing.timing.total = -1;
      await fixture(
        flags,
        [...reports, structuredClone(reports[0]), extra, wrong, timing],
        ({ code, value }) => {
          expect(code).toBe(0);
          expect(value.complete).toBe(true);
          expect(value.rejectionCounts).toEqual({
            duplicate_navigation: 1,
            invalid_identity: 1,
            settings_mismatch: 1,
            invalid_timing: 1,
          });
        },
      );
    });
    it("RED: malformed files and hostile URL fields have bounded codes without leaking values", async () => {
      const foreign = {
        ...report(p),
        finalUrl: `https://unrelated.example/?token=${SECRET_MARKER}`,
      };
      await fixture(
        flags,
        [
          ...full(p),
          "{broken",
          "null",
          "[]",
          report(p, `${ORIGIN}/?token=${SECRET_MARKER}`),
          foreign,
        ],
        ({ code, value }) => {
          expect(code).toBe(0);
          expect(value.complete).toBe(true);
          expect(value.rejectionCounts).toEqual({
            invalid_report: 3,
            unplanned_request: 1,
            invalid_redirect: 1,
          });
        },
      );
    });
    it("RED: duplicate copies are incomplete with stable code, counts and safe next_action", async () => {
      const reports = full(p).flatMap((r, i) => (i % 3 ? [] : copies(r)));
      await fixture(flags, reports, ({ code, value }) => {
        expect(code).toBe(1);
        expect(value.code).toBe("incomplete_collection");
        expect(value.complete).toBe(false);
        expect(value.rejectionCounts).toEqual({ duplicate_navigation: 14 });
        expect(value.next_action).toMatch(/collect|navigation|profile|attempt/i);
        expect(value.rows.map((r) => r.runs)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      });
    });
    for (const [name, args] of [
      ["misspelled fixture flag", (dir) => ["--check-fixtures", dir, "--format", "json"]],
      ["missing fixture directory", () => ["--check-fixture", "--format", "json"]],
      ["wrong output format", (dir) => ["--check-fixture", dir, "--format", "yaml"]],
      ["collection override", (dir) => [...flags(dir), "--collect.numberOfRuns=1"]],
      ["unknown flag", (dir) => [...flags(dir), "--unknown-fixture-option"]],
    ]) {
      it(`RED: ${name} fails before any collection/network action`, async () => {
        await fixture(args, full(p), ({ code, value }) => {
          expect(code).toBe(2);
          expect(value.code).toBe("invalid_arguments");
        });
      });
    }
  });
}
