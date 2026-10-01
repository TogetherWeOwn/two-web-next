// route-inventory: POST /csp-reports
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import {
  MAX_CSP_REPORT_BYTES,
  cspReportLogFields,
  cspReportsRoute,
  extractCspReport,
  parseCspSampleRate,
  readCappedBody,
  shouldSampleReport,
} from "../src/csp-reports";
import type { Env } from "../src/env";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

afterEach(() => {
  vi.restoreAllMocks();
});

// Any session/store/DB touch throws: if /csp-reports reads one, the request 500s.
const noDbEnv = {
  ...env,
  SESSION_STORE: new Proxy(
    {},
    {
      get: () => {
        throw new Error("csp-reports must not touch the session store");
      },
    },
  ),
  ROSTER_STORE: new Proxy(
    {},
    {
      get: () => {
        throw new Error("csp-reports must not touch the roster store");
      },
    },
  ),
} as unknown as Env;

const post = (body: BodyInit | null | undefined, e: Env = env, headers: HeadersInit = {}) =>
  app.request("/csp-reports", { method: "POST", body, headers }, e);

const classicBody = () =>
  JSON.stringify({
    "csp-report": {
      "document-uri": "http://localhost/",
      "violated-directive": "script-src",
      "blocked-uri": "inline",
      "source-file": "http://localhost/",
      "line-number": 1,
    },
  });

describe("POST /csp-reports sink (TOG-10107)", () => {
  it("pins the 8 KB cap", () => {
    expect(MAX_CSP_REPORT_BYTES).toBe(8192);
  });

  it("logs a blocked inline script report and answers 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(classicBody(), env, { "content-type": "application/csp-report" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("csp.report.violation", {
      blocked_uri: "inline",
      violated_directive: "script-src",
      document_uri: "http://localhost/",
      source_file: "http://localhost/",
      line_number: 1,
    });
  });

  it("logs the newer Reporting API shape too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(
      JSON.stringify([
        {
          body: { blockedURL: "inline", effectiveDirective: "script-src-elem", url: "http://localhost/" },
        },
      ]),
      env,
      { "content-type": "application/reports+json" },
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("csp.report.violation", {
      blocked_uri: "inline",
      violated_directive: "script-src-elem",
      document_uri: "http://localhost/",
      source_file: null,
      line_number: null,
    });
  });

  it("answers 204 without logging for malformed and empty bodies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Not JSON, valid JSON that is not a report, and an empty body: the
    // browser must see 204 in every case (a 4xx makes it retry, and a report
    // endpoint that retries is a flood amplifier), and nothing is worth a log
    // row when there is no recognisable report.
    for (const body of ["not-json{{{", JSON.stringify({ hello: "world" })]) {
      const res = await post(body);
      expect(res.status).toBe(204);
    }
    expect((await post(null)).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops oversize bodies before parsing under their own log key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post("x".repeat(MAX_CSP_REPORT_BYTES + 1));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("csp.report.dropped_oversize", { bytes: MAX_CSP_REPORT_BYTES + 1 });
  });

  it("cancels on the first over-cap chunk despite a lying content-length", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("y".repeat(1024)));
      },
      cancel,
    }, { highWaterMark: 0 });
    const req = new Request("https://next.example.test/csp-reports", {
      method: "POST",
      body: stream,
      headers: { "content-length": "1" },
      duplex: "half",
    } as RequestInit);
    const capped = await readCappedBody(req);
    expect(capped).toEqual({ text: "", truncated: true, bytes: 9 * 1024 });
    // Eight chunks fit exactly; the ninth detects overflow, then no more pulls.
    expect(pulls).toBe(9);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("discards a single large overflow chunk and never pulls the next chunk", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel,
    }, { highWaterMark: 0 });
    const req = new Request("https://next.example.test/csp-reports", {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit);
    expect(await readCappedBody(req)).toEqual({ text: "", truncated: true, bytes: 64 * 1024 });
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not pull a body whose declared length exceeds the cap", async () => {
    const pull = vi.fn();
    const stream = new ReadableStream({ pull }, { highWaterMark: 0 });
    const req = new Request("https://next.example.test/csp-reports", {
      method: "POST", body: stream, duplex: "half",
      headers: { "content-length": String(MAX_CSP_REPORT_BYTES + 1) },
    } as RequestInit);
    expect(await readCappedBody(req)).toEqual({
      text: "", truncated: true, bytes: MAX_CSP_REPORT_BYTES + 1,
    });
    expect(pull).not.toHaveBeenCalled();
    await req.body?.cancel();
  });

  it("accepts a body exactly at the cap", async () => {
    const body = "x".repeat(MAX_CSP_REPORT_BYTES);
    const req = new Request("https://next.example.test/csp-reports", { method: "POST", body });
    expect(await readCappedBody(req)).toEqual({ text: body, truncated: false, bytes: MAX_CSP_REPORT_BYTES });
  });

  it("touches no session, cookie, or database — 204 with the app DB down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const forged = `__Host-two_session=${encodeURIComponent("two_forged-token")}.bad`;
    const res = await app.request(
      "/csp-reports",
      { method: "POST", body: classicBody(), headers: { cookie: forged } },
      noDbEnv,
    );
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The valid report still logs: DB-free means the log path works too.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never logs the raw report body, which is attacker-shaped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = JSON.parse(classicBody()) as { "csp-report": Record<string, unknown> };
    report["csp-report"]["evil-probe"] = "exfil-probe-marker-abc123";
    const res = await post(JSON.stringify(report));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("exfil-probe-marker-abc123");
    expect(warn).toHaveBeenCalledWith(
      "csp.report.violation",
      expect.objectContaining({ blocked_uri: "inline" }),
    );
  });

  it("writes nothing when the sample rate is zero", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(classicBody(), { ...env, CSP_REPORT_SAMPLE_RATE: "0.0" });
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an unparseable sample rate keeps logging instead of blinding the sink", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(classicBody(), { ...env, CSP_REPORT_SAMPLE_RATE: "typo" });
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("selects the Reporting API endpoint in the CSP and keeps report-uri fallback", async () => {
    const res = await app.request("/about", {}, env);
    const directives = res.headers.get("content-security-policy")?.split("; ");
    expect(directives).toContain("report-uri /csp-reports");
    expect(directives).toContain("report-to csp-endpoint");
    expect(res.headers.get("reporting-endpoints")).toBe('csp-endpoint="/csp-reports"');
  });

  it("omits the legacy Report-To header instead of advertising an invalid relative URL", async () => {
    const res = await app.request("/about", {}, env);
    expect(res.headers.get("report-to")).toBeNull();
  });
});

