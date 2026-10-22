import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeConfig } from "lighthouse/core/config/config.js";
import diagnosticsConfig from "./lighthouse-diagnostics.config.mjs";
import DocumentTiming, { documentTiming } from "./lighthouse-document-timing.mjs";
import { main as mobile } from "./lighthouse-origin-run.mjs";
import { main as desktop, loadCollectedLhrs } from "./lighthouse-quality-run.mjs";

test("diagnostic audit is additive and does not change scoring, gathers, mobile settings or existing audits", async () => {
  const flags = require("./lighthouserc.cjs").ci.collect.settings;
  const baseline = (await initializeConfig("navigation", undefined, flags)).resolvedConfig;
  const diagnostic = (await initializeConfig("navigation", diagnosticsConfig, flags))
    .resolvedConfig;
  assert.deepEqual(diagnostic.categories, baseline.categories);
  const gatherers = (config) =>
    config.artifacts.map(({ id, dependencies, gatherer }) => ({
      id,
      dependencies,
      path: gatherer.path,
      implementation: gatherer.implementation,
    }));
  assert.deepEqual(gatherers(diagnostic), gatherers(baseline));
  assert.deepEqual(diagnostic.navigations, baseline.navigations);
  assert.deepEqual(diagnostic.settings, {
    ...baseline.settings,
    onlyAudits: ["main-document-timing"],
  });
  assert.deepEqual(
    diagnostic.audits.filter((a) => a.implementation.meta.id !== "main-document-timing"),
    baseline.audits,
  );
  assert.equal(diagnostic.audits.filter((a) => a.implementation === DocumentTiming).length, 1);
  assert.equal(DocumentTiming.meta.scoreDisplayMode, "informative");
});

const require = createRequire(import.meta.url);
const lib = require("./lighthouse-origin-lib.cjs");
const origin = "https://next.togetherweown.com";
const { collect } = lib.buildConfig({ origin }).ci;
const urls = collect.url.flatMap((url) => Array(collect.numberOfRuns).fill(url));
const lhr = (url, server = 100) => ({
  requestedUrl: url,
  finalUrl: url,
  fetchTime: "2026-10-22T12:00:00.000Z",
  categories: Object.fromEntries(
    ["performance", "accessibility", "best-practices", "seo"].map((id) => [id, { score: 1 }]),
  ),
  audits: Object.fromEntries(
    Object.entries({
      "largest-contentful-paint": 1000,
      "cumulative-layout-shift": 0,
      "server-response-time": server,
      "total-blocking-time": 50,
      "first-contentful-paint": 900,
    }).map(([id, numericValue]) => [id, { numericValue }]),
  ),
});

async function scenario(t, steps) {
  const root = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "lh-evidence-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, ".lighthouseci");
  let calls = 0;
  const code = await mobile([origin], {
    dir,
    env: {},
    log: () => {},
    fetchImpl: async () => ({ status: 200, text: async () => "" }),
    lhci: async () => {
      const step = steps[calls++];
      for (const [i, url] of (step.urls ?? urls).entries()) {
        await writeFile(
          join(dir, `lhr-${calls * 1000 + i}.json`),
          JSON.stringify(lhr(url, step.server)),
        );
      }
      await writeFile(join(dir, "assertion-results.json"), step.assertions ?? "[]");
      if (step.malformed) await writeFile(join(dir, "lhr-99999.json"), "{broken");
      return { exitCode: step.exitCode ?? 0, output: "fixture collect" };
    },
  });
  return { root, dir, code, calls };
}

async function runDesktop(dir) {
  return desktop([], {
    env: { QUALITY_ORIGIN: origin },
    lhciDir: dir,
    qualityDir: join(dir, "quality"),
    logFile: join(dir, "quality-collect.log"),
    diagnosisFile: join(dir, "quality-collect-diagnosis.md"),
    log: () => {},
    run: async () => {
      await mkdir(join(dir, "quality"), { recursive: true });
      for (const [i, url] of urls.entries()) {
        await writeFile(join(dir, `lhr-${9000 + i}.json`), JSON.stringify(lhr(url, 25)));
      }
      return { exitCode: 0, output: "desktop fixture" };
    },
  });
}

