// The signed mutation client only ever talks to a bare https: endpoint, and
// it releases 3xx response bodies (acceptance).
//
// A signed mutation body carries an HMAC of the exact request bytes. Sending
// it to a plaintext http: endpoint, to a non-HTTPS scheme, or to an endpoint
// URL that embeds a username/password would put that body on the wire in
// cleartext or leak configured credential material into transport errors and
// diagnostics. The read client already refuses any endpoint that is not bare
// https: with no credentials; the mutation client must refuse the same
// matrix, before any fetch, as the one fixed transport error —
// BotTransportError("bot unreachable") — with no URL or credential substring
// in the message.
//
// A 3xx answer is refused, never followed, and its body must be released the
// same way an over-limit body already is: cancellation is attempted without
// awaiting it, so stalled, throwing, or late-rejecting cleanup can neither
// delay the throw nor change its message.
//
// Hermetic: a mocked fetch only. No live bot, no database, synthetic
// canaries only.
import { describe, expect, it, vi } from "vitest";
import { exceptionClass } from "../src/alerts";
import { createBotClient } from "../src/bot/client";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";

const SECRET = "wire-secret-never-surface-endpoint-guard-canary";
const KEY_ID = "web-staging";
const UUID = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const USER_ID = "900000000000009999";
// Distinctive on purpose: substring checks must not false-positive on prose.
const HOST = "canary-endpoint-4d7k.example";
const URL_USER = "CANARYUSER4d7k";
const URL_PASS = "CANARYPASS9q2m";
const GOOD_HOST = "bot-staging.internal.example";
const GOOD_URL = `https://${GOOD_HOST}`;
const UNREACHABLE = "bot unreachable";
const PENDING = Symbol("pending");

const enc = new TextEncoder();

type Seen = { url: string; init: RequestInit };
type Outcome = { kind: "resolved"; value: unknown } | { kind: "thrown"; error: unknown };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const assigned = () =>
  jsonResponse(200, { ok: true, result: { outcome: "assigned" }, request_id: "r1" });

/** A client for `url` whose fetch hands back a fresh `impl` answer per call. */
function clientFor(url: string, impl: () => Response | Promise<Response> = async () => assigned()) {
  const seen: Seen[] = [];
  const fetchFn = vi.fn(async (fetchUrl: string, init: RequestInit) => {
    seen.push({ url: fetchUrl, init });
    return impl();
  });
  const client = createBotClient({
    url,
    secret: SECRET,
    keyId: KEY_ID,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, seen, fetchFn };
}

async function settleWithin(promise: Promise<unknown>, ms = 2_000): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  try {
    const settled = await Promise.race([
      promise.then(
        (value): Outcome => ({ kind: "resolved", value }),
        (error: unknown): Outcome => ({ kind: "thrown", error }),
      ),
      timeout,
    ]);
    expect(settled, "the attempt must settle before the deadline").not.toBe(PENDING);
    return settled as Outcome;
  } finally {
    clearTimeout(timer);
  }
}

/** Asserts the attempt threw and returns the transport error it threw. */
function transportErrorOf(outcome: Outcome): BotTransportError {
  expect(
    outcome.kind,
    outcome.kind === "resolved" ? "expected a throw, the call resolved" : "expected a throw",
  ).toBe("thrown");
  const error = (outcome as { error: unknown }).error;
  expect(error).toBeInstanceOf(BotTransportError);
  expect(error).not.toBeInstanceOf(BotTerminalError);
  // Not a raw runtime TypeError from URL parsing or stream handling, either.
  expect(exceptionClass(error)).toBe("BotTransportError");
  return error as BotTransportError;
}

function expectNoMaterial(message: string, forbidden: string[]) {
  for (const text of forbidden) {
    expect(message, `message must not carry ${JSON.stringify(text)}`).not.toContain(text);
  }
}

