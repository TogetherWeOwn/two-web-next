import { describe, expect, it, vi } from "vitest";
import { parseAttendanceResult, signedAttendanceReader } from "../src/bot/attendance-read";

const KEY = "01KTESTEVENTKEY000000000001";

function relayed(result: unknown, ok = true) {
  return ok
    ? { ok: true, result }
    : { ok: false, error: { code: "not_found", message: "no such window" } };
}

function goodResult(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    event_key: KEY,
    window: { starts_at: "2026-10-20T18:00:00Z", ends_at: "2026-10-20T21:00:00Z" },
    threshold_minutes: 10,
    peak_concurrent: 24,
    rooms: [{ channel_id: "111111111111111111", name_at_close: "Tavern" }],
    members: [
      {
        discord_id: "900000000000000001",
        minutes: 95,
        sessions: 2,
        first_joined_at: "2026-10-20T18:05:00Z",
      },
    ],
    final: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readerWith(fetcher: typeof fetch) {
  return signedAttendanceReader(
    { baseUrl: "https://bot.internal", keyId: "k1", secret: "s3cr3t" },
    fetcher,
  );
}

describe("parseAttendanceResult", () => {
  it("accepts the contract shape and final:false (the closer decides, not the parser)", () => {
    expect(parseAttendanceResult(goodResult(), KEY)?.final).toBe(true);
    expect(parseAttendanceResult(goodResult({ final: false }), KEY)?.final).toBe(false);
  });

  it("fails closed on a non-object document", () => {
    expect(parseAttendanceResult(null, KEY)).toBeNull();
    expect(parseAttendanceResult("envelope", KEY)).toBeNull();
    expect(parseAttendanceResult([goodResult()], KEY)).toBeNull();
  });

  it("fails closed on key mismatch, bad version, and unordered window", () => {
    expect(parseAttendanceResult(goodResult(), "01KOTHERKEY0000000000000000")).toBeNull();
    expect(parseAttendanceResult(goodResult({ v: 2 }), KEY)).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({
          window: { starts_at: "2026-10-20T21:00:00Z", ends_at: "2026-10-20T18:00:00Z" },
        }),
        KEY,
      ),
    ).toBeNull();
  });

  it("fails closed on every malformed window", () => {
    expect(parseAttendanceResult(goodResult({ window: null }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ window: "2026-10-20" }), KEY)).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ window: { starts_at: 1760983200, ends_at: "2026-10-20T21:00:00Z" } }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ window: { starts_at: "2026-10-20T18:00:00Z", ends_at: 1760994000 } }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ window: { starts_at: "2026-10-20 18:00", ends_at: "2026-10-20T21:00:00Z" } }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ window: { starts_at: "2026-10-20T18:00:00Z", ends_at: "2026-10-20T21:00" } }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({
          window: { starts_at: "2026-10-20T21:00:00Z", ends_at: "2026-10-20T21:00:00Z" },
        }),
        KEY,
      ),
    ).toBeNull();
  });

  it("fails closed on every malformed threshold or peak", () => {
    expect(parseAttendanceResult(goodResult({ threshold_minutes: 0 }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ threshold_minutes: -10 }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ threshold_minutes: 2.5 }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ threshold_minutes: "10" }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ peak_concurrent: -1 }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ peak_concurrent: 2.5 }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ peak_concurrent: "24" }), KEY)).toBeNull();
  });

  it("fails closed on every malformed room", () => {
    expect(parseAttendanceResult(goodResult({ rooms: "tavern" }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ rooms: [null] }), KEY)).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ rooms: [{ channel_id: 111111111111111111, name_at_close: "R" }] }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ rooms: [{ channel_id: "nope", name_at_close: "R" }] }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ rooms: [{ channel_id: "111111111111111111", name_at_close: "" }] }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ rooms: [{ channel_id: "111111111111111111", name_at_close: 7 }] }),
        KEY,
      ),
    ).toBeNull();
  });

  it("fails closed on cap breaches: >100 rooms, >500 members, long names, bad shapes", () => {
    const room = { channel_id: "111111111111111111", name_at_close: "R" };
    expect(
      parseAttendanceResult(goodResult({ rooms: Array.from({ length: 101 }, () => room) }), KEY),
    ).toBeNull();
    const member = {
      discord_id: "900000000000000001",
      minutes: 1,
      sessions: 1,
      first_joined_at: null,
    };
    expect(
      parseAttendanceResult(
        goodResult({ members: Array.from({ length: 501 }, () => member) }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ rooms: [{ ...room, name_at_close: "x".repeat(101) }] }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ members: [{ ...member, discord_id: "not-a-snowflake" }] }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(goodResult({ members: [{ ...member, sessions: 0 }] }), KEY),
    ).toBeNull();
    expect(parseAttendanceResult(goodResult({ threshold_minutes: 0 }), KEY)).toBeNull();
  });

  it("fails closed on every malformed member", () => {
    const member = {
      discord_id: "900000000000000001",
      minutes: 1,
      sessions: 1,
      first_joined_at: null,
    };
    expect(parseAttendanceResult(goodResult({ members: "crowd" }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ members: [null] }), KEY)).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ members: [{ ...member, discord_id: 900000000000000001 }] }),
        KEY,
      ),
    ).toBeNull();
    expect(
      parseAttendanceResult(goodResult({ members: [{ ...member, minutes: -1 }] }), KEY),
    ).toBeNull();
    expect(
      parseAttendanceResult(goodResult({ members: [{ ...member, minutes: 1.5 }] }), KEY),
    ).toBeNull();
    expect(
      parseAttendanceResult(goodResult({ members: [{ ...member, minutes: "95" }] }), KEY),
    ).toBeNull();
    expect(
      parseAttendanceResult(goodResult({ members: [{ ...member, sessions: 1.5 }] }), KEY),
    ).toBeNull();
    expect(
      parseAttendanceResult(goodResult({ members: [{ ...member, sessions: -2 }] }), KEY),
    ).toBeNull();
    expect(
      parseAttendanceResult(goodResult({ members: [{ ...member, sessions: "2" }] }), KEY),
    ).toBeNull();
    expect(
      parseAttendanceResult(
        goodResult({ members: [{ ...member, first_joined_at: "a while ago" }] }),
        KEY,
      ),
    ).toBeNull();
  });

  it("fails closed on a non-boolean final flag", () => {
    expect(parseAttendanceResult(goodResult({ final: "yes" }), KEY)).toBeNull();
    expect(parseAttendanceResult(goodResult({ final: 1 }), KEY)).toBeNull();
    const missing = goodResult() as unknown as Record<string, unknown>;
    delete missing.final;
    expect(parseAttendanceResult(missing, KEY)).toBeNull();
  });

  it("defaults a missing first_joined_at to null", () => {
    const member = { discord_id: "900000000000000001", minutes: 5, sessions: 1 };
    const parsed = parseAttendanceResult(goodResult({ members: [member] }), KEY);
    expect(parsed?.members).toEqual([
      { discord_id: "900000000000000001", minutes: 5, sessions: 1, first_joined_at: null },
    ]);
  });
});

