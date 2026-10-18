// Provider metadata must not bypass log redaction (acceptance for M15.2).
//
// The sibling suite (test/bot-client-no-secret-log.test.ts) proves the client
// never logs the wire secret, signature material, or a request body when the
// provider answers with benign metadata. This suite covers the blind spot: a
// provider (or anything able to shape its answer) that echoes outgoing
// material back inside the envelope fields the client treats as loggable
// metadata — `request_id` and `error.code`. Whatever arrives in those fields
// is untrusted input, so the raw value must never reach a log line, a
// control-bearing value must never forge or corrupt a line, and an overlong
// value must never flood one. Redaction must also stay behavior-neutral: the
// action result, retryability and Retry-After handling are unchanged.
//
// These tests drive the real BotClient through a mocked fetch (no stubbed
// client, no live endpoint) with synthetic canaries only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";

const SECRET = "wire-secret-never-log-4f8e2d1c9b7a";
const URL = "https://bot-staging.internal.example";
const KEY_ID = "web-staging";
const UUID = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
// Distinctive on purpose: substring checks must not false-positive on prose.
const BODY = "Announcement body UNIQUE-NEVER-LOG-7q3z9w2x: the spring fair moves indoors.";
// A redacted/truncated diagnostic line stays far below this; a raw provider
// value of several kilobytes cannot.
const MAX_LOG_LINE = 512;

type Seen = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Records the signed request so the fake provider can echo its material back. */
function stubFetch(behavior: (seen: Seen[]) => Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return behavior(seen);
  });
  const client = createBotClient({
    url: URL,
    secret: SECRET,
    keyId: KEY_ID,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, seen };
}

/** Every console line emitted during the act, serialized. */
function captureLogs() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => {
    const lines: string[] = [];
    for (const spy of [info, warn, error]) {
      for (const call of spy.mock.calls) {
        lines.push(
          call
            .map((a) => {
              try {
                return typeof a === "string" ? a : JSON.stringify(a);
              } catch {
                return String(a);
              }
            })
            .join(" "),
        );
      }
    }
    return lines;
  };
}