test("all mobile samples and assertions survive a complete desktop collect without mixing accounting", async (t) => {
  const { dir, code, calls } = await scenario(t, [{}]);
  assert.equal(code, 0);
  assert.equal(calls, 1);
  const archived = join(dir, "mobile-attempts", "attempt-1");
  assert.equal(loadCollectedLhrs(archived).length, urls.length);
  const before = await readFile(join(archived, "assertion-results.json"), "utf8");
  assert.equal(await runDesktop(dir), 0);
  assert.equal(loadCollectedLhrs(dir).length, urls.length);
  const retained = loadCollectedLhrs(archived);
  assert.equal(retained.length, urls.length);
  for (const url of collect.url)
    assert.equal(retained.filter((r) => r.requestedUrl === url).length, 3);
  assert.equal(await readFile(join(archived, "assertion-results.json"), "utf8"), before);
  assert.ok(retained.every((r) => r.audits["server-response-time"].numericValue === 100));
  assert.ok(
    loadCollectedLhrs(dir).every((r) => r.audits["server-response-time"].numericValue === 25),
  );
});

test("754.261ms server median remains red with no retry and survives desktop cleanup", async (t) => {
  const failure = JSON.stringify([
    {
      url: `${origin}/events`,
      auditId: "server-response-time",
      level: "error",
      actual: 754.261,
      expected: 600,
    },
  ]);
  const { dir, code, calls } = await scenario(t, [
    { server: 754.261, assertions: failure, exitCode: 1 },
  ]);
  assert.equal(code, 1);
  assert.equal(calls, 1);
  const summary = JSON.parse(await readFile(join(dir, "watch-summary.json"), "utf8"));
  assert.equal(summary.rows.find((r) => r.path === "/events").verdict, "fail");
  await runDesktop(dir);
  const archived = join(dir, "mobile-attempts", "attempt-1");
  assert.equal(await readFile(join(archived, "assertion-results.json"), "utf8"), failure);
  assert.equal(loadCollectedLhrs(archived).length, urls.length);
});

test("short attempts are archived separately; malformed evidence never fills the quota", async (t) => {
  const { dir, code, calls } = await scenario(t, [
    { urls: urls.slice(0, 2), malformed: true },
    { urls: urls.slice(0, -1), malformed: true },
  ]);
  assert.equal(code, 1);
  assert.equal(calls, 2);
  await runDesktop(dir);
  const attempts = join(dir, "mobile-attempts");
  assert.deepEqual(await readdir(attempts), ["attempt-1", "attempt-2"]);
  assert.equal(loadCollectedLhrs(join(attempts, "attempt-1")).length, 2);
  assert.equal(loadCollectedLhrs(join(attempts, "attempt-2")).length, urls.length - 1);
  assert.equal(await readFile(join(attempts, "attempt-1", "lhr-99999.json"), "utf8"), "{broken");
});

const resource = {
  requestId: "1",
  url: `${origin}/events?private=DO_NOT_COPY`,
  protocol: "h2",
  responseHeaders: [
    { name: "X-Request-ID", value: "0123456789abcdef-LHR" },
    { name: "CF-Ray", value: "0123456789abcdef-LHR" },
    { name: "Set-Cookie", value: "DO_NOT_COPY" },
    { name: "Authorization", value: "DO_NOT_COPY" },
    { name: "X-Arbitrary", value: "DO_NOT_COPY" },
    { name: "X-Release", value: "DO_NOT_COPY" },
  ],
  timing: { sendEnd: 1, receiveHeadersStart: 755.261, sslStart: -1 },
};
const devtoolsLog = [
  {
    method: "Network.requestWillBeSent",
    params: {
      requestId: "1",
      wallTime: 1792670400,
      request: { url: resource.url, headers: { Cookie: "DO_NOT_COPY" } },
    },
  },
];

test("allowlist retains correlation and native server wait only, without header/query/body data", () => {
  const result = documentTiming(resource, devtoolsLog);
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "schemaVersion",
      "timestamp",
      "requestId",
      "cfRay",
      "protocol",
      "edgeColo",
      "servingRevision",
      "timingMs",
      "serverWaitMs",
    ].sort(),
  );
  assert.equal(result.requestId, "0123456789abcdef-LHR");
  assert.equal(result.cfRay, "0123456789abcdef-LHR");
  assert.equal(result.edgeColo, "LHR");
  assert.equal(result.servingRevision, "unknown");
  assert.equal(result.timestamp, new Date(1792670400000).toISOString());
  assert.equal(result.serverWaitMs, 754.261);
  assert.equal(result.timingMs.sslStart, "unknown");
  assert.doesNotMatch(
    JSON.stringify(result),
    /DO_NOT_COPY|private|Cookie|Authorization|X-Arbitrary|\/events/,
  );
});

