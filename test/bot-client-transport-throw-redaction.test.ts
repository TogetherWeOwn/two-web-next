// Bot transport throws carry no raw provider/runtime text (acceptance).
//
// When the signed fetch itself rejects — DNS failure, connection refused,
// abort/timeout, a redirect the runtime refuses to hand back — the rejection
// text is untrusted, input-derived material: runtimes embed the endpoint
// URL, resolved addresses, redirect targets, and anything a hostile or
// broken endpoint can get echoed into the error. The transport must surface
// that failure as a BotTransportError whose `message` is one fixed string,
// with the original rejection carried structurally as `cause` — never
// interpolated into the message. Error messages travel into queue failure
// records and operator diagnostics, so a raw interpolated message is a
// redaction bypass even when nothing here logs it directly.
//
// Sibling suites cover the neighbouring surfaces and must stay green:
// test/bot-client-provider-metadata-redaction.test.ts (envelope metadata in
// log lines) and test/bot-client-no-secret-log.test.ts (secret/signature in
// log lines). The fixed-string throws in client-serialization and
// client-factory are the positive pattern; the controls below pin them so
// the fix cannot regress them.
//
// Hermetic: a mocked fetch only. No live bot, no database, synthetic
// canaries only.
import { describe, expect, it, vi } from "vitest";
import { exceptionClass } from "../src/alerts";
import { createBotClient } from "../src/bot/client";
import { BotTransportError } from "../src/jobs/types";

const SECRET = "wire-secret-never-throw-synthetic-canary";
const URL = "https://bot-staging.internal.example";
const KEY_ID = "web-staging";
const UUID = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const USER_ID = "900000000000009999";
// Distinctive on purpose: substring checks must not false-positive on prose.
const TOKEN = "CANARY-TRANSPORT-5m8q2z7k";
const BODY = `Announcement body ${TOKEN}-BODY: the spring fair moves indoors.`;
// One fixed diagnostic string stays far below this; an interpolated raw
// runtime message with URLs and addresses need not.
const MAX_THROW_MESSAGE = 120;

type Seen = { url: string; init: RequestInit };
type FetchImpl = (url: string, init: RequestInit, seen: Seen[]) => Promise<Response>;

