// Signed mutation responses are capped before JSON parsing (acceptance).
//
// One signed attempt buffers the provider's answer only to read a small
// envelope. The buffer must stop at the established 256 KiB provider-buffer
// convention (262144 bytes): bytes are counted as they stream in — a small,
// missing, or at-cap Content-Length never excuses a larger actual body — and
// an over-limit or malformed body surfaces as one fixed, redacted
// BotTransportError. Cancellation of an over-limit body is attempted but
// never awaited: stalled or throwing cleanup cannot hold the error hostage.
// Everything else about the attempt is unchanged: one fetch, the exact
// canonical signed bytes, manual redirects, the caller's idempotency key,
// replay/refusal interpretation, and 429 Retry-After handling.
//
// Hermetic: a mocked fetch only. No live bot, no database, synthetic
// canaries only.
import { describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import { BotTransportError } from "../src/jobs/types";

const CAP = 262_144; // 256 KiB, the provider-buffer convention.
const SECRET = "wire-secret-never-surface-synthetic-canary";
const URL = "https://bot-staging.internal.example";
const KEY_ID = "web-staging";
const UUID = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const USER_ID = "900000000000009999";
const TOKEN = "CANARY-RESPONSE-CAP-9v4k1p6d";
const MAX_THROW_MESSAGE = 120;
const PENDING = Symbol("pending");

const enc = new TextEncoder();

type Seen = { url: string; init: RequestInit };

function clientWith(impl: (seen: Seen[]) => Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return impl(seen);
  });
  const client = createBotClient({
    url: URL,
    secret: SECRET,
    keyId: KEY_ID,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, seen, fetchFn };
}

function clientResponding(response: () => Response) {
  return clientWith(async () => response());
}

function signatureOf(seen: Seen[]): string {
  const headers = seen[0]!.init.headers as Record<string, string>;
  const signature = headers["X-TWO-Signature"]!;
  expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  return signature;
}

/** A valid role.assign success envelope padded to exactly `totalBytes`. */
function paddedSuccess(totalBytes: number, padChar = "x", canary = ""): string {
  const skeleton = JSON.stringify({
    ok: true,
    result: { outcome: "assigned" },
    request_id: "r1",
    pad: "",
  });
  const skeletonBytes = enc.encode(skeleton).byteLength;
  const padBytes = totalBytes - skeletonBytes;
  const charBytes = enc.encode(padChar).byteLength;
  const chars = Math.floor((padBytes - canary.length) / charBytes);
  const remainder = padBytes - canary.length - chars * charBytes;
  const pad = canary + padChar.repeat(chars) + "x".repeat(remainder);
  const body = JSON.stringify({
    ok: true,
    result: { outcome: "assigned" },
    request_id: "r1",
    pad,
  });
  expect(enc.encode(body).byteLength).toBe(totalBytes);
  return body;
}

/** A valid rate-limited refusal envelope padded to exactly `totalBytes`. */
function paddedRateLimited(totalBytes: number): string {
  const skeleton = JSON.stringify({
    ok: false,
    error: { code: "rate_limited", message: "slow", retryable: true },
    request_id: "r1",
    pad: "",
  });
  const pad = "x".repeat(totalBytes - enc.encode(skeleton).byteLength);
  const body = JSON.stringify({
    ok: false,
    error: { code: "rate_limited", message: "slow", retryable: true },
    request_id: "r1",
    pad,
  });
  expect(enc.encode(body).byteLength).toBe(totalBytes);
  return body;
}

type StreamHooks = {
  cancel?: () => unknown;
  onPull?: (pulls: number) => void;
};

/** Pull-fed stream over `bytes`; never closes early on its own. */
function pullStream(bytes: Uint8Array, chunkSize: number, hooks: StreamHooks = {}) {
  let offset = 0;
  let pulls = 0;
  const cancel = hooks.cancel ? vi.fn(hooks.cancel) : vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        hooks.onPull?.(pulls);
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const next = bytes.subarray(offset, offset + chunkSize);
        offset += next.byteLength;
        controller.enqueue(next);
      },
      cancel: () => cancel(),
    },
    { highWaterMark: 0 },
  );
  return { body, cancel, pulls: () => pulls };
}

