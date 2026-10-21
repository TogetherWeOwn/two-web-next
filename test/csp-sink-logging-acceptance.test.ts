// route-inventory: POST /csp-reports
// Acceptance: CSP sink must account malformed bodies and sink throws.
// Failing-first for the T4 observability build: malformed bodies and sink
// throws currently answer 204 with no log line at all. After the build, each
// emits a sampled warn reusing the existing token bucket (shed path included)
// or folds into shed accounting, with 204 behavior unchanged and no body, URI
// or exception message in any new line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import * as bodyModule from "../src/csp-report-body";

const BODY_PROBE = "csp-body-probe-6e2f94";
const MSG_PROBE = "csp-sink-msg-probe-8a1d47";
const SQL_PROBE = "csp-sql-probe-SELECT-secret-3c7b52";

const baseEnv = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;

const post = (body: BodyInit | null | undefined, e: Env = baseEnv) =>
  app.request("/csp-reports", { method: "POST", body }, e);

async function expectAlways204(res: Response) {
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.getSetCookie()).toEqual([]);
}

function loggedText(warn: { mock: { calls: unknown[][] } }) {
  return JSON.stringify(warn.mock.calls);
}

function warnKeys(warn: { mock: { calls: unknown[][] } }) {
  return warn.mock.calls.map((call) => String(call[0]));
}

let now = Date.now();

describe("CSP sink logging acceptance", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Refill the per-isolate token bucket between independent cases, never
    // within a flood: mirrors the shed-suite clock discipline.
    now += 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("malformed bodies emit sampled accounting while staying 204", async () => {
    const malformed = `not-json{{{${BODY_PROBE}`;
    const res = await post(malformed, { ...baseEnv, CSP_REPORT_SAMPLE_RATE: "1" });
    await expectAlways204(res);
    const keys = warnKeys(warn);
    // Either a dedicated malformed warn reusing the bucket, or shed accounting
    // for the drop: silence is the failure this acceptance pins.
    expect(
      keys.some((k) => k === "csp.report.malformed" || k === "csp.report.shed"),
      `expected malformed accounting, saw keys: ${JSON.stringify(keys)}`,
    ).toBe(true);
    const logged = loggedText(warn);
    expect(logged).not.toContain(BODY_PROBE);
    expect(logged).not.toContain("/csp-reports");
  });

  it("malformed JSON objects emit sampled accounting while staying 204", async () => {
    const res = await post(JSON.stringify({ hello: "world", probe: BODY_PROBE }), {
      ...baseEnv,
      CSP_REPORT_SAMPLE_RATE: "1",
    });
    await expectAlways204(res);
    const keys = warnKeys(warn);
    expect(
      keys.some((k) => k === "csp.report.malformed" || k === "csp.report.shed"),
      `expected malformed-object accounting, saw keys: ${JSON.stringify(keys)}`,
    ).toBe(true);
    expect(loggedText(warn)).not.toContain(BODY_PROBE);
  });

  it("sink throws emit exception-class-only accounting while staying 204", async () => {
    class CspSinkProbeError extends Error {
      constructor() {
        super(`${MSG_PROBE} ${SQL_PROBE} body=${BODY_PROBE}`);
        this.name = "CspSinkProbeError";
      }
    }
    vi.spyOn(bodyModule, "readCappedBody").mockRejectedValue(new CspSinkProbeError());
    const res = await post(JSON.stringify({ "csp-report": { "blocked-uri": "inline" } }));
    await expectAlways204(res);
    const logged = loggedText(warn);
    expect(logged, "sink throw must log the exception class").toContain("CspSinkProbeError");
    expect(logged).not.toContain(MSG_PROBE);
    expect(logged).not.toContain(SQL_PROBE);
    expect(logged).not.toContain(BODY_PROBE);
    expect(logged).not.toContain("/csp-reports");
  });

  it("malformed flood sheds through the shared bucket instead of going silent or flooding", async () => {
    const malformed = `not-json{{{${BODY_PROBE}-flood}`;
    for (let i = 0; i < 80; i += 1) {
      await expectAlways204(await post(malformed, { ...baseEnv, CSP_REPORT_SAMPLE_RATE: "1" }));
    }
    const keys = warnKeys(warn);
    // Bounded accounting: at least one line proves the flood was seen, and the
    // shared 20-token bucket plus one shed per window bounds the total.
    expect(keys.length, "malformed flood must not stay silent").toBeGreaterThan(0);
    expect(
      keys.length,
      `malformed flood must stay bounded, saw ${keys.length}`,
    ).toBeLessThanOrEqual(25);
    expect(
      keys.some((k) => k === "csp.report.malformed" || k === "csp.report.shed"),
      `expected malformed/shed keys, saw: ${JSON.stringify(keys.slice(0, 5))}`,
    ).toBe(true);
    const logged = loggedText(warn);
    expect(logged).not.toContain(BODY_PROBE);
    expect(logged).not.toContain("/csp-reports");
  });

  it("sampled-out malformed bodies stay silent while staying 204", async () => {
    const res = await post(`not-json{{{${BODY_PROBE}-sampled}`, {
      ...baseEnv,
      CSP_REPORT_SAMPLE_RATE: "0",
    });
    await expectAlways204(res);
    expect(warn).not.toHaveBeenCalled();
  });

  it("empty bodies stay 204 with no new payload content", async () => {
    const res = await post(null, { ...baseEnv, CSP_REPORT_SAMPLE_RATE: "1" });
    await expectAlways204(res);
    // Empty is the heartbeat of a quiet sink: it may account like malformed or
    // stay silent, but it must never log a body, URI or identity.
    const logged = loggedText(warn);
    expect(logged).not.toContain(BODY_PROBE);
    expect(logged).not.toContain("/csp-reports");
  });
});
