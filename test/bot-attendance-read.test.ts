import { afterEach, expect, it, vi } from "vitest";
import { signedAttendanceReader } from "../src/bot/attendance-read";
import { signInternalAction } from "../src/bot/signer";
import contract from "./fixtures/bot-site-contract-v2.json";

const fixture = contract.verbs["event.attendance.read"];
const key = fixture.request.event_key;
const golden = fixture.results.read;
const { window } = golden;
const [fixtureRoom] = golden.rooms;
const [member] = golden.members;
if (!fixtureRoom || !member) throw new Error("Attendance fixture needs a room and a member");
const room = { ...fixtureRoom, name_at_close: "Café Night" };
const attendance = { ...golden, rooms: [room], members: [member] };
const config = { baseUrl: "https://bot.example.test/other", keyId: "fixture", secret: "synthetic" };
const unavailable = { ok: false, code: "bot_unreachable" };
const observe = (response: Response) => signedAttendanceReader(config, async () => response)(key);
const success = (attendance: unknown) => ({ ok: true, attendance });
const reply = (result: unknown, status = 200) => Response.json({ ok: true, result }, { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
it("sends the exact signed POST once and accepts the pinned bot reply", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(golden));
  expect(await signedAttendanceReader(config, fetcher)(key)).toEqual(success(golden));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] ?? [];
  const body = `{"action":"event.attendance.read","event_key":"${key}"}`;
  expect(url).toBe("https://bot.example.test/internal/actions");
  expect(init).toMatchObject({ method: "POST", body, redirect: "manual" });
  const headers = new Headers(init?.headers);
  expect(headers.has("Idempotency-Key")).toBe(false);
  const ts = Number(headers.get("X-TWO-Timestamp"));
  const nonce = headers.get("X-TWO-Nonce") ?? "";
  const signature = await signInternalAction(config.keyId, config.secret, body, ts, nonce);
  expect(headers).toEqual(new Headers({ ...signature, "Content-Type": "application/json" }));
});
it.each([
  [false, []],
  [false, [member]],
  [true, [member]],
] as const)("keeps final=%s and members %j", async (final, members) => {
  const rooms = final ? [] : [room];
  const result = { ...attendance, final, rooms, members };
  const replyRooms = rooms.map((room) => ({ ...room, extra: true }));
  expect(await observe(reply({ ...result, extra: true, rooms: replyRooms }))).toEqual(
    success(result),
  );
});
it("accepts millisecond timestamps, in-budget aggregates, and room-name boundaries", async () => {
  const ms = "1970-01-01T01:00:00.000Z";
  const result = {
    ...attendance,
    window: { starts_at: ms, ends_at: "1970-01-01T02:00:00.000Z" },
    rooms: Array.from({ length: 101 }, (_, i) => ({
      channel_id: String(i + 1),
      name_at_close: "🎮".repeat(i === 0 ? 100 : 1),
    })),
    members: Array.from({ length: 501 }, (_, i) => ({
      ...member,
      discord_id: String(i + 1),
      first_joined_at: i ? ms : null,
    })),
  };
  const response = reply(result);
  expect((await response.clone().arrayBuffer()).byteLength).toBeLessThan(64 * 1024);
  await expect(observe(response)).resolves.toEqual(success(result));
});
it.each([
  ["malformed", 400],
  ["unauthorized", 401],
  ["stale_request", 401],
  ["action_not_allowed", 403],
  ["not_found", 404],
  ["replayed", 409],
  ["in_progress", 409],
  ["needs_reconciliation", 409],
  ["discord_rejected", 422],
  ["rate_limited", 429],
  ["internal", 500],
  ["discord_unavailable", 502],
  ["busy", 503],
  ["upstream_timeout", 504],
  ["not_found", 200, false],
  ["not_found", 503, false],
  ["rate_limited", 500, false],
  ["busy", 502, false],
  ["private_fixture_value", 503, false],
] as const)("projects %s at HTTP %i", async (code, status, valid?: boolean) => {
  const error = { code, message: "private fixture" };
  const result = await observe(Response.json({ ok: false, error }, { status }));
  expect(result).toEqual(valid === false ? unavailable : { ok: false, code });
});
it.each([
  { event_key: "different-event" },
  { final: "true" },
  { v: 2 },
  { window: { ...window, starts_at: window.ends_at.replace("Z", ".000Z") } },
  { window: { ...window, ends_at: "2026-02-30T22:00:00Z" } },
  { threshold_minutes: 0 },
  { peak_concurrent: -1 },
  { rooms: [room, { ...room, name_at_close: "Renamed" }] },
  { rooms: [{ ...room, name_at_close: 123 }] },
  { rooms: [{ ...room, name_at_close: "" }] },
  { rooms: [{ ...room, name_at_close: "🎮".repeat(101) }] },
  { final: true, members: [] },
  { members: [member, { ...member, minutes: 10 }] },
  { members: [{ discord_id: member.discord_id, minutes: 5, sessions: 1 }] },
  { members: [{ ...member, sessions: 0 }] },
  { members: [{ ...member, discord_id: "not-a-snowflake" }] },
])("fails closed on a malformed or unbound result (%j)", async (overrides) => {
  await expect(observe(reply({ ...attendance, ...overrides }))).resolves.toEqual(unavailable);
});
it("rejects malformed envelopes, invalid JSON or UTF-8, and absent bodies", async () => {
  for (const response of [
    reply(attendance, 206),
    Response.json({ ok: true, result: attendance, error: null }),
    Response.json({ ok: false, result: attendance, error: { code: "not_found" } }, { status: 404 }),
    Response.json({ ok: 0, error: { code: "not_found" } }, { status: 404 }),
  ])
    await expect(observe(response)).resolves.toEqual(unavailable);
  await expect(observe(new Response("{"))).resolves.toEqual(unavailable);
  const bytes = new Uint8Array(await reply(attendance).arrayBuffer());
  const truncated = Uint8Array.of(...bytes, 0xc3); // Incomplete UTF-8 after valid JSON.
  await expect(observe(new Response(truncated))).resolves.toEqual(unavailable);
  bytes[bytes.indexOf(0xc3)] = 0xff; // Corrupt é inside the quoted room name.
  await expect(observe(new Response(bytes))).resolves.toEqual(unavailable);
  await expect(observe(new Response(null, { status: 204 }))).resolves.toEqual(unavailable);
});
it("refuses unsafe URLs and redirects even if body cancellation rejects", async () => {
  const cancel = vi.fn().mockRejectedValue(new Error("fixture cancellation failure"));
  const response = new Response(new ReadableStream({ cancel }), {
    status: 302,
    headers: { Location: "https://redirect.example.test/" },
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  for (const baseUrl of [undefined, "http://bot.example.test", "https://user@bot.example.test"])
    expect(await signedAttendanceReader({ ...config, baseUrl }, fetcher)(key)).toEqual(unavailable);
  const unconfigured = signedAttendanceReader({}, fetcher);
  expect(await unconfigured(key)).not.toBe(await unconfigured(key));
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
      for (const bytes of [encoded.subarray(0, split), encoded.subarray(split), padding])
        controller.enqueue(bytes);
      if (!extra) controller.close();
    },
    cancel,
  });
  expect(await observe(new Response(body))).toEqual(extra ? unavailable : success(attendance));
  expect(cancel).toHaveBeenCalledTimes(extra);
});
it("rejects late buffered EOF before the timeout callback runs", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  const { body } = reply(attendance);
  if (!body) throw new Error("Attendance fixture needs a body");
  const clock = new TransformStream({ flush: () => void vi.advanceTimersByTime(2_500) });
  const stream = body.pipeThrough(clock);
  await expect(observe(new Response(stream))).resolves.toEqual(unavailable);
});
it.each(["headers", "body", "chunks"])("keeps a single deadline for %s", async (phase) => {
  vi.useFakeTimers();
  const entered = deferred<AbortSignal | null | undefined>();
  const headers = deferred<Response>();
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const bodyRead = deferred<void>();
  let chunks = 1024;
  const pull = vi.fn((stream: ReadableStreamDefaultController<Uint8Array>) => {
    bodyRead.resolve();
    if (phase !== "chunks") return;
    if (chunks--) stream.enqueue(new Uint8Array());
    else stream.close();
  });
  const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
  const fetcher = vi.fn<typeof fetch>((_url, init) => {
    entered.resolve(init?.signal);
    return headers.promise;
  });
  const pending = signedAttendanceReader(config, fetcher)(key);
  const signal = await entered.promise;
  const settled = vi.fn();
  void pending.then(settled);
  await vi.advanceTimersByTimeAsync(phase === "chunks" ? 2_499 : 2_000);
  if (phase !== "headers") {
    headers.resolve(response);
    await bodyRead.promise;
  }
  if (phase !== "chunks") await vi.advanceTimersByTimeAsync(499);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual(unavailable);
  expect(signal?.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
  if (phase === "headers") {
    headers.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).not.toHaveBeenCalled();
  }
  expect(cancel).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledExactlyOnceWith(unavailable);
});
