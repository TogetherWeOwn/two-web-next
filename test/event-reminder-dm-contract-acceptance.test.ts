// Acceptance: Events — Discord DM reminder delivery contract (web side).
//
// Slice 5 of the event-reminders design spec (§4.3): a NEW bot action,
// `dm.send`, carries one reminder DM over the signed internal-action path.
// No DM action exists today (the surface is only role.assign,
// announcement.post, event.upsert, event.cancel), so every dm.send test here
// fails until the Builder implements the contract. Controls on existing seams
// (idempotency-key shape, the rate_limited fallback, unknown-code
// fail-closed) already pass; they prove the harness, not the feature.
//
// Hermetic: stubbed fetch only. No database, no live Discord or bot calls.
//
// Seams the Builder implements (this file is never edited by the Builder):
//   1. `dmSendPayload` (+ `DmSend`) in src/bot/actions.ts — construction-time
//      validation mirroring announcement.post (body) and role.assign
//      (discord_id), returning exactly
//      { action, discord_id, event_key, body } in that key order.
//   2. `sendDm` on createBotClient (client-factory, client-validation,
//      client-types) — UUID idempotency key on every call, success parses
//      { message_id } plus the Idempotent-Replay flag.
//   3. An explicit `dm_blocked` entry in src/bot/client-retry.ts —
//      non-retryable, so a missing wire flag still fails closed.
//
// Cross-repo vectors: the dm.send body, digest and signature below are the
// two-bot counterpart's acceptance input, in the same secret/timestamp/nonce
// family as the reference vectors in bot-signer.test.ts. Both sides sign and
// verify these exact bytes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidActionRequestError, assertIdempotencyKey, dmSendPayload } from "../src/bot/actions";
import { createBotClient, retryableFallback } from "../src/bot/client";
import { encodeCanonicalJson, sha256Hex, signInternalAction } from "../src/bot/signer";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";

const UUID = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const SNOWFLAKE = "900000000000009999";
const EVENT_KEY = "movie-night-2026-09-01";
const DM_BODY = "Movie Night starts 2026-09-01T18:00:00Z https://example.test/events/movie-night";
// The exact bytes both sides sign and verify (key order pinned).
const DM_VECTOR_BODY =
  '{"action":"dm.send","discord_id":"900000000000009999",' +
  '"event_key":"movie-night-2026-09-01",' +
  '"body":"Movie Night starts 2026-09-01T18:00:00Z https://example.test/events/movie-night"}';
const DM_VECTOR_SHA = "17f0775167dbcd8b86a2009bf6e4946aab2ed5414c198f8d068b5eb30c6c2172";
const DM_VECTOR_SIG = "sha256=b999b1ea2f843b84a3ab56a9d71fcb5a978061da5f6832b6196ba77522fe4927";
const VECTOR_SECRET = "test-secret-do-not-use";
const VECTOR_TS = 1787173135;
const VECTOR_NONCE = "deadbeefdeadbeefdeadbeefdeadbeef";

const opts = { url: "https://bot-staging.internal.example", secret: "s", keyId: "web-staging" };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(responses: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    return next;
  });
  return {
    client: createBotClient({ ...opts, fetchFn: fetchFn as unknown as typeof fetch }),
    seen,
    fetchFn,
  };
}

const dmSendInput = () => ({ discordId: SNOWFLAKE, eventKey: EVENT_KEY, body: DM_BODY });
const dmClientInput = () => ({ userId: SNOWFLAKE, eventKey: EVENT_KEY, body: DM_BODY });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dm.send payload contract", () => {
  it("builds the documented payload, by key and never by channel or role id", () => {
    expect(dmSendPayload(dmSendInput())).toEqual({
      action: "dm.send",
      discord_id: SNOWFLAKE,
      event_key: EVENT_KEY,
      body: DM_BODY,
    });
  });

  it("serializes to the exact bytes both sides sign (cross-repo pin)", () => {
    // Key order and escaping are part of the contract: the body is hashed
    // into the signature, so a reordered key answers `unauthorized` with no
    // clue as to why. The two-bot counterpart verifies this same string.
    expect(encodeCanonicalJson(dmSendPayload(dmSendInput()))).toBe(DM_VECTOR_BODY);
  });

  it("carries no channel_key, location, or role_key", () => {
    const body = dmSendPayload(dmSendInput());
    expect(body).not.toHaveProperty("channel_key");
    expect(body).not.toHaveProperty("location");
    expect(body).not.toHaveProperty("role_key");
  });

  it.each(["everyone", "<@900000000000009999>", "", "999999999999999999999", "9000000000000099ab"])(
    "refuses a discord id that is not a snowflake: %j",
    (discordId) => {
      expect(() => dmSendPayload({ discordId, eventKey: EVENT_KEY, body: DM_BODY })).toThrow(
        InvalidActionRequestError,
      );
    },
  );

  it.each([
    ["blank event key", ""],
    ["whitespace event key", "   "],
    ["event key over 64 characters", "k".repeat(65)],
    ["blank body", ""],
    ["whitespace body", "  \n "],
    ["body over 2000 characters", "a".repeat(2001)],
  ])("refuses a dm.send that breaks the documented limits (%s)", (_label, _v) => {
    const v = _v as string;
    const input =
      _label === "blank body" ||
      _label === "whitespace body" ||
      _label === "body over 2000 characters"
        ? { discordId: SNOWFLAKE, eventKey: EVENT_KEY, body: v }
        : { discordId: SNOWFLAKE, eventKey: v, body: DM_BODY };
    expect(() => dmSendPayload(input)).toThrow(InvalidActionRequestError);
  });

  it("accepts an event key and a body exactly on the limit", () => {
    const body = dmSendPayload({
      discordId: SNOWFLAKE,
      eventKey: "k".repeat(64),
      body: "a".repeat(2000),
    });
    expect(body.event_key).toHaveLength(64);
    expect(body.body).toHaveLength(2000);
  });

  it("counts characters and not bytes against the body limit", () => {
    // Discord's ceiling is characters. Counting bytes would refuse a
    // legitimate 2000-character reminder with an accent in it.
    const body = dmSendPayload({
      discordId: SNOWFLAKE,
      eventKey: EVENT_KEY,
      body: "é".repeat(2000),
    });
    expect([...body.body!].length).toBe(2000);
  });
});

