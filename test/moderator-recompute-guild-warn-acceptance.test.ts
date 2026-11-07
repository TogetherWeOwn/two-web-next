import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMemberRoles, recomputeModerator } from "../src/roles";

// Synthetic fixtures only: no deployment bindings, sessions or live Discord calls.
// Acceptance contract: both moderator-recompute lookup warnings carry the guild
// under test as `guild_id` (the guildId argument), alongside any existing fields,
// and never log the userId (a Discord ID is member data).
const GUILD_A = "111111111111111111";
const GUILD_B = "333333333333333333";
const USER_ID = "222222222222222222";
const OTHER_USER_ID = "444444444444444444";
const BOT_TOKEN = "***synthetic-guild-warn-bot-token***";
const ROLE_ID = "123456789012345678";

let diagnostics: { level: string; args: unknown[] }[];

beforeEach(() => {
  diagnostics = [];
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      diagnostics.push({ level, args });
    });
  }
  // A forgotten stub must reject, never fall through to the network.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected role lookup")));
});

afterEach(() => {
  try {
    // format also renders Error messages/causes, unlike JSON.stringify(Error).
    const output = diagnostics.map(({ level, args }) => `${level}: ${format(...args)}`).join("\n");
    expect(output).not.toContain(BOT_TOKEN);
    expect(output).not.toContain(USER_ID);
    expect(output).not.toContain(OTHER_USER_ID);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

function stubResponse(response: Response) {
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function warns() {
  return diagnostics.filter((d) => d.level === "warn");
}

function expectSingleGuildWarn(message: string, guildId: string, extra: Record<string, unknown>) {
  const entries = warns();
  expect(entries).toHaveLength(1);
  const [first, payload, ...rest] = entries[0]!.args;
  expect(first).toBe(message);
  expect(rest).toEqual([]);
  expect(payload).toEqual(expect.objectContaining({ guild_id: guildId, ...extra }));
  // The member identifier must not appear under any key, in any shape.
  expect(payload).not.toHaveProperty("userId");
  expect(payload).not.toHaveProperty("user_id");
  expect(payload).not.toHaveProperty("user");
  expect(payload).not.toHaveProperty("id");
  expect(format(payload)).not.toContain(USER_ID);
  expect(format(payload)).not.toContain(OTHER_USER_ID);
}

describe("moderator recompute lookup warnings carry the guild under test", () => {
  it.each([GUILD_A, GUILD_B])(
    "non-OK lookup warns with guild_id %s alongside the existing status, and fails closed",
    async (guildId) => {
      const fetch = stubResponse(new Response("{}", { status: 500 }));
      await expect(fetchMemberRoles(guildId, USER_ID, BOT_TOKEN)).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        `https://discord.com/api/v10/guilds/${guildId}/members/${USER_ID}`,
        {
          headers: { authorization: `Bot ${BOT_TOKEN}` },
          signal: expect.any(AbortSignal),
        },
      );
      expectSingleGuildWarn("moderator recompute lookup failed", guildId, { status: 500 });
    },
  );

  it.each([401, 403, 429, 503])(
    "non-OK status %i warns with guild_id alongside that status",
    async (status) => {
      stubResponse(new Response("{}", { status }));
      await expect(fetchMemberRoles(GUILD_A, USER_ID, BOT_TOKEN)).resolves.toBeNull();
      expectSingleGuildWarn("moderator recompute lookup failed", GUILD_A, { status });
    },
  );

  it.each([GUILD_A, GUILD_B])(
    "non-JSON lookup warns with guild_id %s, and fails closed",
    async (guildId) => {
      const fetch = stubResponse(new Response("not JSON", { status: 200 }));
      await expect(fetchMemberRoles(guildId, USER_ID, BOT_TOKEN)).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        `https://discord.com/api/v10/guilds/${guildId}/members/${USER_ID}`,
        {
          headers: { authorization: `Bot ${BOT_TOKEN}` },
          signal: expect.any(AbortSignal),
        },
      );
      expectSingleGuildWarn("moderator recompute lookup returned non-JSON", guildId, {});
    },
  );

  it("non-JSON warning carries the guild of the call, not a neighbouring member id", async () => {
    stubResponse(new Response("not JSON", { status: 200 }));
    await expect(fetchMemberRoles(GUILD_B, OTHER_USER_ID, BOT_TOKEN)).resolves.toBeNull();
    expectSingleGuildWarn("moderator recompute lookup returned non-JSON", GUILD_B, {});
  });

  it("guild_id is taken from the argument, so two calls in sequence report their own guilds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response("not JSON", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchMemberRoles(GUILD_A, USER_ID, BOT_TOKEN)).resolves.toBeNull();
    await expect(fetchMemberRoles(GUILD_B, USER_ID, BOT_TOKEN)).resolves.toBeNull();
    const entries = warns();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.args[0]).toBe("moderator recompute lookup failed");
    expect(entries[0]!.args[1]).toEqual(
      expect.objectContaining({ guild_id: GUILD_A, status: 500 }),
    );
    expect(entries[1]!.args[0]).toBe("moderator recompute lookup returned non-JSON");
    expect(entries[1]!.args[1]).toEqual(expect.objectContaining({ guild_id: GUILD_B }));
  });
});

describe("positive controls: unchanged behaviour around the warnings", () => {
  it("404 (Unknown Member, code 10007) still returns null with no warning at all", async () => {
    stubResponse(
      new Response(JSON.stringify({ message: "Unknown Member", code: 10007 }), { status: 404 }),
    );
    await expect(fetchMemberRoles(GUILD_A, USER_ID, BOT_TOKEN)).resolves.toBeNull();
    expect(diagnostics).toEqual([]);
  });

  it("a valid member payload still returns roles and joinedAt with no warning", async () => {
    stubResponse(
      Response.json({ roles: [ROLE_ID, 42, null], joined_at: "2024-01-02T03:04:05.000Z" }),
    );
    await expect(fetchMemberRoles(GUILD_A, USER_ID, BOT_TOKEN)).resolves.toEqual({
      roles: [ROLE_ID],
      joinedAt: "2024-01-02T03:04:05.000Z",
    });
    expect(diagnostics).toEqual([]);
  });

  it("a blank bot token still fails closed without fetching or warning", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("must not fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchMemberRoles(GUILD_A, USER_ID, "  ")).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });

  it("recomputeModerator still denies on a failed lookup (fail-closed semantics unchanged)", async () => {
    stubResponse(new Response("{}", { status: 500 }));
    await expect(
      recomputeModerator({
        guildId: GUILD_A,
        userId: USER_ID,
        botToken: BOT_TOKEN,
        moderatorRoleIds: [ROLE_ID],
      }),
    ).resolves.toBe(false);
  });

  it("recomputeModerator still grants on a matching role with no warning", async () => {
    stubResponse(Response.json({ roles: [ROLE_ID], joined_at: null }));
    await expect(
      recomputeModerator({
        guildId: GUILD_A,
        userId: USER_ID,
        botToken: BOT_TOKEN,
        moderatorRoleIds: [ROLE_ID],
      }),
    ).resolves.toBe(true);
    expect(diagnostics).toEqual([]);
  });
});
