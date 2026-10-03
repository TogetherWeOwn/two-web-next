// route-inventory: POST /csp-reports
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { MAX_CSP_REPORT_URI_LENGTH, redactCspReportUri } from "../src/csp-report-uri";
import { cspReportLogFields } from "../src/csp-reports";

const markers = [
  "synthetic-user-marker",
  "synthetic-password-marker",
  "synthetic-query-marker",
  "synthetic-fragment-marker",
];
const credentialUrl = (path: string) =>
  `https://${markers[0]}:${markers[1]}@next.example.test${path}?code=${markers[2]}#${markers[3]}`;

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

afterEach(() => {
  expect(bindingAccess).not.toHaveBeenCalled();
  bindingAccess.mockClear();
  vi.restoreAllMocks();
});

async function post(payload: unknown, sampleRate = "1") {
  const bindings = new Proxy(env, {
    get(target, key, receiver) {
      return key === "CSP_REPORT_SAMPLE_RATE" ? sampleRate : Reflect.get(target, key, receiver);
    },
  });
  const response = await app.request(
    "/csp-reports",
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { cookie: "__Host-two_session=synthetic-forged-session.bad" },
    },
    bindings,
  );
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.getSetCookie()).toEqual([]);
}

describe("CSP report URI log confidentiality", () => {
  it("removes credentials from classic URI fields before log emission", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await post({
      "csp-report": {
        "blocked-uri": credentialUrl("/blocked.js"),
        "document-uri": credentialUrl("/auth/callback"),
        "source-file": credentialUrl("/source.js"),
        "violated-directive": "script-src",
        "line-number": 17,
      },
    });
    expect(warn.mock.calls).toEqual([
      [
        "csp.report.violation",
        {
          blocked_uri: "https://next.example.test/blocked.js",
          document_uri: "https://next.example.test/auth/callback",
          source_file: "https://next.example.test/source.js",
          violated_directive: "script-src",
          line_number: 17,
        },
      ],
    ]);
    for (const marker of markers) expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
  });

  it.each(["documentURL", "url", "envelope"])(
    "sanitizes the modern %s document source",
    async (field) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const body = {
        blockedURL: credentialUrl("/blocked.js"),
        sourceFile: credentialUrl("/source.js"),
        effectiveDirective: "script-src-elem",
        lineNumber: 0,
        ...(field === "envelope" ? {} : { [field]: credentialUrl("/auth/callback") }),
      };
      await post([{ type: "csp-violation", url: credentialUrl("/auth/callback"), body }]);
      expect(warn.mock.calls).toEqual([
        [
          "csp.report.violation",
          {
            blocked_uri: "https://next.example.test/blocked.js",
            document_uri: "https://next.example.test/auth/callback",
            source_file: "https://next.example.test/source.js",
            violated_directive: "script-src-elem",
            line_number: 0,
          },
        ],
      ]);
      for (const marker of markers) expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    },
  );

  it("sanitizes legacy flat Reporting API fields too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await post([
      { blockedURL: "eval", url: credentialUrl("/document"), sourceFile: credentialUrl("/source") },
    ]);
    expect(warn.mock.calls).toEqual([
      [
        "csp.report.violation",
        {
          blocked_uri: "eval",
          document_uri: "https://next.example.test/document",
          source_file: "https://next.example.test/source",
          violated_directive: null,
          line_number: null,
        },
      ],
    ]);
    for (const marker of markers) expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
  });

  it("fails closed on attacker strings at the actual logging boundary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await post({
      "csp-report": {
        "blocked-uri": `data:text/plain,${markers[0]}`,
        "document-uri": `https://[invalid/?code=${markers[2]}`,
        "source-file": `not-a-url-${markers[3]}`,
        "violated-directive": "default-src",
        "line-number": 2,
      },
    });
    expect(warn.mock.calls).toEqual([
      [
        "csp.report.violation",
        {
          blocked_uri: null,
          document_uri: null,
          source_file: null,
          violated_directive: "default-src",
          line_number: 2,
        },
      ],
    ]);
    for (const marker of markers) expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
  });

  it("keeps field precedence rather than falling through after sanitization failure", () => {
    expect(
      cspReportLogFields({
        "blocked-uri": "not-a-url",
        blockedURL: "inline",
        "document-uri": "",
        documentURL: credentialUrl("/body"),
        url: credentialUrl("/fallback"),
        "source-file": "not-a-url",
        sourceFile: credentialUrl("/source"),
      }),
    ).toEqual({
      blocked_uri: null,
      document_uri: null,
      source_file: null,
      violated_directive: null,
      line_number: null,
    });
  });

  it("leaves zero, fractional, boundary and invalid-rate sampling unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const random = vi.spyOn(Math, "random").mockReturnValue(0.6);
    const payload = {
      "csp-report": { "blocked-uri": "inline", "document-uri": credentialUrl("/document") },
    };
    await post(payload, "0");
    await post(payload, "0.5");
    expect(warn).not.toHaveBeenCalled();
    random.mockReturnValue(0.5);
    await post(payload, "0.5");
    await post(payload, "typo");
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls)
      expect(call[1]).toMatchObject({
        blocked_uri: "inline",
        document_uri: "https://next.example.test/document",
      });
    for (const marker of markers) expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
  });
});