describe("endpoint guard: only bare https: is ever fetched", () => {
  it.each([
    ["a plaintext http: endpoint", `http://${HOST}`, [HOST, "http:"]],
    [
      "an https: endpoint with a username and password",
      `https://${URL_USER}:${URL_PASS}@${HOST}`,
      [HOST, URL_USER, URL_PASS, "@"],
    ],
    [
      "an https: endpoint with a username only",
      `https://${URL_USER}@${HOST}`,
      [HOST, URL_USER, "@"],
    ],
    [
      "an https: endpoint with a password only",
      `https://:${URL_PASS}@${HOST}`,
      [HOST, URL_PASS, "@"],
    ],
    ["an ftp: endpoint", `ftp://${HOST}`, [HOST, "ftp:"]],
    ["a ws: endpoint", `ws://${HOST}`, [HOST, "ws:"]],
    ["a scheme-less endpoint", HOST, [HOST]],
  ])(
    "%s is refused before any fetch with the fixed transport error",
    async (_label, url, forbidden) => {
      // The stub would answer a clean signed success if it were ever reached:
      // resolving at all is itself the failure these cases pin.
      const { client, fetchFn } = clientFor(url);
      const outcome = await settleWithin(
        client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
      );
      const error = transportErrorOf(outcome);
      expect(fetchFn, "no fetch may be attempted").not.toHaveBeenCalled();
      // One fixed string: the same shape as a rejecting fetch, never an echo
      // of the configured URL, its credentials, or the signing secret.
      expect(error.message).toBe(UNREACHABLE);
      expectNoMaterial(error.message, [...forbidden, SECRET, "/internal/actions"]);
    },
  );

  it("the guard is shared by every mutation action, not one method", async () => {
    const { client, fetchFn } = clientFor(`http://${HOST}`);
    for (const attempt of [
      () => client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
      () => client.postAnnouncement({ channelKey: "qa-throwaway", body: "hi" }, UUID),
      () =>
        client.upsertEvent(
          {
            eventKey: "e1",
            name: "n",
            startsAt: "2026-10-01T00:00:00Z",
            endsAt: "2026-10-01T01:00:00Z",
            location: "L",
            description: null,
          },
          UUID,
        ),
      () => client.cancelEvent({ eventKey: "e1" }, UUID),
    ]) {
      const error = transportErrorOf(await settleWithin(attempt()));
      expect(error.message).toBe(UNREACHABLE);
    }
    expect(fetchFn, "no action may reach the fetch").not.toHaveBeenCalled();
  });
});

