// route-inventory: POST /csp-reports
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { CSP_REPORT_BODY_DEADLINE_MS, readCappedBody } from "../src/csp-report-body";
import { extractCspReport } from "../src/csp-reports";
import type { Env } from "../src/env";

const DEADLINE_MS = CSP_REPORT_BODY_DEADLINE_MS;
const encode = (text: string) => new TextEncoder().encode(text);
const report = JSON.stringify({
  "csp-report": { "blocked-uri": "inline", "violated-directive": "script-src" },
});

const env = { APP_URL: "https://next.example.test" } as Env;
const post = async (req: Request): Promise<Response> => {
  const response = await app.request(req, undefined, env);
  return response;
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

type MockReader = {
  read: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
};

const stallRequest = (reader: MockReader) => {
  const req = new Request("https://next.example.test/csp-reports", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }),
    duplex: "half",
  } as RequestInit);
  const body = req.body!;
  vi.spyOn(body, "getReader").mockReturnValue(
    reader as unknown as ReturnType<typeof body.getReader>,
  );
  return req;
};

const pendingReader = () => {
  const pending = deferred<ReadableStreamReadResult<Uint8Array>>();
  const cancellation = deferred<void>();
  return {
    pending,
    cancellation,
    reader: {
      read: vi.fn(() => pending.promise),
      cancel: vi.fn(() => cancellation.promise),
      releaseLock: vi.fn(),
    } as MockReader,
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  try {
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("readCappedBody stalled-stream deadline", () => {
  it("pins a finite one-second total body deadline", () => {
    expect(DEADLINE_MS).toBe(1000);
  });

  it("resolves an empty body within the deadline when the first read never settles", async () => {
    const { cancellation, reader } = pendingReader();
    const req = stallRequest(reader);
    let settled = false;
    const result = readCappedBody(req).then((capped) => {
      settled = true;
      return capped;
    });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ text: "", truncated: false, bytes: 0 });
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(req.body!.locked).toBe(false);
    cancellation.resolve();
    await result;
  });

  it.each(["resolve", "reject"] as const)(
    "retains nothing from a late read %s after the deadline",
    async (outcome) => {
      const { pending, cancellation, reader } = pendingReader();
      const promise = readCappedBody(stallRequest(reader));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      const capped = await promise;
      expect(capped).toEqual({ text: "", truncated: false, bytes: 0 });
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalledOnce();
      const decode = vi.spyOn(TextDecoder.prototype, "decode");
      if (outcome === "resolve") pending.resolve({ done: false, value: encode(report) });
      else pending.reject(new Error("late synthetic read rejection"));
      cancellation.reject(new Error("late synthetic cancellation rejection"));
      await vi.advanceTimersByTimeAsync(0);
      expect(reader.read).toHaveBeenCalledOnce();
      expect(decode).not.toHaveBeenCalled();
      // The empty win maps to the silent path, so the sink still answers 204.
      expect(extractCspReport(capped.text)).toBeNull();
      expect(console.warn).not.toHaveBeenCalled();
      // Vitest also fails this suite on any unhandled rejection.
    },
  );

  it("still answers 204 by the deadline when the stream stalls", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancellation = deferred<void>();
    const cancel = vi.fn(() => cancellation.promise);
    const stream = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const req = new Request("https://next.example.test/csp-reports", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    let response: Response | undefined;
    const completed = post(req).then((r) => {
      response = r;
    });
    try {
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(response).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(response?.status).toBe(204);
      expect(await response!.text()).toBe("");
      expect(response!.headers.get("cache-control")).toBe("no-store");
      expect(response!.headers.getSetCookie()).toHaveLength(0);
      expect(console.warn).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(req.body!.locked).toBe(false);
    } finally {
      if (!response) controller.close();
      cancellation.resolve();
      await completed;
    }
  });
});
