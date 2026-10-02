// No-secret logging on bot failure paths (legacy §4 rule, src/bot/client.ts).
//
// The client may log request metadata (request_id, action, status, code,
// retryable, duration_ms); it must never log the wire secret, the
// signature/nonce header material, or a request body — the announcement body
// in particular. These tests fail the transport, return refusals, and return
// garbage envelopes against a capturing logger, then assert none of the
// forbidden bytes appear in any emitted line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import { BotTransportError } from "../src/jobs/types";

const SECRET = "wire-secret-never-log-4f8e2d1c9b7a";
const URL = "https://bot-staging.internal.example";
const KEY_ID = "web-staging";
const UUID = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
// Distinctive on purpose: substring checks must not false-positive on prose.
const BODY = "Announcement body UNIQUE-NEVER-LOG-7q3z9w2x: the spring fair moves indoors.";

type Seen = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Records the request (headers + body) even when the transport itself fails. */
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

/** Forbidden bytes for one attempt: secret, body, and the exact wire material sent. */
function forbiddenFor(seen: Seen[]): string[] {
  const forbidden = [SECRET, BODY];
  for (const s of seen) {
    const headers = s.init.headers as Record<string, string>;
    for (const name of ["X-TWO-Nonce", "X-TWO-Signature"]) {
      const value = headers[name];
      if (typeof value === "string" && value.length > 0) forbidden.push(value);
    }
    if (typeof s.init.body === "string") forbidden.push(s.init.body);
  }
  return forbidden;
}

function expectSecretFree(lines: string[], forbidden: string[]) {
  expect(forbidden.length).toBeGreaterThan(0);
  for (const line of lines) {
    for (const secret of forbidden) {
      expect(line).not.toContain(secret);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bot client failure paths log no secrets", () => {
  it("a dead transport throws with no log lines at all", async () => {
    const seen: Seen[] = [];
    const client = createBotClient({
      url: URL,
      secret: SECRET,
      keyId: KEY_ID,
      fetchFn: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        throw new Error("socket hung up");
      }) as unknown as typeof fetch,
    });
    const readLogs = captureLogs();
    const err = await client
      .postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotTransportError);
    const lines = readLogs();
    expect(lines).toEqual([]);
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(String((err as Error).message)).not.toContain(BODY);
    // The signed request was still built: prove the assertion had material to catch.
    expect(forbiddenFor(seen).length).toBeGreaterThan(2);
  });

  it.each([
    ["non-JSON answer", new Response("<html>bot down</html>", { status: 200 })],
    [
      "envelope without an ok field",
      jsonResponse(200, { result: { message_id: "m1" }, request_id: "r1" }),
    ],
    ["success without a result object", jsonResponse(200, { ok: true, request_id: "r1" })],
    ["failure without an error code", jsonResponse(400, { ok: false, request_id: "r1" })],
  ])("garbage response (%s) throws transport with no log lines", async (_label, response) => {
    const { client, seen } = stubFetch(async () => response);
    const readLogs = captureLogs();
    const err = await client
      .postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotTransportError);
    expect(readLogs()).toEqual([]);
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(String((err as Error).message)).not.toContain(BODY);
    expect(forbiddenFor(seen).length).toBeGreaterThan(2);
  });

  it.each([
    [
      "retryable refusal",
      409,
      {
        ok: false,
        error: { code: "in_progress", message: "busy", retryable: true },
        request_id: "r1",
      },
      {},
    ],
    [
      "terminal refusal",
      400,
      {
        ok: false,
        error: { code: "malformed", message: "no", retryable: false },
        request_id: "r1",
      },
      {},
    ],
    [
      "rate-limited refusal",
      429,
      {
        ok: false,
        error: { code: "rate_limited", message: "slow", retryable: true },
        request_id: "r1",
      },
      { "Retry-After": "42" },
    ],
  ])(
    "%s logs metadata only, never secret material or the body",
    async (_label, status, envelope, headers) => {
      const { client, seen } = stubFetch(async () => jsonResponse(status, envelope, headers));
      const readLogs = captureLogs();
      const answer = await client.postAnnouncement(
        { channelKey: "qa-throwaway", body: BODY },
        UUID,
      );
      expect(answer).toMatchObject({ ok: false });
      const lines = readLogs();
      expect(lines.length).toBeGreaterThan(0); // the refusal line exists; prove it is clean
      expectSecretFree(lines, forbiddenFor(seen));
    },
  );

  it("a role.assign refusal likewise logs no secret material", async () => {
    const { client, seen } = stubFetch(async () =>
      jsonResponse(409, {
        ok: false,
        error: { code: "in_progress", message: "busy" },
        request_id: "r1",
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
    expectSecretFree(lines, forbiddenFor(seen));
  });

  it("an unusable success (unknown outcome) logs the success line clean, then throws clean", async () => {
    const { client, seen } = stubFetch(async () =>
      jsonResponse(200, { ok: true, result: { outcome: "mystery" }, request_id: "r1" }),
    );
    const readLogs = captureLogs();
    const err = await client
      .assignRole({ userId: "900000000000009999", roleKey: "rocketleague" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotTransportError);
    const lines = readLogs();
    expect(lines.length).toBeGreaterThan(0); // success was logged before the outcome check threw
    expectSecretFree(lines, forbiddenFor(seen));
    expect(String((err as Error).message)).not.toContain(SECRET);
  });

  it("an announcement success without message_id logs clean, then throws clean", async () => {
    const { client, seen } = stubFetch(async () =>
      jsonResponse(200, { ok: true, result: {}, request_id: "r1" }),
    );
    const readLogs = captureLogs();
    const err = await client
      .postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotTransportError);
    const lines = readLogs();
    expect(lines.length).toBeGreaterThan(0);
    expectSecretFree(lines, forbiddenFor(seen));
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(String((err as Error).message)).not.toContain(BODY);
  });

  it("a clean success logs metadata only, never the body", async () => {
    const { client, seen } = stubFetch(async () =>
      jsonResponse(200, { ok: true, result: { message_id: "m1" }, request_id: "r1" }),
    );
    const readLogs = captureLogs();
    const answer = await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    expect(answer).toMatchObject({ ok: true, messageId: "m1" });
    const lines = readLogs();
    expect(lines.length).toBeGreaterThan(0);
    expectSecretFree(lines, forbiddenFor(seen));
  });
});
