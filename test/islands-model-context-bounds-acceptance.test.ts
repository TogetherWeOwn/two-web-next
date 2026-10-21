// WebMCP public-read bounds acceptance: each tool invocation owns a finite
// deadline, a bounded body and an actionable failure.
//
// Contract under test (written blind to the fix; Builder implements it):
//  1. Every execute() schedules exactly one owned deadline timer (0.5s-30s)
//     covering fetch plus body consumption. The timer fires once per call;
//     success clears it. Concurrent calls schedule distinct timers.
//  2. Response bytes refuse above 32 KiB (API_PUBLIC_BOUNDS.maxBodyBytes):
//     32768 bytes of valid JSON succeeds, 32769 refuses. Oversized or
//     malformed bodies fail with code "invalid_response", never success.
//  3. Failures surface as a stable tool-surface failure, either thrown or
//     returned. Thrown: reject with an Error carrying .code/.message and
//     optional .retryAfter. Returned: resolve to { error: { code, message,
//     retryAfter? } } or { code, message }. The harness accepts either.
//     Allowlisted codes: timeout, invalid_response, unavailable,
//     rate_limited, not_found, invalid_request. This suite pins:
//       timeout          -> never-settling fetch or body settles via deadline
//       invalid_response -> oversized (>32 KiB) or malformed JSON
//       unavailable      -> 503/5xx or transport rejection (no retry)
//       rate_limited     -> 429 with bounded Retry-After (no retry)
//  4. Every failure message is safe and actionable: 1-500 chars, names a next
//     step (try again / retry / later for timeout, unavailable, rate_limited;
//     try again / retry / later / invalid / failed for invalid_response),
//     and never reflects untrusted body text or raw header values.
//  5. 429 preserves bounded Retry-After guidance in .retryAfter (integer
//     1-86400, absurd values cap at 86400, malformed yields undefined or a
//     bounded integer, never raw text) with exactly one fetch (no retries).
//  6. Cleanup settles even if abort is ignored: a fetch that never settles
//     and ignores its signal still settles via the deadline. Late resolve or
//     late reject after the deadline never changes the settled failure and
//     never breaks a later call.
//  7. Pagehide composes with the per-call deadline: an abort-ignoring
//     in-flight read still settles promptly on pagehide with a stable code,
//     and a persisted pageshow re-registers live tools.
//  8. Fetch uses redirect:"manual" (or "error"); an opaqueredirect response
//     is a failure, never success. No network leaves the page when
//     modelContext is absent. The four tool names, input schemas and
//     readOnlyHint stay unchanged; reads stay session-free.
//
// Runnable local check (fixtures only, no network or database):
//   npx vitest run test/islands-model-context-bounds-acceptance.test.ts
//
// Fixture assumptions: runs the served public/islands/model-context.js bytes
// in a vm double with controllable setTimeout/clearTimeout, a fake fetch and
// fake Response (ok/status/headers/text/json), Node AbortController and
// TextEncoder. Real timers in the test detect still-pending promises.
//
// Builder: implement in assets/islands/model-context.js, regenerate the
// served bytes with `npm run build:assets`, keep the island bundle budget,
// and update the old `tool errors surface instead of resolving empty`
// assertion to the structured failure. Never edit this file; corrections
// return to the Test Author.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { API_PUBLIC_BOUNDS } from "../src/public-data/contracts";
import { webmcpPilotEnabled } from "../src/webmcp-pilot";

const binder = readFileSync(
  new NodeURL("../public/islands/model-context.js", import.meta.url),
  "utf8",
);

const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MAX_BODY_BYTES = API_PUBLIC_BOUNDS.maxBodyBytes;
const MAX_RETRY_AFTER = 86400;
const STABLE_CODES = [
  "timeout",
  "invalid_response",
  "unavailable",
  "rate_limited",
  "not_found",
  "invalid_request",
] as const;

