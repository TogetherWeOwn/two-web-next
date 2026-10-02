import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import { signInternalAction } from "../src/bot/signer";
import { BotTerminalError } from "../src/jobs/types";

// W15a: HMAC-signature verification vectors + idempotency-protocol rows.
//
// Two-web is the signer; the bot verifies (two-bot docs/INTERNAL_ACTIONS.md
// §1-§2), so there is no verifier to unit-test on this side. This file pins
// the verification contract from the outside instead: every vector below is
// checked with an independent node:crypto reference that never touches the
// shipped signer — the same outside-both-codebases rule the Pest originals
// follow (openssl vectors, reference-harness vectors).
//
// Pest originals (legacy two-web @ e1e939a, the revision docs/parity.md pins):
// - tests/Unit/Services/Bot/InternalActionSignerTest.php
// - tests/Unit/Services/Bot/InternalActionSignerReferenceTest.php
// - tests/Unit/Services/Bot/InternalActionClientTest.php
// - tests/Unit/Services/Bot/RoleAndAnnouncementTest.php
// Bot-side verification semantics (two-bot @ main, the implementation the
// reference harness accepted the endpoint against):
// - test/unit.internalauth.test.ts
//
// What this file deliberately does NOT cover: the bot's nonce cache, token
// buckets and bind guard are bot runtime internals (two-bot, not Pest, not
// two-web); the event.cancel action needs a client method that does not exist
// yet. Rows already ported elsewhere are not repeated here: the signing
// vectors themselves (test/bot-signer.test.ts), client happy paths
// (test/bot-client.test.ts), producer key minting
// (test/internal-action-producer-identity.test.ts), no-secret logging
// (test/bot-client-no-secret-log.test.ts) and server-side dedupe/conflict
// (test/agent-events.test.ts).

// ---------------------------------------------------------------------------
// Independent reference: node:crypto, never the shipped signer.
// ---------------------------------------------------------------------------

const KEY_ID = "web-test";
const NOW_MS = 1787173135_000;

const referenceDigest = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex");

const referenceCanonical = (timestamp: string, nonce: string, body: string): string =>
  ["POST", "/internal/actions", timestamp, nonce, referenceDigest(body)].join("\n");

