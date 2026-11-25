// route-inventory: POST /__probe/voice-move
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { QA_IDENTITIES, STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, SESSION_ROLE_RECHECK_SECONDS } from "../src/sessions";
import app from "./app";
import contract from "./fixtures/bot-site-contract-v2.json";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

const move = contract.verbs["voice.move_member"];
const { discord_id: memberId, channel_id: target } = move.request;
const source = move.results.moved.from_channel_id;
const botUrl = "https://two-bot-next-staging.5150.workers.dev";
const secret = "fixture-hmac-key-for-staging-voice-move";
const requestId = move.refusals.discord_unavailable.body.request_id;
const success = (result: unknown) => ({ ok: true, request_id: requestId, result });
const outbound = vi.fn<typeof fetch>();
let now: number;
let store: ReturnType<typeof createMemorySessionStore>;
let cookie: string;

beforeEach(async () => {
  now = Date.now();
  store = createMemorySessionStore(() => now);
  cookie = await cookieFor(store, { ...MEMBER, userId: memberId });
  outbound.mockReset().mockRejectedValue(new Error("fixture has no external network"));
  vi.stubGlobal("fetch", outbound);
});
afterEach(() => vi.unstubAllGlobals());

function post(
  bind: Partial<Env> = {},
  body = { channel_id: target },
  bearer = cookie,
  origin?: string | null,
) {
  const bindings = {
    ...env,
    APP_URL: STAGING_APP_URL,
    DISCORD_GUILD_ID: "100000000000000015",
    SESSION_STORE: store,
    STAGING_VOICE_MOVE_ENABLED: "true",
    STAGING_VOICE_MOVE_MEMBER_ID: memberId,
    STAGING_VOICE_MOVE_CHANNEL_IDS: `${target},${source}`,
    BOT_ENDPOINT_URL: botUrl,
    BOT_SHARED_SECRET: secret,
    BOT_KEY_ID: "voice-fixture",
    ...bind,
  };
  const headers: Record<string, string> = { cookie: bearer, "content-type": "application/json" };
  if (origin === null) headers["sec-fetch-site"] = "same-origin";
  else headers.origin = origin ?? new URL(bindings.APP_URL).origin;
  const init = { method: "POST", body: JSON.stringify(body), headers };
  return app.request("/__probe/voice-move", init, bindings);
}

async function botReply(response: Response | null, channel = target) {
  if (response) outbound.mockResolvedValueOnce(response);
  const result = await post({}, { channel_id: channel });
  expect(outbound).toHaveBeenCalledTimes(1);
  return result;
}

it("signs the mirrored keyless request once with the current member session's identity", async () => {
  const receipt = success(move.results.moved);
  const res = await botReply(Response.json(receipt));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(res.headers.has("set-cookie")).toBe(false);
  expect(await res.json()).toEqual(receipt);
  const [url, init] = outbound.mock.calls[0]!;
  expect(url).toBe(`${botUrl}/internal/actions`);
  expect(init).toMatchObject({ method: "POST", redirect: "manual" });
  const h = new Headers(init?.headers);
  expect(h.get("X-TWO-Key-Id")).toBe("voice-fixture");
  expect(h.has("Idempotency-Key") || h.has("Cookie")).toBe(false);
  const body = String(init?.body);
  expect(body).toBe(JSON.stringify(move.request));
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = `POST\n/internal/actions\n${h.get("X-TWO-Timestamp")}\n${h.get("X-TWO-Nonce")}\n${hash}`;
  expect(h.get("X-TWO-Signature")).toBe(
    `sha256=${createHmac("sha256", secret).update(canonical).digest("hex")}`,
  );
});

it.each(Object.values(move.results))("projects the mirrored $outcome result", async (result) => {
  const input = Response.json(success({ ...result, extra: "provider-text" }));
  const res = await botReply(input, result.outcome === "moved" ? target : source);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(success(result));
});

it.each(Object.values(move.refusals))("projects $status refusal", async ({ status, body }) => {
  const input = { ...body, error: { ...body.error, message: "provider-text" } };
  const res = await botReply(Response.json(input, { status, headers: { "Retry-After": "16" } }));
  expect(res.status).toBe(status);
  expect(res.headers.get("retry-after")).toBe(status === 429 ? "16" : null);
  expect(await res.json()).toEqual(body);
});