type Registered = {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
  options?: { signal?: AbortSignal };
};

type FakeTimer = { fn: () => void; ms: number; cleared: boolean; fired: boolean };
type FetchCall = { url: string; init?: RequestInit & { redirect?: string } };

function caseInsensitiveHeaders(entries: Record<string, string>) {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(entries)) lower.set(k.toLowerCase(), v);
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function fakeResponse(opts: {
  ok: boolean;
  status: number;
  bodyText?: string;
  jsonValue?: unknown;
  jsonError?: unknown;
  headers?: Record<string, string>;
  type?: string;
  textNeverSettles?: boolean;
}) {
  return {
    ok: opts.ok,
    status: opts.status,
    type: opts.type ?? "basic",
    headers: caseInsensitiveHeaders(opts.headers ?? {}),
    text: async () => {
      if (opts.textNeverSettles) await new Promise(() => {});
      return opts.bodyText ?? "";
    },
    json: async () => {
      if (opts.jsonError !== undefined) throw opts.jsonError;
      if (opts.jsonValue !== undefined) return opts.jsonValue;
      return JSON.parse(opts.bodyText ?? "");
    },
  };
}

function island(
  fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>,
  opts: {
    documentCookie?: string;
  } = {},
) {
  const registered: Registered[] = [];
  const fetched: FetchCall[] = [];
  const timers: FakeTimer[] = [];
  const listeners = new Map<string, (event?: { persisted?: boolean }) => void>();
  const wrappedFetch = async (url: string, init?: RequestInit) => {
    fetched.push({ url, init: init as FetchCall["init"] });
    return fetchImpl(url, init);
  };
  const fakeSetTimeout = (fn: () => void, ms = 0) => {
    timers.push({ fn, ms: Number(ms) || 0, cleared: false, fired: false });
    return timers.length;
  };
  const fakeClearTimeout = (id: number) => {
    const t = timers[id - 1];
    if (t) t.cleared = true;
  };
  const ctx = {
    registerTool: (tool: Registered, options?: { signal?: AbortSignal }) => {
      registered.push({ ...tool, options });
    },
    provideContext: () => {},
    clearContext: () => {},
  };
  const sandbox: Record<string, unknown> = {
    AbortController,
    TextEncoder,
    fetch: wrappedFetch,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    document: { cookie: opts.documentCookie ?? "", modelContext: ctx },
    navigator: {},
  };
  sandbox.window = {
    addEventListener: (kind: string, fn: (event?: { persisted?: boolean }) => void) => {
      listeners.set(kind, fn);
    },
    removeEventListener: (kind: string) => {
      listeners.delete(kind);
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  };
  // Bare globals and window.* share the same controllable timers.
  runInNewContext(binder, sandbox);
  const byName = new Map(registered.map((t) => [t.name, t]));
  return {
    registered,
    byName,
    fetched,
    timers,
    firePagehide(event?: { persisted?: boolean }) {
      listeners.get("pagehide")?.(event);
    },
    firePageshow(event?: { persisted?: boolean }) {
      listeners.get("pageshow")?.(event);
    },
    fireTimers() {
      for (const t of timers) {
        if (!t.cleared && !t.fired) {
          t.fired = true;
          t.fn();
        }
      }
    },
    boundedTimers() {
      return timers.filter((t) => t.ms >= 500 && t.ms <= 30000);
    },
  };
}

type NormalizedFailure = { code: unknown; message: unknown; retryAfter: unknown; raw: unknown };

function normalizeFailureShape(value: unknown): NormalizedFailure {
  if (typeof value !== "object" || value === null) {
    return { code: undefined, message: String(value), retryAfter: undefined, raw: value };
  }
  const obj = value as Record<string, unknown>;
  const nested = (obj.error as Record<string, unknown> | undefined) ?? {};
  const code = obj.code ?? nested.code;
  const message =
    obj.message ?? nested.message ?? (value instanceof Error ? value.message : undefined);
  const retryAfter = obj.retryAfter ?? nested.retryAfter ?? obj.retry_after ?? nested.retry_after;
  return { code, message, retryAfter, raw: value };
}

type SettleOutcome =
  | { kind: "resolved"; value: unknown }
  | { kind: "rejected"; error: unknown }
  | null;

async function settle(
  promise: Promise<unknown>,
  realTimeoutMs = 250,
): Promise<{ settled: boolean; outcome: SettleOutcome }> {
  let settled = false;
  let outcome: SettleOutcome = null;
  const tracked = promise.then(
    (value) => {
      settled = true;
      outcome = { kind: "resolved", value };
    },
    (error) => {
      settled = true;
      outcome = { kind: "rejected", error };
    },
  );
  await Promise.race([tracked, new Promise((r) => setTimeout(r, realTimeoutMs))]);
  return { settled, outcome };
}

function isFailureEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.code === "string") return true;
  const nested = obj.error as Record<string, unknown> | undefined;
  return typeof nested?.code === "string";
}

