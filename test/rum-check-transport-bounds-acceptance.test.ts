import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import * as rumModule from "../ci/rum-check.mjs";

// Acceptance contract: bound Analytics I/O and report unevaluated budgets truthfully.
//
// At the base this was written against, ci/rum-check.mjs awaits fetchImpl and
// then res.json() with no application-owned deadline and no response-byte
// bound. A transport that never sends headers, stalls mid-body, or ignores an
// abort leaves runRumCheck unsettled forever and emits no summary at all; the
// only backstop is whole-job cancellation in the workflow. res.json() also
// buffers the entire provider body before any structural admission.
//
// Locked builder contract (this file is Test Author-owned; do not edit it to
// make an implementation pass — hand incorrect tests back on the card):
// - ci/rum-check.mjs exports RUM_TRANSPORT_TIMEOUT_MS: a finite, documented
//   total transport deadline (1s-30s) covering headers AND body through
//   completion. It is one total deadline, not an idle timer a dripping body
//   resets, and not a second deadline restarted when headers arrive.
// - It exports RUM_MAX_RESPONSE_BYTES: a finite, documented integer response
//   ceiling (16 KiB-1 MiB) enforced on raw bytes BEFORE JSON parsing. A body
//   of exactly the ceiling is accepted; one byte over is refused as soon as
//   the overflow byte arrives, without waiting for EOF. Bytes are counted as
//   UTF-8 bytes across chunk boundaries, never as string code units.
// - runRumCheck accepts optional { timeoutMs, maxResponseBytes } overrides
//   defaulting to those constants. It passes an AbortSignal to fetchImpl
//   (preserving the existing method, headers and body), aborts on deadline or
//   overflow, and settles independently of the transport even when the
//   injected fetch/read ignores the signal. Consuming res.body as a byte
//   stream is the expected shape; res.json() alone cannot satisfy the
//   cap-before-parse or prompt-overflow requirements. Drive the deadline
//   with the global setTimeout (raced against the transport work), not
//   AbortSignal.timeout alone: the abort-ignoring tests require settlement
//   independent of the signal, and the controlled-clock tests use fake
//   timers, which do not govern AbortSignal.timeout in this Vitest version.
// - Deadline expiry settles exactly once as { code: 1, kind: "timeout" } with
//   one fixed summary that says the query timed out and "Budgets not
//   evaluated.". Byte overflow settles exactly once as
//   { code: 1, kind: "response-too-large" } with one fixed summary that says
//   the response was too large and "Budgets not evaluated.". Summaries stay
//   bounded fixed-shape strings: no token, account, site tag, provider
//   payload or body content.
// - On timeout/overflow the implementation attempts disposal (abort plus
//   response-body cancellation) WITHOUT awaiting uncooperative cleanup.
//   Disposal that throws, rejects or never settles, and transport work that
//   resolves, rejects or errors after settlement, must not change the settled
//   result, emit a second summary, or surface as an unhandled rejection.
// - Existing outcomes are preserved through the new read path: unconfigured
//   skip (no fetch), insufficient samples, pass, over-budget, HTTP/GraphQL
//   query failures, invalid JSON and malformed envelopes. ci/rum-budget.json
//   thresholds (LCP/CLS/INP/minSamples) are not relaxed, and
//   docs/rum-web-vitals.md documents the timeout and byte-cap behaviour.
// - Note: the pre-existing doubles in test/rum-check.test.ts expose only
//   json() and no body stream. That file is not acceptance-owned; update its
//   doubles (or tolerate a body-less response) so its outcomes stay green.
//
// Hermetic only: injected fetch/ReadableStream doubles, no network.

