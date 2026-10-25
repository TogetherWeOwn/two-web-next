import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeConfig } from "lighthouse/core/config/config.js";
import diagnosticsConfig from "./lighthouse-diagnostics.config.mjs";
import { navigationMetadata } from "../test/lighthouse-navigation-fixtures.mjs";
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
const lhr = (url, server = 100, profile = "mobile") => ({
  ...navigationMetadata(profile, { deployed: true }),
  requestedUrl: url,
  finalUrl: url,
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
        await writeFile(join(dir, `lhr-${9000 + i}.json`), JSON.stringify(lhr(url, 25, "desktop")));
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

test("production mobile launcher selects and initializes the diagnostic Lighthouse config", async (t) => {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "lh-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, ".lighthouseci");
  const calls = [];
  const spawn = t.mock.method(childProcess, "spawn", (command, args, options) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    // Exercise main's default runLhci, replacing only the child-process boundary.
    // No real CLI, browser or HTTP request can be launched by this test.
    void (async () => {
      for (const [i, url] of urls.entries())
        await writeFile(join(dir, `lhr-${i}.json`), JSON.stringify(lhr(url)));
      await writeFile(join(dir, "assertion-results.json"), "[]");
      child.emit("close", 0);
    })().catch((error) => child.emit("error", error));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  assert.equal(
    await mobile([origin], {
      dir,
      env: {},
      log: () => {},
      fetchImpl: async () => ({ status: 200, text: async () => "" }),
    }),
    0,
  );
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.equal(command, process.execPath);
  assert.deepEqual(args.slice(0, 3), [
    require.resolve("@lhci/cli/src/cli.js"),
    "autorun",
    "--config=ci/lighthouse-origin.cjs",
  ]);
  assert.equal(options.env.LIGHTHOUSE_ORIGIN, origin);
  const prefix = "--collect.settings.configPath=";
  const configArgs = args.filter((arg) => arg.startsWith(prefix));
  assert.equal(configArgs.length, 1);
  const configPath = configArgs[0].slice(prefix.length);
  assert.equal(
    configPath,
    fileURLToPath(new URL("./lighthouse-diagnostics.config.mjs", import.meta.url)),
  );
  const selectedConfig = (await import(pathToFileURL(configPath).href)).default;
  const resolved = (await initializeConfig("navigation", selectedConfig, collect.settings))
    .resolvedConfig;
  assert.equal(
    resolved.audits.filter((audit) => audit.implementation === DocumentTiming).length,
    1,
  );
  assert.ok(resolved.settings.onlyAudits.includes("main-document-timing"));
});

const timestampCases = [
  [undefined, "unknown"],
  [null, "unknown"],
  ["1", "unknown"],
  [true, "unknown"],
  [NaN, "unknown"],
  [Infinity, "unknown"],
  [-Infinity, "unknown"],
  [-Number.MIN_VALUE, "unknown"],
  [0, "unknown"],
  [Number.MIN_VALUE, "1970-01-01T00:00:00.000Z"],
  [1, "1970-01-01T00:00:01.000Z"],
  [8639999999999.999, "+275760-09-12T23:59:59.999Z"],
  [8640000000000, "unknown"],
  [8640000000000.002, "unknown"],
  [8640000000001, "unknown"],
];
for (const [wallTime, expected] of timestampCases) {
  test(`matching request timestamp boundary: ${String(wallTime)} => ${expected}`, () => {
    const log = [{ ...devtoolsLog[0], params: { ...devtoolsLog[0].params, wallTime } }];
    assert.equal(documentTiming(resource, log).timestamp, expected);
  });
}

const timingKeys = [
  "dnsStart",
  "dnsEnd",
  "connectStart",
  "connectEnd",
  "sslStart",
  "sslEnd",
  "sendStart",
  "sendEnd",
  "receiveHeadersStart",
  "receiveHeadersEnd",
];
for (const key of timingKeys) {
  test(`timing offset boundaries for ${key}`, () => {
    for (const [value, expected] of [
      [undefined, "unknown"],
      [null, "unknown"],
      ["1", "unknown"],
      [true, "unknown"],
      [NaN, "unknown"],
      [Infinity, "unknown"],
      [-Infinity, "unknown"],
      [-1, "unknown"],
      [-Number.MIN_VALUE, "unknown"],
      [0, 0],
      [Number.MIN_VALUE, Number.MIN_VALUE],
      [86399999.99999999, 86399999.99999999],
      [86400000, 86400000],
      [86400000.00000001, "unknown"],
      [86400001, "unknown"],
    ]) {
      const result = documentTiming({ ...resource, timing: { [key]: value } }, devtoolsLog);
      assert.deepEqual(Object.keys(result.timingMs), timingKeys);
      for (const field of timingKeys)
        assert.equal(
          result.timingMs[field],
          field === key ? expected : "unknown",
          `${key}=${String(value)}: ${field}`,
        );
      assert.equal(result.serverWaitMs, "unknown");
    }
  });
}

test("timestamp correlation ignores later same-URL requests with other IDs and same-ID requests with other URLs", () => {
  const matching = { ...devtoolsLog[0], params: { ...devtoolsLog[0].params, wallTime: 100 } };
  const otherId = {
    ...matching,
    params: { ...matching.params, requestId: "other", wallTime: 200 },
  };
  const otherUrl = {
    ...matching,
    params: { ...matching.params, wallTime: 300, request: { url: `${origin}/about` } },
  };
  assert.equal(
    documentTiming(resource, [matching, otherId, otherUrl]).timestamp,
    "1970-01-01T00:01:40.000Z",
  );
  assert.equal(documentTiming(resource, [otherId, otherUrl]).timestamp, "unknown");
});

test("real MainResource selects the final document navigation, not a later same-URL XHR", async () => {
  const { MainResource } = await import("lighthouse/core/computed/main-resource.js");
  const { default: ServerResponseTime } = await import(
    "lighthouse/core/audits/server-response-time.js"
  );
  const navigation = (requestId, wallTime, timestamp, type, ray, wait) => [
    {
      method: "Network.requestWillBeSent",
      params: {
        requestId,
        wallTime,
        timestamp,
        type,
        documentURL: resource.url,
        frameId: "main",
        loaderId: requestId,
        initiator: { type: "other" },
        request: { url: resource.url },
      },
    },
    {
      method: "Network.responseReceived",
      params: {
        requestId,
        timestamp: timestamp + 1,
        type,
        response: {
          url: resource.url,
          status: 200,
          mimeType: "text/html",
          protocol: "h2",
          connectionId: 1,
          connectionReused: false,
          headers: { "X-Request-ID": ray, "CF-Ray": ray },
          timing: { requestTime: timestamp, sendEnd: 1, receiveHeadersStart: 1 + wait },
          encodedDataLength: 100,
        },
      },
    },
    {
      method: "Network.loadingFinished",
      params: { requestId, timestamp: timestamp + 2, encodedDataLength: 200 },
    },
  ];
  const log = [
    ...navigation("first", 100, 10, "Document", "1111111111111111-LHR", 100),
    ...navigation("reload", 200, 20, "Document", "2222222222222222-LHR", 754.261),
    ...navigation("xhr", 300, 30, "XHR", "3333333333333333-LHR", 900),
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
  const selected = await MainResource.request({ devtoolsLog: log, URL: artifacts.URL }, context);
  assert.equal(selected.requestId, "reload");
  const diagnostic = await DocumentTiming.audit(artifacts, context);
  const native = await ServerResponseTime.audit(artifacts, context);
  assert.equal(diagnostic.details.timestamp, "1970-01-01T00:03:20.000Z");
  assert.equal(diagnostic.details.requestId, "2222222222222222-LHR");
  assert.equal(diagnostic.details.cfRay, "2222222222222222-LHR");
  assert.equal(diagnostic.details.serverWaitMs, 754.261);
  assert.equal(diagnostic.details.serverWaitMs, native.numericValue);
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