async function captureFailure(promise: Promise<unknown>) {
  const { settled, outcome } = await settle(promise);
  if (!settled || !outcome) return { kind: "pending" as const };
  if (outcome.kind === "rejected") {
    return { kind: "thrown" as const, failure: normalizeFailureShape(outcome.error) };
  }
  if (isFailureEnvelope(outcome.value)) {
    return { kind: "returned" as const, failure: normalizeFailureShape(outcome.value) };
  }
  return { kind: "success" as const, value: outcome.value };
}

function expectActionableFailure(
  failure: NormalizedFailure,
  expectedCode: string,
  opts: { forbidden: string[]; messagePattern: RegExp },
) {
  expect(STABLE_CODES as readonly unknown[]).toContain(failure.code);
  expect(failure.code).toBe(expectedCode);
  expect(typeof failure.message).toBe("string");
  const message = failure.message as string;
  expect(message.length).toBeGreaterThan(0);
  expect(message.length).toBeLessThanOrEqual(500);
  expect(message).toMatch(opts.messagePattern);
  const haystack = `${String(failure.code)} ${message} ${String(failure.retryAfter ?? "")}`;
  for (const needle of opts.forbidden) {
    expect(haystack).not.toContain(needle);
  }
}

function expectRetryAfter(failure: NormalizedFailure, expected: number | "bounded-or-undefined") {
  if (expected === "bounded-or-undefined") {
    if (failure.retryAfter === undefined) return;
    expect(Number.isInteger(failure.retryAfter)).toBe(true);
    expect(failure.retryAfter as number).toBeGreaterThanOrEqual(1);
    expect(failure.retryAfter as number).toBeLessThanOrEqual(MAX_RETRY_AFTER);
    return;
  }
  expect(failure.retryAfter).toBe(expected);
}

function neverSettlingFetchIgnoringAbort() {
  return async (_url: string, _init?: RequestInit) => new Promise(() => {});
}

function exactByteJson(totalBytes: number): string {
  // {"a":"<pad>"} with ASCII pad so chars == UTF-8 bytes.
  const overhead = JSON.stringify({ a: "" }).length;
  const pad = "x".repeat(Math.max(0, totalBytes - overhead));
  const body = JSON.stringify({ a: pad });
  if (new TextEncoder().encode(body).length !== totalBytes) {
    throw new Error(`fixture cannot hit ${totalBytes} bytes`);
  }
  return body;
}