type RumResult = { code: number; kind: string; summary: string };
type RunOpts = {
  env?: Record<string, string>;
  fetchImpl?: unknown;
  budget?: unknown;
  onSummary?: (md: string) => void;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

const rum = rumModule as unknown as Record<string, unknown>;
const runRumCheck = rum.runRumCheck as (opts: RunOpts) => Promise<RumResult>;
const TIMEOUT_DEFAULT = rum.RUM_TRANSPORT_TIMEOUT_MS;
const CAP_DEFAULT = rum.RUM_MAX_RESPONSE_BYTES;

const repoFile = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const source = repoFile("ci/rum-check.mjs");

const budget = { lcpMs: 2500, cls: 0.1, inpMs: 200, minSamples: 50 };
const env = {
  CF_ANALYTICS_READ_TOKEN: "token-marker-abc123",
  CF_RUM_ACCOUNT_ID: "account-marker-abc123",
  CF_RUM_SITE_TAG: "site-marker-abc123",
};
const TIMEOUT_MS = 60;
const BOUND_MS = 1_500;
const encoder = new TextEncoder();

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flushMicro = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Tracked = {
  settled: boolean;
  value?: RumResult;
  error?: unknown;
  done: Promise<void>;
};
function track(p: Promise<RumResult>): Tracked {
  const t: Tracked = { settled: false, done: Promise.resolve() };
  t.done = p.then(
    (value) => {
      t.settled = true;
      t.value = value;
    },
    (error: unknown) => {
      t.settled = true;
      t.error = error;
    },
  );
  return t;
}
async function settleWithin(p: Promise<RumResult>, ms = BOUND_MS): Promise<Tracked> {
  const t = track(p);
  await Promise.race([t.done, delay(ms)]);
  return t;
}
function expectSettled(t: Tracked, what: string): RumResult {
  expect(t.error, `${what}: runRumCheck must resolve, not reject`).toBeUndefined();
  expect(t.settled, `${what}: runRumCheck must settle within ${BOUND_MS}ms`).toBe(true);
  return t.value as RumResult;
}

function collectUnhandled() {
  const seen: unknown[] = [];
  const onUnhandled = (err: unknown) => seen.push(err);
  process.on("unhandledRejection", onUnhandled);
  return { seen, stop: () => process.off("unhandledRejection", onUnhandled) };
}

type ManualStream = {
  stream: ReadableStream<Uint8Array>;
  state: { cancelled: boolean; cancelCalls: number };
  enqueue: (bytes: Uint8Array) => void;
  close: () => void;
  error: (err: unknown) => void;
};
function manualStream(cancelImpl?: (reason: unknown) => unknown): ManualStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false, cancelCalls: 0 };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel(reason) {
      state.cancelled = true;
      state.cancelCalls++;
      return cancelImpl?.(reason) as Promise<void> | undefined;
    },
  });
  const safe = (fn: () => void) => () => {
    try {
      fn();
    } catch {
      // The reader may already have cancelled/closed the stream; cleanup is best-effort.
    }
  };
  return {
    stream,
    state,
    enqueue: (bytes) => safe(() => controller.enqueue(bytes))(),
    close: safe(() => controller.close()),
    error: (err) => safe(() => controller.error(err))(),
  };
}

const jsonResponse = (body: ManualStream | string, status = 200) =>
  new Response(typeof body === "string" ? body : body.stream, {
    status,
    headers: { "content-type": "application/json" },
  });

const group = (count: number, lcpMicros = 1_800_000) => ({
  count,
  quantiles: {
    largestContentfulPaintP75: lcpMicros,
    cumulativeLayoutShiftP75: 0.05,
    interactionToNextPaintP75: 150_000,
  },
});
const envelope = (g: unknown, extra: Record<string, unknown> = {}) => ({
  data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [g] }] } },
  ...extra,
});
const validText = (count = 500, lcpMicros?: number) =>
  JSON.stringify(envelope(group(count, lcpMicros)));

// A valid envelope padded (via an ignored top-level field) to an exact UTF-8
// byte length. The pad mixes 2-byte characters with an ASCII marker so byte
// counts and code-unit counts differ and payload leakage is detectable.
function paddedValidText(targetBytes: number): string {
  const skeleton = envelope(group(500), { pad: "" });
  const base = encoder.encode(JSON.stringify(skeleton)).length;
  const need = targetBytes - base;
  expect(need, "target must exceed the unpadded envelope").toBeGreaterThanOrEqual(16);
  const marker = "PAYLOAD-MARKER-";
  let pad = marker;
  let remaining = need - encoder.encode(pad).length;
  pad += "é".repeat(Math.floor(remaining / 2));
  remaining = need - encoder.encode(pad).length;
  pad += "x".repeat(remaining);
  const text = JSON.stringify(envelope(group(500), { pad }));
  expect(encoder.encode(text).length).toBe(targetBytes);
  return text;
}

