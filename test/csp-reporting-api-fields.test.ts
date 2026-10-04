// route-inventory: POST /csp-reports
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { MAX_CSP_REPORT_BYTES, cspReportLogFields } from "../src/csp-reports";
import type { Env } from "../src/env";

const documentUrl = "https://next.example.test/events/synthetic";
const envelopeUrl = "https://next.example.test/envelope";
const sourceUrl = "https://next.example.test/public/synthetic.js";
const bodyFields = () => ({
  documentURL: documentUrl,
  blockedURL: "inline",
  effectiveDirective: "script-src-elem",
  sourceFile: sourceUrl,
  lineNumber: 17,
  columnNumber: 4,
  disposition: "enforce",
  statusCode: 200,
  sample: "synthetic sample must not be logged",
});
const report = (body: unknown = bodyFields(), url: unknown = envelopeUrl) => ({
  age: 0,
  type: "csp-violation",
  url,
  user_agent: "synthetic browser",
  body,
});
const expectedFields = {
  blocked_uri: "inline",
  violated_directive: "script-src-elem",
  document_uri: documentUrl,
  source_file: sourceUrl,
  line_number: 17,
};

const forbiddenBindings = new Set([
  "DB",
  "DATABASE_URL",
  "AGENT_DB",
  "HYPERDRIVE",
  "SESSION_STORE",
  "ROSTER_STORE",
  "SESSION_SECRET",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "QA_AUTH_TOKEN",
]);
const bindingAccess = vi.fn();
const env = new Proxy({ APP_URL: "https://next.example.test" } as Env, {
  get(target, key, receiver) {
    if (typeof key === "string" && forbiddenBindings.has(key)) {
      bindingAccess(key);
      throw new Error("CSP reports must not read DB, session or auth bindings");
    }
    return Reflect.get(target, key, receiver);
  },
});

