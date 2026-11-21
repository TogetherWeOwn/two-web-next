import { expect, it, vi } from "vitest";
import { signInternalAction } from "../src/bot/signer";
import { signedVoiceReader, type VoiceSnapshot } from "../src/bot/voice-read";
import { createVoiceSnapshotCache } from "../src/bot/voice-snapshot";

const observed_at = "2026-11-03T19:04:11Z";
const epoch = Date.parse(observed_at);
const room = (channel_id: string, member_ids: string[], extra = {}) => ({
  channel_id,
  member_ids,
  name: `Room ${channel_id}`,
  position: null,
  user_limit: 0,
  ...extra,
});
const lobby = room("10", ["901", "902", "903"]);
const snapshot: VoiceSnapshot = { v: 1, observed_at, total_in_voice: 3, rooms: [lobby] };
const cfg = { baseUrl: "https://bot.example", keyId: "fixture", secret: "fixture" };
const wire = (result: unknown = snapshot) => JSON.stringify({ ok: true, result });
const respond = (body: BodyInit, status = 200) =>
  signedVoiceReader(cfg, async () => new Response(body, { status }))();

it("sends exactly one signed read without an idempotency key or redirects", async () => {
  const rooms = [{ ...lobby, event_key: "raid", occupied_since: observed_at }];
  const value = { ...snapshot, rooms };
  const send = vi.fn<typeof fetch>(async () => new Response(wire(value)));
  expect(await signedVoiceReader(cfg, send)()).toEqual(value);
  const [url, request] = send.mock.calls[0]!;
  const h = new Headers(request?.headers);
  const body = '{"action":"voice.snapshot"}';
  expect(url).toBe("https://bot.example/internal/actions");
  expect(request).toMatchObject({ method: "POST", redirect: "manual", body });
  expect(h.has("Idempotency-Key")).toBe(false);
  const stamp = Number(h.get("X-TWO-Timestamp"));
  const nonce = h.get("X-TWO-Nonce")!;
  const signed = await signInternalAction(cfg.keyId, cfg.secret, body, stamp, nonce);
  expect(h.get("X-TWO-Signature")).toBe(signed["X-TWO-Signature"]);
  expect(await signedVoiceReader({ ...cfg, baseUrl: "http://bot.example" }, send)()).toBeNull();
  expect(send).toHaveBeenCalledOnce();
  expect(await respond(wire(), 302)).toBeNull();
});

it("rejects the whole snapshot on bad fields, totals or caps", async () => {
  const ids = Array.from({ length: 500 }, (_, i) => String(1_000 + i));
  const many = room("11", ids);
  for (const patch of [
    { v: 2 },
    { observed_at: "2026-02-30T19:04:11Z" },
    { total_in_voice: 4 },
    { rooms: Array(101).fill(lobby) },
    { rooms: [many, room("12", ["904"], { afk: true })], total_in_voice: 500 },
    ...[
      { name: "🔥".repeat(101) },
      { member_ids: ["bad"] },
      { occupied_since: 10 },
      { event_key: [] },
    ].map((roomPatch) => ({ rooms: [{ ...lobby, ...roomPatch }] })),
  ])
    expect(await respond(wire({ ...snapshot, ...patch }))).toBeNull();
});

it("redacts refusals and emits only fixed signing diagnostics", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const code of ["private", "action_not_allowed", "unauthorized", "stale_request"]) {
      const body = JSON.stringify({ ok: false, error: { code, message: "sensitive" } });
      expect(await respond(body, 403)).toBeNull();
    }
    expect(warn.mock.calls).toEqual(Array(2).fill(["voice.snapshot signing refused"]));
  } finally {
    warn.mockRestore();
  }
});