function streamResponse(
  body: ReadableStream<Uint8Array>,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T | typeof PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Outcome = { kind: "resolved"; value: unknown } | { kind: "thrown"; error: unknown };

async function settleWithin(promise: Promise<unknown>, ms = 2_000): Promise<Outcome> {
  const settled = await within(
    promise.then(
      (value): Outcome => ({ kind: "resolved", value }),
      (error: unknown): Outcome => ({ kind: "thrown", error }),
    ),
    ms,
  );
  expect(settled, "the attempt must settle before the deadline").not.toBe(PENDING);
  return settled as Outcome;
}

/** Runs one role.assign against `impl`; returns the thrown value and `seen`. */
async function thrownAssign(impl: (seen: Seen[]) => Promise<Response>) {
  const { client, seen } = clientWith(impl);
  const outcome = await settleWithin(
    client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
  );
  expect(outcome.kind, "expected the call to throw, not resolve").toBe("thrown");
  const error = (outcome as { kind: "thrown"; error: unknown }).error;
  expect(error).toBeInstanceOf(BotTransportError);
  expect(seen, "exactly one signed attempt").toHaveLength(1);
  return { error: error as BotTransportError, seen };
}

function expectCleanTransportError(error: BotTransportError, seen: Seen[]) {
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.message.length).toBeLessThanOrEqual(MAX_THROW_MESSAGE);
  const forbidden = [
    TOKEN,
    SECRET,
    signatureOf(seen),
    "sha256=",
    "bot-staging.internal.example",
    "/internal/actions",
  ];
  for (const text of forbidden) {
    expect(error.message, `message must not carry ${JSON.stringify(text)}`).not.toContain(text);
  }
}

