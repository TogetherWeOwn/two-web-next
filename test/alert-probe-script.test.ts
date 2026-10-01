import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone probe tooling has no declaration file.
import { PROBE_FINGERPRINT, STAGING_URL, probeReceipts, runProbe, tailObjects } from "../bin/alert-probe.mjs";

const at = Date.parse("2026-10-01T00:00:00Z");
const receipt = (event: string, extra = {}) => ({
  delivery: "ops.alert.delivered", event, timestamp: new Date(at).toISOString(),
  ...(event === "error.alert" ? { route: "/__probe/alert", fingerprint: PROBE_FINGERPRINT }
    : { job: "AlertProbe", fingerprint: "queue.failing@AlertProbe", attempts: 1 }), ...extra,
});
const trace = (lines: unknown[], scriptName = "two-web-next-alerts") => JSON.stringify({
  scriptName, logs: [{ message: lines.map((line) => JSON.stringify(line)) }],
}, null, 2);

describe("operator alert probe tool (local fixtures)", () => {
  it("reads pretty-printed Wrangler events and ignores incomplete objects and braces in strings", () => {
    const text = `Connected\n${trace([receipt("error.alert", { note: 'braces { } and quote "' })])}\n${trace([receipt("queue.failing")])}\n{"logs":`;
    expect(tailObjects(text)).toHaveLength(2);
    expect(probeReceipts(text, at).size).toBe(2);
    expect(tailObjects('{not JSON}\n{"logs":[]}')).toEqual([{ logs: [] }]);
  });

  it("requires confirmed, new receipts from the Tail Worker for BOTH synthetic fingerprints", () => {
    const rejected = [
      receipt("error.alert", { delivery: "ops.alert.delivery_failed" }),
      receipt("error.alert", { timestamp: new Date(at - 1).toISOString() }),
      receipt("error.alert", { route: "/join" }), receipt("error.alert", { fingerprint: "other" }),
      receipt("queue.failing", { job: "CallInternalAction" }), receipt("queue.failing", { attempts: 0 }),
      null, "malformed", { event: "error.alert" },
    ];
    expect(probeReceipts(trace(rejected), at).size).toBe(0);
    expect(probeReceipts(trace([receipt("error.alert"), receipt("queue.failing")], "two-web-next"), at).size).toBe(0);
    expect(probeReceipts(trace([receipt("error.alert")]), at).size).toBe(1);
  });

  it("posts to staging with token in a header and waits for actual receipt evidence", async () => {
    let time = at, reads = 0;
    const send = vi.fn(async () => new Response(null, { status: 500 }));
    const read = vi.fn(async () => {
      reads++;
      return reads < 3 ? trace([receipt("error.alert")]) : trace([receipt("error.alert"), receipt("queue.failing")]);
    });
    const result = await runProbe({ token: "fixture-qa-token", receiptFile: "fixture.json", fetch: send, read,
      now: () => time, pause: async () => { time += 1000; } });
    expect(result).toMatchObject({ target: STAGING_URL, receipts: [{ event: "error.alert" }, { event: "queue.failing" }] });
    expect(send).toHaveBeenCalledWith(`${STAGING_URL}/__probe/alert`, expect.objectContaining({
      method: "POST", headers: { origin: STAGING_URL, "X-TWO-QA-Auth": "fixture-qa-token" }, redirect: "error",
    }));
    expect(reads).toBe(3);
    expect(JSON.stringify(result)).not.toContain("fixture-qa-token");
  });

  it.each([
    { baseUrl: "https://togetherweown.com" }, { baseUrl: `${STAGING_URL}/` }, { baseUrl: `${STAGING_URL}.evil.test` },
    { token: "" }, { receiptFile: "" }, { timeoutMs: -1 }, { timeoutMs: 300_001 },
  ])("fails before network for unsafe target/missing input %#", async (change) => {
    const send = vi.fn();
    await expect(runProbe({ token: "fixture", receiptFile: "fixture.json", fetch: send, ...change })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to send before the receipt file exists", async () => {
    const send = vi.fn();
    await expect(runProbe({ token: "fixture", receiptFile: "fixture.json", fetch: send,
      read: async () => { throw new Error("missing file"); } })).rejects.toThrow("missing file");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([200, 404, 403, 503])("HTTP %s is not probe success", async (status) => {
    await expect(runProbe({ token: "fixture", receiptFile: "fixture.json", read: async () => "",
      fetch: async () => new Response(null, { status }) })).rejects.toThrow(`HTTP ${status}`);
  });

  it("a source 500 or only one delivered event cannot pass the bounded wait", async () => {
    let time = at;
    await expect(runProbe({ token: "fixture", receiptFile: "fixture.json", timeoutMs: 2000,
      read: async () => trace([receipt("error.alert")]), fetch: async () => new Response(null, { status: 500 }),
      now: () => time, pause: async () => { time += 1000; },
    })).rejects.toThrow("BOTH");
  });
});
