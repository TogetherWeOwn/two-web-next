// route-inventory: POST /__probe/voice-move
// route-inventory: POST /__probe/voice-move/session
import { createHash, createHmac } from "node:crypto";
import { parseSigned, serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Env } from "../src/env";
import { QA_IDENTITIES, STAGING_APP_URL } from "../src/qa";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  SESSION_ROLE_RECHECK_SECONDS,
} from "../src/sessions";
import app from "./app";
import contract from "./fixtures/bot-site-contract-v2.json";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

const move = contract.verbs["voice.move_member"];
const { discord_id: memberId, channel_id: target } = move.request;
const fixtureMember = { ...MEMBER, userId: memberId, avatar: null };
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
  cookie = await cookieFor(store, fixtureMember);
  outbound.mockReset().mockRejectedValue(new Error("fixture has no external network"));
  vi.stubGlobal("fetch", outbound);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function probeEnv(bind: Partial<Env>) {
  return {
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
}

function post(
  bind: Partial<Env> = {},
  body = { channel_id: target },
  bearer = cookie,
  origin?: string | null,
) {
  const bindings = probeEnv(bind);
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

const proofPath = "/__probe/voice-move/session";
const pins = { discord_id: memberId, channel_ids: [target, source] };
const version = { id: "12345678-1234-4321-8123-123456789abc", tag: "a".repeat(40) };
const throttleStore = vi.fn();
type ProofRequest = {
  bindings?: Partial<Env>;
  headers?: HeadersInit;
  path?: string;
  body?: string;
};

async function proof(request: ProofRequest = {}) {
  const bindings = {
    ...probeEnv({ CF_VERSION_METADATA: version, ...request.bindings }),
    THROTTLE_STORE: throttleStore.mockClear(),
  };
  const origin = new URL(bindings.APP_URL).origin;
  const headers = request.headers ?? { cookie, origin, "content-type": "application/json" };
  const writes = [
    "applyRoleRecheck",
    "create",
    "renew",
    "replace",
    "revoke",
    "revokeLineage",
    "revokeUserSessions",
    "rotate",
    "sweepExpired",
  ] as const;
  const spies = writes.map((method) => vi.spyOn(store, method).mockClear());
  const body = request.body ?? JSON.stringify(pins);
  const res = await app.request(
    request.path ?? proofPath,
    { method: "POST", headers, body },
    bindings,
  );
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(res.headers.has("set-cookie")).toBe(false);
  expect(outbound).not.toHaveBeenCalled();
  expect(throttleStore).not.toHaveBeenCalled();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  return res;
}

async function refuses(status: number, error: string, request?: ProofRequest) {
  const res = await proof(request);
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error, request_id: expect.any(String) });
}

it.each<Partial<Env>>([
  { STAGING_VOICE_MOVE_ENABLED: undefined },
  { APP_URL: "https://togetherweown.com" },
  { STAGING_VOICE_MOVE_MEMBER_ID: QA_IDENTITIES["qa-member"]!.discordId },
  { STAGING_VOICE_MOVE_CHANNEL_IDS: `${target},${target}` },
  { CF_VERSION_METADATA: { id: version.id } },
  { CF_VERSION_METADATA: { ...version, id: "invalid" } },
])("refuses disabled, production or incomplete configuration (%#)", async (bindings) => {
  const get = vi.spyOn(store, "get");
  await refuses(404, "not_found", { bindings });
  expect(get).not.toHaveBeenCalled();
});

it("requires both an exact staging request URL and explicit same-origin Origin", async () => {
  await refuses(404, "not_found", { path: `http://${new URL(STAGING_APP_URL).host}${proofPath}` });
  for (const origin of ["https://elsewhere.example", null]) {
    const headers = new Headers({ accept: "application/json", "sec-fetch-site": "same-origin" });
    if (origin !== null) headers.set("origin", origin);
    await refuses(403, "cross_origin", { headers });
  }
});