describe("dm.send cross-repo signing vectors", () => {
  it("signs the pinned bytes to the published signature", async () => {
    const h = await signInternalAction(
      "web-test",
      VECTOR_SECRET,
      encodeCanonicalJson(dmSendPayload(dmSendInput())),
      VECTOR_TS,
      VECTOR_NONCE,
    );
    expect(h["X-TWO-Signature"]).toBe(DM_VECTOR_SIG);
    expect(h["X-TWO-Key-Id"]).toBe("web-test");
    expect(h["X-TWO-Timestamp"]).toBe(String(VECTOR_TS));
    expect(h["X-TWO-Nonce"]).toBe(VECTOR_NONCE);
  });

  it("hashes the body to the digest the bot recomputes", async () => {
    expect(await sha256Hex(encodeCanonicalJson(dmSendPayload(dmSendInput())))).toBe(DM_VECTOR_SHA);
  });
});

describe("dm.send idempotency", () => {
  it("control: an idempotency key is a UUID, refused before anything is sent", () => {
    expect(() => assertIdempotencyKey(UUID)).not.toThrow();
    expect(() => assertIdempotencyKey("not-a-uuid")).toThrow(InvalidActionRequestError);
    expect(() => assertIdempotencyKey("")).toThrow(InvalidActionRequestError);
  });

  it("rejects a non-UUID idempotency key before sending", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(client.sendDm(dmClientInput(), "not-a-uuid")).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("same key + fresh nonce across retries: two sends, one key, different nonces and signatures", async () => {
    const { client, seen } = clientWith([
      jsonResponse(200, { ok: true, result: { message_id: "m1" }, request_id: "r1" }),
      jsonResponse(
        200,
        { ok: true, result: { message_id: "m1" }, request_id: "r1" },
        { "Idempotent-Replay": "true" },
      ),
    ]);
    await client.sendDm(dmClientInput(), UUID);
    await client.sendDm(dmClientInput(), UUID);
    const h = seen.map((s) => s.init.headers as Record<string, string>);
    expect(h[0]!["Idempotency-Key"]).toBe(UUID);
    expect(h[1]!["Idempotency-Key"]).toBe(UUID);
    expect(h[0]!["X-TWO-Nonce"]).not.toBe(h[1]!["X-TWO-Nonce"]);
    expect(h[0]!["X-TWO-Signature"]).not.toBe(h[1]!["X-TWO-Signature"]);
  });
});

describe("dm.send client success", () => {
  it("sends action dm.send with the key header and parses message id", async () => {
    const { client, seen } = clientWith([
      jsonResponse(200, { ok: true, result: { message_id: "m1" }, request_id: "r1" }),
    ]);
    const r = await client.sendDm(dmClientInput(), UUID);
    expect(r).toMatchObject({ ok: true, messageId: "m1", replayed: false, requestId: "r1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://bot-staging.internal.example/internal/actions");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(UUID);
    expect(headers["X-TWO-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    // The signed bytes are the sent bytes.
    expect(seen[0]!.init.body as string).toBe(DM_VECTOR_BODY);
  });

  it("a replayed key surfaces replayed:true — one logical send", async () => {
    const { client } = clientWith([
      jsonResponse(
        200,
        { ok: true, result: { message_id: "m1" }, request_id: "r1" },
        { "Idempotent-Replay": "true" },
      ),
    ]);
    const r = await client.sendDm(dmClientInput(), UUID);
    expect(r).toMatchObject({ ok: true, messageId: "m1", replayed: true });
  });

  it.each(["", " ", null, 123])("rejects an unusable message id: %s", async (id) => {
    const { client } = clientWith([
      jsonResponse(200, { ok: true, result: { message_id: id }, request_id: "r1" }),
    ]);
    await expect(client.sendDm(dmClientInput(), UUID)).rejects.toThrow(BotTransportError);
  });

  it("rejects an over-long body before sending (terminal, no network)", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(
      client.sendDm({ userId: SNOWFLAKE, eventKey: EVENT_KEY, body: "x".repeat(2001) }, UUID),
    ).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a non-snowflake user id before sending (terminal, no network)", async () => {
    const { client, fetchFn } = clientWith([]);
    await expect(
      client.sendDm({ userId: "not-an-id", eventKey: EVENT_KEY, body: DM_BODY }, UUID),
    ).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("dm.send fail-closed (dm_blocked)", () => {
  it.each([403, 422])(
    "closed DMs answer dm_blocked on status %d: non-retryable, no backoff, no silent retry",
    async (status) => {
      const { client } = clientWith([
        jsonResponse(
          status,
          {
            ok: false,
            error: { code: "dm_blocked", message: "cannot dm this member", retryable: false },
            request_id: "r1",
          },
          { "Retry-After": "42" },
        ),
      ]);
      const r = await client.sendDm(dmClientInput(), UUID);
      // Never branch on status: the wire code + flag are authoritative.
      expect(r).toMatchObject({
        ok: false,
        code: "dm_blocked",
        retryable: false,
        retryAfterSeconds: null,
      });
    },
  );

  it("a missing wire retryable flag still fails closed via the fallback table", async () => {
    const { client } = clientWith([
      jsonResponse(422, {
        ok: false,
        error: { code: "dm_blocked", message: "cannot dm this member" },
        request_id: "r1",
      }),
    ]);
    const r = await client.sendDm(dmClientInput(), UUID);
    expect(r).toMatchObject({ ok: false, code: "dm_blocked", retryable: false });
  });

  it("dm_blocked is an explicit non-retryable entry in the fallback table", () => {
    expect(retryableFallback("dm_blocked")).toBe(false);
  });

  it("dm_blocked is pinned in the fallback source, not just the default branch", async () => {
    // Unknown codes fail closed through `default` today; dm_blocked is a
    // documented delivery outcome, so it gets its own entry that survives a
    // future default flip. Tell the Builder exactly where it goes.
    const root = new URL("../", import.meta.url);
    const src = await readFile(
      fileURLToPath(new URL("src/bot/client-retry.ts", root).href),
      "utf8",
    );
    expect(src, "src/bot/client-retry.ts must name dm_blocked as non-retryable").toMatch(
      /["']dm_blocked["']/,
    );
  });

  it("control: rate_limited stays retryable and unknown codes stay fail-closed", () => {
    expect(retryableFallback("rate_limited")).toBe(true);
    expect(retryableFallback("weird-new-code")).toBe(false);
  });
});

describe("dm.send rate limiting rides the shared backoff", () => {
  it.each([
    ["whole seconds pass through", "42", 42],
    ["fractions round up, never sooner than asked", "1.2", 2],
    ["non-numeric is unusable", "abc", null],
    ["absent header is unusable", null, null],
  ])("%s via dm.send", async (_label, header, expected) => {
    const { client } = clientWith([
      jsonResponse(
        429,
        {
          ok: false,
          error: { code: "rate_limited", message: "slow", retryable: true },
          request_id: "r1",
        },
        header === null ? {} : { "Retry-After": header as string },
      ),
    ]);
    // The full header matrix is pinned on the announcement seam; these prove
    // dm.send rides the same transport path and shared parser.
    const r = await client.sendDm(dmClientInput(), UUID);
    expect(r).toMatchObject({ ok: false, code: "rate_limited", retryable: true });
    if (!r.ok) expect(r.retryAfterSeconds).toBe(expected);
  });

  it("a non-429 refusal never carries backoff, even with a usable header", async () => {
    const { client } = clientWith([
      jsonResponse(
        409,
        {
          ok: false,
          error: { code: "in_progress", message: "busy", retryable: true },
          request_id: "r1",
        },
        { "Retry-After": "42" },
      ),
    ]);
    const r = await client.sendDm(dmClientInput(), UUID);
    expect(r).toMatchObject({ ok: false, retryable: true });
    if (!r.ok) expect(r.retryAfterSeconds).toBeNull();
  });

  it("a 429 that is not rate_limited never carries backoff", async () => {
    const { client } = clientWith([
      jsonResponse(
        429,
        {
          ok: false,
          error: { code: "in_progress", message: "busy", retryable: true },
          request_id: "r1",
        },
        { "Retry-After": "42" },
      ),
    ]);
    const r = await client.sendDm(dmClientInput(), UUID);
    if (!r.ok) expect(r.retryAfterSeconds).toBeNull();
  });
});
