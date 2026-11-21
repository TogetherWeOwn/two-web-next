import { afterEach, describe, expect, it, vi } from "vitest";
import { signedAttendanceReader } from "../src/bot/attendance-read";
import { signInternalAction } from "../src/bot/signer";

const key = "01KTESTEVENT000000000000000";
const config = { baseUrl: "https://bot.example.test/other", keyId: "fixture", secret: "synthetic" };
const unavailable = { ok: false, code: "bot_unreachable" };
const window = { starts_at: "2026-10-20T20:00:00Z", ends_at: "2026-10-20T22:00:00Z" };
const room = { channel_id: "100000000000000001", name_at_close: "Café Night" };
const member = {
  discord_id: "100000000000000002",
  minutes: 5,
  sessions: 1,
  first_joined_at: window.starts_at,
};
const attendance = {
  v: 1,
  event_key: key,
  window,
  threshold_minutes: 10,
  peak_concurrent: 1,
  rooms: [room],
  members: [member],
  final: true,
};

function observe(response: Response) {
  return signedAttendanceReader(config, vi.fn<typeof fetch>().mockResolvedValue(response))(key);
}

function reply(result: unknown) {
  return Response.json({ ok: true, result });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("signed event attendance read", () => {
  it("sends the exact signed canonical POST once without redirect following", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(attendance));
    expect(await signedAttendanceReader(config, fetcher)(key)).toEqual({ ok: true, attendance });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    const body = `{"action":"event.attendance.read","event_key":"${key}"}`;
    expect(url).toBe("https://bot.example.test/internal/actions");
    expect(init).toMatchObject({ method: "POST", body, redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has("Idempotency-Key")).toBe(false);
    const signature = await signInternalAction(
      config.keyId,
      config.secret,
      body,
      Number(headers.get("X-TWO-Timestamp")),
      headers.get("X-TWO-Nonce") ?? "",
    );
    expect(headers).toEqual(new Headers({ ...signature, "Content-Type": "application/json" }));
  });

  it("keeps provisional attendance and ignores additive fields", async () => {
    const result = { ...attendance, final: false };
    await expect(
      observe(reply({ ...result, extra: true, rooms: [{ ...room, extra: true }] })),
    ).resolves.toEqual({ ok: true, attendance: result });
  });

  it.each([
    ["not_found", 404, { ok: false, code: "not_found" }],
    ["rate_limited", 429, { ok: false, code: "rate_limited" }],
    ["private_fixture_value", 503, unavailable],
  ] as const)("projects error %s without provider text", async (code, status, result) => {
    await expect(
      observe(
        Response.json({ ok: false, error: { code, message: "private fixture" } }, { status }),
      ),
    ).resolves.toEqual(result);
  });

  it.each([
    { event_key: "different-event" },
    { final: "true" },
    { v: 2 },
    { window: { ...window, ends_at: window.starts_at } },
    { window: { ...window, ends_at: "2026-02-30T22:00:00Z" } },
    { threshold_minutes: 0 },
    { peak_concurrent: -1 },
    { rooms: Array.from({ length: 101 }, () => room) },
    { rooms: [{ ...room, name_at_close: "x".repeat(101) }] },
    { members: Array.from({ length: 501 }, () => member) },
    { members: [{ ...member, sessions: 0 }] },
    { members: [{ ...member, discord_id: "not-a-snowflake" }] },
  ])("fails closed on a malformed or unbound result (%j)", async (overrides) => {
    await expect(observe(reply({ ...attendance, ...overrides }))).resolves.toEqual(unavailable);
  });

  it("rejects malformed envelopes, invalid JSON, and absent bodies", async () => {
    await expect(observe(Response.json({ ok: 0, error: { code: "not_found" } }))).resolves.toEqual(
      unavailable,
    );
    await expect(observe(new Response("{"))).resolves.toEqual(unavailable);
    await expect(observe(new Response(null, { status: 204 }))).resolves.toEqual(unavailable);
  });

  it("rejects unsafe destinations and returned redirects without another fetch", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 302,
      headers: { Location: "https://redirect.example.test/" },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    for (const baseUrl of [undefined, "http://bot.example.test", "https://user@bot.example.test"]) {
      await expect(signedAttendanceReader({ ...config, baseUrl }, fetcher)(key)).resolves.toEqual(
        unavailable,
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(signedAttendanceReader(config, fetcher)(key)).resolves.toEqual(unavailable);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([0, 1])("enforces the cumulative byte cap (+%i bytes)", async (extra) => {
    const encoded = new TextEncoder().encode(JSON.stringify({ ok: true, result: attendance }));
    const padding = new Uint8Array(256 * 1024 - encoded.length + extra).fill(32);
    const split = encoded.indexOf(0xc3) + 1; // Split é across chunks.
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.subarray(0, split));
        controller.enqueue(encoded.subarray(split));
        controller.enqueue(padding);
        if (!extra) controller.close();
      },
      cancel,
    });
    await expect(observe(new Response(body))).resolves.toEqual(
      extra ? unavailable : { ok: true, attendance },
    );
    expect(cancel).toHaveBeenCalledTimes(extra);
  });

  it.each(["headers", "body"])("owns a single deadline even when %s stall", async (stall) => {
    vi.useFakeTimers();
    const entered = deferred<AbortSignal | null | undefined>();
    const headers = deferred<Response>();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const bodyRead = deferred<void>();
    const pull = vi.fn(() => bodyRead.resolve());
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      entered.resolve(init?.signal);
      return headers.promise;
    });
    const pending = signedAttendanceReader(config, fetcher)(key);
    const signal = await entered.promise;
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(2_000);
    if (stall === "body") {
      headers.resolve(response);
      await bodyRead.promise;
    }
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(unavailable);
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    if (stall === "headers") {
      headers.resolve(response);
      await vi.advanceTimersByTimeAsync(0);
      expect(pull).not.toHaveBeenCalled();
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledExactlyOnceWith(unavailable);
  });
});
