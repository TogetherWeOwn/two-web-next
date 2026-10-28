import { afterEach, describe, expect, it, vi } from "vitest";
import { addGuildMember, DiscordError, fetchUser } from "../src/discord";
import type { Env } from "../src/env";
import { fetchMemberRoles } from "../src/roles";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";

// Acceptance: Discord guild/user ids are charset-bound to the provider
// snowflake charset (ASCII digits) before any credentialed call, and member
// path segments cannot be reshaped by `/`, `?`, `#` or percent-encoded kin.
// Positive controls use realistic 18-digit snowflakes; the length of an
// all-digit id is deliberately unpinned (charset is the contract here), so a
// builder may accept any digit run or a bounded snowflake length.
// Inert fixtures only: no real OAuth grants or Discord credentials.
const GUILD = "2".repeat(18);
const USER = "3".repeat(18);
const ACCESS = "fixture-access";
const BOT = "fixture-bot";
const MEMBER_URL = `https://discord.com/api/v10/guilds/${GUILD}/members/${USER}`;

const HOSTILE_IDS: [string, string][] = [
  ["path separator", "111/222"],
  ["path traversal", "../111"],
  ["query opener", "111?admin=1"],
  ["fragment opener", "111#frag"],
  ["percent-encoded slash", "111%2f222"],
  ["percent-encoded traversal", "%2e%2e%2f111"],
  ["backslash", "111\\222"],
  ["authority separator", "111@222"],
  ["inner space", "111 222"],
  ["leading space", " 111222"],
  ["trailing space", "111222 "],
  ["newline", "111\n222"],
  ["trailing newline", "111222\n"],
  ["trailing carriage return", "111222\r"],
  ["trailing CRLF", "111222\r\n"],
  ["letters", "fixture-user"],
  ["alphanumeric mix", "123abc456"],
  ["minus sign", "-123"],
  ["plus sign", "+123"],
  ["decimal point", "123.5"],
  ["fullwidth digits", "１２３４５６"],
  ["empty", ""],
  ["whitespace only", "   "],
];

type Call = { url: string; method: string; authorization: string | null; body: unknown };

function recordingFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      authorization: headers.get("authorization"),
      body: init.body,
    };
    calls.push(call);
    return answer(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("addGuildMember id admission", () => {
  it.each(HOSTILE_IDS)(
    "fails closed with zero Discord requests for a guild id with %s",
    async (_label, guildId) => {
      const calls = recordingFetch(async () => new Response("{}", { status: 201 }));
      expect(await addGuildMember(guildId, USER, ACCESS, BOT)).toBe("failed");
      // Zero requests means no Authorization header (bot or user) is ever emitted.
      expect(calls).toEqual([]);
    },
  );

  it.each(HOSTILE_IDS)(
    "fails closed with zero Discord requests for a user id with %s",
    async (_label, userId) => {
      const calls = recordingFetch(async () => new Response("{}", { status: 201 }));
      expect(await addGuildMember(GUILD, userId, ACCESS, BOT)).toBe("failed");
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ["111/222/333", USER],
    [GUILD, "111/../../222"],
    [GUILD, `${USER}?access_token=other`],
    [`${GUILD}#`, USER],
  ])("never emits a reshaped member path for guild=%s user=%s", async (guildId, userId) => {
    const calls = recordingFetch(async () => new Response("{}", { status: 201 }));
    expect(await addGuildMember(guildId, userId, ACCESS, BOT)).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("PUTs the exact member URL with the live tokens on a 201", async () => {
    const calls = recordingFetch(async () => new Response("{}", { status: 201 }));
    expect(await addGuildMember(GUILD, USER, ACCESS, BOT)).toBe("joined");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MEMBER_URL);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.authorization).toBe(`Bot ${BOT}`);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ access_token: ACCESS });
  });

  it("PUTs the exact member URL on a 204 already-member answer", async () => {
    const calls = recordingFetch(async () => new Response(null, { status: 204 }));
    expect(await addGuildMember(GUILD, USER, ACCESS, BOT)).toBe("already_member");
    expect(calls.map((c) => c.url)).toEqual([MEMBER_URL]);
  });

  it.each([
    [400, "failed"],
    [401, "failed"],
    [404, "failed"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "provider_outage"],
  ] as const)(
    "keeps genuine Discord HTTP %i mapping to %s for valid ids",
    async (status, expected) => {
      const calls = recordingFetch(async () => new Response("{}", { status }));
      expect(await addGuildMember(GUILD, USER, ACCESS, BOT)).toBe(expected);
      // A genuine provider failure is reached exactly once: admission must not
      // turn a valid snowflake pair into a silent local refusal.
      expect(calls.map((c) => c.url)).toEqual([MEMBER_URL]);
    },
  );

  it("keeps a transport throw mapping to transport_failure for valid ids", async () => {
    recordingFetch(async () => {
      throw new Error("fixture transport failure");
    });
    expect(await addGuildMember(GUILD, USER, ACCESS, BOT)).toBe("transport_failure");
  });
});