test("real Lighthouse audit selects the same main document and leaves the real LHCI 600ms median red", async () => {
  const { default: ServerResponseTime } = await import(
    "lighthouse/core/audits/server-response-time.js"
  );
  const { getAllAssertionResults } = require("@lhci/utils/src/assertions.js");
  const log = [
    {
      method: "Network.requestWillBeSent",
      params: {
        ...devtoolsLog[0].params,
        documentURL: resource.url,
        timestamp: 100,
        type: "Document",
        frameId: "main",
        loaderId: "1",
        initiator: { type: "other" },
      },
    },
    {
      method: "Network.responseReceived",
      params: {
        requestId: "1",
        timestamp: 101,
        type: "Document",
        response: {
          url: resource.url,
          status: 200,
          mimeType: "text/html",
          protocol: "h2",
          connectionId: 1,
          connectionReused: false,
          headers: Object.fromEntries(
            resource.responseHeaders.map(({ name, value }) => [name, value]),
          ),
          timing: { requestTime: 100, ...resource.timing },
          encodedDataLength: 100,
        },
      },
    },
    {
      method: "Network.loadingFinished",
      params: { requestId: "1", timestamp: 102, encodedDataLength: 200 },
    },
  ];
  const artifacts = {
    DevtoolsLog: log,
    URL: {
      requestedUrl: resource.url,
      mainDocumentUrl: resource.url,
      finalDisplayedUrl: resource.url,
    },
    GatherContext: { gatherMode: "navigation" },
  };
  const context = { computedCache: new Map() };
  const native = await ServerResponseTime.audit(artifacts, context);
  const diagnostic = await DocumentTiming.audit(artifacts, context);
  assert.equal(native.numericValue, 754.261);
  assert.equal(diagnostic.details.serverWaitMs, native.numericValue);
  assert.equal(diagnostic.details.requestId, "0123456789abcdef-LHR");
  assert.equal(diagnostic.score, null);
  assert.doesNotMatch(JSON.stringify(diagnostic), /DO_NOT_COPY|private|Cookie|Authorization/);
  const reports = [650.73, 754.261, 769.81].map((value) => lhr(`${origin}/events`, value));
  const options = require("./lighthouserc.cjs").ci.assert;
  const failure = getAllAssertionResults(options, reports).find(
    (row) => row.auditId === "server-response-time",
  );
  assert.equal(failure.passed, false);
  assert.equal(failure.expected, 600);
  assert.equal(failure.actual, 754.261);
  const withDiagnostics = reports.map((report) => ({
    ...report,
    audits: { ...report.audits, "main-document-timing": { ...diagnostic, numericValue: 0 } },
  }));
  assert.deepEqual(
    getAllAssertionResults(options, withDiagnostics),
    getAllAssertionResults(options, reports),
  );
});

test("invalid, duplicate, absent metadata and timing are unknown, never inferred from checkout", () => {
  const result = documentTiming(
    {
      ...resource,
      protocol: "evil",
      responseHeaders: [
        { name: "x-request-id", value: "untrusted text" },
        { name: "cf-ray", value: "0123456789abcdef-LHR" },
        { name: "cf-ray", value: "0123456789abcdef-LHR" },
      ],
      timing: { sendEnd: Infinity, receiveHeadersStart: -1 },
    },
    [],
  );
  for (const key of [
    "timestamp",
    "requestId",
    "cfRay",
    "protocol",
    "edgeColo",
    "servingRevision",
    "serverWaitMs",
  ])
    assert.equal(result[key], "unknown", key);
  assert.ok(Object.values(result.timingMs).every((v) => v === "unknown"));
  assert.equal(documentTiming({ ...resource, responseHeaders: [] }, []).requestId, "unknown");
  assert.equal(
    documentTiming(
      {
        ...resource,
        responseHeaders: [{ name: "x-request-id", value: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      },
      [],
    ).requestId,
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  );
});

test("malformed assertions stay failing over full samples, regardless of diagnostics", async (t) => {
  const { dir, code, calls } = await scenario(t, [{ assertions: "{broken" }]);
  assert.equal(code, 1);
  assert.equal(calls, 1);
  await runDesktop(dir);
  assert.equal(
    await readFile(join(dir, "mobile-attempts", "attempt-1", "assertion-results.json"), "utf8"),
    "{broken",
  );
});