describe("signedAttendanceReader", () => {
  it("returns the typed not_found code without the bot message", async () => {
    const fetcher = vi.fn(async () => jsonResponse(relayed(null, false)));
    const result = await readerWith(fetcher as typeof fetch)(KEY);
    expect(result).toEqual({ ok: false, code: "not_found" });
  });

  it("returns the parsed payload on ok:true", async () => {
    const fetcher = vi.fn(async () => jsonResponse(relayed(goodResult())));
    const result = await readerWith(fetcher as typeof fetch)(KEY);
    expect(result).toEqual({ ok: true, attendance: expect.objectContaining({ final: true }) });
  });

  it("fails closed on a malformed payload and on missing credentials", async () => {
    const fetcher = vi.fn(async () => jsonResponse(relayed(goodResult({ v: 2 }))));
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "bot_unreachable",
    });
    const naked = signedAttendanceReader({}, (async () =>
      jsonResponse(relayed(goodResult()))) as typeof fetch);
    expect(await naked(KEY)).toEqual({ ok: false, code: "bot_unreachable" });
  });

  it.each([
    {},
    { baseUrl: "https://bot.internal", keyId: "", secret: "s3cr3t" },
    { baseUrl: "https://bot.internal", keyId: "k1", secret: "" },
    { baseUrl: "http://bot.internal", keyId: "k1", secret: "s3cr3t" },
    { baseUrl: "https://user:password@bot.internal", keyId: "k1", secret: "s3cr3t" },
    { baseUrl: "not a url", keyId: "k1", secret: "s3cr3t" },
  ])("unsafe or unconfigured endpoint is unreachable without any request: %j", async (config) => {
    const fetcher = vi.fn(async () => jsonResponse(relayed(goodResult())));
    expect(await signedAttendanceReader(config, fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "bot_unreachable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the default fetcher only after the credential check", async () => {
    await expect(signedAttendanceReader({})(KEY)).resolves.toEqual({
      ok: false,
      code: "bot_unreachable",
    });
  });

  it("a rejected transport is unreachable with no retry", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("fixture transport detail");
    });
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "bot_unreachable",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("a redirect is unreachable and its body is never parsed", async () => {
    const fetcher = vi.fn(
      async () =>
        ({
          status: 302,
          ok: false,
          body: null,
        }) as unknown as Response,
    );
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "bot_unreachable",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["a non-object document", "42"],
    ["a document without ok", '{"result":1}'],
    ["invalid JSON", "not json"],
  ])("fails closed on %s over the schemaless text path", async (_name, text) => {
    const fetcher = vi.fn(
      async () =>
        ({ status: 200, ok: true, body: null, text: async () => text }) as unknown as Response,
    );
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "bot_unreachable",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reads a valid document over the schemaless text path", async () => {
    const fetcher = vi.fn(
      async () =>
        ({
          status: 200,
          ok: true,
          body: null,
          text: async () => JSON.stringify(relayed(goodResult())),
        }) as unknown as Response,
    );
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: true,
      attendance: expect.objectContaining({ final: true, event_key: KEY }),
    });
  });

  it("an unreadable text body is unreachable", async () => {
    const fetcher = vi.fn(
      async () =>
        ({
          status: 200,
          ok: true,
          body: null,
          text: async () => {
            throw new Error("fixture body failure");
          },
        }) as unknown as Response,
    );
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "bot_unreachable",
    });
  });

  it("an over-ceiling text body is refused before parsing", async () => {
    const fetcher = vi.fn(
      async () =>
        ({
          status: 200,
          ok: true,
          body: null,
          text: async () => "x".repeat(262_144 + 1),
        }) as unknown as Response,
    );
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "bot_unreachable",
    });
  });

  it("a non-ok status still returns a well-formed bot error code", async () => {
    const fetcher = vi.fn(async () => jsonResponse(relayed(null, false), 403));
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("a non-ok status with a malformed payload is unreachable", async () => {
    const fetcher = vi.fn(async () => jsonResponse(relayed(goodResult({ v: 2 })), 500));
    expect(await readerWith(fetcher as typeof fetch)(KEY)).toEqual({
      ok: false,
      code: "bot_unreachable",
    });
  });

  it.each([
    ["missing error", { ok: false }],
    ["non-object error", { ok: false, error: "nope" }],
    ["non-string code", { ok: false, error: { code: 404 } }],
    ["off-alphabet code", { ok: false, error: { code: "NOT FOUND" } }],
  ])("returns unreachable, never a raw bot body, for %s", async (_name, doc) => {
    const fetcher = vi.fn(async () => jsonResponse(doc));
    const result = await readerWith(fetcher as typeof fetch)(KEY);
    expect(result).toEqual({ ok: false, code: "bot_unreachable" });
    expect(JSON.stringify(result)).not.toContain("NOT FOUND");
  });
});