function clientWith(impl: FetchImpl, timeoutSeconds?: number) {
  const seen: Seen[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return impl(url, init, seen);
  });
  const client = createBotClient({
    url: URL,
    secret: SECRET,
    keyId: KEY_ID,
    timeoutSeconds,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, seen };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type ThrownTransport = BotTransportError & { cause?: unknown };

/** Runs one role.assign that must throw; returns the thrown value. */
async function thrownFrom(impl: FetchImpl, timeoutSeconds?: number): Promise<ThrownTransport> {
  const { client } = clientWith(impl, timeoutSeconds);
  let thrown: unknown;
  try {
    await client.assignRole({ userId: USER_ID, roleKey: "rocketleague" });
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected the call to throw").toBeInstanceOf(BotTransportError);
  return thrown as ThrownTransport;
}

/** The contract every fetch-rejection fixture must satisfy. */
function expectCleanThrow(err: ThrownTransport, raw: unknown, forbidden: string[]) {
  expect(err).toBeInstanceOf(Error);
  expect(exceptionClass(err)).toBe("BotTransportError");
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.message.length).toBeLessThanOrEqual(MAX_THROW_MESSAGE);
  for (const text of forbidden) {
    expect(err.message, `message must not carry ${JSON.stringify(text)}`).not.toContain(text);
  }
  // The original rejection is diagnostics material, carried structurally.
  expect(err.cause).toBe(raw);
}

describe("bot transport: a rejecting fetch throws a fixed string with a structural cause", () => {
  it("DNS failure: the message carries neither the host nor the endpoint URL", async () => {
    let raw: Error | undefined;
    const err = await thrownFrom(async (url) => {
      raw = new Error(`getaddrinfo ENOTFOUND ${TOKEN}.internal while fetching ${url}`);
      throw raw;
    });
    expectCleanThrow(err, raw, [
      TOKEN,
      "ENOTFOUND",
      "bot-staging.internal.example",
      "/internal/actions",
    ]);
  });

  it("connection refused: the message carries no resolved address text", async () => {
    let raw: Error | undefined;
    const err = await thrownFrom(async () => {
      raw = new TypeError(`fetch failed: connect ECONNREFUSED 10.9.8.7:443 ${TOKEN}`);
      throw raw;
    });
    expectCleanThrow(err, raw, [TOKEN, "ECONNREFUSED", "10.9.8.7"]);
  });

  it("timeout: an abort after the deadline carries no request-derived text", async () => {
    let raw: Error | undefined;
    const err = await thrownFrom(
      async (url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            raw = new Error(`request to ${url} timed out after deadline ${TOKEN}`);
            reject(raw);
          });
        }),
      0.05,
    );
    expectCleanThrow(err, raw, [TOKEN, "bot-staging.internal.example", "/internal/actions"]);
  });

  it("timeout: a runtime TimeoutError DOMException is carried as cause, not text", async () => {
    const raw = new DOMException(`The operation timed out ${TOKEN}`, "TimeoutError");
    const err = await thrownFrom(async () => {
      throw raw;
    });
    expectCleanThrow(err, raw, [TOKEN]);
  });

  it("redirect refused by the runtime: the message carries no redirect target", async () => {
    const location = `https://${TOKEN}.elsewhere.example/internal/actions`;
    let raw: Error | undefined;
    const err = await thrownFrom(async () => {
      raw = new Error(`redirect mode is set to error; refusing to follow to ${location}`);
      throw raw;
    });
    expectCleanThrow(err, raw, [TOKEN, "elsewhere.example", location]);
  });

  it("non-Error string rejection: the string is the cause, never the message", async () => {
    const raw = `boom ${TOKEN} from the socket layer`;
    const err = await thrownFrom(async () => {
      throw raw;
    });
    expectCleanThrow(err, raw, [TOKEN, "socket layer"]);
  });

  it("non-Error object rejection: its stringification never reaches the message", async () => {
    const raw = { toString: () => `socket exploded ${TOKEN}` };
    const err = await thrownFrom(async () => {
      throw raw;
    });
    expectCleanThrow(err, raw, [TOKEN, "socket exploded"]);
  });

  it("echoed outgoing material: a rejection embedding the signature and body leaks neither", async () => {
    let raw: Error | undefined;
    const { client, seen } = clientWith(async () => {
      const headers = seen[0]!.init.headers as Record<string, string>;
      raw = new Error(
        `upstream rejected signature ${headers["X-TWO-Signature"]} for body ${String(seen[0]!.init.body)}`,
      );
      throw raw;
    });
    let thrown: unknown;
    try {
      await client.postAnnouncement({ channelKey: "qa-throwaway", body: BODY }, UUID);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BotTransportError);
    const signature = (seen[0]!.init.headers as Record<string, string>)["X-TWO-Signature"]!;
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expectCleanThrow(thrown as ThrownTransport, raw, [TOKEN, signature, "sha256="]);
  });

  it("the message is one fixed string: different raw rejections, identical message", async () => {
    const first = await thrownFrom(async () => {
      throw new Error(`first raw wording ${TOKEN} alpha`);
    });
    const second = await thrownFrom(async () => {
      throw new Error(`completely different raw wording ${TOKEN} beta gamma delta`);
    });
    expect(second.message).toBe(first.message);
  });

  it("an empty raw message still yields the fixed string, with the raw error as cause", async () => {
    const raw = new Error("");
    const err = await thrownFrom(async () => {
      throw raw;
    });
    expectCleanThrow(err, raw, [TOKEN]);
  });
});