describe("controls: bare https: endpoints behave exactly as before", () => {
  it("a signed success still goes to the https: endpoint, manual redirect, signed bytes", async () => {
    const { client, seen } = clientFor(GOOD_URL);
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({ ok: true, outcome: "assigned", requestId: "r1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://${GOOD_HOST}/internal/actions`);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.redirect).toBe("manual");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["X-TWO-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("a trailing slash on the https: endpoint still resolves to the one actions path", async () => {
    const { client, seen } = clientFor(`${GOOD_URL}/`);
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({ ok: true, outcome: "assigned" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://${GOOD_HOST}/internal/actions`);
  });

  it("an https: endpoint with an explicit port is still fetched", async () => {
    const { client, seen } = clientFor(`https://${GOOD_HOST}:8443`);
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({ ok: true, outcome: "assigned" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://${GOOD_HOST}:8443/internal/actions`);
  });

  it("a bot refusal over https: is still an answer branching on retryable, not a throw", async () => {
    const { client, seen } = clientFor(GOOD_URL, async () =>
      jsonResponse(409, {
        ok: false,
        error: { code: "in_progress", message: "busy" },
        request_id: "r1",
      }),
    );
    await expect(
      client.postAnnouncement({ channelKey: "c", body: "b" }, UUID),
    ).resolves.toMatchObject({ ok: false, code: "in_progress", retryable: true });
    expect(seen).toHaveLength(1);
  });

  it("a rejecting fetch to the https: endpoint still throws the same fixed string, cause attached", async () => {
    const raw = new Error(`getaddrinfo ENOTFOUND ${HOST} ${SECRET}`);
    const { client, seen } = clientFor(GOOD_URL, async () => {
      throw raw;
    });
    const error = transportErrorOf(
      await settleWithin(client.assignRole({ userId: USER_ID, roleKey: "rocketleague" })),
    );
    // The endpoint-guard refusal above pins this identical message: a guard
    // that invented its own wording would fork the diagnostics shape.
    expect(error.message).toBe(UNREACHABLE);
    expect((error as { cause?: unknown }).cause).toBe(raw);
    expectNoMaterial(error.message, [HOST, SECRET, "ENOTFOUND"]);
    expect(seen).toHaveLength(1);
  });
});

/** A response body that never yields a byte and never closes on its own. */
function hangingBody(cancelImpl: () => void | Promise<void> = () => {}) {
  const cancel = vi.fn(cancelImpl);
  const body = new ReadableStream<Uint8Array>({
    pull: () => {},
    cancel: () => cancel(),
  });
  return { body, cancel };
}

function redirectResponse(body: ReadableStream<Uint8Array> | null, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      location: `https://${HOST}/internal/actions`,
    },
  });
}

describe("3xx answers: refused as before, and the body is released without awaiting it", () => {
  it.each([300, 301, 302, 303, 307, 308, 399])(
    "a %s answer cancels its body and keeps the exact redirect error",
    async (status) => {
      const stream = hangingBody();
      const { client, seen } = clientFor(GOOD_URL, async () =>
        redirectResponse(stream.body, status),
      );
      const error = transportErrorOf(
        await settleWithin(client.assignRole({ userId: USER_ID, roleKey: "rocketleague" })),
      );
      expect(stream.cancel, "the 3xx body must be released").toHaveBeenCalledTimes(1);
      expect(error.message).toBe(`bot answered with a redirect (${status}); not followed`);
      expectNoMaterial(error.message, [HOST, SECRET, "/internal/actions"]);
      expect(seen).toHaveLength(1);
    },
  );

  it("settles with the redirect error even when cancelling the body never settles", async () => {
    // The body also never yields or closes: an implementation that awaited
    // the cancellation (or drained the body) instead of releasing it would
    // blow the settle deadline here.
    const stream = hangingBody(() => new Promise<void>(() => {}));
    const { client } = clientFor(GOOD_URL, async () => redirectResponse(stream.body, 307));
    const error = transportErrorOf(
      await settleWithin(client.assignRole({ userId: USER_ID, roleKey: "rocketleague" })),
    );
    expect(stream.cancel, "cancellation must have been attempted").toHaveBeenCalledTimes(1);
    expect(error.message).toBe("bot answered with a redirect (307); not followed");
  });

  it("a synchronously throwing cancel is swallowed and the redirect error is unchanged", async () => {
    const stream = hangingBody(() => {
      throw new Error(`cancel exploded for ${HOST} ${SECRET}`);
    });
    const { client } = clientFor(GOOD_URL, async () => redirectResponse(stream.body, 308));
    const error = transportErrorOf(
      await settleWithin(client.assignRole({ userId: USER_ID, roleKey: "rocketleague" })),
    );
    expect(stream.cancel, "cancellation must have been attempted").toHaveBeenCalledTimes(1);
    expect(error.message).toBe("bot answered with a redirect (308); not followed");
    expectNoMaterial(error.message, [HOST, SECRET]);
  });

  it("a late-rejecting cancel is swallowed: no unhandled rejection after the throw", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectCancel: ((reason: unknown) => void) | undefined;
      const stream = hangingBody(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCancel = reject;
          }),
      );
      const { client } = clientFor(GOOD_URL, async () => redirectResponse(stream.body, 302));
      const error = transportErrorOf(
        await settleWithin(client.assignRole({ userId: USER_ID, roleKey: "rocketleague" })),
      );
      expect(stream.cancel, "cancellation must have been attempted").toHaveBeenCalledTimes(1);
      expect(error.message).toBe("bot answered with a redirect (302); not followed");
      expect(rejectCancel, "cancellation must have been initiated").toBeTypeOf("function");
      rejectCancel!(new Error("late cancellation failure"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("control: a 3xx answer with no body still throws the exact redirect error", async () => {
    const { client, seen } = clientFor(GOOD_URL, async () => redirectResponse(null, 302));
    const error = transportErrorOf(
      await settleWithin(client.assignRole({ userId: USER_ID, roleKey: "rocketleague" })),
    );
    expect(error.message).toBe("bot answered with a redirect (302); not followed");
    expect(seen).toHaveLength(1);
  });

  it("control: a streamed 200 success is read, not cancelled", async () => {
    const bytes = enc.encode(
      JSON.stringify({ ok: true, result: { outcome: "assigned" }, request_id: "r1" }),
    );
    let sent = false;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) {
            controller.close();
            return;
          }
          sent = true;
          controller.enqueue(bytes);
        },
        cancel: () => cancel(),
      },
      { highWaterMark: 0 },
    );
    const { client } = clientFor(
      GOOD_URL,
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({ ok: true, outcome: "assigned", requestId: "r1" });
    expect(cancel, "a body that is read to completion is not cancelled").not.toHaveBeenCalled();
  });
});
