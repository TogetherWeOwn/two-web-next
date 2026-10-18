// Defensive cleanup paths of the capped mutation-response reader (supplement).
//
// The acceptance suite pins the ceiling, streaming byte counts, and
// cancellation behaviour through real Response objects, which always carry a
// non-null body. These cases pin the remaining defensive branches of
// readCappedJson in src/bot/client-transport.ts: a null body falling back to
// text() (including a rejecting text()), a reader whose read() rejects
// mid-stream, a cancel() that throws synchronously, and a releaseLock() that
// throws during cleanup. Every outcome is the same fixed, redacted
// BotTransportError (or the untouched success), never provider text.
//
// Hermetic: a mocked fetch only. No live bot, no database, synthetic
// canaries only.
import { describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import { BotTransportError } from "../src/jobs/types";

const CAP = 262_144; // 256 KiB, the provider-buffer convention.
const SECRET = "wire-secret-never-surface-synthetic-canary-cleanup";
const URL = "https://bot-staging.internal.example";
const KEY_ID = "web-staging";
const USER_ID = "900000000000009999";
const TOKEN = "CANARY-TRANSPORT-CLEANUP-7q2m8z4t";
const TOO_LARGE = "bot answered with a body that is too large";
const NOT_JSON = "bot answered with a body that is not JSON";

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
  return { client, seen };
}

/** A null-body answer whose text() behaves as `textImpl` says. */
function nullBodyResponse(textImpl: () => Promise<string>, status = 200): Response {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    text: textImpl,
  } as unknown as Response;
}

type ReaderStep = { done: boolean; value?: Uint8Array };

/** A fake reader playing `script` in order, then repeating its last step. */
function fakeReader(
  script: ReaderStep[],
  hooks: { cancel?: () => unknown; releaseLock?: () => void } = {},
) {
  let at = 0;
  const reader = {
    read: vi.fn(async () => script[Math.min(at++, script.length - 1)]),
    cancel: vi.fn(hooks.cancel ?? (() => {})),
    releaseLock: vi.fn(hooks.releaseLock ?? (() => {})),
  };
  return reader;
}

function readerBody(reader: ReturnType<typeof fakeReader>, status = 200): Response {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader: () => reader,
    },
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

async function throwsTransport(promise: Promise<unknown>): Promise<BotTransportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BotTransportError);
    return error as BotTransportError;
  }
  throw new Error("expected a BotTransportError, the call succeeded");
}

function expectRedacted(error: BotTransportError, seen: Seen[]) {
  const signature = (seen[0]!.init.headers as Record<string, string>)["X-TWO-Signature"]!;
  for (const text of [TOKEN, SECRET, signature, "sha256=", "bot-staging.internal.example"]) {
    expect(error.message, `message must not carry ${JSON.stringify(text)}`).not.toContain(text);
  }
}

describe("null-body answers fall back to text() without leaking", () => {
  it("a rejecting text() still throws one fixed redacted error", async () => {
    const { client, seen } = clientWith(async () =>
      nullBodyResponse(() => Promise.reject(new Error(`boom ${TOKEN} ${SECRET}`))),
    );
    const error = await throwsTransport(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    );
    expect(error.message).toBe(NOT_JSON);
    expectRedacted(error, seen);
    expect(seen).toHaveLength(1);
  });

  it("an over-limit text() still throws the fixed too-large error", async () => {
    const { client, seen } = clientWith(async () =>
      nullBodyResponse(async () => `${TOKEN}${"x".repeat(CAP)}`),
    );
    const error = await throwsTransport(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    );
    expect(error.message).toBe(TOO_LARGE);
    expectRedacted(error, seen);
    expect(seen).toHaveLength(1);
  });

  it("a small non-JSON text() still throws the fixed not-JSON error", async () => {
    const { client, seen } = clientWith(async () =>
      nullBodyResponse(async () => `<html>${TOKEN}</html>`),
    );
    const error = await throwsTransport(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    );
    expect(error.message).toBe(NOT_JSON);
    expectRedacted(error, seen);
    expect(seen).toHaveLength(1);
  });
});

describe("reader and cleanup failures never leak or poison the outcome", () => {
  it("a rejecting read() still throws the fixed not-JSON error", async () => {
    const reader = fakeReader([{ done: true }]);
    reader.read.mockRejectedValueOnce(new Error(`stream boom ${TOKEN} ${SECRET}`));
    const { client, seen } = clientWith(async () => readerBody(reader));
    const error = await throwsTransport(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    );
    expect(error.message).toBe(NOT_JSON);
    expectRedacted(error, seen);
    expect(seen).toHaveLength(1);
  });

  it("a synchronously throwing cancel() is swallowed and the too-large error still settles", async () => {
    const cancel = vi.fn(() => {
      throw new Error(`sync cancel boom ${TOKEN}`);
    });
    const reader = fakeReader([{ done: false, value: new Uint8Array(CAP + 1) }], { cancel });
    const { client, seen } = clientWith(async () => readerBody(reader));
    const error = await throwsTransport(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    );
    expect(error.message).toBe(TOO_LARGE);
    expect(cancel, "cancellation is attempted exactly once").toHaveBeenCalledTimes(1);
    expectRedacted(error, seen);
    expect(seen).toHaveLength(1);
  });

  it("a throwing releaseLock() does not poison a successful answer", async () => {
    const bytes = enc.encode(
      JSON.stringify({ ok: true, result: { outcome: "assigned" }, request_id: "r1" }),
    );
    const half = Math.floor(bytes.byteLength / 2);
    const reader = fakeReader(
      [
        { done: false, value: bytes.subarray(0, half) },
        { done: false, value: bytes.subarray(half) },
        { done: true },
      ],
      {
        releaseLock: () => {
          throw new Error("lock boom");
        },
      },
    );
    const { client, seen } = clientWith(async () => readerBody(reader));
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({ ok: true, outcome: "assigned", requestId: "r1" });
    expect(seen).toHaveLength(1);
  });
});
