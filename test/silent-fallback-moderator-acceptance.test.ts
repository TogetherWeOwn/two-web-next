// Acceptance contract: transport-throw moderator degrade warns (X3 leg D).
//
// Acceptance-owned: the Builder builds on this branch and never edits this file.
// Failing-first: the two transport tests run RED on main (recomputeModerator
// swallows transport rejections in .catch(() => null) with no line) and go
// green when the build lands. The silence + flag controls already pass and
// must keep passing.
//
// Contract for the Builder (exact console.warn line, fired once per degrade):
//   "moderator recompute lookup transport failed" { exception, guild_id }
// Sibling-row precedent (src/roles.ts non-OK / non-JSON warns): class-only
// exception plus guild_id, never the member user id, role list or bot
// credential. Flag behavior is unchanged: a transport failure still degrades
// to a non-moderator false; only the distinguishing line is new. Whether the
// warn lives in the recomputeModerator catch or inside fetchMemberRoles is
// the Builder's choice, but exactly one line fires per degraded lookup: this
// file pins only the recomputeModerator contract, never the intermediate
// fetchMemberRoles throw shape.
//
// Hermetic: stubbed fetch transport, synthetic snowflakes, no network, no
// live Discord.
import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordHttpTimeoutError } from "../src/discord-http";
import { recomputeModerator } from "../src/roles";

const GUILD = "111111111111111111";
const USER_ID = "222222222222222222";
const BOT_TOKEN = "***synthetic-transport-warn-bot-token***";
const ROLE_ID = "123456789012345678";
const TRANSPORT_WARN = "moderator recompute lookup transport failed";

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
    expect(output).not.toContain(ROLE_ID);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

function warns() {
  return diagnostics.filter((d) => d.level === "warn");
}

function opts() {
  return { guildId: GUILD, userId: USER_ID, botToken: BOT_TOKEN, moderatorRoleIds: [ROLE_ID] };
}

describe("transport-throw moderator degrade warns (failing-first)", () => {
  it("transport rejection warns once with class + guild and still degrades", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("private transport moderator-transport-marker")),
    );
    await expect(recomputeModerator(opts())).resolves.toBe(false);
    const entries = warns();
    expect(entries).toHaveLength(1);
    const [message, payload, ...rest] = entries[0]!.args;
    expect(message).toBe(TRANSPORT_WARN);
    expect(rest).toEqual([]);
    expect(payload).toEqual(expect.objectContaining({ exception: "Error", guild_id: GUILD }));
    expect(payload).not.toHaveProperty("userId");
    expect(payload).not.toHaveProperty("user_id");
    expect(payload).not.toHaveProperty("roles");
    const logged = format(payload);
    expect(logged).not.toContain("moderator-transport-marker");
    expect(logged).not.toContain("private transport");
  });

  it("Discord budget timeout warns once with a bounded timeout class", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DiscordHttpTimeoutError()));
    await expect(recomputeModerator(opts())).resolves.toBe(false);
    const entries = warns();
    expect(entries).toHaveLength(1);
    const [message, payload, ...rest] = entries[0]!.args;
    expect(message).toBe(TRANSPORT_WARN);
    expect(rest).toEqual([]);
    const fields = payload as { exception?: unknown; guild_id?: unknown };
    expect(fields.guild_id).toBe(GUILD);
    expect(typeof fields.exception).toBe("string");
    expect(fields.exception as string).toContain("Timeout");
    const logged = format(payload);
    expect(logged).not.toContain("timed out");
  });
});

describe("moderator silence + flag stability", () => {
  it("404 still degrades with no warning at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(recomputeModerator(opts())).resolves.toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it("blank allowlist still denies without fetching or warning", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("must not fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(recomputeModerator({ ...opts(), moderatorRoleIds: [] })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });

  it("blank bot token still denies without fetching or warning", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("must not fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(recomputeModerator({ ...opts(), botToken: "  " })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });

  it("matching role still grants with no warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ roles: [ROLE_ID], joined_at: null })),
    );
    await expect(recomputeModerator(opts())).resolves.toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("answered non-OK keeps its existing line, with no second transport line", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    await expect(recomputeModerator(opts())).resolves.toBe(false);
    const entries = warns();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args[0]).toBe("moderator recompute lookup failed");
    expect(entries[0]!.args[1]).toEqual(expect.objectContaining({ status: 500, guild_id: GUILD }));
  });

  it("answered non-JSON keeps its existing line, with no second transport line", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON", { status: 200 })));
    await expect(recomputeModerator(opts())).resolves.toBe(false);
    const entries = warns();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args[0]).toBe("moderator recompute lookup returned non-JSON");
    expect(entries[0]!.args[1]).toEqual(expect.objectContaining({ guild_id: GUILD }));
  });
});