describe("extractCspReport", () => {
  it("unwraps the classic shape and the Reporting API first-body shape", () => {
    expect(extractCspReport(classicBody())).toEqual({
      "document-uri": "http://localhost/",
      "violated-directive": "script-src",
      "blocked-uri": "inline",
      "source-file": "http://localhost/",
      "line-number": 1,
    });
    expect(
      extractCspReport(JSON.stringify([{ body: { blockedURL: "inline" } }])),
    ).toEqual({ blockedURL: "inline" });
    expect(extractCspReport(JSON.stringify([{ blockedURL: "inline" }]))).toEqual({
      blockedURL: "inline",
    });
  });

  it("returns null for anything unrecognisable", () => {
    for (const raw of ["", "not-json{{{", "42", '"str"', "[1,2]", '{"hello":"world"}']) {
      expect(extractCspReport(raw)).toBeNull();
    }
  });
});

describe("cspReportLogFields", () => {
  it("collapses non-scalar values to null — never nested attacker data", () => {
    expect(
      cspReportLogFields({
        "blocked-uri": ["inline"],
        "violated-directive": { evil: true },
        "document-uri": 42,
        "source-file": "x",
        "line-number": "1",
      }),
    ).toEqual({
      blocked_uri: null,
      violated_directive: null,
      document_uri: null,
      source_file: "x",
      line_number: null,
    });
  });
});

describe("parseCspSampleRate / shouldSampleReport", () => {
  it("defaults to 1.0, clamps out-of-range, survives typos", () => {
    expect(parseCspSampleRate(undefined)).toBe(1.0);
    expect(parseCspSampleRate("0.5")).toBe(0.5);
    expect(parseCspSampleRate("2")).toBe(1);
    expect(parseCspSampleRate("-1")).toBe(0);
    expect(parseCspSampleRate("typo")).toBe(1.0);
    expect(parseCspSampleRate("")).toBe(1.0);
  });

  it("edges mirror legacy: >= 1.0 always logs, <= 0.0 never does", () => {
    expect(shouldSampleReport(1.0, () => 0.999)).toBe(true);
    expect(shouldSampleReport(0.0, () => 0.0)).toBe(false);
    expect(shouldSampleReport(0.5, () => 0.4)).toBe(true);
    expect(shouldSampleReport(0.5, () => 0.6)).toBe(false);
  });
});

describe("cspReportsRoute contract", () => {
  it("is the function wired at POST /csp-reports", () => {
    expect(typeof cspReportsRoute).toBe("function");
  });
});