function startRun(opts: RunOpts) {
  const onSummary = vi.fn();
  const promise = runRumCheck({ env, budget, onSummary, ...opts });
  return { promise, onSummary };
}

afterEach(() => {
  vi.useRealTimers();
});

// --- Positive/refusal controls: pass at the base, pin preserved behaviour. ---

describe("controls preserved through the streamed read path", () => {
  it("passes a valid in-budget streamed response and preserves the request shape", async () => {
    let seenUrl: unknown;
    let seenInit: { method?: string; headers?: Record<string, string>; body?: string } = {};
    const fetchImpl = async (url: unknown, init: typeof seenInit) => {
      seenUrl = url;
      seenInit = init;
      const body = manualStream();
      const bytes = encoder.encode(validText());
      body.enqueue(bytes.slice(0, 10));
      body.enqueue(bytes.slice(10));
      body.close();
      return jsonResponse(body);
    };
    const { promise, onSummary } = startRun({ fetchImpl });
    const r = expectSettled(await settleWithin(promise), "valid streamed response");
    expect(r).toMatchObject({ code: 0, kind: "pass" });
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(onSummary).toHaveBeenCalledWith(r.summary);
    expect(String(seenUrl)).toContain("api.cloudflare.com/client/v4/graphql");
    expect(seenInit.method).toBe("POST");
    expect(seenInit.headers?.authorization).toBe("Bearer token-marker-abc123");
    expect(seenInit.headers?.["content-type"]).toBe("application/json");
    const sent = JSON.parse(String(seenInit.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(sent.query).toContain("rumWebVitalsEventsAdaptiveGroups");
    expect(sent.variables.account).toBe("account-marker-abc123");
    expect(sent.variables.site).toBe("site-marker-abc123");
    expect(r.summary).not.toContain("token-marker-abc123");
  });

  it("keeps insufficient samples as a zero-code insufficient outcome", async () => {
    const fetchImpl = async () => jsonResponse(validText(10, 9_000_000));
    const { promise, onSummary } = startRun({ fetchImpl });
    const r = expectSettled(await settleWithin(promise), "insufficient samples");
    expect(r).toMatchObject({ code: 0, kind: "insufficient" });
    expect(onSummary).toHaveBeenCalledTimes(1);
  });

  it("keeps an over-budget streamed response as over-budget", async () => {
    const fetchImpl = async () => jsonResponse(validText(500, 3_100_000));
    const { promise } = startRun({ fetchImpl });
    const r = expectSettled(await settleWithin(promise), "over-budget");
    expect(r).toMatchObject({ code: 1, kind: "over-budget" });
  });

  it("keeps HTTP and GraphQL failures as query-failed without leaking payloads", async () => {
    const http = startRun({
      fetchImpl: async () => jsonResponse("<html>gateway-marker</html>", 502),
    });
    const httpResult = expectSettled(await settleWithin(http.promise), "HTTP 502");
    expect(httpResult).toMatchObject({ code: 1, kind: "query-failed" });
    expect(httpResult.summary).toContain("HTTP 502");
    expect(httpResult.summary).not.toContain("gateway-marker");

    const gqlBody = JSON.stringify({
      ...envelope(group(500)),
      errors: [{ message: "partial-failure-marker" }],
    });
    const gql = startRun({ fetchImpl: async () => jsonResponse(gqlBody) });
    const gqlResult = expectSettled(await settleWithin(gql.promise), "GraphQL errors");
    expect(gqlResult).toMatchObject({ code: 1, kind: "query-failed" });
    expect(gqlResult.summary).toContain("1 GraphQL error(s)");
    expect(gqlResult.summary).not.toContain("partial-failure-marker");
  });

  it("keeps invalid JSON and malformed envelopes as invalid-response", async () => {
    const badJson = startRun({ fetchImpl: async () => jsonResponse("not json at all") });
    expect(expectSettled(await settleWithin(badJson.promise), "invalid JSON")).toMatchObject({
      code: 1,
      kind: "invalid-response",
    });
    const malformed = startRun({
      fetchImpl: async () => jsonResponse(JSON.stringify({ data: null })),
    });
    expect(
      expectSettled(await settleWithin(malformed.promise), "malformed envelope"),
    ).toMatchObject({
      code: 1,
      kind: "invalid-response",
    });
  });

  it("keeps the unconfigured skip without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const { promise, onSummary } = startRun({ fetchImpl, env: {} });
    const r = expectSettled(await settleWithin(promise), "unconfigured skip");
    expect(r).toMatchObject({ code: 0, kind: "skipped" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onSummary).toHaveBeenCalledTimes(1);
  });

  it("does not relax the ci/rum-budget.json thresholds", () => {
    expect(JSON.parse(repoFile("ci/rum-budget.json"))).toEqual({
      lcpMs: 2500,
      cls: 0.1,
      inpMs: 200,
      minSamples: 50,
    });
  });
});

// --- The exported bounds. ---

describe("exported transport bounds", () => {
  it("exports a finite documented total deadline and byte ceiling", () => {
    expect(TIMEOUT_DEFAULT, "RUM_TRANSPORT_TIMEOUT_MS must be exported").toBeTypeOf("number");
    expect(CAP_DEFAULT, "RUM_MAX_RESPONSE_BYTES must be exported").toBeTypeOf("number");
    const timeout = TIMEOUT_DEFAULT as number;
    const cap = CAP_DEFAULT as number;
    expect(Number.isFinite(timeout)).toBe(true);
    expect(timeout).toBeGreaterThanOrEqual(1_000);
    expect(timeout).toBeLessThanOrEqual(30_000);
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThanOrEqual(16_384);
    expect(cap).toBeLessThanOrEqual(1_048_576);
    for (const [name, docPattern] of [
      ["RUM_TRANSPORT_TIMEOUT_MS", /deadline|timed? ?out/i],
      ["RUM_MAX_RESPONSE_BYTES", /byte/i],
    ] as const) {
      const at = source.indexOf(name);
      expect(at, `${name} must be defined in ci/rum-check.mjs`).toBeGreaterThanOrEqual(0);
      expect(
        source.slice(Math.max(0, at - 400), at + 200),
        `${name} must be documented next to its definition`,
      ).toMatch(docPattern);
    }
  });

  it("documents the timeout and byte-cap behaviour in docs/rum-web-vitals.md", () => {
    const docs = repoFile("docs/rum-web-vitals.md");
    expect(docs).toMatch(/timed? ?out|deadline/i);
    expect(docs).toMatch(/byte/i);
    expect(docs).toMatch(/not evaluated/i);
  });
});

// --- The deadline contract. ---

describe("transport deadline", () => {
  it("times out when headers never arrive, aborts the fetch, and reports budgets unevaluated", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = (_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        seenSignal = init?.signal;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    const { promise, onSummary } = startRun({ fetchImpl, timeoutMs: TIMEOUT_MS });
    const r = expectSettled(await settleWithin(promise), "no headers");
    expect(r).toMatchObject({ code: 1, kind: "timeout" });
    expect(r.summary).toMatch(/timed? ?out/i);
    expect(r.summary).toContain("Budgets not evaluated.");
    expect(r.summary.length).toBeLessThan(2_000);
    for (const marker of ["token-marker-abc123", "account-marker-abc123", "site-marker-abc123"]) {
      expect(r.summary).not.toContain(marker);
    }
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(onSummary).toHaveBeenCalledWith(r.summary);
    expect(seenSignal, "fetch must receive an AbortSignal").toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted, "deadline must abort the in-flight fetch").toBe(true);
  });

  it("settles by deadline even when fetch ignores abort, and a late valid response changes nothing", async () => {
    const unhandled = collectUnhandled();
    let resolveFetch!: (res: Response) => void;
    const fetchImpl = () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    const { promise, onSummary } = startRun({ fetchImpl, timeoutMs: TIMEOUT_MS });
    try {
      const r = expectSettled(await settleWithin(promise), "abort-ignoring fetch");
      expect(r).toMatchObject({ code: 1, kind: "timeout" });
      resolveFetch(jsonResponse(validText()));
      await delay(150);
      expect(onSummary, "late completion must not emit a second summary").toHaveBeenCalledTimes(1);
      expect(unhandled.seen).toEqual([]);
    } finally {
      resolveFetch?.(jsonResponse(validText()));
      await flushMicro();
      unhandled.stop();
    }
  });

  it("swallows a late fetch rejection after the deadline settles", async () => {
    const unhandled = collectUnhandled();
    let rejectFetch!: (err: unknown) => void;
    const fetchImpl = () =>
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      });
    const { promise, onSummary } = startRun({ fetchImpl, timeoutMs: TIMEOUT_MS });
    try {
      const r = expectSettled(await settleWithin(promise), "late fetch rejection");
      expect(r).toMatchObject({ code: 1, kind: "timeout" });
      rejectFetch(new Error("late network failure"));
      await delay(150);
      expect(onSummary).toHaveBeenCalledTimes(1);
      expect(unhandled.seen, "late rejections must not be unhandled").toEqual([]);
    } finally {
      rejectFetch?.(new Error("cleanup"));
      await flushMicro();
      unhandled.stop();
    }
  });

  it("times out a stalled body that ignores abort and cancels the body", async () => {
    const body = manualStream();
    body.enqueue(encoder.encode(validText().slice(0, 20)));
    const fetchImpl = async () => jsonResponse(body);
    const { promise, onSummary } = startRun({ fetchImpl, timeoutMs: TIMEOUT_MS });
    try {
      const r = expectSettled(await settleWithin(promise), "stalled body");
      expect(r).toMatchObject({ code: 1, kind: "timeout" });
      expect(r.summary).toContain("Budgets not evaluated.");
      expect(onSummary).toHaveBeenCalledTimes(1);
      expect(body.state.cancelled, "timed-out response body must be cancelled").toBe(true);
    } finally {
      body.enqueue(encoder.encode(validText().slice(20)));
      body.close();
      await flushMicro();
    }
  });

  it("times out a dripping body: the deadline is total, not per-chunk idle", async () => {
    const body = manualStream();
    const drip = setInterval(() => body.enqueue(encoder.encode("x")), 15);
    const fetchImpl = async () => jsonResponse(body);
    const { promise } = startRun({ fetchImpl, timeoutMs: TIMEOUT_MS });
    try {
      const r = expectSettled(await settleWithin(promise), "dripping body");
      expect(r).toMatchObject({ code: 1, kind: "timeout" });
    } finally {
      clearInterval(drip);
      body.close();
      await flushMicro();
    }
  });

  it("runs ONE total deadline across the header and body phases (controlled clock)", async () => {
    vi.useFakeTimers();
    const body = manualStream();
    let resolveFetch!: (res: Response) => void;
    const fetchImpl = () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    const { promise, onSummary } = startRun({ fetchImpl, timeoutMs: 100 });
    const t = track(promise);
    try {
      await vi.advanceTimersByTimeAsync(60);
      resolveFetch(jsonResponse(body));
      body.enqueue(encoder.encode(validText().slice(0, 20)));
      await flushMicro();
      await vi.advanceTimersByTimeAsync(39);
      await flushMicro();
      expect(t.settled, "must not settle before the total deadline").toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await flushMicro();
      expect(
        t.settled,
        "deadline is total from fetch start (100ms), not restarted at headers (would be 160ms)",
      ).toBe(true);
      expect(t.value).toMatchObject({ code: 1, kind: "timeout" });
      expect(onSummary).toHaveBeenCalledTimes(1);
    } finally {
      body.close();
      vi.useRealTimers();
      await flushMicro();
    }
  });

  it("applies the exported default deadline when timeoutMs is not overridden", async () => {
    expect(TIMEOUT_DEFAULT, "RUM_TRANSPORT_TIMEOUT_MS must be exported").toBeTypeOf("number");
    vi.useFakeTimers();
    const fetchImpl = () => new Promise(() => {});
    const { promise } = startRun({ fetchImpl });
    const t = track(promise);
    try {
      await vi.advanceTimersByTimeAsync((TIMEOUT_DEFAULT as number) - 1);
      await flushMicro();
      expect(t.settled, "default deadline must not fire early").toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await flushMicro();
      expect(t.settled, "exported default deadline must settle the run").toBe(true);
      expect(t.value).toMatchObject({ code: 1, kind: "timeout" });
    } finally {
      vi.useRealTimers();
      await flushMicro();
    }
  });

  it.each([
    [
      "throwing",
      () => {
        throw new Error("disposal exploded");
      },
    ],
    ["rejecting", () => Promise.reject(new Error("disposal rejected"))],
    ["never-settling", () => new Promise(() => {})],
  ])("settles once despite %s body disposal after a timeout", async (_name, cancelImpl) => {
    const unhandled = collectUnhandled();
    const body = manualStream(cancelImpl as (reason: unknown) => unknown);
    body.enqueue(encoder.encode(validText().slice(0, 20)));
    const fetchImpl = async () => jsonResponse(body);
    const { promise, onSummary } = startRun({ fetchImpl, timeoutMs: TIMEOUT_MS });
    try {
      const r = expectSettled(await settleWithin(promise), "uncooperative disposal");
      expect(r).toMatchObject({ code: 1, kind: "timeout" });
      await delay(100);
      expect(onSummary).toHaveBeenCalledTimes(1);
      expect(unhandled.seen, "disposal failures must not be unhandled").toEqual([]);
    } finally {
      body.close();
      await flushMicro();
      unhandled.stop();
    }
  });

  it("ignores body completion and body errors that arrive after a timeout settles", async () => {
    const unhandled = collectUnhandled();
    const completing = manualStream();
    completing.enqueue(encoder.encode(validText().slice(0, 20)));
    const first = startRun({
      fetchImpl: async () => jsonResponse(completing),
      timeoutMs: TIMEOUT_MS,
    });
    const erroring = manualStream();
    erroring.enqueue(encoder.encode(validText().slice(0, 20)));
    const second = startRun({
      fetchImpl: async () => jsonResponse(erroring),
      timeoutMs: TIMEOUT_MS,
    });
    try {
      expect(
        expectSettled(await settleWithin(first.promise), "late body completion"),
      ).toMatchObject({
        code: 1,
        kind: "timeout",
      });
      expect(expectSettled(await settleWithin(second.promise), "late body error")).toMatchObject({
        code: 1,
        kind: "timeout",
      });
      completing.enqueue(encoder.encode(validText().slice(20)));
      completing.close();
      erroring.error(new Error("late stream failure"));
      await delay(150);
      expect(first.onSummary).toHaveBeenCalledTimes(1);
      expect(second.onSummary).toHaveBeenCalledTimes(1);
      expect(unhandled.seen).toEqual([]);
    } finally {
      completing.close();
      erroring.close();
      await flushMicro();
      unhandled.stop();
    }
  });
});