/** One piece of outgoing material a hostile echo could carry back. */
function headerValue(seen: Seen[], name: string): string {
  const headers = seen[0]!.init.headers as Record<string, string>;
  const value = headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected a non-empty ${name} on the signed request`);
  }
  return value;
}

const CANARIES: ReadonlyArray<readonly [string, (seen: Seen[]) => string]> = [
  ["wire secret", () => SECRET],
  ["announcement body", () => BODY],
  ["nonce header value", (seen) => headerValue(seen, "X-TWO-Nonce")],
  ["signature header value", (seen) => headerValue(seen, "X-TWO-Signature")],
  ["serialized request body", (seen) => String(seen[0]!.init.body)],
];

function expectAbsent(lines: string[], canary: string) {
  expect(canary.length).toBeGreaterThan(0); // the assertion had material to catch
  for (const line of lines) {
    expect(line).not.toContain(canary);
  }
}

/** Redaction may scrub values, but a useful diagnostic for the action remains. */
function expectUsefulDiagnostic(lines: string[]) {
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.some((line) => line.includes("announcement.post"))).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider metadata echoing outgoing material never reaches the logs", () => {
  it.each(CANARIES)(
    "success envelope echoing the %s in request_id logs a clean diagnostic and still succeeds",
    async (_label, pick) => {
      const { client, seen } = stubFetch(async (s) =>
        jsonResponse(200, { ok: true, result: { message_id: "m1" }, request_id: pick(s) }),
      );
      const readLogs = captureLogs();
      const answer = await client.postAnnouncement(
        { channelKey: "qa-throwaway", body: BODY },
        UUID,
      );
      expect(answer).toMatchObject({ ok: true, messageId: "m1" });
      const lines = readLogs();
      expectUsefulDiagnostic(lines);
      expectAbsent(lines, pick(seen));
    },
  );

  it.each(CANARIES)(
    "refusal envelope echoing the %s in request_id logs a clean diagnostic and keeps its verdict",
    async (_label, pick) => {
      const { client, seen } = stubFetch(async (s) =>
        jsonResponse(409, {
          ok: false,
          error: { code: "in_progress", message: "busy" },
          request_id: pick(s),
        }),
      );
      const readLogs = captureLogs();
      const answer = await client.postAnnouncement(
        { channelKey: "qa-throwaway", body: BODY },
        UUID,
      );
      // Known code, no wire retryable flag: the published fallback still applies.
      expect(answer).toMatchObject({ ok: false, code: "in_progress", retryable: true });
      const lines = readLogs();
      expectUsefulDiagnostic(lines);
      expectAbsent(lines, pick(seen));
    },
  );

  it.each(CANARIES)(
    "refusal envelope echoing the %s in error.code logs a clean diagnostic and fails closed",
    async (_label, pick) => {
      const { client, seen } = stubFetch(async (s) =>
        jsonResponse(400, {
          ok: false,
          error: { code: pick(s), message: "echoed" },
          request_id: "r1",
        }),
      );
      const readLogs = captureLogs();
      const answer = await client.postAnnouncement(
        { channelKey: "qa-throwaway", body: BODY },
        UUID,
      );
      // An echoed canary is an unknown code: unknown codes fail closed.
      expect(answer).toMatchObject({ ok: false, retryable: false });
      const lines = readLogs();
      expectUsefulDiagnostic(lines);
      expectAbsent(lines, pick(seen));
    },
  );

  it("a refusal echoing canaries in both fields at once logs neither", async () => {
    const { client, seen } = stubFetch(async (s) =>
      jsonResponse(400, {
        ok: false,
        error: { code: headerValue(s, "X-TWO-Signature"), message: "echoed" },
        request_id: SECRET,
      }),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({ ok: false, retryable: false });
    const lines = readLogs();
    expectUsefulDiagnostic(lines);
    expectAbsent(lines, SECRET);
    expectAbsent(lines, headerValue(seen, "X-TWO-Signature"));
    expectAbsent(lines, BODY);
  });

  it("a role.assign refusal echoing the secret in request_id logs a clean diagnostic", async () => {
    const { client } = stubFetch(async () =>
      jsonResponse(409, {
        ok: false,
        error: { code: "in_progress", message: "busy" },
        request_id: SECRET,
      }),
    );
    const readLogs = captureLogs();
    const answer = await client.assignRole({
      userId: "900000000000009999",
      roleKey: "rocketleague",
    });
    expect(answer).toMatchObject({ ok: false, code: "in_progress" });
    const lines = readLogs();
    expect(lines.length).toBeGreaterThan(0);
    expectAbsent(lines, SECRET);
  });
});

describe("control-bearing and overlong provider metadata cannot reach a log line raw", () => {
  it("a request_id carrying a newline, escape and forged record stays out of the logs", async () => {
    const forged = `${SECRET}\n{"evt":"forged-record"}\u0001\u001b[31m`;
    const { client } = stubFetch(async () =>
      jsonResponse(409, {
        ok: false,
        error: { code: "in_progress", message: "busy" },
        request_id: forged,
      }),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({ ok: false, code: "in_progress", retryable: true });
    const lines = readLogs();
    expectUsefulDiagnostic(lines);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("forged-record");
      expect(line).not.toContain("\n"); // no forged extra record
      expect(line).not.toContain("\u0001");
      expect(line).not.toContain("\u001b"); // no terminal escape injection
    }
  });

  it("an error.code carrying control characters stays out of the logs", async () => {
    const forged = `busy\r\n${SECRET}\u0007`;
    const { client } = stubFetch(async () =>
      jsonResponse(400, {
        ok: false,
        error: { code: forged, message: "echoed" },
        request_id: "r1",
      }),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({ ok: false, retryable: false });
    const lines = readLogs();
    expectUsefulDiagnostic(lines);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\r");
      expect(line).not.toContain("\u0007");
    }
  });

  it("an overlong request_id cannot flood or smuggle through a success log line", async () => {
    const overlong = `${"x".repeat(4096)}${SECRET}`;
    const { client } = stubFetch(async () =>
      jsonResponse(200, { ok: true, result: { message_id: "m1" }, request_id: overlong }),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({ ok: true, messageId: "m1" });
    const lines = readLogs();
    expectUsefulDiagnostic(lines);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line.length).toBeLessThanOrEqual(MAX_LOG_LINE);
    }
  });

  it("an overlong error.code cannot flood or smuggle through a refusal log line", async () => {
    const overlong = `${SECRET}${"y".repeat(4096)}`;
    const { client } = stubFetch(async () =>
      jsonResponse(400, {
        ok: false,
        error: { code: overlong, message: "echoed" },
        request_id: "r1",
      }),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({ ok: false, retryable: false });
    const lines = readLogs();
    expectUsefulDiagnostic(lines);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line.length).toBeLessThanOrEqual(MAX_LOG_LINE);
    }
  });
});

describe("redaction does not alter bot behavior", () => {
  it("a terminal refusal stays terminal when request_id echoes the body", async () => {
    const { client } = stubFetch(async () =>
      jsonResponse(400, {
        ok: false,
        error: { code: "malformed", message: "no", retryable: false },
        request_id: BODY,
      }),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({ ok: false, code: "malformed", retryable: false });
    const lines = readLogs();
    expectUsefulDiagnostic(lines);
    expectAbsent(lines, BODY);
  });

  it("a 429 keeps its numeric Retry-After when request_id echoes the secret", async () => {
    const { client } = stubFetch(async () =>
      jsonResponse(
        429,
        {
          ok: false,
          error: { code: "rate_limited", message: "slow", retryable: true },
          request_id: SECRET,
        },
        { "Retry-After": "42" },
      ),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({
      ok: false,
      code: "rate_limited",
      retryable: true,
      retryAfterSeconds: 42,
    });
    const lines = readLogs();
    expectUsefulDiagnostic(lines);
    expectAbsent(lines, SECRET);
    expectAbsent(lines, BODY);
  });

  it("a wire retryable refusal stays retryable when request_id echoes the signature", async () => {
    const { client, seen } = stubFetch(async (s) =>
      jsonResponse(503, {
        ok: false,
        error: { code: "unavailable", message: "later", retryable: true },
        request_id: headerValue(s, "X-TWO-Signature"),
      }),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({ ok: false, retryable: true });
    const lines = readLogs();
    expectUsefulDiagnostic(lines);
    expectAbsent(lines, headerValue(seen, "X-TWO-Signature"));
  });
});
