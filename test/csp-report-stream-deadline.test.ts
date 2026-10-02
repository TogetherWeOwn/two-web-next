// route-inventory: POST /csp-reports
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { CSP_REPORT_BODY_DEADLINE_MS, MAX_CSP_REPORT_BYTES } from "../src/csp-report-body";
import type { Env } from "../src/env";

const DEADLINE_MS = CSP_REPORT_BODY_DEADLINE_MS;
const encode = (text: string) => new TextEncoder().encode(text);
const report = JSON.stringify({
  "csp-report": { "blocked-uri": "inline", "evil-probe": "private-marker" },
});
const forbiddenAccess = vi.fn(() => {
  throw new Error("CSP sink touched a session or database binding");
});
const env = Object.defineProperties(
  { APP_URL: "https://next.example.test" },
  Object.fromEntries(
    ["SESSION_STORE", "ROSTER_STORE", "ADMIN_DB", "DB", "DATABASE_URL", "SESSION_SECRET"].map(
      (key) => [key, { get: forbiddenAccess }],
    ),
  ),
) as Env;

const request = (body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request("https://next.example.test/csp-reports", {
    method: "POST",
    body,
    duplex: "half",
    headers: { cookie: "__Host-two_session=two_forged.bad", ...headers },
  } as RequestInit);
const post = async (req: Request) => app.request(req, undefined, env);
const assert204 = async (response: Response | undefined) => {
  expect(response?.status).toBe(204);
  expect(await response!.text()).toBe("");
  expect(response!.headers.get("cache-control")).toBe("no-store");
  expect(response!.headers.getSetCookie()).toHaveLength(0);
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

beforeEach(() => {
  vi.useFakeTimers();
  forbiddenAccess.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("CSP sink must not fetch");
  });
});

afterEach(() => {
  try {
    expect(forbiddenAccess).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("CSP report stream liveness", () => {
  it("pins a finite one-second total body deadline", () => {
    expect(DEADLINE_MS).toBe(1000);
  });

  it("answers 204 by the deadline when the first read never settles", async () => {
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
    const req = request(stream);
    let response: Response | undefined;
    const completed = post(req).then((r) => {
      response = r;
    });
    try {
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(response).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await assert204(response);
      expect(cancel).toHaveBeenCalledOnce();
      expect(req.body!.locked).toBe(false);
      expect(console.warn).not.toHaveBeenCalled();
    } finally {
      if (!response) controller.close();
      cancellation.resolve();
      await completed;
    }
  });

  it("discards even a valid JSON prefix and does not renew the deadline per chunk", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
          c.enqueue(encode(report));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const parse = vi.spyOn(JSON, "parse");
    let response: Response | undefined;
    const completed = post(request(stream)).then((r) => {
      response = r;
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(DEADLINE_MS / 4);
      controller.enqueue(encode(" "));
      await vi.advanceTimersByTimeAsync(0);
      expect(response).toBeUndefined();
    }
    await vi.advanceTimersByTimeAsync(DEADLINE_MS / 4);
    await completed;
    await assert204(response);
    expect(cancel).toHaveBeenCalledOnce();
    expect(parse).not.toHaveBeenCalledWith(report + " ".repeat(3));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("answers 204 without waiting for an over-cap stream's cancellation", async () => {
    const cancellation = deferred<void>();
    const cancel = vi.fn(() => cancellation.promise);
    const prefix = report.padEnd(MAX_CSP_REPORT_BYTES, " ");
    const parse = vi.spyOn(JSON, "parse");
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls += 1;
          c.enqueue(pulls === 1 ? encode(prefix) : new Uint8Array(64 * 1024));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const req = request(stream, { "content-length": "1" });
    let response: Response | undefined;
    const completed = post(req).then((r) => {
      response = r;
    });
    try {
      // Overflow returns immediately; cancellation gets no response budget.
      await vi.advanceTimersByTimeAsync(0);
      await assert204(response);
      expect(pulls).toBe(2);
      expect(cancel).toHaveBeenCalledOnce();
      expect(req.body!.locked).toBe(false);
      expect(parse).not.toHaveBeenCalledWith(prefix);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("csp.report.dropped_oversize", {
        bytes: MAX_CSP_REPORT_BYTES + 64 * 1024,
      });
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect(pulls).toBe(2);
    } finally {
      cancellation.resolve();
      await completed;
    }
  });

  it("discards an aborted read without waiting for cancellation", async () => {
    const cancellation = deferred<void>();
    const req = request(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }));
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: encode(report) })
      .mockRejectedValueOnce(new Error("synthetic read failure"));
    const cancel = vi.fn(() => cancellation.promise);
    const releaseLock = vi.fn();
    const body = req.body!;
    vi.spyOn(body, "getReader").mockReturnValue({
      read,
      cancel,
      releaseLock,
    } as unknown as ReturnType<typeof body.getReader>);
    const parse = vi.spyOn(JSON, "parse");
    let response: Response | undefined;
    const completed = post(req).then((r) => {
      response = r;
    });
    await vi.advanceTimersByTimeAsync(0);
    await assert204(response);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(parse).not.toHaveBeenCalledWith(report);
    expect(console.warn).not.toHaveBeenCalled();
    cancellation.resolve();
    await completed;
  });

  it.each(["resolve", "reject"] as const)(
    "consumes late read/cancel rejection and ignores a late read %s",
    async (outcome) => {
      // A synthetic reader keeps its read pending through cancel/release, letting
      // this test exercise late settlement independently of native stream cleanup.
      const pending = deferred<ReadableStreamReadResult<Uint8Array>>();
      const cancellation = deferred<void>();
      const req = request(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }));
      const read = vi.fn(() => pending.promise);
      const cancel = vi.fn(() => cancellation.promise);
      const releaseLock = vi.fn();
      const body = req.body!;
      vi.spyOn(body, "getReader").mockReturnValue({
        read,
        cancel,
        releaseLock,
      } as unknown as ReturnType<typeof body.getReader>);
      let response: Response | undefined;
      const completed = post(req).then((r) => {
        response = r;
      });
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      await completed;
      await assert204(response);
      expect(cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
      const decode = vi.spyOn(TextDecoder.prototype, "decode");
      if (outcome === "resolve") pending.resolve({ done: false, value: encode(report) });
      else pending.reject(new Error("late synthetic read rejection"));
      cancellation.reject(new Error("late synthetic cancellation rejection"));
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledOnce();
      expect(decode).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      // Vitest also fails this suite on any unhandled rejection.
    },
  );
});

