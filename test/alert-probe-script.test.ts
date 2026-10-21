import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone probe tooling has no declaration file.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { ALERT_PROBE_HEADER, PROBE_FINGERPRINT, STAGING_URL, main, probeReceipts, runProbe, tailObjects } from "../bin/alert-probe.mjs";

const at = Date.parse("2026-10-01T00:00:00Z");
const probeId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const receipt = (event: string, extra = {}) => ({
  delivery: "ops.alert.delivered",
  event,
  probeId,
  timestamp: new Date(at).toISOString(),
  ...(event === "error.alert"
    ? { route: "/__probe/alert", fingerprint: PROBE_FINGERPRINT }
    : { job: "AlertProbe", fingerprint: "queue.failing@AlertProbe", attempts: 1 }),
  ...extra,
});
const trace = (lines: unknown[], scriptName = "two-web-next-alerts") =>
  JSON.stringify(
    {
      scriptName,
      logs: [{ message: lines.map((line) => JSON.stringify(line)) }],
    },
    null,
    2,
  );
const pair = (extra = {}) =>
  trace([receipt("error.alert", extra), receipt("queue.failing", extra)]);

function fixtureRead(snapshots: string[]) {
  let reads = 0;
  return vi.fn(async () => snapshots[Math.min(reads++, snapshots.length - 1)]!);
}

function clock() {
  let time = at;
  return {
    now: () => time,
    pause: vi.fn(async () => {
      time += 1000;
    }),
  };
}

const inputs = { token: "fixture-qa-token", receiptFile: "fixture.json", probeId };
const response = async () => new Response(null, { status: 500 });

