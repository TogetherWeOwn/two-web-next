import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone probe tooling has no declaration file.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { ALERT_PROBE_HEADER, PROBE_FINGERPRINT, STAGING_URL, runProbe } from "../bin/alert-probe.mjs";

const at = Date.parse("2026-10-01T00:00:00Z");
const probeId = "11111111-1111-4111-8111-111111111111";
const TOKEN = "fixture-qa-token";
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
const pair = () => trace([receipt("error.alert"), receipt("queue.failing")]);

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

const inputs = { token: TOKEN, receiptFile: "fixture.json", probeId };

type DisposalMode = "resolves" | "sync-throw" | "rejects" | "never-settles";
const modes: DisposalMode[] = ["resolves", "sync-throw", "rejects", "never-settles"];

// The disposal error deliberately carries the token: no verdict, error,
// result or diagnostic produced from it may ever surface that text.
function makeCancel(mode: DisposalMode) {
  switch (mode) {
    case "resolves":
      return vi.fn(async () => undefined);
    case "sync-throw":
      return vi.fn(() => {
        throw new Error(`dispose failed ${TOKEN}`);
      });
    case "rejects":
      return vi.fn(async () => {
        throw new Error(`dispose failed ${TOKEN}`);
      });
    case "never-settles":
      return vi.fn(() => new Promise<never>(() => {}));
  }
}

function responseWith(status: number, cancel: ReturnType<typeof makeCancel>) {
  const stream = new ReadableStream({ start() {} });
  Object.defineProperty(stream, "cancel", { value: cancel });
  return new Response(stream, { status });
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected runProbe to reject, but it resolved");
}

function expectCleanError(error: Error, expected: string) {
  expect(error.message).toContain(expected);
  expect(error.message).not.toContain(TOKEN);
  expect(error.message).not.toContain("dispose failed");
}

describe("alert probe response disposal is inert to the verdict", () => {
  it("null-body 500 with both receipts still succeeds (positive control)", async () => {
    const result = await runProbe({
      ...inputs,
      fetch: async () => new Response(null, { status: 500 }),
      read: fixtureRead(["", pair()]),
      ...clock(),
    });
    expect(result.receipts).toHaveLength(2);
  });

  it.each(modes)(
    "500 with both receipts succeeds when body disposal %s",
    async (mode) => {
      const cancel = makeCancel(mode);
      const send = vi.fn(async () => responseWith(500, cancel));
      const result = await runProbe({
        ...inputs,
        fetch: send,
        read: fixtureRead(["", pair()]),
        ...clock(),
      });
      await flush();
      expect(result).toMatchObject({
        target: STAGING_URL,
        probeId,
        receipts: [{ event: "error.alert" }, { event: "queue.failing" }],
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      // Disposal is still attempted exactly once; dropping it is not inertness.
      expect(cancel).toHaveBeenCalledTimes(1);
      // Exact staging target and token transport fences are retained.
      expect(send).toHaveBeenCalledWith(
        `${STAGING_URL}/__probe/alert`,
        expect.objectContaining({
          method: "POST",
          headers: {
            origin: STAGING_URL,
            "X-TWO-QA-Auth": TOKEN,
            [ALERT_PROBE_HEADER]: probeId,
          },
          redirect: "error",
        }),
      );
    },
    3000,
  );

  it.each(modes)(
    "500 with only the error.alert receipt still reaches the timeout when disposal %s",
    async (mode) => {
      const cancel = makeCancel(mode);
      const time = clock();
      const error = await caught(
        runProbe({
          ...inputs,
          timeoutMs: 2000,
          fetch: async () => responseWith(500, cancel),
          read: fixtureRead(["", trace([receipt("error.alert")])]),
          ...time,
        }),
      );
      await flush();
      expectCleanError(error, "BOTH");
      expect(time.pause).toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
    3000,
  );

  it.each(modes)(
    "500 with only the queue.failing receipt still reaches the timeout when disposal %s",
    async (mode) => {
      const cancel = makeCancel(mode);
      const time = clock();
      const error = await caught(
        runProbe({
          ...inputs,
          timeoutMs: 2000,
          fetch: async () => responseWith(500, cancel),
          read: fixtureRead(["", trace([receipt("queue.failing")])]),
          ...time,
        }),
      );
      await flush();
      expectCleanError(error, "BOTH");
      expect(time.pause).toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
    3000,
  );

  it.each(modes)(
    "500 with no receipts times out instead of cleanup manufacturing success when disposal %s",
    async (mode) => {
      const cancel = makeCancel(mode);
      const error = await caught(
        runProbe({
          ...inputs,
          timeoutMs: 2000,
          fetch: async () => responseWith(500, cancel),
          read: fixtureRead([""]),
          ...clock(),
        }),
      );
      expectCleanError(error, "BOTH");
    },
    3000,
  );

  it.each(modes)(
    "non-500 still refuses even with both receipts available when disposal %s",
    async (mode) => {
      const cancel = makeCancel(mode);
      const error = await caught(
        runProbe({
          ...inputs,
          fetch: async () => responseWith(200, cancel),
          read: fixtureRead(["", pair()]),
          ...clock(),
        }),
      );
      await flush();
      expectCleanError(error, "HTTP 200");
      expect(cancel).toHaveBeenCalledTimes(1);
    },
    3000,
  );

  it("a disposal rejection that lands after the verdict is swallowed without a trace", async () => {
    let rejectCancel!: (error: Error) => void;
    const cancel = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectCancel = reject;
        }),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const consoleCalls: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args.map((arg) => String(arg)).join(" "));
      }),
    );
    let settledBeforeRejection = false;
    let result: { receipts: unknown[] } | undefined;
    let failure: Error | undefined;
    try {
      const pending = runProbe({
        ...inputs,
        fetch: async () => responseWith(500, cancel),
        read: fixtureRead(["", pair()]),
        ...clock(),
      }) as Promise<{ receipts: unknown[] }>;
      void pending.then(
        () => {
          settledBeforeRejection = true;
        },
        () => {
          settledBeforeRejection = true;
        },
      );
      await flush();
      const wasSettled = settledBeforeRejection;
      rejectCancel(new Error(`late dispose failed ${TOKEN}`));
      result = await pending.catch((error: Error) => {
        failure = error;
        return undefined;
      });
      settledBeforeRejection = wasSettled;
      await flush();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      for (const spy of spies) spy.mockRestore();
    }
    // The verdict was already reached while disposal was still pending.
    expect(settledBeforeRejection).toBe(true);
    expect(failure).toBeUndefined();
    expect(result?.receipts).toHaveLength(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    expect(consoleCalls.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