describe("CSP stream controls", () => {
  it("accepts a small report split inside a UTF-8 scalar and logs only fixed fields", async () => {
    // The multi-byte scalar rides `violated-directive` (a passthrough field):
    // URI fields are redacted fail-closed since main's credential-redaction
    // slice, so a relative `blocked-uri` can no longer carry the proof —
    // redaction would mask a broken reassembly as `null`.
    const body = encode(
      JSON.stringify({
        "csp-report": {
          "blocked-uri": "inline",
          "violated-directive": "script-src é",
          "evil-probe": "private-marker",
        },
      }),
    );
    const split = body.indexOf(0xc3) + 1;
    const cancel = vi.fn();
    const req = request(
      new ReadableStream<Uint8Array>(
        {
          start(c) {
            c.enqueue(body.slice(0, split));
            c.enqueue(body.slice(split));
            c.close();
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    await assert204(await post(req));
    expect(req.body!.locked).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("csp.report.violation", {
      blocked_uri: "inline",
      violated_directive: "script-src é",
      document_uri: null,
      source_file: null,
      line_number: null,
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private-marker");
  });

  it.each([null, "", "not-json{{{", '{"hello":"world"}'])(
    "silently returns 204 for empty/malformed input %j",
    async (body) => {
      const stream =
        body === null
          ? null
          : new ReadableStream<Uint8Array>(
              {
                start(c) {
                  c.enqueue(encode(body));
                  c.close();
                },
              },
              { highWaterMark: 0 },
            );
      await assert204(await post(request(stream)));
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it("accepts a complete valid body exactly at the cap", async () => {
    await assert204(await post(request(report.padEnd(MAX_CSP_REPORT_BYTES, " "))));
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("csp.report.violation", {
      blocked_uri: "inline",
      violated_directive: null,
      document_uri: null,
      source_file: null,
      line_number: null,
    });
  });

  it("does not read a declared oversize body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const req = request(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), {
      "content-length": String(MAX_CSP_REPORT_BYTES + 1),
    });
    await assert204(await post(req));
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(req.body!.locked).toBe(false);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("csp.report.dropped_oversize", {
      bytes: MAX_CSP_REPORT_BYTES + 1,
    });
    await req.body!.cancel();
  });
});