describe("redactCspReportUri", () => {
  it.each(["inline", "eval", "wasm-eval"])("preserves the exact safe CSP token %s", (token) => {
    expect(redactCspReportUri(token)).toBe(token);
  });

  it.each([
    [credentialUrl("/path"), "https://next.example.test/path"],
    [
      "HTTP://user:password@EXAMPLE.TEST:8080/path?token=value#secret",
      "http://example.test:8080/path",
    ],
    ["wss://user:password@example.test/socket?token=value#secret", "wss://example.test/socket"],
    ["ws://example.test:8080/socket?token=value", "ws://example.test:8080/socket"],
    [
      "https://user%40name:pass%3Fword@[::1]:8443/a%20b?q=secret#secret",
      "https://[::1]:8443/a%20b",
    ],
    ["https://example.test?token=value#secret", "https://example.test/"],
  ])("retains only normalized origin/path for %s", (input, expected) => {
    expect(redactCspReportUri(input)).toBe(expected);
    expect(redactCspReportUri(expected)).toBe(expected);
  });

  it.each([
    null,
    "",
    "not-a-url-synthetic-query-marker",
    "/relative?token=synthetic-query-marker",
    "//user:password@example.test/path",
    "https:synthetic-query-marker",
    "https://",
    "https://[invalid/?token=synthetic-query-marker",
    "https://example.test:99999/path",
    "data:text/plain,synthetic-query-marker",
    "blob:https://example.test/synthetic-query-marker",
    "javascript:synthetic-query-marker",
    "file:///synthetic-query-marker",
    "about:synthetic-query-marker",
    "inline?synthetic-query-marker",
    "eval#synthetic-query-marker",
    "INLINE",
  ])("never returns raw unrecognized URI data %j", (input) => {
    expect(redactCspReportUri(input)).toBeNull();
  });

  it("bounds the sanitized value after parsing full credentials", () => {
    expect(MAX_CSP_REPORT_URI_LENGTH).toBe(512);
    const input = `https://${"u".repeat(600)}:${markers[1]}@next.example.test/path?token=${markers[2]}#${markers[3]}`;
    expect(redactCspReportUri(input)).toBe("https://next.example.test/path");
    const longPath = credentialUrl(`/${"a".repeat(700)}`);
    const result = redactCspReportUri(longPath);
    expect(result).toBe(`https://next.example.test/${"a".repeat(700)}`.slice(0, 512));
    expect(result).toHaveLength(512);
    for (const marker of markers) expect(result).not.toContain(marker);
  });
});