describe("model-context bounds acceptance", () => {
  it("schedules one bounded deadline per call and settles a hanging fetch with timeout", async () => {
    const b = island(neverSettlingFetchIgnoringAbort());
    const tool = b.byName.get("two_get_community")!;
    const pending = tool.execute({});
    pending.catch(() => {});
    // Flush the synchronous fetch kickoff before asserting timers.
    await Promise.resolve();
    expect(
      b.boundedTimers().length,
      "each invocation schedules one 0.5s-30s deadline",
    ).toBeGreaterThanOrEqual(1);
    b.fireTimers();
    const captured = await captureFailure(pending);
    expect(captured.kind, "a hanging fetch settles via the deadline, not hangs").not.toBe(
      "pending",
    );
    expect(captured.kind).not.toBe("success");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expectActionableFailure(captured.failure, "timeout", {
        forbidden: [],
        messagePattern: /try again|retry|later/i,
      });
    }
  });

  it("deadline covers body consumption: a hanging text() settles with timeout", async () => {
    const b = island(async () =>
      fakeResponse({ ok: true, status: 200, textNeverSettles: true, jsonValue: {} }),
    );
    const pending = b.byName.get("two_get_community")!.execute({});
    pending.catch(() => {});
    await Promise.resolve();
    expect(b.boundedTimers().length).toBeGreaterThanOrEqual(1);
    b.fireTimers();
    const captured = await captureFailure(pending);
    expect(captured.kind).not.toBe("pending");
    expect(captured.kind).not.toBe("success");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expectActionableFailure(captured.failure, "timeout", {
        forbidden: [],
        messagePattern: /try again|retry|later/i,
      });
    }
  });

  it("successful reads schedule then clear their deadline", async () => {
    const b = island(async () => fakeResponse({ ok: true, status: 200, bodyText: "{}" }));
    const pending = b.byName.get("two_get_community")!.execute({});
    await Promise.resolve();
    expect(b.boundedTimers().length).toBeGreaterThanOrEqual(1);
    await expect(pending).resolves.toEqual({});
    expect(
      b.timers.some((t) => t.cleared),
      "success clears its owned deadline",
    ).toBe(true);
  });

  it("refuses an oversized body with invalid_response and never returns it", async () => {
    const bigText = JSON.stringify({ data: "x".repeat(MAX_BODY_BYTES) });
    expect(new TextEncoder().encode(bigText).length).toBeGreaterThan(MAX_BODY_BYTES);
    const bigValue = JSON.parse(bigText) as unknown;
    const b = island(async () =>
      fakeResponse({ ok: true, status: 200, bodyText: bigText, jsonValue: bigValue }),
    );
    const captured = await captureFailure(b.byName.get("two_get_community")!.execute({}));
    expect(captured.kind, "oversized bodies refuse instead of resolving").not.toBe("success");
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expectActionableFailure(captured.failure, "invalid_response", {
        forbidden: [bigText.slice(0, 32)],
        messagePattern: /try again|retry|later|invalid|failed/i,
      });
    }
  });

  it("holds the exact 32 KiB public-read cap: 32768 succeeds, 32769 refuses", async () => {
    expect(MAX_BODY_BYTES).toBe(32768);
    const atCap = exactByteJson(MAX_BODY_BYTES);
    const overCap = exactByteJson(MAX_BODY_BYTES + 1);
    const ok = island(async () =>
      fakeResponse({ ok: true, status: 200, bodyText: atCap, jsonValue: JSON.parse(atCap) }),
    );
    await expect(ok.byName.get("two_get_community")!.execute({})).resolves.toEqual(
      JSON.parse(atCap),
    );
    const over = island(async () =>
      fakeResponse({ ok: true, status: 200, bodyText: overCap, jsonValue: JSON.parse(overCap) }),
    );
    const captured = await captureFailure(over.byName.get("two_get_community")!.execute({}));
    expect(captured.kind).not.toBe("success");
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expect(captured.failure.code).toBe("invalid_response");
    }
  });

  it("refuses malformed JSON with invalid_response and no reflected text", async () => {
    const evil = "evil-body-marker-7f3a-not-json{{{";
    const b = island(async () =>
      fakeResponse({ ok: true, status: 200, bodyText: evil, jsonError: new SyntaxError("bad") }),
    );
    const captured = await captureFailure(b.byName.get("two_get_community")!.execute({}));
    expect(captured.kind).not.toBe("success");
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expectActionableFailure(captured.failure, "invalid_response", {
        forbidden: ["evil-body-marker-7f3a"],
        messagePattern: /try again|retry|later|invalid|failed/i,
      });
    }
  });

  it("maps 503 to unavailable with a safe next action, one fetch and no reflected body", async () => {
    const evil = "evil-503-marker-9c1d<script>";
    const b = island(async () =>
      fakeResponse({
        ok: false,
        status: 503,
        bodyText: JSON.stringify({ error: { code: "unavailable", message: evil } }),
        headers: {},
      }),
    );
    const captured = await captureFailure(b.byName.get("two_get_community")!.execute({}));
    expect(b.fetched).toHaveLength(1);
    expect(captured.kind).not.toBe("success");
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expectActionableFailure(captured.failure, "unavailable", {
        forbidden: ["evil-503-marker-9c1d", "<script>"],
        messagePattern: /try again|retry|later/i,
      });
    }
  });

  it("maps a transport rejection to unavailable", async () => {
    const b = island(async () => {
      throw new TypeError("fetch failed");
    });
    const captured = await captureFailure(b.byName.get("two_get_community")!.execute({}));
    expect(captured.kind).not.toBe("success");
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expectActionableFailure(captured.failure, "unavailable", {
        forbidden: [],
        messagePattern: /try again|retry|later/i,
      });
    }
  });

  it("maps 429 with a usable Retry-After to rate_limited with bounded guidance and no retry", async () => {
    const b = island(async () =>
      fakeResponse({
        ok: false,
        status: 429,
        bodyText: JSON.stringify({ error: { code: "rate_limited", message: "limited" } }),
        headers: { "retry-after": "120" },
      }),
    );
    const captured = await captureFailure(b.byName.get("two_get_community")!.execute({}));
    expect(b.fetched, "rate limits never retry automatically").toHaveLength(1);
    expect(captured.kind).not.toBe("success");
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expectActionableFailure(captured.failure, "rate_limited", {
        forbidden: [],
        messagePattern: /try again|retry|later/i,
      });
      expectRetryAfter(captured.failure, 120);
    }
  });

  it("caps an absurd 429 Retry-After at 86400", async () => {
    const b = island(async () =>
      fakeResponse({
        ok: false,
        status: 429,
        bodyText: "{}",
        headers: { "retry-after": "9999999" },
      }),
    );
    const captured = await captureFailure(b.byName.get("two_get_community")!.execute({}));
    expect(b.fetched).toHaveLength(1);
    expect(captured.kind).not.toBe("success");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expect(captured.failure.code).toBe("rate_limited");
      expectRetryAfter(captured.failure, MAX_RETRY_AFTER);
      expect(String(captured.failure.retryAfter)).not.toContain("9999999");
    }
  });

  it("keeps a malformed 429 Retry-After rate_limited without reflecting the raw value", async () => {
    const raw = "soon-evil-marker-4bd2";
    const b = island(async () =>
      fakeResponse({
        ok: false,
        status: 429,
        bodyText: JSON.stringify({ error: { code: "rate_limited", message: raw } }),
        headers: { "retry-after": raw },
      }),
    );
    const captured = await captureFailure(b.byName.get("two_get_community")!.execute({}));
    expect(b.fetched).toHaveLength(1);
    expect(captured.kind).not.toBe("success");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expectActionableFailure(captured.failure, "rate_limited", {
        forbidden: ["soon-evil-marker-4bd2"],
        messagePattern: /try again|retry|later/i,
      });
      expectRetryAfter(captured.failure, "bounded-or-undefined");
    }
  });

  it("fences a late resolve after the deadline: the timeout stands and the next call works", async () => {
    let resolveLate: ((v: unknown) => void) | null = null;
    const gate = new Promise((resolve) => {
      resolveLate = resolve;
    });
    const b = island(async () => gate);
    const first = b.byName.get("two_get_community")!.execute({});
    // Silence the harness-owned gate; the island must fence it, not leak it.
    gate.catch(() => {});
    first.catch(() => {});
    await Promise.resolve();
    expect(b.boundedTimers().length).toBeGreaterThanOrEqual(1);
    b.fireTimers();
    const captured = await captureFailure(first);
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expect(captured.failure.code).toBe("timeout");
    } else {
      expect.unreachable("a timed-out call never resolves late with success");
    }
    resolveLate!(fakeResponse({ ok: true, status: 200, bodyText: "{}", jsonValue: {} }));
    await Promise.resolve();
    const again = await captureFailure(first);
    if (again.kind === "thrown" || again.kind === "returned") {
      expect(again.failure.code).toBe("timeout");
    } else {
      expect.unreachable("late resolve must not flip the settled timeout");
    }
  });

  it("fences a late rejection after the deadline", async () => {
    let rejectLate: ((e: unknown) => void) | null = null;
    const gate = new Promise((_resolve, reject) => {
      rejectLate = reject;
    });
    gate.catch(() => {});
    const b = island(async () => gate);
    const first = b.byName.get("two_get_community")!.execute({});
    first.catch(() => {});
    await Promise.resolve();
    expect(b.boundedTimers().length).toBeGreaterThanOrEqual(1);
    b.fireTimers();
    const captured = await captureFailure(first);
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expect(captured.failure.code).toBe("timeout");
    } else {
      expect.unreachable("a timed-out call never flips to a late rejection");
    }
    rejectLate!(new Error("late-network-flake"));
    await Promise.resolve();
    const again = await captureFailure(first);
    if (again.kind === "thrown" || again.kind === "returned") {
      expect(again.failure.code).toBe("timeout");
    } else {
      expect.unreachable("late rejection must not flip the settled timeout");
    }
  });

  it("gives concurrent calls independent timers and controllers", async () => {
    let calls = 0;
    const b = island(async (url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      void url;
      void init;
      return fakeResponse({ ok: true, status: 200, bodyText: JSON.stringify({ url }) });
    });
    const tool = b.byName.get("two_get_community")!;
    const hanging = tool.execute({});
    const quick = tool.execute({});
    hanging.catch(() => {});
    await Promise.resolve();
    expect(b.fetched).toHaveLength(2);
    expect(
      b.boundedTimers().length,
      "concurrent calls schedule independent deadlines",
    ).toBeGreaterThanOrEqual(2);
    const signals = b.fetched.map((c) => c.init?.signal).filter(Boolean) as AbortSignal[];
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    await expect(quick).resolves.toEqual({ url: "/api/public/community" });
    const still = await settle(hanging, 50);
    expect(still.settled, "the quick success never settles its sibling").toBe(false);
    b.fireTimers();
    const captured = await captureFailure(hanging);
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expect(captured.failure.code).toBe("timeout");
    } else {
      expect.unreachable("the hanging sibling settles via its own deadline");
    }
  });

  it("composes pagehide with the deadline even when abort is ignored, then restores on pageshow", async () => {
    const b = island(neverSettlingFetchIgnoringAbort());
    const first = b.byName.get("two_get_community")!.execute({});
    first.catch(() => {});
    await Promise.resolve();
    b.firePagehide({ persisted: true });
    const captured = await captureFailure(first);
    expect(captured.kind, "pagehide settles an abort-ignoring read instead of hanging").not.toBe(
      "pending",
    );
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expect(STABLE_CODES as readonly unknown[]).toContain(captured.failure.code);
    } else {
      expect.unreachable("pagehide never resolves an abort-ignoring read with success");
    }
    const before = b.registered.length;
    b.firePageshow({ persisted: true });
    expect(b.registered.length).toBeGreaterThan(before);
  });

  it("retains the four stable tools, schemas and readOnlyHint", () => {
    const b = island(async () => fakeResponse({ ok: true, status: 200, bodyText: "{}" }));
    expect(b.registered.map((t) => t.name).sort()).toEqual(
      ["two_get_community", "two_get_event", "two_get_join_info", "two_search_events"].sort(),
    );
    for (const tool of b.registered) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema?.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
    const search = b.byName.get("two_search_events")!;
    expect(search.inputSchema.properties).toMatchObject({
      page: expect.objectContaining({ minimum: 1 }),
      per_page: expect.objectContaining({ minimum: 1, maximum: 20 }),
    });
    const getEvent = b.byName.get("two_get_event")!;
    expect(getEvent.inputSchema.required).toEqual(["event_key"]);
  });

  it("keeps reads session-free for moderator cookies", async () => {
    const b = island(
      async (url: string) => fakeResponse({ ok: true, status: 200, bodyText: "{}" }),
      {
        documentCookie: "two_session=sess_moderator_probe; __Host-two_session_status=abc",
      },
    );
    await b.byName.get("two_search_events")!.execute({ page: 1, per_page: 20 });
    expect(b.fetched).toHaveLength(1);
    expect(b.fetched[0]!.url).toBe("/api/public/events?page=1&per_page=20");
    expect(b.fetched[0]!.url).not.toContain("sess_moderator_probe");
    expect((b.fetched[0]!.init as { credentials?: unknown } | undefined)?.credentials).not.toBe(
      "include",
    );
    await b.byName.get("two_get_event")!.execute({ event_key: EVENT_KEY });
    expect(b.fetched[1]!.url).toBe(`/api/public/events/${EVENT_KEY}`);
  });

  it("does nothing observable when modelContext is absent", () => {
    const fetched: FetchCall[] = [];
    const timers: FakeTimer[] = [];
    runInNewContext(binder, {
      AbortController,
      TextEncoder,
      fetch: async (url: string, init?: RequestInit) => {
        fetched.push({ url, init: init as FetchCall["init"] });
        return fakeResponse({ ok: true, status: 200, bodyText: "{}" });
      },
      setTimeout: (fn: () => void, ms = 0) => {
        timers.push({ fn, ms: Number(ms) || 0, cleared: false, fired: false });
        return timers.length;
      },
      clearTimeout: (id: number) => {
        const t = timers[id - 1];
        if (t) t.cleared = true;
      },
      document: { cookie: "", modelContext: null },
      navigator: {},
      window: { addEventListener: () => {}, removeEventListener: () => {} },
    });
    expect(fetched).toHaveLength(0);
    expect(timers).toHaveLength(0);
  });

  it("fetches with manual redirect handling", async () => {
    const b = island(async () => fakeResponse({ ok: true, status: 200, bodyText: "{}" }));
    await b.byName.get("two_get_community")!.execute({});
    expect(b.fetched).toHaveLength(1);
    expect(["manual", "error"]).toContain(
      (b.fetched[0]!.init as { redirect?: string } | undefined)?.redirect,
    );
  });

  it("treats an opaqueredirect response as a failure, never success", async () => {
    const b = island(async () =>
      fakeResponse({ ok: false, status: 0, bodyText: "", type: "opaqueredirect" }),
    );
    const captured = await captureFailure(b.byName.get("two_get_community")!.execute({}));
    expect(captured.kind).not.toBe("success");
    expect(captured.kind).not.toBe("pending");
    if (captured.kind === "thrown" || captured.kind === "returned") {
      expect(STABLE_CODES as readonly unknown[]).toContain(captured.failure.code);
    }
  });

  it("keeps the pilot flag off by default", () => {
    expect(webmcpPilotEnabled({})).toBe(false);
    expect(webmcpPilotEnabled({ WEBMCP_PILOT_ENABLED: "true" })).toBe(true);
  });
});