describe("controls: neighbouring fixed-string surfaces are already clean and stay unchanged", () => {
  it("a 3xx answer throws transport without the Location target in the message", async () => {
    const location = `https://${TOKEN}.elsewhere.example/internal/actions`;
    const err = await thrownFrom(async () =>
      jsonResponse(307, { ok: true, result: { outcome: "assigned" } }, { location }),
    );
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("elsewhere.example");
  });

  it("a non-JSON answer throws transport without the body text in the message", async () => {
    const err = await thrownFrom(
      async () => new Response(`<html>${TOKEN}</html>`, { status: 502 }),
    );
    expect(err.message).not.toContain(TOKEN);
  });

  it("an envelope without an `ok` field throws the fixed serialization string", async () => {
    const err = await thrownFrom(async () => jsonResponse(200, { note: TOKEN }));
    expect(err.message).toBe("bot answered without an `ok` field");
  });

  it.each([
    ["a null JSON body", null],
    ["a scalar JSON body", `bare string ${TOKEN}`],
  ])("%s throws the fixed ok-field serialization string", async (_label, body) => {
    // The { note } fixture above reaches only the `!("ok" in json)` disjunct;
    // null pins `json === null` and the scalar pins `typeof json !== "object"`.
    const err = await thrownFrom(async () => jsonResponse(200, body));
    expect(err.message).toBe("bot answered without an `ok` field");
    expect(err.message).not.toContain(TOKEN);
  });

  it("an ok:true envelope without a result object throws the fixed serialization string", async () => {
    // Premise check (2026-10-19 probe): these two serialization throws carry
    // no `cause` by design — unlike the fetch-rejection throw ("bot
    // unreachable", { cause }) — so the pin is exact message plus no raw-body
    // leak into the message. No production change per card scope.
    const err = await thrownFrom(async () =>
      jsonResponse(200, { ok: true, request_id: "r1", note: TOKEN }),
    );
    expect(err.message).toBe("bot success has no result object");
    expect(err.message).not.toContain(TOKEN);
  });

  it("an ok:true envelope with result:null throws the fixed serialization string", async () => {
    // typeof null === "object": the missing-result fixture above reaches only
    // the typeof disjunct, so this pins `body.result === null`.
    const err = await thrownFrom(async () =>
      jsonResponse(200, { ok: true, result: null, request_id: "r1", note: TOKEN }),
    );
    expect(err.message).toBe("bot success has no result object");
    expect(err.message).not.toContain(TOKEN);
  });

  it("an ok:false envelope without an error code throws the fixed serialization string", async () => {
    const err = await thrownFrom(async () =>
      jsonResponse(200, { ok: false, error: { message: TOKEN }, request_id: "r1" }),
    );
    expect(err.message).toBe("bot failure has no error code");
    expect(err.message).not.toContain(TOKEN);
  });

  it.each([
    ["missing", { ok: false, request_id: "r1", note: TOKEN }],
    ["null", { ok: false, error: null, request_id: "r1", note: TOKEN }],
    ["a non-object string", { ok: false, error: TOKEN, request_id: "r1", note: TOKEN }],
  ])(
    "an ok:false envelope with error %s throws the fixed serialization string",
    async (_label, body) => {
      // The error-object fixture above reaches only the `typeof error.code`
      // disjunct; these normalize to null and pin `!error`.
      const err = await thrownFrom(async () => jsonResponse(200, body));
      expect(err.message).toBe("bot failure has no error code");
      expect(err.message).not.toContain(TOKEN);
    },
  );

  it("an unknown role.assign outcome throws the fixed factory string, not the outcome", async () => {
    const err = await thrownFrom(async () =>
      jsonResponse(200, { ok: true, result: { outcome: TOKEN }, request_id: "r1" }),
    );
    expect(err.message).toBe("a role.assign outcome this release does not know");
  });

  it("an announcement success with no message_id throws the fixed factory string", async () => {
    const { client } = clientWith(async () =>
      jsonResponse(200, { ok: true, result: { note: TOKEN }, request_id: "r1" }),
    );
    let thrown: unknown;
    try {
      await client.postAnnouncement({ channelKey: "qa-throwaway", body: "hi" }, UUID);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BotTransportError);
    expect((thrown as Error).message).toBe("an announcement.post success with no message_id");
  });

  it("a bot refusal is still an answer, not a throw, and keeps its shape", async () => {
    const { client } = clientWith(async () =>
      jsonResponse(409, {
        ok: false,
        error: { code: "in_progress", message: "busy" },
        request_id: "r1",
      }),
    );
    await expect(
      client.postAnnouncement({ channelKey: "c", body: "b" }, UUID),
    ).resolves.toMatchObject({
      ok: false,
      code: "in_progress",
      retryable: true,
    });
  });

  it("a successful answer still succeeds through the same stubbed transport", async () => {
    const { client, seen } = clientWith(async () =>
      jsonResponse(200, { ok: true, result: { outcome: "assigned" }, request_id: "r1" }),
    );
    await expect(
      client.assignRole({ userId: USER_ID, roleKey: "rocketleague" }),
    ).resolves.toMatchObject({ ok: true, outcome: "assigned" });
    expect(seen).toHaveLength(1);
  });
});