it("accepts the byte ceiling and cancels overflow across chunks", async () => {
  const encoder = new TextEncoder();
  const full = encoder.encode(wire().padEnd(256 * 1024, " "));
  expect(await respond(full)).toEqual(snapshot);
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(full);
      c.enqueue(encoder.encode(" "));
    },
    cancel,
  });
  expect(await respond(stream)).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(["headers", "body"])("settles at 2.5 seconds against abort-ignoring %s", async (stage) => {
  vi.useFakeTimers();
  try {
    let start!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      start = resolve;
    });
    const never = new Promise<never>(() => undefined);
    const pending = signedVoiceReader(cfg, async (_url, request) => {
      start(request?.signal as AbortSignal);
      if (stage === "headers") return never;
      return new Response(new ReadableStream({ pull: () => never }));
    })();
    const signal = await started;
    await vi.advanceTimersByTimeAsync(2_499);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

const session = { member: true, moderator: false };
const guest = { session: null };
const access = (visibility: "member" | "moderator") => ({ visibility, canJoin: true });
const viewer = { session, roomAccess: new Map([["10", access("member")]]) };
function fixture(skew = 0) {
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void jobs.push(p) };
  const clock = { now: epoch + skew };
  const get = createVoiceSnapshotCache(() => clock.now);
  return { ctx, jobs, clock, get };
}

it("returns immediately, coalesces, throttles failures and freezes the last good value", async () => {
  const { ctx, jobs, clock, get } = fixture();
  const read = vi
    .fn(async () => snapshot)
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(Error());
  expect(get(read, ctx, viewer)).toBeNull();
  expect(get(read, ctx, viewer)).toBeNull();
  expect(jobs).toHaveLength(1);
  await jobs[0];
  expect(get(read, ctx, guest)).toBeNull();
  clock.now += 9_999;
  expect(get(read, ctx, viewer)).toMatchObject({ freshness: "fresh", rooms: [{ canMove: true }] });
  expect(jobs).toHaveLength(1);
  clock.now += 1;
  get(read, ctx, viewer);
  await jobs[1];
  const frozen = { freshness: "frozen", rooms: [{ count: 3, canMove: false }] };
  expect(get(read, ctx, viewer)).toMatchObject(frozen);
  expect(jobs).toHaveLength(2);
  clock.now += 10_000;
  get(read, ctx, viewer);
  await jobs[2];
  expect(get(read, ctx, viewer)).toMatchObject({ freshness: "fresh" });
});

it.each([-1_000, 1_000])("uses the older of the two ages (clock skew %s)", async (skew) => {
  const { ctx, jobs, clock, get } = fixture(skew);
  const read = vi
    .fn(() => new Promise<VoiceSnapshot>(() => undefined))
    .mockResolvedValueOnce(snapshot);
  get(read, ctx, viewer);
  await jobs[0];
  const start = Math.min(clock.now, epoch);
  const bands = { 30000: "fresh", 30001: "aging", 120000: "aging", 120001: "frozen" };
  for (const [age, freshness] of Object.entries(bands)) {
    clock.now = start + Number(age);
    expect(get(read, ctx, viewer)).toMatchObject({ ageMs: Number(age), freshness });
  }
  expect(jobs).toHaveLength(2);
});

it("serializes only proven rooms and current consented identity", async () => {
  const { ctx, jobs, get } = fixture();
  const afk = room("13", ["906"], { afk: true });
  const rooms = [lobby, room("11", ["904"]), room("12", ["905"]), afk];
  const read = async () => ({ ...snapshot, total_in_voice: 5, rooms });
  expect(get(read, ctx, guest)).toBeNull();
  await jobs[0];
  const aggregate = { audience: "guest", count: 5, ageMs: 0, freshness: "fresh" };
  expect(get(read, ctx, guest)).toEqual(aggregate);
  const roomAccess = new Map(viewer.roomAccess)
    .set("11", access("moderator"))
    .set("13", access("member"));
  const profiles = new Map([
    ["901", { name: "Visible", avatarUrl: "https://cdn.discordapp.com/avatars/901/abc.png" }],
    ["902", { name: "Opted out", show_in_live_rooms: false }],
    ["906", { name: "AFK occupant" }],
  ]);
  const output = JSON.stringify(get(read, ctx, { session, roomAccess, profiles }));
  const visible = { channelId: "10", count: 3, occupants: [{ name: "Visible" }] };
  const idle = { channelId: "13", count: 0, occupants: [], canMove: false };
  expect(JSON.parse(output)).toMatchObject({ rooms: [visible, idle] });
  expect(output).not.toMatch(/90[1-6]|Opted out|AFK occupant|Room 11|Room 12|cdn.discordapp/);
  const moderator = { session: { ...session, moderator: true }, roomAccess, profiles };
  expect(get(read, ctx, moderator)).toMatchObject({ rooms: [visible, { channelId: "11" }, idle] });
});