describe("operator alert probe tool (local fixtures)", () => {
  it("reads pretty-printed Wrangler events and ignores incomplete objects and braces in strings", () => {
    const text = `Connected\n${trace([receipt("error.alert", { note: 'braces { } and quote "' })])}\n${trace([receipt("queue.failing")])}\n{"logs":`;
    expect(tailObjects(text)).toHaveLength(2);
    expect(probeReceipts(text, probeId).size).toBe(2);
    expect(tailObjects('{not JSON}\n{"logs":[]}')).toEqual([{ logs: [] }]);
  });

  it("requires confirmed receipts from the Tail Worker for BOTH synthetic fingerprints and this probe ID", () => {
    const rejected = [
      receipt("error.alert", { delivery: "ops.alert.delivery_failed" }),
      receipt("error.alert", { timestamp: "invalid" }),
      receipt("error.alert", { timestamp: [new Date(at).toISOString()] }),
      receipt("error.alert", { probeId: otherId }),
      receipt("error.alert", { route: "/join" }),
      receipt("error.alert", { fingerprint: "other" }),
      receipt("queue.failing", { job: "CallInternalAction" }),
      receipt("queue.failing", { attempts: 0 }),
      receipt("queue.failing", { attempts: 1.5 }),
      receipt("queue.failing", { attempts: "1" }),
      null,
      "malformed",
      { event: "error.alert" },
    ];
    expect(probeReceipts(trace(rejected), probeId).size).toBe(0);
    expect(
      probeReceipts(
        trace([receipt("error.alert"), receipt("queue.failing")], "two-web-next"),
        probeId,
      ).size,
    ).toBe(0);
    expect(probeReceipts(trace([receipt("error.alert")]), probeId).size).toBe(1);
  });

  it("posts to staging with token in a header and waits for actual receipt evidence", async () => {
    const baseline = pair({ probeId: otherId });
    const read = fixtureRead([
      baseline,
      `${baseline}\n${trace([receipt("error.alert")])}`,
      `${baseline}\n${pair()}`,
    ]);
    const send = vi.fn(response);
    const result = await runProbe({ ...inputs, fetch: send, read, ...clock() });
    expect(result).toMatchObject({
      target: STAGING_URL,
      probeId,
      receipts: [{ event: "error.alert" }, { event: "queue.failing" }],
    });
    expect(send).toHaveBeenCalledWith(
      `${STAGING_URL}/__probe/alert`,
      expect.objectContaining({
        method: "POST",
        headers: {
          origin: STAGING_URL,
          "X-TWO-QA-Auth": "fixture-qa-token",
          [ALERT_PROBE_HEADER]: probeId,
        },
        redirect: "error",
      }),
    );
    expect(read).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("fixture-qa-token");
  });

  it.each([-30_000, 30_000])(
    "unchanged old receipts cannot pass with remote clock skew %i",
    async (skew) => {
      const old = pair({ timestamp: new Date(at + skew).toISOString() });
      const read = fixtureRead([old]);
      const time = clock();
      await expect(
        runProbe({ ...inputs, timeoutMs: 2000, fetch: response, read, ...time }),
      ).rejects.toThrow("BOTH");
      expect(time.pause).toHaveBeenCalledTimes(2);
    },
  );

  it("a pending baseline object completed after the POST is still old evidence", async () => {
    const old = pair({ timestamp: new Date(at + 30_000).toISOString() });
    const baseline = old.slice(0, -20);
    await expect(
      runProbe({
        ...inputs,
        timeoutMs: 2000,
        fetch: response,
        read: fixtureRead([baseline, old]),
        ...clock(),
      }),
    ).rejects.toThrow("BOTH");
  });

  it("accepts only newly started objects, including after an old partial object, without comparing remote/local clocks", async () => {
    const old = pair();
    const baseline = old.slice(0, -20);
    const fresh = pair({ timestamp: new Date(at - 30_000).toISOString() });
    const result = await runProbe({
      ...inputs,
      fetch: response,
      read: fixtureRead([baseline, `${old}\n${fresh}`]),
      ...clock(),
    });
    expect(result.receipts).toHaveLength(2);
    expect(
      result.receipts.every(
        (r: { timestamp: string }) => r.timestamp === new Date(at - 30_000).toISOString(),
      ),
    ).toBe(true);
  });

  it.each([
    pair({ probeId: otherId }),
    trace([receipt("error.alert"), receipt("queue.failing", { probeId: otherId })]),
  ])("concurrent probe receipts cannot prove this run's delivery %#", async (foreign) => {
    await expect(
      runProbe({
        ...inputs,
        timeoutMs: 2000,
        fetch: response,
        read: fixtureRead(["", foreign]),
        ...clock(),
      }),
    ).rejects.toThrow("BOTH");
  });

  it("fails closed if the receipt stream is truncated or replaced", async () => {
    await expect(
      runProbe({
        ...inputs,
        fetch: response,
        read: fixtureRead([pair(), pair({ probeId: otherId })]),
        ...clock(),
      }),
    ).rejects.toThrow("Receipt stream changed");
  });

  it.each([
    { baseUrl: "https://togetherweown.com" },
    { baseUrl: `${STAGING_URL}/` },
    { baseUrl: `${STAGING_URL}.evil.test` },
    { token: "" },
    { receiptFile: "" },
    { timeoutMs: -1 },
    { timeoutMs: 300_001 },
    { probeId: "not-a-uuid" },
  ])("fails before network for unsafe target/missing input %#", async (change) => {
    const send = vi.fn();
    await expect(runProbe({ ...inputs, fetch: send, ...change })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to send before the receipt file exists", async () => {
    const send = vi.fn();
    await expect(
      runProbe({
        ...inputs,
        fetch: send,
        read: async () => {
          throw new Error("missing file");
        },
      }),
    ).rejects.toThrow("missing file");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([200, 404, 403, 503])("HTTP %s is not probe success", async (status) => {
    await expect(
      runProbe({
        ...inputs,
        read: async () => "",
        fetch: async () => new Response(null, { status }),
      }),
    ).rejects.toThrow(`HTTP ${status}`);
  });

  it("a source 500 or only one delivered event cannot pass the bounded wait", async () => {
    await expect(
      runProbe({
        ...inputs,
        timeoutMs: 2000,
        read: fixtureRead(["", trace([receipt("error.alert")])]),
        fetch: response,
        ...clock(),
      }),
    ).rejects.toThrow("BOTH");
  });
});

describe("alert-probe CLI exit codes (offline main)", () => {
  const TOKEN = "fixture-main-token";
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: typeof process.exitCode;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = prevExitCode;
  });

  const logged = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((callArgs: unknown[]) => String(callArgs[0])).join("\n");

  it("delivery failure exits 1 with the failure line and code=delivery_failed, never the token", async () => {
    const probe = vi.fn(async () => {
      throw new Error("delivery down");
    });
    await main({
      args: ["--receipt-file", "dummy.json"],
      env: { QA_AUTH_TOKEN: TOKEN },
      probe,
      readImpl: async () => "{}",
    });
    expect(probe).toHaveBeenCalledWith({ token: TOKEN, receiptFile: "dummy.json" });
    expect(process.exitCode).toBe(1);
    const stderr = logged(errorSpy);
    expect(stderr).toContain("no delivery claimed");
    expect(stderr).toContain("code=delivery_failed");
    expect(stderr).not.toContain(TOKEN);
    expect(logged(logSpy)).not.toContain(TOKEN);
  });

  it("pins exact stable codes for usage, missing inputs, and dry-run success", async () => {
    // usage
    await main({ args: ["--unknown"], env: { QA_AUTH_TOKEN: TOKEN } });
    expect(process.exitCode).toBe(2);
    expect(logged(errorSpy)).toContain("code=usage");
    expect(logged(errorSpy)).toMatch(/Usage:/);

    // real missing token
    errorSpy.mockClear();
    process.exitCode = undefined;
    await main({
      args: ["--receipt-file", "dummy.json"],
      env: {},
      readImpl: async () => "{}",
    });
    expect(process.exitCode).toBe(2);
    expect(logged(errorSpy)).toContain("code=missing_token");

    // real unreadable receipt
    errorSpy.mockClear();
    process.exitCode = undefined;
    await main({
      args: ["--receipt-file", "absent.json"],
      env: { QA_AUTH_TOKEN: TOKEN },
      readImpl: async () => {
        throw new Error("missing");
      },
    });
    expect(process.exitCode).toBe(2);
    expect(logged(errorSpy)).toContain("code=unreadable_receipt");

    // dry-run missing token
    errorSpy.mockClear();
    process.exitCode = undefined;
    await main({
      args: ["--receipt-file", "dummy.json", "--dry-run"],
      env: {},
      readImpl: async () => "{}",
    });
    expect(process.exitCode).toBe(2);
    expect(logged(errorSpy)).toContain("code=missing_token");

    // dry-run unreadable receipt
    errorSpy.mockClear();
    process.exitCode = undefined;
    await main({
      args: ["--receipt-file", "absent.json", "--dry-run"],
      env: { QA_AUTH_TOKEN: TOKEN },
      readImpl: async () => {
        throw new Error("missing");
      },
    });
    expect(process.exitCode).toBe(2);
    expect(logged(errorSpy)).toContain("code=unreadable_receipt");

    // dry-run success pins exact JSON shape
    errorSpy.mockClear();
    logSpy.mockClear();
    process.exitCode = undefined;
    await main({
      args: ["--receipt-file", "receipt.json", "--dry-run"],
      env: { QA_AUTH_TOKEN: TOKEN },
      readImpl: async () => "{}",
    });
    expect(process.exitCode).toBeUndefined();
    expect(logged(errorSpy)).toBe("");
    const verdict = JSON.parse(logged(logSpy));
    expect(verdict.code).toBe("dry_run.ok");
    expect(verdict.mode).toBe("dry-run");
    expect(verdict.dry_run).toBe(true);
    expect(logged(logSpy)).not.toContain(TOKEN);
  });

  it("forwards a successful delivery result to stdout without setting an exit code", async () => {
    const result = { target: STAGING_URL, probeId, receipts: [] };
    const probe = vi.fn(async () => result);
    await main({
      args: ["--receipt-file", "dummy.json"],
      env: { QA_AUTH_TOKEN: TOKEN },
      probe,
      readImpl: async () => "{}",
    });
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(logged(logSpy))).toEqual(result);
  });
});