it("preserves a lease expiry refusal at handoff and requires a new request after renewal", async () => {
  const refused = {
    ok: false,
    request_id: "00000000000000000000000002",
    error: { code: "action_not_allowed", message: "request refused", retryable: false },
  };
  const returnMove = { ...move.request, channel_id: source };
  const effects: string[] = [];
  let receiverNow = 0;
  let leaseUntil = 1_000;
  let room = source;

  // The staging receiver owns the lease. The Web request carries no deadline.
  const receiveMove: typeof fetch = async (_url, init) => {
    if (receiverNow >= leaseUntil) {
      return Response.json(
        { ...refused, error: { ...refused.error, message: "synthetic receiver details" } },
        { status: 403, headers: { "Retry-After": "16" } },
      );
    }
    const { channel_id: destination } = JSON.parse(String(init?.body));
    const from = room;
    effects.push(destination);
    room = destination;
    return Response.json(success({ outcome: "moved", from_channel_id: from }));
  };
  outbound.mockImplementation(receiveMove);

  const before = await post();
  expect(before.status).toBe(200);
  expect(await before.json()).toEqual(success(move.results.moved));
  expect(effects).toEqual([target]);

  receiverNow = leaseUntil - 1;
  outbound.mockImplementationOnce((...request) => {
    receiverNow = leaseUntil;
    return receiveMove(...request);
  });
  const expired = await post({}, { channel_id: source });
  expect(expired.status).toBe(403);
  expect(expired.headers.get("cache-control")).toBe("no-store, private");
  expect(expired.headers.has("retry-after")).toBe(false);
  expect(await expired.json()).toEqual(refused);
  expect(outbound).toHaveBeenCalledTimes(2);
  expect(effects).toEqual([target]);

  leaseUntil += 1_000;
  const fresh = await post({}, { channel_id: source });
  expect(fresh.status).toBe(200);
  expect(await fresh.json()).toEqual(success({ outcome: "moved", from_channel_id: target }));
  expect(effects).toEqual([target, source]);
  expect(outbound.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    move.request,
    returnMove,
    returnMove,
  ]);
  const headers = outbound.mock.calls.map(([, init]) => new Headers(init?.headers));
  expect(headers.every((header) => !header.has("X-TWO-Voice-Move-Until"))).toBe(true);
  const nonces = headers.map((header) => header.get("X-TWO-Nonce"));
  expect(nonces).not.toContain(null);
  expect(new Set(nonces).size).toBe(3);
});

const { body: limited } = move.refusals.rate_limited;
const moved = success(move.results.moved);
it.each([
  Response.json({ ...limited, ok: "false" }, { status: 429 }),
  Response.json({ ...limited, error: { ...limited.error, retryable: undefined } }, { status: 429 }),
  Response.json(moved, { status: 502 }),
  Response.json({ ...moved, request_id: "provider text" }),
  Response.json(success({ outcome: "moved", from_channel_id: "100000000000000013" })),
  Response.json(moved, { headers: { "Idempotent-Replay": "true" } }),
  Response.redirect("https://elsewhere.example", 307),
  null,
])("leaves invalid Bot replies and transport loss unconfirmed (%#)", async (response) => {
  const res = await botReply(response);
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "bot_unavailable" });
});

it.each([null, "null", "https://elsewhere.example"])("refuses Origin %s", async (origin) => {
  expect((await post({}, undefined, cookie, origin)).status).toBe(403);
  expect(outbound).not.toHaveBeenCalled();
});

it.each([
  { STAGING_VOICE_MOVE_ENABLED: undefined },
  { STAGING_VOICE_MOVE_ENABLED: "false" },
  { APP_URL: "https://togetherweown.com" },
  { APP_URL: `${STAGING_APP_URL}/` },
  { STAGING_VOICE_MOVE_MEMBER_ID: QA_IDENTITIES["qa-member"]!.discordId },
  { BOT_ENDPOINT_URL: "https://two-bot-next.5150.workers.dev" },
])("keeps a disabled or misconfigured probe dark with %j", async (bind) => {
  const get = vi.spyOn(store, "get");
  expect((await post(bind)).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
  expect(outbound).not.toHaveBeenCalled();
});

it("refuses absent, unrelated and noncurrent dedicated sessions", async () => {
  for (const bearer of ["", await cookieFor(store, MODERATOR)]) {
    expect((await post({}, undefined, bearer)).status).toBe(403);
  }
  vi.spyOn(store, "getLive").mockResolvedValueOnce(null);
  const res = await post();
  expect(res.status).toBe(403);
  expect(res.headers.has("location")).toBe(false);
  expect(outbound).not.toHaveBeenCalled();
});

it("honors a current role refresh that removes the dedicated account's membership", async () => {
  now += SESSION_ROLE_RECHECK_SECONDS * 1000;
  outbound.mockResolvedValueOnce(Response.json({ code: 10007 }, { status: 404 }));
  expect((await post()).status).toBe(403);
  expect(outbound).toHaveBeenCalledTimes(1);
  expect(outbound.mock.calls[0]?.[0]).toContain(`/members/${memberId}`);
});

it("refuses member substitution and a target outside the fixture", async () => {
  const substitute = { channel_id: target, discord_id: MODERATOR.userId };
  expect((await post({}, substitute)).status).toBe(400);
  expect((await post({}, { channel_id: "100000000000000013" })).status).toBe(403);
  expect(outbound).not.toHaveBeenCalled();
});