// --- The byte-ceiling contract. ---

describe("response byte ceiling", () => {
  it("accepts a valid payload of exactly the ceiling, split into small chunks across multibyte boundaries", async () => {
    const text = paddedValidText(4_096);
    const bytes = encoder.encode(text);
    const fetchImpl = async () => {
      const body = manualStream();
      // 7-byte chunks split the 2-byte pad characters at arbitrary offsets.
      for (let i = 0; i < bytes.length; i += 7) body.enqueue(bytes.slice(i, i + 7));
      body.close();
      return jsonResponse(body);
    };
    const { promise, onSummary } = startRun({ fetchImpl, maxResponseBytes: bytes.length });
    const r = expectSettled(await settleWithin(promise), "exact-ceiling payload");
    expect(r).toMatchObject({ code: 0, kind: "pass" });
    expect(onSummary).toHaveBeenCalledTimes(1);
  });

  it("refuses a payload one byte over the ceiling without evaluating budgets or leaking it", async () => {
    const text = paddedValidText(4_096);
    const bytes = encoder.encode(text);
    const fetchImpl = async () => jsonResponse(text);
    const { promise, onSummary } = startRun({
      fetchImpl,
      maxResponseBytes: bytes.length - 1,
    });
    const r = expectSettled(await settleWithin(promise), "one byte over ceiling");
    expect(r).toMatchObject({ code: 1, kind: "response-too-large" });
    expect(r.summary).toMatch(/too large/i);
    expect(r.summary).toContain("Budgets not evaluated.");
    expect(r.summary).not.toContain("PAYLOAD-MARKER");
    expect(r.summary.length).toBeLessThan(2_000);
    expect(onSummary).toHaveBeenCalledTimes(1);
  });

  it("refuses overflow promptly without waiting for EOF and cancels the body", async () => {
    const body = manualStream();
    // A complete valid (in-budget) document, then overflow bytes, then no EOF:
    // waiting for EOF hangs, parsing the prefix misreports a pass.
    body.enqueue(encoder.encode(validText()));
    body.enqueue(encoder.encode(" ".repeat(8_192)));
    const fetchImpl = async () => jsonResponse(body);
    const { promise, onSummary } = startRun({ fetchImpl, maxResponseBytes: 4_096 });
    try {
      const r = expectSettled(await settleWithin(promise), "overflow without EOF");
      expect(r).toMatchObject({ code: 1, kind: "response-too-large" });
      expect(onSummary).toHaveBeenCalledTimes(1);
      expect(body.state.cancelled, "overflowing response body must be cancelled").toBe(true);
    } finally {
      body.close();
      await flushMicro();
    }
  });

  it("counts UTF-8 bytes, not string code units, against the ceiling", async () => {
    const text = paddedValidText(4_096);
    // text.length (code units) < byte length because the pad is mostly 2-byte
    // characters. A code-unit counter accepts at cap = text.length; a byte
    // counter must refuse.
    expect(text.length).toBeLessThan(encoder.encode(text).length);
    const fetchImpl = async () => jsonResponse(text);
    const { promise } = startRun({ fetchImpl, maxResponseBytes: text.length });
    const r = expectSettled(await settleWithin(promise), "multibyte counting");
    expect(r).toMatchObject({ code: 1, kind: "response-too-large" });
  });

  it("settles once as response-too-large despite rejecting body disposal", async () => {
    const unhandled = collectUnhandled();
    const body = manualStream(() => Promise.reject(new Error("disposal rejected")));
    body.enqueue(encoder.encode(paddedValidText(8_192)));
    const fetchImpl = async () => jsonResponse(body);
    const { promise, onSummary } = startRun({ fetchImpl, maxResponseBytes: 4_096 });
    try {
      const r = expectSettled(await settleWithin(promise), "overflow disposal rejection");
      expect(r).toMatchObject({ code: 1, kind: "response-too-large" });
      expect(
        body.state.cancelCalls,
        "overflow must attempt body disposal, not merely abandon the stream",
      ).toBeGreaterThanOrEqual(1);
      await delay(100);
      expect(onSummary).toHaveBeenCalledTimes(1);
      expect(unhandled.seen).toEqual([]);
    } finally {
      body.close();
      await flushMicro();
      unhandled.stop();
    }
  });

  it("applies the exported default ceiling when maxResponseBytes is not overridden", async () => {
    expect(CAP_DEFAULT, "RUM_MAX_RESPONSE_BYTES must be exported").toBeTypeOf("number");
    const cap = CAP_DEFAULT as number;
    const exact = startRun({ fetchImpl: async () => jsonResponse(paddedValidText(cap)) });
    expect(expectSettled(await settleWithin(exact.promise), "exact default ceiling")).toMatchObject(
      {
        code: 0,
        kind: "pass",
      },
    );
    const over = startRun({
      fetchImpl: async () => jsonResponse(paddedValidText(cap + 1)),
    });
    expect(expectSettled(await settleWithin(over.promise), "over default ceiling")).toMatchObject({
      code: 1,
      kind: "response-too-large",
    });
  });
});
