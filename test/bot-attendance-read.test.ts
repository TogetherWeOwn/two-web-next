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
});
