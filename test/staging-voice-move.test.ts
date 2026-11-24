// route-inventory: POST /__probe/voice-move
import { createHash, createHmac } from "node:crypto";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const move = contract.verbs["voice.move_member"];
const memberId = move.request.discord_id;
const destination = move.request.channel_id;
const otherChannel = move.results.moved.from_channel_id;
const botUrl = "https://two-bot-next-staging.5150.workers.dev";
const sessionSecret = "fixture-session-key-for-staging-voice-move";
const botSecret = "fixture-hmac-key-for-staging-voice-move";
const path = "/__probe/voice-move";
const validBody = JSON.stringify({ channel_id: destination });
const requestId = move.refusals.discord_unavailable.body.request_id;
const success = (result: unknown) => ({ ok: true, request_id: requestId, result });

function fixture() {
  let now = Date.now();
  const store = createMemorySessionStore(() => now);
  const get = vi.spyOn(store, "get");
  const throttle = vi.fn(async () => null);
  const env = {
    APP_URL: STAGING_APP_URL,
    SESSION_SECRET: sessionSecret,
    SESSION_STORE: store,
    THROTTLE_STORE: throttle,
    STAGING_VOICE_MOVE_ENABLED: "true",
    STAGING_VOICE_MOVE_MEMBER_ID: memberId,
    STAGING_VOICE_MOVE_CHANNEL_IDS: `${destination},${otherChannel}`,
    BOT_ENDPOINT_URL: botUrl,
    BOT_SHARED_SECRET: botSecret,
    BOT_KEY_ID: "voice-fixture",
  } satisfies Partial<Env> & Record<string, unknown>;
  async function session(userId = memberId, member = true, moderator = false, expired = false) {
    const token = newSessionToken();
    const row = {
      tokenHash: await hashToken(token),
      userId,
      username: "synthetic fixture",
      avatar: null,
      member,
      moderator,
      expiresAt: new Date(Date.now() + (expired ? -60_000 : 3600_000)),
    };
    await store.create(row);
    const cookie = (
      await serializeSigned(SESSION_COOKIE, token, sessionSecret, { secure: true, path: "/" })
    ).split(";")[0]!;
    return { cookie, row };
  }
  function post(
    cookie?: string,
    {
      body = validBody,
      bind = {},
      url = path,
      headers = {},
    }: {
      body?: string;
      bind?: Partial<Env>;
      url?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const bindings = { ...env, ...bind } as unknown as Env;
    return app.request(
      url,
      {
        method: "POST",
        body,
        headers: {
          origin: bindings.APP_URL,
          "content-type": "application/json",
          accept: "application/json",
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
      },
      bindings,
    );
  }
  const ageRoles = () => {
    now += SESSION_ROLE_RECHECK_SECONDS * 1000;
  };
  return { store, get, throttle, session, post, ageRoles };
}

const outbound = vi.fn<typeof fetch>();
beforeEach(() => {
  outbound.mockReset().mockRejectedValue(new Error("fixture has no external network"));
  vi.stubGlobal("fetch", outbound);
});
afterEach(() => vi.unstubAllGlobals());

describe("protected staging voice self-move", () => {
  it("signs the mirrored keyless request once with the current member session's identity", async () => {
    const f = fixture();
    const { cookie } = await f.session();
    const envelope = success(move.results.moved);
    outbound.mockResolvedValueOnce(Response.json(envelope));
    const res = await f.post(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(await res.json()).toEqual(envelope);
    expect(outbound).toHaveBeenCalledTimes(1);
    const [url, init] = outbound.mock.calls[0]!;
    expect(url).toBe(`${botUrl}/internal/actions`);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("X-TWO-Key-Id")).toBe("voice-fixture");
    expect(headers.get("X-TWO-Timestamp")).toMatch(/^\d+$/);
    expect(headers.get("X-TWO-Nonce")).toMatch(/^[0-9a-f]{32}$/);
    expect(headers.has("Idempotency-Key")).toBe(false);
    expect(headers.has("Cookie")).toBe(false);
    const body = String(init?.body);
    expect(body).toBe(JSON.stringify(move.request));
    const hash = createHash("sha256").update(body).digest("hex");
    const canonical = `POST\n/internal/actions\n${headers.get("X-TWO-Timestamp")}\n${headers.get("X-TWO-Nonce")}\n${hash}`;
    expect(headers.get("X-TWO-Signature")).toBe(
      `sha256=${createHmac("sha256", botSecret).update(canonical).digest("hex")}`,
    );
  });

  it.each(Object.values(move.results))("projects the mirrored $outcome result", async (result) => {
    const f = fixture();
    const { cookie } = await f.session();
    const channel = result.outcome === "moved" ? destination : otherChannel;
    outbound.mockResolvedValueOnce(Response.json(success({ ...result, extra: "provider-text" })));
    const res = await f.post(cookie, { body: JSON.stringify({ channel_id: channel }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(success(result));
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it.each(Object.values(move.refusals))(
    "projects the mirrored $status refusal",
    async ({ status, body }) => {
      const f = fixture();
      const { cookie } = await f.session();
      outbound.mockResolvedValueOnce(
        Response.json(body, { status, headers: { "retry-after": "16" } }),
      );
      const res = await f.post(cookie);
      expect(res.status).toBe(status);
      expect(res.headers.get("retry-after")).toBe(status === 429 ? "16" : null);
      expect(await res.json()).toEqual(body);
      expect(outbound).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a closed refusal for Bot's disabled action", async () => {
    const f = fixture();
    const { cookie } = await f.session();
    const envelope = {
      ok: false,
      request_id: requestId,
      error: { code: "action_not_allowed", message: "request refused", retryable: false },
    };
    outbound.mockResolvedValueOnce(
      Response.json(
        {
          ...envelope,
          error: { ...envelope.error, message: "provider-text" },
        },
        { status: 403 },
      ),
    );
    const res = await f.post(cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(envelope);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it.each([
    [200, success({ outcome: "moved" })],
    [200, success({ outcome: "moved", from_channel_id: "100000000000000013" })],
    [200, success({ outcome: "provider-text" })],
    [200, { ...success(move.results.moved), request_id: "provider-text" }],
    [502, success(move.results.moved)],
    [403, { ok: false, request_id: requestId, error: { code: "provider-text" } }],
  ] as const)("keeps unconfirmed or invalid Bot replies generic (%s)", async (status, body) => {
    const f = fixture();
    const { cookie } = await f.session();
    outbound.mockResolvedValueOnce(Response.json(body, { status }));
    const res = await f.post(cookie);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "bot_unavailable" });
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("returns an unconfirmed result on transport loss without retrying", async () => {
    const f = fixture();
    const { cookie } = await f.session();
    const res = await f.post(cookie);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "bot_unavailable" });
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "false", "TRUE", "true "])(
    "flag %s stays off before any reads or dispatch",
    async (flag) => {
      const f = fixture();
      const { cookie } = await f.session();
      expect((await f.post(cookie, { bind: { STAGING_VOICE_MOVE_ENABLED: flag } })).status).toBe(
        404,
      );
      expect(f.get).not.toHaveBeenCalled();
      expect(f.throttle).not.toHaveBeenCalled();
      expect(outbound).not.toHaveBeenCalled();
    },
  );

  it.each(["https://togetherweown.com", "http://next.togetherweown.com"])(
    "refuses non-staging origins %s even with complete bindings",
    async (APP_URL) => {
      const f = fixture();
      const { cookie } = await f.session();
      expect((await f.post(cookie, { bind: { APP_URL } })).status).toBe(404);
      expect(f.get).not.toHaveBeenCalled();
      expect(outbound).not.toHaveBeenCalled();
    },
  );

  it("requires the staging request origin and an explicit same-origin header", async () => {
    const f = fixture();
    const { cookie } = await f.session();
    expect((await f.post(cookie, { url: `http://next.togetherweown.com${path}` })).status).toBe(
      404,
    );
    expect((await f.post(cookie, { headers: { origin: "null" } })).status).toBe(403);
    expect(f.get).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("refuses absent, unrelated, expired, unauthorized and predecessor sessions", async () => {
    const f = fixture();
    const predecessor = await f.session();
    expect(
      await f.store.rotate(predecessor.row.tokenHash, {
        ...predecessor.row,
        tokenHash: await hashToken(newSessionToken()),
      }),
    ).toBe(true);
    // Prove the previous bearer is still inside read grace.
    expect(await f.store.get(predecessor.row.tokenHash)).not.toBeNull();
    for (const cookie of [
      undefined,
      "invalid",
      predecessor.cookie,
      (await f.session("100000000000000002", true, true)).cookie,
      (await f.session(memberId, false, true)).cookie,
      (await f.session(memberId, true, false, true)).cookie,
    ])
      expect((await f.post(cookie)).status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("honors a current role refresh that removes the dedicated account's membership", async () => {
    const f = fixture();
    const { cookie } = await f.session();
    const guildId = "100000000000000015";
    f.ageRoles();
    outbound.mockResolvedValueOnce(Response.json({ code: 10007 }, { status: 404 }));
    const res = await f.post(cookie, {
      bind: { DISCORD_GUILD_ID: guildId, DISCORD_BOT_TOKEN: "fixture-discord-token" },
    });
    expect(res.status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound.mock.calls[0]?.[0]).toBe(
      `https://discord.com/api/v10/guilds/${guildId}/members/${memberId}`,
    );
  });

  it.each([
    { STAGING_VOICE_MOVE_MEMBER_ID: QA_IDENTITIES["qa-member"]!.discordId },
    { STAGING_VOICE_MOVE_CHANNEL_IDS: `${destination},${destination}` },
    { STAGING_VOICE_MOVE_CHANNEL_IDS: `${destination},18446744073709551616` },
    { BOT_ENDPOINT_URL: "https://two-bot-next.5150.workers.dev" },
    { BOT_SHARED_SECRET: undefined },
  ])(
    "requires the dedicated fixture and pinned staging Bot before session lookup",
    async (bind) => {
      const f = fixture();
      const { cookie } = await f.session(bind.STAGING_VOICE_MOVE_MEMBER_ID ?? memberId);
      expect((await f.post(cookie, { bind })).status).toBe(404);
      expect(f.get).not.toHaveBeenCalled();
      expect(outbound).not.toHaveBeenCalled();
    },
  );

  it("refuses a supplied member, an outside room, malformed JSON and oversized input", async () => {
    const f = fixture();
    const { cookie } = await f.session();
    for (const [body, status] of [
      [JSON.stringify({ channel_id: destination, discord_id: "100000000000000002" }), 400],
      [JSON.stringify({ channel_id: "100000000000000013" }), 403],
      ["{", 400],
      ["x".repeat(BODY_LIMIT_BYTES.action + 1), 413],
    ] as const)
      expect((await f.post(cookie, { body })).status).toBe(status);
    expect((await f.post(cookie, { url: `${path}?discord_id=100000000000000002` })).status).toBe(
      400,
    );
    expect((await f.post(cookie, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(outbound).not.toHaveBeenCalled();
  });
});
