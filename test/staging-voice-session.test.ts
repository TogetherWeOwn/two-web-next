// route-inventory: POST /__probe/voice-move/session
import { serializeSigned } from "hono/utils/cookie";
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

const route = "/__probe/voice-move/session";
const memberId = "100000000000000701";
const otherId = "100000000000000702";
const channelIds = ["100000000000000703", "100000000000000704"] as const;
const claims = { discord_id: memberId, channel_ids: channelIds };
const version = { id: "12345678-1234-4321-8123-123456789abc", tag: "a".repeat(40) };
const start = Date.parse("2030-06-15T12:34:56.000Z");
const expiresAt = new Date(start + 3_600_000);
const member = {
  userId: memberId,
  member: true,
  moderator: false,
  username: "synthetic",
  avatar: null,
};
const outbound = vi.fn<typeof fetch>();
const throttleStore = vi.fn();
let store: ReturnType<typeof createMemorySessionStore>;
let signingKey: string;
let token: string;
let bearer: string;

async function signed(value: string, key = signingKey) {
  return (await serializeSigned(SESSION_COOKIE, value, key, { path: "/", secure: true })).split(
    ";",
  )[0]!;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  store = createMemorySessionStore();
  signingKey = newSessionToken();
  token = newSessionToken();
  await store.create({ ...member, expiresAt, tokenHash: await hashToken(token) });
  bearer = await signed(token);
  outbound.mockReset().mockRejectedValue(new Error("Unexpected external request"));
  throttleStore.mockReset();
  vi.stubGlobal("fetch", outbound);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Post = {
  bindings?: Partial<Env>;
  path?: string;
  origin?: string | null;
  headers?: Record<string, string>;
  body?: string;
};

async function post({
  bindings,
  path = route,
  origin = STAGING_APP_URL,
  headers,
  body = JSON.stringify(claims),
}: Post = {}) {
  const effects = [
    "create",
    "replace",
    "applyRoleRecheck",
    "renew",
    "rotate",
    "revoke",
    "revokeLineage",
    "revokeUserSessions",
    "sweepExpired",
  ] as const;
  const writes = effects.map((name) => vi.spyOn(store, name).mockClear());
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(origin === null ? {} : { origin }),
        cookie: bearer,
        ...headers,
      },
      body,
    },
    {
      APP_URL: STAGING_APP_URL,
      STAGING_VOICE_MOVE_ENABLED: "true",
      STAGING_VOICE_MOVE_MEMBER_ID: memberId,
      STAGING_VOICE_MOVE_CHANNEL_IDS: channelIds.join(","),
      CF_VERSION_METADATA: version,
      SESSION_SECRET: signingKey,
      SESSION_STORE: store,
      DISCORD_GUILD_ID: otherId,
      DISCORD_BOT_TOKEN: newSessionToken(),
      THROTTLE_STORE: throttleStore,
      ...bindings,
    },
  );
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(res.headers.has("set-cookie")).toBe(false);
  expect(res.headers.has("location")).toBe(false);
  expect(outbound).not.toHaveBeenCalled();
  expect(throttleStore).not.toHaveBeenCalled();
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  return res;
}

async function expectRefusal(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error: code, request_id: expect.any(String) });
}

it.each([
  { STAGING_VOICE_MOVE_ENABLED: undefined },
  { STAGING_VOICE_MOVE_ENABLED: "false" },
  { APP_URL: "https://togetherweown.com" },
  { APP_URL: `${STAGING_APP_URL}/` },
])("refuses a disabled or non-staging binding before a session read (%#)", async (bindings) => {
  const get = vi.spyOn(store, "get");
  const origin = new URL(bindings.APP_URL ?? STAGING_APP_URL).origin;
  await expectRefusal(await post({ bindings, origin }), 404, "not_found");
  expect(get).not.toHaveBeenCalled();
});

it("refuses a different request origin on the staging hostname", async () => {
  const get = vi.spyOn(store, "get");
  const path = `http://${new URL(STAGING_APP_URL).host}${route}`;
  await expectRefusal(await post({ path }), 404, "not_found");
  expect(get).not.toHaveBeenCalled();
});

it.each(["https://elsewhere.example", "null", null, `${STAGING_APP_URL}/`])(
  "refuses a missing or inexact Origin (%#)",
  async (origin) => {
    const get = vi.spyOn(store, "get");
    const headers = { "sec-fetch-site": "same-origin" };
    await expectRefusal(await post({ origin, headers }), 403, "cross_origin");
    expect(get).not.toHaveBeenCalled();
  },
);

it.each([
  { STAGING_VOICE_MOVE_MEMBER_ID: undefined },
  { STAGING_VOICE_MOVE_MEMBER_ID: "invalid" },
  { STAGING_VOICE_MOVE_MEMBER_ID: QA_IDENTITIES["qa-member"]!.discordId },
  { STAGING_VOICE_MOVE_CHANNEL_IDS: undefined },
  { STAGING_VOICE_MOVE_CHANNEL_IDS: channelIds[0] },
  { STAGING_VOICE_MOVE_CHANNEL_IDS: `${channelIds[0]},${channelIds[0]}` },
  { STAGING_VOICE_MOVE_CHANNEL_IDS: `${channelIds[0]},invalid` },
  { SESSION_SECRET: undefined },
  { CF_VERSION_METADATA: undefined },
  { CF_VERSION_METADATA: { id: version.id } },
  { CF_VERSION_METADATA: { tag: version.tag } },
  { CF_VERSION_METADATA: { ...version, id: "invalid" } },
  { CF_VERSION_METADATA: { ...version, tag: "invalid" } },
])("refuses incomplete fixture, signing or revision configuration (%#)", async (bindings) => {
  const get = vi.spyOn(store, "get");
  await expectRefusal(await post({ bindings }), 404, "not_found");
  expect(get).not.toHaveBeenCalled();
});