describe("signed responses over the 256 KiB ceiling are refused before parsing", () => {
  it("a buffered body one byte over the ceiling throws transport, not success", async () => {
    const { error, seen } = await thrownAssign(async () =>
      jsonResponse(200, paddedSuccess(CAP + 1, "x", TOKEN)),
    );
    expectCleanTransportError(error, seen);
  });

  it("a chunked body with no Content-Length is counted as it streams", async () => {
    const bytes = enc.encode(paddedSuccess(CAP + 1, "x", TOKEN));
    const { error, seen } = await thrownAssign(async () =>
      streamResponse(pullStream(bytes, 16_384).body),
    );
    expectCleanTransportError(error, seen);
  });

  it("a misleadingly small Content-Length does not excuse a larger actual body", async () => {
    const bytes = enc.encode(paddedSuccess(CAP + 4096, "x", TOKEN));
    const { error, seen } = await thrownAssign(async () =>
      streamResponse(pullStream(bytes, 16_384).body, 200, { "content-length": "10" }),
    );
    expectCleanTransportError(error, seen);
  });

  it("an at-cap Content-Length does not excuse one more actual byte", async () => {
    const bytes = enc.encode(paddedSuccess(CAP + 1, "x", TOKEN));
    const { error, seen } = await thrownAssign(async () =>
      streamResponse(pullStream(bytes, 16_384).body, 200, { "content-length": String(CAP) }),
    );
    expectCleanTransportError(error, seen);
  });

  it("bytes, not characters: multibyte padding under the character count still trips", async () => {
    // "é" is 2 UTF-8 bytes: this body's character length is far below the
    // ceiling while its byte length is one byte over it.
    const body = paddedSuccess(CAP + 1, "é", TOKEN);
    expect(body.length).toBeLessThan(CAP);
    const { error, seen } = await thrownAssign(async () => jsonResponse(200, body));
    expectCleanTransportError(error, seen);
  });

  it("an over-limit rate-limited answer throws transport instead of surfacing as a refusal", async () => {
    const { error, seen } = await thrownAssign(async () =>
      jsonResponse(429, paddedRateLimited(CAP + 1), { "Retry-After": "42" }),
    );
    expectCleanTransportError(error, seen);
  });

  it("the over-limit message is one fixed string across different provider bodies", async () => {
    const first = await thrownAssign(async () =>
      jsonResponse(200, paddedSuccess(CAP + 1, "x", `${TOKEN}-alpha`)),
    );
    const second = await thrownAssign(async () =>
      jsonResponse(200, paddedSuccess(CAP + 50_000, "y", `${TOKEN}-beta-gamma`)),
    );
    expect(second.error.message).toBe(first.error.message);
    expectCleanTransportError(first.error, first.seen);
    expectCleanTransportError(second.error, second.seen);
  });

  it("reading stops at the ceiling: a long stream is not consumed to its end", async () => {
    // 40 chunks of 32 KiB (1.25 MiB) of non-JSON filler. A capping reader
    // trips after the 9th chunk; slack covers one read-ahead, not the tail.
    const filler = new Uint8Array(32_768 * 40).fill(0x78);
    const stream = pullStream(filler, 32_768);
    const { client, seen } = clientResponding(() => streamResponse(stream.body));
    const outcome = await settleWithin(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    );
    expect(outcome.kind).toBe("thrown");
    expect((outcome as { error: unknown }).error).toBeInstanceOf(BotTransportError);
    expect(seen).toHaveLength(1);
    expect(stream.pulls()).toBeLessThanOrEqual(16);
  });

  it("no log line carries the over-limit provider body, the secret, or the signature", async () => {
    const logged: string[] = [];
    const record =
      (...args: unknown[]) =>
      () => {
        logged.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(" "));
      };
    const spies = (["info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(record()),
    );
    try {
      const { error, seen } = await thrownAssign(async () =>
        jsonResponse(200, paddedSuccess(CAP + 1, "x", TOKEN)),
      );
      expectCleanTransportError(error, seen);
      const allLogged = logged.join("\n");
      expect(allLogged).not.toContain(TOKEN);
      expect(allLogged).not.toContain(SECRET);
      expect(allLogged).not.toContain(signatureOf(seen));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("over-limit cancellation is attempted, never awaited", () => {
  function oversizeStream(hooks: StreamHooks) {
    return pullStream(enc.encode(paddedSuccess(CAP + 100_000, "x", TOKEN)), 65_536, hooks);
  }

  it("settles as transport even when cancel never settles, and cancellation was attempted", async () => {
    const stream = oversizeStream({ cancel: () => new Promise<void>(() => {}) });
    const { error, seen } = await thrownAssign(async () => streamResponse(stream.body));
    expect(stream.cancel).toHaveBeenCalled();
    expectCleanTransportError(error, seen);
  });

  it("settles as transport when cancel throws, and cancellation was attempted", async () => {
    const stream = oversizeStream({
      cancel: () => {
        throw new Error(`cleanup exploded ${TOKEN}`);
      },
    });
    const { error, seen } = await thrownAssign(async () => streamResponse(stream.body));
    expect(stream.cancel).toHaveBeenCalled();
    expectCleanTransportError(error, seen);
  });

  it("a late-rejecting cancel is swallowed: no unhandled rejection after the throw", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectCancel: ((reason: unknown) => void) | undefined;
      const stream = oversizeStream({
        cancel: () =>
          new Promise<void>((_resolve, reject) => {
            rejectCancel = reject;
          }),
      });
      const { error, seen } = await thrownAssign(async () => streamResponse(stream.body));
      expect(stream.cancel).toHaveBeenCalled();
      expectCleanTransportError(error, seen);
      expect(rejectCancel, "cancellation must have been initiated").toBeTypeOf("function");
      rejectCancel!(new Error("late cancellation failure"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("positive controls: at and under the ceiling, behaviour is unchanged", () => {
  it("a buffered body at exactly the ceiling still succeeds", async () => {
    const { client, seen } = clientResponding(() => jsonResponse(200, paddedSuccess(CAP)));
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "assigned",
      requestId: "r1",
    });
    expect(seen).toHaveLength(1);
  });

  it("a streamed body at exactly the ceiling, split mid-character, still succeeds", async () => {
    const bytes = enc.encode(paddedSuccess(CAP, "é"));
    const firstMultibyte = bytes.findIndex((b) => b >= 0x80);
    expect(firstMultibyte).toBeGreaterThan(0);
    // First chunk ends between the two UTF-8 bytes of a single character.
    const split = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(bytes.subarray(0, firstMultibyte + 1));
          controller.enqueue(bytes.subarray(firstMultibyte + 1));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const { client, seen } = clientResponding(() => streamResponse(split));
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "assigned",
    });
    expect(seen).toHaveLength(1);
  });

  it("a small body in many tiny chunks still succeeds with the exact signed bytes sent once", async () => {
    const body = JSON.stringify({ ok: true, result: { outcome: "assigned" }, request_id: "r1" });
    const stream = pullStream(enc.encode(body), 7);
    const { client, seen } = clientResponding(() => streamResponse(stream.body));
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "assigned",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.redirect).toBe("manual");
    expect(seen[0]!.init.body as string).toBe(
      '{"action":"role.assign","discord_id":"900000000000009999","role_key":"rocketleague"}',
    );
    signatureOf(seen);
  });

  it("an announcement keeps the caller idempotency key and reads the replay flag", async () => {
    const { client, seen } = clientResponding(() =>
      jsonResponse(
        200,
        JSON.stringify({ ok: true, result: { message_id: "m1" }, request_id: "r1" }),
        { "Idempotent-Replay": "true" },
      ),
    );
    await expect(
      client.postAnnouncement({ channelKey: "qa-throwaway", body: "hi" }, UUID),
    ).resolves.toMatchObject({ ok: true, messageId: "m1", replayed: true });
    expect(seen).toHaveLength(1);
    expect((seen[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(UUID);
  });

  it("a refusal at normal size is still an answer, not a throw", async () => {
    const { client, seen } = clientResponding(() =>
      jsonResponse(
        409,
        JSON.stringify({
          ok: false,
          error: { code: "in_progress", message: "busy" },
          request_id: "r1",
        }),
      ),
    );
    await expect(
      client.postAnnouncement({ channelKey: "c", body: "b" }, UUID),
    ).resolves.toMatchObject({
      ok: false,
      code: "in_progress",
      retryable: true,
    });
    expect(seen).toHaveLength(1);
  });

  it("a 429 at normal size still carries the numeric Retry-After", async () => {
    const { client, seen } = clientResponding(() =>
      jsonResponse(429, paddedRateLimited(1024), { "Retry-After": "42" }),
    );
    await expect(
      client.postAnnouncement({ channelKey: "c", body: "b" }, UUID),
    ).resolves.toMatchObject({
      ok: false,
      code: "rate_limited",
      retryAfterSeconds: 42,
    });
    expect(seen).toHaveLength(1);
  });

  it("a redirect answer still throws transport after exactly one attempt", async () => {
    const { error, seen } = await thrownAssign(async () =>
      jsonResponse(307, JSON.stringify({ ok: true, result: { outcome: "assigned" } }), {
        location: `https://${TOKEN}.elsewhere.example/internal/actions`,
      }),
    );
    expect(seen).toHaveLength(1);
    expect(error.message).not.toContain(TOKEN);
  });

  it("a small non-JSON answer still throws transport without echoing the body", async () => {
    const { error, seen } = await thrownAssign(
      async () => new Response(`<html>${TOKEN}</html>`, { status: 502 }),
    );
    expect(seen).toHaveLength(1);
    expect(error.message).not.toContain(TOKEN);
  });
});