describe("fetchMemberRoles id admission", () => {
  it.each(HOSTILE_IDS)(
    "returns null with zero Discord requests for a guild id with %s",
    async (_label, guildId) => {
      const calls = recordingFetch(async () => Response.json({ roles: [], joined_at: null }));
      expect(await fetchMemberRoles(guildId, USER, BOT)).toBeNull();
      expect(calls).toEqual([]);
    },
  );

  it.each(HOSTILE_IDS)(
    "returns null with zero Discord requests for a user id with %s",
    async (_label, userId) => {
      const calls = recordingFetch(async () => Response.json({ roles: [], joined_at: null }));
      expect(await fetchMemberRoles(GUILD, userId, BOT)).toBeNull();
      expect(calls).toEqual([]);
    },
  );

  it("GETs the exact member URL for valid ids", async () => {
    const role = "4".repeat(18);
    const calls = recordingFetch(async () =>
      Response.json({ roles: [role], joined_at: "2026-01-01T00:00:00.000Z" }),
    );
    expect(await fetchMemberRoles(GUILD, USER, BOT)).toEqual({
      roles: [role],
      joinedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MEMBER_URL);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.authorization).toBe(`Bot ${BOT}`);
  });

  it("keeps a genuine 404 mapping to null for valid ids", async () => {
    const calls = recordingFetch(async () => new Response("{}", { status: 404 }));
    expect(await fetchMemberRoles(GUILD, USER, BOT)).toBeNull();
    expect(calls.map((c) => c.url)).toEqual([MEMBER_URL]);
  });
});

describe("fetchUser provider id admission", () => {
  const identityWith = (id: unknown) =>
    Response.json({ id, username: "fixture-name", global_name: null, avatar: null });

  it.each(HOSTILE_IDS)(
    "rejects a provider identity whose id has %s as a provider rejection",
    async (_label, id) => {
      const calls = recordingFetch(async () => identityWith(id));
      const err = await fetchUser(ACCESS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiscordError);
      expect(err).toMatchObject({ step: "fetch_user", kind: "provider_reject" });
      // The only traffic is the identity read itself, on its exact URL.
      expect(calls.map((c) => c.url)).toEqual(["https://discord.com/api/v10/users/@me"]);
      expect(calls[0]!.authorization).toBe(`Bearer ${ACCESS}`);
    },
  );

  it.each([123, null, true, ["1"], { value: "1" }])(
    "still rejects a non-string provider id %j",
    async (id) => {
      recordingFetch(async () => identityWith(id));
      await expect(fetchUser(ACCESS)).rejects.toMatchObject({
        step: "fetch_user",
        kind: "provider_reject",
      });
    },
  );

  it("returns a snowflake provider identity unchanged", async () => {
    recordingFetch(async () => identityWith(USER));
    expect(await fetchUser(ACCESS)).toEqual({
      id: USER,
      username: "fixture-name",
      global_name: null,
      avatar: null,
    });
  });
});

describe("sign-in route with a hostile provider id", () => {
  function journeyEnv() {
    const store = createMemorySessionStore(() => Date.now());
    const sql = (async (strings: TemplateStringsArray) => {
      if ((strings[0] ?? "").includes("count(*)")) return [{ n: 0, wait: 1 }];
      return [];
    }) as unknown as Sql;
    const env = {
      APP_URL: "https://example.test",
      DISCORD_CLIENT_ID: "fixture-client",
      DISCORD_CLIENT_SECRET: "fixture-secret",
      DISCORD_GUILD_ID: GUILD,
      DISCORD_BOT_TOKEN: BOT,
      DISCORD_INVITE_URL: "https://discord.gg/fixture-invite",
      SESSION_SECRET: "fixture signing key ".repeat(3),
      DISCORD_MODERATOR_ROLE_IDS: "1".repeat(18),
      SESSION_STORE: store,
      JOIN_DEPS: { store: async () => withThrottleTx(sql) },
    };
    return env as Env;
  }

  const cookieHeader = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

  function discordTraffic(providerId: string) {
    return recordingFetch(async (call) => {
      if (call.url.endsWith("/oauth2/token")) return Response.json({ access_token: ACCESS });
      if (call.url.endsWith("/users/@me")) {
        return Response.json({
          id: providerId,
          username: "fixture-name",
          global_name: null,
          avatar: null,
        });
      }
      if (call.method === "PUT") return new Response(null, { status: 204 });
      return Response.json({ roles: [], joined_at: null });
    });
  }

  async function signIn(env: Env) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const start = await app.request("/auth/discord", {}, env);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    return app.request(
      `/auth/discord/callback?code=fixture-code&state=${state}`,
      { headers: { cookie: cookieHeader(start) } },
      env,
    );
  }

  it.each([
    ["path separator", "111/222"],
    ["query opener", "111?admin=1"],
    ["fragment opener", "111#frag"],
    ["percent-encoded slash", "111%2f222"],
    ["letters", "fixture-user"],
  ])("fails sign-in closed and stops after the identity read for an id with %s", async (_l, id) => {
    const calls = discordTraffic(id);
    const res = await signIn(journeyEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-two_session="))).toBe(false);
    // Token exchange + identity read only: no member PUT, no role lookup, so
    // neither the bot token nor the live access token travels on a path the
    // hostile id could have reshaped.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://discord.com/api/v10/oauth2/token",
      "GET https://discord.com/api/v10/users/@me",
    ]);
  });

  it("signs a snowflake identity in and PUTs the exact member URL", async () => {
    const calls = discordTraffic(USER);
    const res = await signIn(journeyEnv());
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-two_session="))).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(MEMBER_URL);
    expect(put?.authorization).toBe(`Bot ${BOT}`);
    expect(JSON.parse(String(put?.body))).toEqual({ access_token: ACCESS });
  });
});