it.each(
  [
    null,
    [claims],
    { ...claims, extra: true },
    { ...claims, discord_id: 1 },
    { ...claims, channel_ids: channelIds.join(",") },
    { ...claims, channel_ids: [channelIds[0]] },
    { ...claims, channel_ids: [channelIds[0], "18446744073709551616"] },
  ].map((body) => ({ body })),
)("refuses a malformed assertion tuple (%#)", async ({ body }) => {
  const get = vi.spyOn(store, "get");
  await expectRefusal(await post({ body: JSON.stringify(body) }), 400, "invalid");
  expect(get).not.toHaveBeenCalled();
});

it.each([
  { ...claims, discord_id: otherId },
  { ...claims, channel_ids: [channelIds[0], otherId] },
  { ...claims, channel_ids: [channelIds[1], channelIds[0]] },
])("refuses mismatched or swapped assertions without selecting a session (%#)", async (claims) => {
  const get = vi.spyOn(store, "get");
  await expectRefusal(await post({ body: JSON.stringify(claims) }), 403, "forbidden");
  expect(get).not.toHaveBeenCalled();
});

it("refuses query input, a different media type, malformed JSON and oversized JSON", async () => {
  const get = vi.spyOn(store, "get");
  await expectRefusal(await post({ path: `${route}?extra=1` }), 400, "invalid");
  await expectRefusal(
    await post({ headers: { "content-type": "text/plain" } }),
    415,
    "unsupported_media_type",
  );
  await expectRefusal(await post({ body: "{" }), 400, "invalid");
  const body = JSON.stringify(claims).padEnd(BODY_LIMIT_BYTES.action + 1);
  const oversized = await post({ body });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ reason: "payload_too_large" });
  expect(get).not.toHaveBeenCalled();
});

it("refuses absent, unsigned, wrong-signature and wrongly shaped bearers before a store read", async () => {
  const get = vi.spyOn(store, "get");
  for (const cookie of [
    "",
    `${SESSION_COOKIE}=${token}`,
    await signed(token, newSessionToken()),
    await signed("invalid"),
  ]) {
    await expectRefusal(await post({ headers: { cookie } }), 403, "forbidden");
  }
  expect(get).not.toHaveBeenCalled();
});

it.each([{ userId: otherId }, { member: false }])(
  "refuses the wrong session principal or role (%#)",
  async (overrides) => {
    await store.create({ ...member, ...overrides, expiresAt, tokenHash: await hashToken(token) });
    await expectRefusal(await post(), 403, "forbidden");
  },
);

it("refuses membership exactly at the refresh deadline without refreshing", async () => {
  vi.setSystemTime(start + SESSION_ROLE_RECHECK_SECONDS * 1000);
  expect(await store.roleRecheckDue?.(await hashToken(token))).toBe(true);
  await expectRefusal(await post(), 403, "forbidden");
});

it("refuses a replaced bearer during predecessor grace", async () => {
  const hash = await hashToken(token);
  const replacement = { ...member, expiresAt, tokenHash: await hashToken(newSessionToken()) };
  expect(await store.rotate(hash, replacement)).toBe(true);
  expect(await store.get(hash)).toMatchObject({ member: true });
  await expectRefusal(await post(), 403, "forbidden");
});

it("refuses an expired bearer", async () => {
  vi.setSystemTime(expiresAt);
  await expectRefusal(await post(), 403, "forbidden");
});

it("refuses a bearer revoked between the initial and exact live reads", async () => {
  const get = store.get;
  const revoke = store.revoke;
  vi.spyOn(store, "get").mockImplementationOnce(async (hash) => {
    const row = await get(hash);
    await revoke(hash);
    return row;
  });
  await expectRefusal(await post(), 403, "forbidden");
});

it("returns exactly the bounded receipt with the observation time after the live read", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const getLive = store.getLive;
  vi.setSystemTime(start + SESSION_ROLE_RECHECK_SECONDS * 1000 - 2);
  vi.spyOn(store, "getLive").mockImplementationOnce(async (...args) => {
    const live = await getLive(...args);
    vi.setSystemTime(Date.now() + 1);
    return live;
  });
  const res = await post({ body: JSON.stringify(claims).padEnd(BODY_LIMIT_BYTES.action) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    matched: true,
    observed_at: "2030-06-15T12:39:55.999Z",
    revision: { version_id: version.id, commit: version.tag },
  });
  expect(log).toHaveBeenCalledTimes(1);
  const line = String(log.mock.calls[0]?.[0]);
  expect(JSON.parse(line)).toMatchObject({ event: "http.request", route, status: 200 });
  for (const privateValue of [memberId, ...channelIds, token, bearer, signingKey]) {
    expect(line.includes(privateValue)).toBe(false);
  }
});
