import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recomputeModerator } from "../src/roles";

// Synthetic fixtures only: no deployment bindings, sessions or live Discord calls.
const ROLE_ID = "123456789012345";
const OTHER_ROLE_ID = "123456789012346";
const BOT_TOKEN = "***synthetic-role-bot-token***";
const PAYLOAD = "***synthetic-role-payload***";
const opts = {
  guildId: "100000000000000001",
  userId: "100000000000000002",
  botToken: BOT_TOKEN,
  moderatorRoleIds: [ROLE_ID],
};
const memberUrl = `https://discord.com/api/v10/guilds/${opts.guildId}/members/${opts.userId}`;
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
    expect(output).not.toContain(PAYLOAD);
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

function expectLookup(fetch: ReturnType<typeof vi.fn>) {
  expect(fetch).toHaveBeenCalledTimes(1);
  // The bounded-lookup helper (TOG-11463) arms every call with an abort signal.
  expect(fetch).toHaveBeenCalledWith(memberUrl, {
    headers: { authorization: `Bot ${BOT_TOKEN}` },
    signal: expect.any(AbortSignal),
  });
}

const malformedEnvelopes: [string, unknown][] = [
  ["null", null],
  ["empty array", []],
  ["top-level role array", [ROLE_ID, PAYLOAD]],
  ["string scalar", BOT_TOKEN],
  ["number scalar", Number(ROLE_ID)],
  ["boolean scalar", true],
  ["missing roles", { diagnostic: PAYLOAD }],
  ["null roles", { roles: null, diagnostic: PAYLOAD }],
  ["string roles", { roles: ROLE_ID, diagnostic: PAYLOAD }],
  ["number roles", { roles: Number(ROLE_ID), diagnostic: PAYLOAD }],
  ["boolean roles", { roles: true, diagnostic: PAYLOAD }],
  ["object roles", { roles: { id: ROLE_ID }, diagnostic: PAYLOAD }],
  ["nested role arrays", { roles: [[ROLE_ID]], diagnostic: PAYLOAD }],
];

describe("moderator recompute contains malformed successful Discord responses", () => {
  it.each(malformedEnvelopes)("settles false for HTTP-200 %s", async (_name, body) => {
    const fetch = stubResponse(Response.json(body));
    // In particular, the helper's null-body throw is contained by this boundary.
    await expect(recomputeModerator(opts)).resolves.toBe(false);
    expectLookup(fetch);
    expect(diagnostics).toEqual([]);
  });

  it("settles false for malformed JSON without logging the raw body", async () => {
    const fetch = stubResponse(new Response(`not JSON ${PAYLOAD} ${BOT_TOKEN}`, { status: 200 }));
    await expect(recomputeModerator(opts)).resolves.toBe(false);
    expectLookup(fetch);
    expect(diagnostics).toEqual([
      { level: "warn", args: ["moderator recompute lookup returned non-JSON"] },
    ]);
  });

  it("settles false when JSON body reading rejects with token-bearing errors", async () => {
    // The bounded lookup (TOG-11463) consumes the body stream itself, so the
    // injection point is a body that errors after a valid prefix — the token-
    // bearing error must stay contained and read exactly like non-JSON.
    const payload = new TextEncoder().encode(JSON.stringify({ roles: [ROLE_ID] }));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(payload);
          c.error(new Error(`body read ${BOT_TOKEN}`, { cause: new Error(PAYLOAD) }));
        },
      }),
    );
    const fetch = stubResponse(response);
    await expect(recomputeModerator(opts)).resolves.toBe(false);
    expectLookup(fetch);
    expect(diagnostics).toEqual([
      { level: "warn", args: ["moderator recompute lookup returned non-JSON"] },
    ]);
  });

  it("settles false when the provider fetch rejects without logging the exception", async () => {
    const fetch = vi.fn().mockRejectedValue(
      new TypeError(`request ${BOT_TOKEN}`, {
        cause: new Error(PAYLOAD),
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(recomputeModerator(opts)).resolves.toBe(false);
    expectLookup(fetch);
    expect(diagnostics).toEqual([]);
  });

  it.each([401, 403, 404, 429, 500, 503])(
    "HTTP %i denies even a body claiming the allowed role",
    async (status) => {
      const response = Response.json(
        { roles: [ROLE_ID], diagnostic: `${PAYLOAD} ${BOT_TOKEN}` },
        { status },
      );
      const json = vi.spyOn(response, "json");
      const fetch = stubResponse(response);
      await expect(recomputeModerator(opts)).resolves.toBe(false);
      expectLookup(fetch);
      expect(json).not.toHaveBeenCalled();
      expect(diagnostics).toEqual(
        status === 404
          ? []
          : [{ level: "warn", args: ["moderator recompute lookup failed", { status }] }],
      );
    },
  );
});

describe("moderator recompute preserves string-role intersection semantics", () => {
  it.each([
    ["valid snowflake intersection", [OTHER_ROLE_ID, ROLE_ID], true],
    ["unmatched snowflake", [OTHER_ROLE_ID], false],
    ["empty role list", [], false],
    ["display name", ["SySOp"], false],
    [
      "numeric/object roles are not coerced",
      [Number(ROLE_ID), { id: ROLE_ID }, null, false],
      false,
    ],
    [
      "mixed array without an admitted intersection",
      [OTHER_ROLE_ID, Number(ROLE_ID), { id: ROLE_ID }, PAYLOAD],
      false,
    ],
    [
      "mixed array retains its matching string",
      [null, Number(ROLE_ID), { id: ROLE_ID }, ROLE_ID, PAYLOAD],
      true,
    ],
  ] satisfies [string, unknown[], boolean][])("%s", async (_name, roles, expected) => {
    const fetch = stubResponse(Response.json({ roles, diagnostic: PAYLOAD }));
    await expect(recomputeModerator(opts)).resolves.toBe(expected);
    expectLookup(fetch);
    expect(diagnostics).toEqual([]);
  });

  it("an empty allowlist denies without fetching or emitting diagnostics", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error(`must not send ${BOT_TOKEN}`));
    vi.stubGlobal("fetch", fetch);
    await expect(recomputeModerator({ ...opts, moderatorRoleIds: [] })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });
});