it.each([
  { ...pins, extra: true },
  { ...pins, discord_id: 1 },
  { ...pins, channel_ids: [target] },
  { ...pins, channel_ids: [target, "18446744073709551616"] },
])("refuses malformed assertions (%#)", (body) =>
  refuses(400, "invalid", { body: JSON.stringify(body) }),
);

it.each([
  { ...pins, discord_id: MODERATOR.userId },
  { ...pins, channel_ids: [target, MODERATOR.userId] },
  { ...pins, channel_ids: [source, target] },
])("refuses mismatched or reordered assertions before session lookup (%#)", async (body) => {
  const get = vi.spyOn(store, "get");
  await refuses(403, "forbidden", { body: JSON.stringify(body) });
  expect(get).not.toHaveBeenCalled();
});

it("refuses query input, a different media type, malformed JSON and an oversized upload", async () => {
  await refuses(400, "invalid", { path: `${proofPath}?extra=1` });
  await refuses(415, "unsupported_media_type", { headers: { origin: STAGING_APP_URL } });
  await refuses(400, "invalid", { body: "{" });
  const res = await proof({ body: JSON.stringify(pins).padEnd(BODY_LIMIT_BYTES.action + 1) });
  expect(res.status).toBe(413);
});

async function tokenInCookie() {
  const token = (await parseSigned(cookie, env.SESSION_SECRET))[SESSION_COOKIE];
  if (!token) throw new Error("Synthetic bearer missing");
  return token;
}

it("refuses absent, incorrectly signed, unrelated and nonmember bearers", async () => {
  const forged = await serializeSigned(SESSION_COOKIE, await tokenInCookie(), newSessionToken(), {
    secure: true,
    path: "/",
  });
  const outsider = await cookieFor(store, { ...fixtureMember, member: false });
  for (const cookie of ["", forged.split(";")[0]!, await cookieFor(store, MODERATOR), outsider]) {
    const headers = { cookie, origin: STAGING_APP_URL, "content-type": "application/json" };
    await refuses(403, "forbidden", { headers });
  }
});

it("refuses stale membership at the exact refresh deadline and after bearer expiry", async () => {
  const hash = await hashToken(await tokenInCookie());
  now += SESSION_ROLE_RECHECK_SECONDS * 1000;
  await refuses(403, "forbidden");
  await store.create({ ...fixtureMember, tokenHash: hash, expiresAt: new Date(now) });
  await refuses(403, "forbidden");
});

it("refuses a replaced bearer within predecessor grace", async () => {
  const hash = await hashToken(await tokenInCookie());
  const replacement = {
    ...fixtureMember,
    tokenHash: await hashToken(newSessionToken()),
    expiresAt: new Date(now + 3600_000),
  };
  expect(await store.rotate(hash, replacement)).toBe(true);
  expect(await store.get(hash)).toMatchObject({ member: true });
  await refuses(403, "forbidden");
});

it("refuses a bearer revoked between the initial and exact live reads", async () => {
  const { get, revoke } = store;
  vi.spyOn(store, "get").mockImplementationOnce(async (hash) => {
    const row = await get(hash);
    await revoke(hash);
    return row;
  });
  await refuses(403, "forbidden");
});

it("returns the exact bounded receipt after the live read and logs no private values", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const observedAt = new Date("2030-06-15T12:39:55.999Z");
  const getLive = store.getLive;
  vi.spyOn(store, "getLive").mockImplementationOnce(async (...args) => {
    const live = await getLive(...args);
    vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(observedAt);
    return live;
  });
  const res = await proof({ body: JSON.stringify(pins).padEnd(BODY_LIMIT_BYTES.action) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    matched: true,
    observed_at: observedAt.toISOString(),
    revision: { version_id: version.id, commit: version.tag },
  });
  expect(log).toHaveBeenCalledTimes(1);
  const line = String(log.mock.calls[0]?.[0]);
  expect(JSON.parse(line)).toMatchObject({ event: "http.request", route: proofPath, status: 200 });
  for (const privateValue of [memberId, target, source, cookie, env.SESSION_SECRET]) {
    expect(line.includes(privateValue)).toBe(false);
  }
});