const referenceSign = (secret: string, timestamp: string, nonce: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(referenceCanonical(timestamp, nonce, body), "utf8").digest("hex")}`;

// The bot's verification rule (INTERNAL_ACTIONS.md §1): recompute over the
// received bytes and constant-time compare; a wrong signature and an unknown
// key id are the same refusal. Lengths are compared first: timingSafeEqual
// throws on a mismatch, which must be a refusal, never a 500
// (two-bot test/unit.internalauth.test.ts:43-48).
function referenceVerify(
  secrets: ReadonlyMap<string, string>,
  keyId: string,
  signature: string,
  timestamp: string,
  nonce: string,
  body: string,
): boolean {
  const secret = secrets.get(keyId);
  if (secret === undefined) return false;
  const expected = Buffer.from(referenceSign(secret, timestamp, nonce, body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// Freshness half of verification: ±120 seconds on unix-second stamps
// (INTERNAL_ACTIONS.md §1; two-bot test/unit.internalauth.test.ts:72-82).
// Compared in milliseconds against the serving clock: the stamped second is
// already behind `now` by the sub-second remainder.
const SKEW_MS = 120_000;
function referenceFresh(timestamp: string, nowMs: number): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const stampedMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(stampedMs)) return false;
  return Math.abs(nowMs - stampedMs) <= SKEW_MS;
}

// The three known vectors, carried over unmodified:
// - openssl event.upsert (InternalActionSignerTest.php:24-31)
// - reference-harness role.assign (InternalActionSignerReferenceTest.php:35-37)
// - reference-harness announcement.post (:41-43; slash + non-ASCII bytes)
const VECTORS = [
  {
    label: "openssl event.upsert",
    secret: "two-web-test-secret-at-least-32-characters",
    body: '{"action":"event.upsert","event_key":"movie-night-2026-09-01"}',
    timestamp: 1787173135,
    nonce: "9f1c0a2b3d4e5f60718293a4b5c6d7e8",
    signature:
      "sha256=3604fc650acae867427205ec8da5dc6dc7e379e264c9014a2d947368d95a1224",
  },
  {
    label: "reference role.assign",
    secret: "test-secret-do-not-use",
    body: '{"action":"role.assign","discord_id":"900000000000009999","role_key":"rocketleague"}',
    timestamp: 1787173135,
    nonce: "9f1c0d3e5a7b9c1d3e5f7a9b0c2d4e6f",
    signature:
      "sha256=a2159435259369a4460b5d94202f44219f3e22fb17ed24c8a4394948bc6251a0",
  },
  {
    label: "reference announcement.post",
    secret: "test-secret-do-not-use",
    body: '{"action":"announcement.post","channel_key":"qa-throwaway","body":"héllo / world «ok»"}',
    timestamp: 1787173135,
    nonce: "9f1c0d3e5a7b9c1d3e5f7a9b0c2d4e6f",
    signature:
      "sha256=d75833b1faf35524dbce628cf26a14bc71084f9eea37d645c2160cc9039afd51",
  },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HMAC verification vectors", () => {
  it.each(VECTORS.map((v) => ({ label: v.label, vector: v })))(
    "verifies the known-good $label vector",
    async ({ vector: v }) => {
      // The reference reproduces the pinned signature byte for byte — this
      // guards the reference itself — and the shipped signer agrees with it.
      expect(referenceSign(v.secret, String(v.timestamp), v.nonce, v.body)).toBe(v.signature);
      const headers = await signInternalAction(KEY_ID, v.secret, v.body, v.timestamp, v.nonce);
      expect(headers["X-TWO-Signature"]).toBe(v.signature);
      expect(
        referenceVerify(
          new Map([[KEY_ID, v.secret]]),
          KEY_ID,
          headers["X-TWO-Signature"],
          String(v.timestamp),
          v.nonce,
          v.body,
        ),
      ).toBe(true);
    },
  );

  // Wrong-secret / tampered-body / truncated-signature / unknown-key-id, one
  // row per vector (InternalActionSignerTest.php:65-88;
  // InternalActionSignerReferenceTest.php:66-75;
  // two-bot test/unit.internalauth.test.ts:33-59).
  const tamperRows = VECTORS.flatMap((v) => {
    const ts = String(v.timestamp);
    return [
      {
        label: v.label,
        kind: "wrong secret",
        keyId: KEY_ID,
        signature: referenceSign("a-completely-different-shared-secret-value", ts, v.nonce, v.body),
        body: v.body,
        secret: v.secret,
      },
      {
        label: v.label,
        kind: "tampered body",
        keyId: KEY_ID,
        signature: v.signature,
        body: `${v.body} `,
        secret: v.secret,
      },
      {
        label: v.label,
        kind: "truncated signature",
        keyId: KEY_ID,
        signature: v.signature.slice(0, -1),
        body: v.body,
        secret: v.secret,
      },
      {
        label: v.label,
        kind: "unknown key id",
        keyId: "web-staging",
        signature: v.signature,
        body: v.body,
        secret: v.secret,
      },
    ];
  });

  it.each(tamperRows)("rejects $label with a $kind", ({ keyId, signature, body, secret, kind }) => {
    expect(kind).toMatch(/wrong secret|tampered body|truncated signature|unknown key id/);
    expect(
      referenceVerify(
        new Map([[KEY_ID, secret]]),
        keyId,
        signature,
        String(VECTORS[0]!.timestamp),
        VECTORS[0]!.nonce,
        body,
      ),
    ).toBe(false);
  });

  it("never confuses the key with the data (the hash_hmac argument-order row)", () => {
    // InternalActionSignerReferenceTest.php:66-75: both orders are
    // 71-character sha256=-prefixed hex strings and neither looks wrong.
    // Only the vector separates them.
    const v = VECTORS[1]!;
    const canonical = referenceCanonical(String(v.timestamp), v.nonce, v.body);
    const swapped = `sha256=${createHmac("sha256", canonical).update(v.secret, "utf8").digest("hex")}`;
    expect(swapped).not.toBe(v.signature);
    expect(
      referenceVerify(
        new Map([[KEY_ID, v.secret]]),
        KEY_ID,
        swapped,
        String(v.timestamp),
        v.nonce,
        v.body,
      ),
    ).toBe(false);
  });

  it("emits the signature as lowercase hex behind an sha256= prefix", async () => {
    // InternalActionSignerTest.php:58-63.
    const v = VECTORS[0]!;
    const headers = await signInternalAction(KEY_ID, v.secret, v.body, v.timestamp, v.nonce);
    expect(headers["X-TWO-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("verification freshness (expired timestamps)", () => {
  // two-bot test/unit.internalauth.test.ts:72-82. Milliseconds instead of
  // seconds is the mistake a caller actually makes
  // (InternalActionSignerTest.php:46-56 pins seconds on the wire).
  it.each([
    { label: "a current timestamp", timestamp: String(NOW_MS / 1000), fresh: true },
    { label: "119s ago", timestamp: String(NOW_MS / 1000 - 119), fresh: true },
    { label: "119s ahead", timestamp: String(NOW_MS / 1000 + 119), fresh: true },
    { label: "121s ago", timestamp: String(NOW_MS / 1000 - 121), fresh: false },
    { label: "121s ahead", timestamp: String(NOW_MS / 1000 + 121), fresh: false },
    { label: "a non-numeric timestamp", timestamp: "not-a-number", fresh: false },
    { label: "an empty timestamp", timestamp: "", fresh: false },
    { label: "milliseconds instead of seconds", timestamp: String(NOW_MS), fresh: false },
  ])("classifies $label as $fresh", ({ timestamp, fresh }) => {
    expect(referenceFresh(timestamp, NOW_MS)).toBe(fresh);
  });

  // The ±120s edge does not move with the sub-second phase of the clock
  // (two-bot test/unit.internalauth.test.ts:96-115): the stamped second is
  // already behind `now`, so +120 always has slack and -120 has none.
  const second = NOW_MS / 1000;
  const edgeRows = [0, 1, 500, 999].flatMap((remainderMs) =>
    [
      { offset: 0, fresh: true },
      { offset: 119, fresh: true },
      { offset: -119, fresh: true },
      { offset: 120, fresh: true },
      { offset: -120, fresh: remainderMs === 0 },
      { offset: 121, fresh: false },
      { offset: -121, fresh: false },
    ].map(({ offset, fresh }) => ({ remainderMs, offset, fresh })),
  );

  it.each(edgeRows)(
    "holds the edge at $offset s when $remainderMs ms into the second",
    ({ remainderMs, offset, fresh }) => {
      expect(referenceFresh(String(second + offset), NOW_MS + remainderMs)).toBe(fresh);
    },
  );

  it("stamps unix seconds (not milliseconds) and a fresh 32-hex nonce on the wire", async () => {
    // InternalActionClientTest.php:221-229: seconds, not milliseconds — the
    // skew window is ±120 seconds, so a millisecond stamp reads as expired.
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const { client, seen } = stubClient([
      jsonResponse(200, { ok: true, result: { outcome: "created", event_id: "d1" }, request_id: "r1" }),
    ]);
    await client.upsertEvent(EVENT, UUID_1);
    expect(seen).toHaveLength(1);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["X-TWO-Timestamp"]).toBe(String(NOW_MS / 1000));
    expect(referenceFresh(headers["X-TWO-Timestamp"]!, NOW_MS)).toBe(true);
    expect(headers["X-TWO-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency protocol rows (stubbed fetch: pure, no DB, no islands).
// ---------------------------------------------------------------------------

const UUID_1 = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const UUID_2 = "2e9d2f1a-2b3c-4d5e-8f90-123456789abd";
const OPTS = { url: "https://bot-staging.internal.example", secret: "s", keyId: "web-staging" };
const EVENT = {
  eventKey: "e1",
  name: "n",
  startsAt: "2026-10-01T00:00:00Z",
  endsAt: "2026-10-01T01:00:00Z",
  location: "L",
  description: null,
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubClient(responses: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    return next;
  });
  return { client: createBotClient({ ...OPTS, fetchFn: fetchFn as unknown as typeof fetch }), seen, fetchFn };
}

const announced = (messageId = "m1", requestId = "r1") =>
  jsonResponse(200, { ok: true, result: { message_id: messageId }, request_id: requestId });
const announcedReplay = (messageId = "m1", requestId = "r1") =>
  jsonResponse(
    200,
    { ok: true, result: { message_id: messageId }, request_id: requestId },
    { "Idempotent-Replay": "true" },
  );
describe("idempotency-key rows", () => {
  it("dedupes a duplicate delivery: same key, fresh nonce, replayed with the same message id", async () => {
    // InternalActionClientTest.php:243-264 (same key, fresh nonce across
    // attempts) + :186-193 (Idempotent-Replay header) +
    // RoleAndAnnouncementTest.php:139-150 (the replay carries the message id,
    // the only proof it did not post twice).
    const { client, seen } = stubClient([announced(), announcedReplay()]);
    const action = { channelKey: "c", body: "b" };
    const first = await client.postAnnouncement(action, UUID_1);
    const second = await client.postAnnouncement(action, UUID_1);
    expect(first).toMatchObject({ ok: true, messageId: "m1", replayed: false });
    expect(second).toMatchObject({ ok: true, messageId: "m1", replayed: true });
    const headers = seen.map((s) => s.init.headers as Record<string, string>);
    expect(headers[0]!["Idempotency-Key"]).toBe(UUID_1);
    expect(headers[1]!["Idempotency-Key"]).toBe(UUID_1);
    expect(headers[0]!["X-TWO-Nonce"]).not.toBe(headers[1]!["X-TWO-Nonce"]);
    expect(headers[0]!["X-TWO-Signature"]).not.toBe(headers[1]!["X-TWO-Signature"]);
  });

  it("processes distinct keys as distinct operations", async () => {
    // InternalActionClientTest.php:278-285: two key mints are two
    // operations; a retry reuses the first key instead.
    const { client, seen } = stubClient([announced("m1"), announced("m2")]);
    const action = { channelKey: "c", body: "b" };
    const first = await client.postAnnouncement(action, UUID_1);
    const second = await client.postAnnouncement(action, UUID_2);
    expect(first).toMatchObject({ ok: true, messageId: "m1", replayed: false });
    expect(second).toMatchObject({ ok: true, messageId: "m2", replayed: false });
    const headers = seen.map((s) => s.init.headers as Record<string, string>);
    expect(headers[0]!["Idempotency-Key"]).toBe(UUID_1);
    expect(headers[1]!["Idempotency-Key"]).toBe(UUID_2);
  });

  it.each([
    { action: "announcement.post", key: "not-a-uuid" },
    { action: "announcement.post", key: "" },
    { action: "event.upsert", key: "not-a-uuid" },
    { action: "event.upsert", key: "" },
  ])("refuses a malformed $action key without calling the bot", async ({ action, key }) => {
    // InternalActionClientTest.php:287-296; RoleAndAnnouncementTest.php:130-137.
    // A needs-key action with a malformed key is a `malformed` from the bot —
    // better to fail here, where the message names the value.
    const { client, fetchFn } = stubClient([]);
    const call =
      action === "announcement.post"
        ? client.postAnnouncement({ channelKey: "c", body: "b" }, key)
        : client.upsertEvent(EVENT, key);
    await expect(call).rejects.toThrow(BotTerminalError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads updated as a distinct outcome from created", async () => {
    // InternalActionClientTest.php:173-184.
    const { client } = stubClient([
      jsonResponse(200, { ok: true, result: { outcome: "updated", event_id: "999" }, request_id: "r1" }),
    ]);
    const result = await client.upsertEvent(EVENT, UUID_1);
    expect(result).toMatchObject({ ok: true, outcome: "updated", discordEventId: "999", replayed: false });
  });
});

describe("bot error-code dataset (table-driven)", () => {
  // InternalActionClientTest.php:303-315: all eleven codes, with in_progress
  // and replayed sitting on the same 409 with opposite answers. The wire
  // `retryable` flag is authoritative (INTERNAL_ACTIONS.md §2).
  const table: Array<[number, string, boolean]> = [
    [400, "malformed", false],
    [401, "unauthorized", false],
    [401, "stale_request", false],
    [403, "action_not_allowed", false],
    [409, "replayed", false],
    [409, "in_progress", true],
    [422, "discord_rejected", false],
    [429, "rate_limited", true],
    [500, "internal", true],
    [502, "discord_unavailable", true],
    [504, "upstream_timeout", true],
  ];

  it.each(table.map(([status, code, retryable]) => ({ status, code, retryable })))(
    "returns the wire retryable answer for $code ($status)",
    async ({ status, code, retryable }) => {
      // InternalActionClientTest.php:317-329.
      const { client } = stubClient([jsonResponse(status, {
        ok: false,
        error: { code, message: "the bot said no", retryable },
        request_id: "01JERROR0123456789",
      })]);
      const failure = await client.upsertEvent(EVENT, UUID_1);
      expect(failure).toMatchObject({
        ok: false,
        code,
        status,
        retryable,
        message: "the bot said no",
        requestId: "01JERROR0123456789",
      });
    },
  );

  it.each(table.map(([status, code, retryable]) => ({ status, code, retryable })))(
    "falls back to the published table for $code when the bot omits the flag",
    async ({ status, code, retryable }) => {
      // InternalActionClientTest.php:331-347: never branch on the status —
      // the status gets 409 wrong in both directions.
      const { client } = stubClient([jsonResponse(status, {
        ok: false,
        error: { code, message: "the bot said no" },
        request_id: "01JERROR0123456789",
      })]);
      const failure = await client.upsertEvent(EVENT, UUID_1);
      expect(failure).toMatchObject({ ok: false, code, retryable });
    },
  );

  it("does not decide retryability from the status code (both 409s, opposite answers)", async () => {
    // InternalActionClientTest.php:349-366: the assertion that catches a
    // status-code implementation.
    const { client } = stubClient([
      jsonResponse(409, { ok: false, error: { code: "in_progress", message: "busy", retryable: true }, request_id: "r" }),
      jsonResponse(409, { ok: false, error: { code: "replayed", message: "done", retryable: false }, request_id: "r" }),
    ]);
    expect(await client.upsertEvent(EVENT, UUID_1)).toMatchObject({ ok: false, retryable: true });
    expect(await client.upsertEvent(EVENT, UUID_2)).toMatchObject({ ok: false, retryable: false });
  });

  it("honours the wire flag over the published table", async () => {
    // InternalActionClientTest.php:368-378: if the running bot contradicts
    // its own markdown, do what the running bot says.
    const { client } = stubClient([
      jsonResponse(409, { ok: false, error: { code: "replayed", message: "?", retryable: true }, request_id: "r" }),
    ]);
    expect(await client.upsertEvent(EVENT, UUID_1)).toMatchObject({ ok: false, code: "replayed", retryable: true });
  });

  it("treats an unknown code as not retryable", async () => {
    // InternalActionClientTest.php:380-396: the table grows; an unknown code
    // must not crash us and must not become a retry loop.
    const { client } = stubClient([
      jsonResponse(418, { ok: false, error: { code: "something_new", message: "from a future bot" }, request_id: "01JNEW" }),
    ]);
    const failure = await client.upsertEvent(EVENT, UUID_1);
    expect(failure).toMatchObject({ ok: false, code: "something_new", retryable: false, requestId: "01JNEW" });
  });

  it("surfaces retry-after in seconds on a 429, and null everywhere else", async () => {
    // InternalActionClientTest.php:414-453: the doc says seconds; an
    // HTTP-date is legal per RFC but is not what this endpoint sends.
    const { client } = stubClient([
      jsonResponse(429, { ok: false, error: { code: "rate_limited", message: "slow", retryable: true }, request_id: "r" }, { "Retry-After": "42" }),
      jsonResponse(429, { ok: false, error: { code: "rate_limited", message: "slow", retryable: true }, request_id: "r" }),
      jsonResponse(500, { ok: false, error: { code: "internal", message: "x", retryable: true }, request_id: "r" }, { "Retry-After": "9" }),
    ]);
    expect(await client.upsertEvent(EVENT, UUID_1)).toMatchObject({ retryAfterSeconds: 42 });
    expect(await client.upsertEvent(EVENT, UUID_2)).toMatchObject({ retryAfterSeconds: null });
    expect(await client.upsertEvent(EVENT, UUID_1)).toMatchObject({ retryAfterSeconds: null });
  });

});