let now = Date.now();
beforeEach(() => {
  // Each shape case starts after a full isolate log-budget refill.
  now += 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

// Check actual binding reads, not just the 204: the sink catches exceptions.
afterEach(() => {
  expect(bindingAccess).not.toHaveBeenCalled();
  bindingAccess.mockClear();
  vi.restoreAllMocks();
});

async function post(body: string | ReadableStream<Uint8Array> | null, sampleRate = "1") {
  const bindings = new Proxy(env, {
    get(target, key, receiver) {
      return key === "CSP_REPORT_SAMPLE_RATE" ? sampleRate : Reflect.get(target, key, receiver);
    },
  });
  const response = await app.request(
    "/csp-reports",
    {
      method: "POST",
      headers: {
        "content-type": "application/reports+json",
        cookie: "__Host-two_session=synthetic-forged-session.bad",
      },
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    },
    bindings,
  );
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.getSetCookie()).toEqual([]);
}

const captureLogs = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("Reporting API CSP fields", () => {
  it("maps browser-shaped body fields into the existing five scalar keys", async () => {
    const warn = captureLogs();
    await post(JSON.stringify([report()]));
    expect(warn.mock.calls).toEqual([["csp.report.violation", expectedFields]]);
  });

  it.each([
    [undefined, envelopeUrl],
    [null, envelopeUrl],
    [{ nested: documentUrl }, envelopeUrl],
    [[documentUrl], envelopeUrl],
    [42, envelopeUrl],
    ["", null],
    [documentUrl, documentUrl],
  ])("uses a scalar documentURL before the envelope URL (%j)", async (documentURL, expected) => {
    const warn = captureLogs();
    await post(JSON.stringify([report({ ...bodyFields(), documentURL })]));
    expect(warn.mock.calls).toEqual([
      ["csp.report.violation", { ...expectedFields, document_uri: expected }],
    ]);
  });

  it("retains the legacy body.url fallback before the envelope URL", async () => {
    const warn = captureLogs();
    await post(JSON.stringify([report({ blockedURL: "inline", url: documentUrl })]));
    expect(warn.mock.calls).toEqual([
      [
        "csp.report.violation",
        {
          blocked_uri: "inline",
          violated_directive: null,
          document_uri: documentUrl,
          source_file: null,
          line_number: null,
        },
      ],
    ]);
  });

  it("prefers documentURL over the legacy body.url alias", async () => {
    const warn = captureLogs();
    await post(
      JSON.stringify([report({ ...bodyFields(), url: "https://next.example.test/legacy" })]),
    );
    expect(warn.mock.calls).toEqual([["csp.report.violation", expectedFields]]);
  });

  it.each([undefined, null, {}, [envelopeUrl]].map((value) => [value]))(
    "keeps body evidence when the envelope URL is missing or non-scalar %j",
    async (url) => {
      const warn = captureLogs();
      await post(JSON.stringify([{ ...report(), url }]));
      expect(warn.mock.calls).toEqual([["csp.report.violation", expectedFields]]);
    },
  );

  it("keeps classic fields and their precedence when both spellings appear", async () => {
    const warn = captureLogs();
    await post(
      JSON.stringify({
        "csp-report": {
          ...bodyFields(),
          "blocked-uri": "eval",
          "violated-directive": "script-src",
          "document-uri": envelopeUrl,
          "source-file": "https://next.example.test/classic.js",
          "line-number": 0,
        },
      }),
    );
    expect(warn.mock.calls).toEqual([
      [
        "csp.report.violation",
        {
          blocked_uri: "eval",
          violated_directive: "script-src",
          document_uri: envelopeUrl,
          source_file: "https://next.example.test/classic.js",
          line_number: 0,
        },
      ],
    ]);
  });

  it("never logs nested fields, extra body keys or envelope metadata", async () => {
    const warn = captureLogs();
    await post(
      JSON.stringify([
        report(
          {
            blockedURL: { nested: "probe" },
            effectiveDirective: ["script-src"],
            documentURL: { nested: "probe" },
            url: ["probe"],
            sourceFile: { nested: "probe" },
            lineNumber: { nested: 17 },
            sample: "probe",
            unknown: { nested: "probe" },
          },
          { nested: "probe" },
        ),
      ]),
    );
    expect(warn.mock.calls).toEqual([
      [
        "csp.report.violation",
        {
          blocked_uri: null,
          violated_directive: null,
          document_uri: null,
          source_file: null,
          line_number: null,
        },
      ],
    ]);
  });

  it.each(["17", null, [], {}, true, 1e400].map((value) => [value]))(
    "does not coerce invalid lineNumber %j",
    async (lineNumber) => {
      const warn = captureLogs();
      await post(JSON.stringify([report({ ...bodyFields(), lineNumber })]));
      expect(warn.mock.calls).toEqual([
        ["csp.report.violation", { ...expectedFields, line_number: null }],
      ]);
    },
  );

  it("rejects non-finite line numbers before serialization", () => {
    for (const lineNumber of [NaN, Infinity, -Infinity]) {
      expect(cspReportLogFields({ lineNumber }).line_number).toBeNull();
    }
  });

  it.each(["deprecation", "intervention", "network-error", null, {}, []].map((value) => [value]))(
    "silently ignores an explicitly non-CSP or malformed type %j",
    async (type) => {
      const warn = captureLogs();
      await post(JSON.stringify([{ ...report(), type }]));
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("keeps first-report-only handling rather than treating a later report as the first", async () => {
    const warn = captureLogs();
    await post(JSON.stringify([{ ...report(), type: "deprecation" }, report()]));
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([null, [], "invalid", 17].map((value) => [value]))(
    "ignores a typed CSP report with malformed body %j",
    async (body) => {
      const warn = captureLogs();
      await post(JSON.stringify([report(body)]));
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not-json", "null", "[]", "[null]", '{"csp-report":[]}'])(
    "always answers 204/no-store without logging malformed input %j",
    async (raw) => {
      const warn = captureLogs();
      await post(raw);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("keeps the 8 KB cap and cancels an oversized report stream", async () => {
    const warn = captureLogs();
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(MAX_CSP_REPORT_BYTES + 1));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    expect(MAX_CSP_REPORT_BYTES).toBe(8192);
    await post(stream);
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([["csp.report.dropped_oversize", { bytes: 8193 }]]);
  });

  it("still answers 204/no-store when the body stream fails", async () => {
    const warn = captureLogs();
    await post(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("synthetic abort"));
        },
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("still answers 204/no-store when the logger throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("synthetic logger failure");
    });
    await post(JSON.stringify([report()]));
  });

  it("applies the existing sampling gate to standard reports", async () => {
    const warn = captureLogs();
    vi.spyOn(Math, "random").mockReturnValue(0.6);
    const raw = JSON.stringify([report()]);
    await post(raw, "0");
    await post(raw, "0.5");
    expect(warn).not.toHaveBeenCalled();
    vi.spyOn(Math, "random").mockReturnValue(0.4);
    await post(raw, "0.5");
    expect(warn.mock.calls).toEqual([["csp.report.violation", expectedFields]]);
  });
});
