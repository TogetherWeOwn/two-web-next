import { expect, it, vi } from "vitest";
import { signInternalAction } from "../src/bot/signer";
import { signedVoiceReader, type VoiceSnapshot } from "../src/bot/voice-read";
import { createVoiceSnapshotCache } from "../src/bot/voice-snapshot";
import contract from "./fixtures/bot-site-contract-v2.json";
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
  const event_key = "raid:phase.1_".padEnd(200, "a");
  const value = { ...snapshot, rooms: [{ ...lobby, event_key, occupied_since: observed_at }] };
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
  const cancel = vi.fn().mockRejectedValue(Error("fixture"));
  expect(await respond(new ReadableStream({ cancel }), 302)).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});

it("rejects the whole snapshot on bad fields, totals or caps", async () => {
  const ids = Array.from({ length: 500 }, (_, i) => String(1_000 + i));
  const rooms = ids.slice(0, 101).map((id, i) => room(String(10 + i), [id]));
  const atCap = { ...snapshot, rooms: rooms.slice(0, 100), total_in_voice: 100 };
  expect(await respond(wire(atCap))).toEqual(atCap);
  for (const patch of [
    { v: 2 },
    { observed_at: "2026-02-30T19:04:11Z" },
    { total_in_voice: 4 },
    { rooms, total_in_voice: 101 },
    { rooms: [room("11", ids), room("12", ["904"], { afk: true })], total_in_voice: 500 },
    { rooms: ["11", "12"].map((id) => room(id, [id + "0"], { afk: true })), total_in_voice: 0 },
    ...[
      { name: "🔥".repeat(101) },
      { member_ids: ["bad"] },
      { occupied_since: 10 },
      { event_key: [] },
      { event_key: "raid night" },
      { event_key: "a".repeat(201) },
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
  const full = new TextEncoder().encode(wire().padEnd(256 * 1024, " "));
  expect(await respond(full)).toEqual(snapshot);
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(full);
      c.enqueue(Uint8Array.of(0x20));
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
  return { ctx, jobs, clock, get: createVoiceSnapshotCache(() => clock.now) };
}

it("projects a Bot self-move destination only with current room proof", async () => {
  const { ctx, jobs, get } = fixture();
  const { discord_id, channel_id } = contract.verbs["voice.move_member"].request;
  const read = () => respond(wire(contract.verbs["voice.snapshot"].results.full));
  const viewOnly = {
    session,
    roomAccess: new Map([[channel_id, { ...access("member"), canJoin: false }]]),
  };

  expect(get(read, ctx, viewOnly)).toBeNull();
  await Promise.all(jobs);
  expect(get(read, ctx, guest)).toBeNull();
  expect(get(read, ctx, { session })).toMatchObject({ audience: "member", rooms: [] });
  const projection = get(read, ctx, viewOnly);
  expect(projection).toMatchObject({
    audience: "member",
    rooms: [
      { channelId: channel_id, eventKey: "test-raid-night-1", occupants: [], canMove: false },
    ],
  });
  expect(projection?.audience === "member" && projection.rooms).toHaveLength(1);
  expect(JSON.stringify(projection)).not.toContain(discord_id);
  expect(
    get(read, ctx, { session, roomAccess: new Map([[channel_id, access("member")]]) }),
  ).toMatchObject({ rooms: [{ channelId: channel_id, canMove: true }] });
});

it("returns immediately, coalesces, throttles failures and freezes the last good value", async () => {
  const { ctx, jobs, clock, get } = fixture();
  const read = vi.fn(async () => snapshot);
  read.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(Error());
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
  const read = vi.fn(() => new Promise<VoiceSnapshot>(() => undefined));
  read.mockResolvedValueOnce(snapshot);
  get(read, ctx, viewer);
  await jobs[0];
  const bands = { 30000: "fresh", 30001: "aging", 120000: "aging", 120001: "frozen" };
  for (const [age, freshness] of Object.entries(bands)) {
    clock.now = epoch + Math.min(skew, 0) + Number(age);
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
  const roomAccess = new Map(viewer.roomAccess).set("11", access("moderator"));
  roomAccess.set("13", access("member"));
  const profiles = new Map([
    ["901", { name: "Visible", avatarUrl: "https://cdn.discordapp.com/avatars/901/abc.png" }],
    ["902", { name: "Opted out", show_in_live_rooms: false }],
    ["904", { name: "Opted out in restricted room", show_in_live_rooms: false }],
    ["906", { name: "AFK occupant" }],
  ]);
  const output = JSON.stringify(get(read, ctx, { session, roomAccess, profiles }));
  const visible = { channelId: "10", count: 3, occupants: [{ name: "Visible" }] };
  const idle = { channelId: "13", count: 0, occupants: [], canMove: false };
  expect(JSON.parse(output)).toMatchObject({ rooms: [visible, idle] });
  expect(output).not.toMatch(/90[1-6]|Opted out|AFK occupant|Room 11|Room 12|cdn.discordapp/);
  const moderator = { session: { ...session, moderator: true }, roomAccess, profiles };
  const restricted = { channelId: "11", count: 1, occupants: [] };
  const moderated = JSON.stringify(get(read, ctx, moderator));
  expect(JSON.parse(moderated)).toMatchObject({ rooms: [visible, restricted, idle] });
  expect(moderated).not.toMatch(/90[1-6]|Opted out|AFK occupant|Room 12|cdn.discordapp/);
});
