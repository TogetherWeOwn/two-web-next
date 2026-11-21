import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LiveSequence } from "../src/live/sequence";
import { reduceLiveState } from "../src/live/state";
import { signedLiveSnapshot } from "../src/live/transport";
import { decodeLiveDelta, type LiveState, snapshotTopics } from "../src/live/wire";

const guildId = "18446744073709551615";
const origin = "https://producer.example";
const config = { keyId: "fixture", secret: "offline signing fixture", origin, guildId };
const room = { id: "200", name: "HQ", kind: "voice", parentId: null, position: 1, overwrites: [] };
const member = { userId: "300", roleIds: [], nick: null, bot: false, pending: false };
const role = { id: guildId, permissions: "1024" };
const guest = { ...member, userId: "301" };
const occupant = { userId: guest.userId, channelId: room.id };
const event = {
  id: "400",
  channelId: room.id,
  status: "active",
  title: "Test event",
  description: null,
  location: null,
  startsAt: "2026-11-21T02:00:00Z",
  endsAt: null,
};
const baseline = {
  guild: { ownerId: member.userId, afkChannelId: null },
  channels: [room],
  roles: [role],
  members: [member, guest],
  voice: [occupant],
  events: [event],
};
const update = { topic: "voice", op: "upsert", id: guest.userId, value: occupant };
const removeRole = (id: string) => ({ topic: "roles", op: "remove", id });
const envelope = { v: 1, guild_id: guildId, seq: 2, occurred_at: event.startsAt, ops: [update] };
const snapshotEnvelope = {
  v: 1,
  guild_id: guildId,
  seq: Number.MAX_SAFE_INTEGER,
  observed_at: "2026-11-21T02:00:00.123456789Z",
};
const decode = (value: unknown, id = guildId) =>
  decodeLiveDelta(new Uint8Array(new TextEncoder().encode(JSON.stringify(value))).buffer, id);
const patch = (...ops: unknown[]) => decode({ ...envelope, ops: [update, ...ops] });
const pullTopics = (fetcher: typeof fetch) =>
  signedLiveSnapshot(config, (topics) => snapshotTopics(topics, guildId), fetcher);

function fixture(raw: unknown = baseline): LiveState {
  const state = snapshotTopics(raw, guildId);
  if (!state) throw new Error("Invalid live state fixture");
  return state;
}

describe("live wire allowlist", () => {
  it("admits the whole parent-format batch and a complete snapshot", () => {
    expect(decode(envelope)).toEqual(envelope);
    const maxOps = { ...envelope, ops: Array(128).fill(update) };
    expect(decode(maxOps)).toEqual(maxOps);
    expect(fixture()).toEqual(baseline);
  });
  it.each([
    { ...envelope, v: 2 },
    { ...envelope, seq: 0 },
    { ...envelope, seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...envelope, occurred_at: "2026-02-30T02:00:00Z" },
    { ...envelope, debug: true },
    { ...envelope, ops: [] },
    { ...envelope, ops: Array.from({ length: 129 }, () => update) },
  ])("rejects an invalid or over-limit envelope", (bad) => {
    expect(decode(bad)).toBeNull();
  });
  it("rejects the entire batch for a wrong guild, wrong key, or non-allowlisted operation", () => {
    expect(decode(envelope, "101")).toBeNull();
    expect(patch({ ...update, id: member.userId })).toBeNull();
    expect(patch(removeRole("18446744073709551615"))).not.toBeNull();
    expect(patch(removeRole("18446744073709551616"))).toBeNull();
    expect(patch({ ...update, value: { ...occupant, token: "fixture-only" } })).toBeNull();
    expect(patch({ ...update, op: "remove" })).toBeNull();
    expect(patch({ topic: "guild", op: "upsert", id: "101", value: baseline.guild })).toBeNull();
    expect(patch({ topic: "presence", op: "remove", id: member.userId })).toBeNull();
    expect(decodeLiveDelta(Uint8Array.of(255).buffer, guildId)).toBeNull();
  });
  it("requires unique keys and complete permission dependencies in snapshot topics", () => {
    expect(snapshotTopics({ ...baseline, members: [member, guest, member] }, guildId)).toBeNull();
    const unknownRole = { ...member, roleIds: ["101"] };
    expect(snapshotTopics({ ...baseline, members: [unknownRole, guest] }, guildId)).toBeNull();
    expect(snapshotTopics({ ...baseline, roles: [] }, guildId)).toBeNull();
    expect(snapshotTopics({ ...baseline, channels: [] }, guildId)).toBeNull();
    const category = { ...room, id: "201", kind: "category" };
    const nested = { ...category, parentId: category.id };
    expect(snapshotTopics({ ...baseline, channels: [room, nested] }, guildId)).toBeNull();
    expect(patch({ topic: "channels", op: "upsert", id: nested.id, value: nested })).toBeNull();
    expect(snapshotTopics({ ...baseline, rawDiscord: {} }, guildId)).toBeNull();
    const child = { ...room, parentId: category.id };
    const grouped = { ...baseline, channels: [child, category] };
    expect(snapshotTopics(grouped, guildId)).toEqual(grouped);
    expect(snapshotTopics({ ...baseline, channels: [child] }, guildId)).toBeNull();
    const nonCategory = { ...category, kind: "other" };
    expect(snapshotTopics({ ...baseline, channels: [child, nonCategory] }, guildId)).toBeNull();
  });
});

it("recovers complete state on a gap through one exact signed snapshot pull", async () => {
  const snapshot = {
    ...snapshotEnvelope,
    seq: 9,
    topics: { ...baseline, channels: [{ ...room, name: "New HQ" }] },
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot));
  const before = fixture({ ...baseline, voice: [] });
  const load = vi
    .fn()
    .mockResolvedValueOnce({ seq: 2, state: before })
    .mockImplementation(pullTopics(fetcher));
  const sequence = new LiveSequence(load, reduceLiveState);
  expect(await sequence.synchronize()).toBe(true);
  const recovery = sequence.ingest(8, { ...decode(envelope)!, seq: 8 });
  expect(sequence.current).toBeNull();
  expect(await recovery).toBe("resynced");
  expect(sequence.current).toEqual({ seq: snapshot.seq, state: snapshot.topics });
  expect(await sequence.ingest(9, decode({ ...envelope, seq: 9 })!)).toBe("duplicate");
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  const body = `{"action":"live.snapshot","guild_id":"${guildId}"}`;
  expect(url).toBe("https://producer.example/internal/actions");
  expect(init).toMatchObject({ method: "POST", redirect: "manual", body });
  const headers = new Headers(init?.headers);
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = `POST\n/internal/actions\n${headers.get("X-TWO-Timestamp")}\n${headers.get("X-TWO-Nonce")}\n${digest}`;
  expect(headers.get("X-TWO-Key-Id")).toBe(config.keyId);
  const signature = createHmac("sha256", config.secret).update(canonical).digest("hex");
  expect(headers.get("X-TWO-Signature")).toBe(`sha256=${signature}`);
});

describe("live batch reduction", () => {
  it("commits a move and room creation atomically, irrespective of dependency order", () => {
    const newRoom = { ...room, id: "201" };
    const move = { ...update, value: { ...occupant, channelId: newRoom.id } };
    const delta = patch(move, { topic: "channels", op: "upsert", id: newRoom.id, value: newRoom });
    const state = fixture();
    expect(reduceLiveState(state, delta!)?.voice).toEqual([move.value]);
    expect(state.voice).toEqual([occupant]);
  });
  it("withdraws voice and linked events on a channel removal", () => {
    const state = fixture();
    const delta = patch({ topic: "channels", op: "remove", id: room.id });
    const withdrawn = { ...baseline, voice: [], events: [], channels: [] };
    expect(reduceLiveState(state, delta!)).toEqual(withdrawn);
  });
  it("clears a departed non-owner's voice without invalidating the baseline", () => {
    const delta = patch({ topic: "members", op: "remove", id: guest.userId });
    const departed = { ...baseline, members: [member], voice: [] };
    expect(reduceLiveState(fixture(), delta!)).toEqual(departed);
  });
  it.each([0, 1])("caps snapshots and reduced state at 1 MiB + %s UTF-8 bytes", async (extra) => {
    const row = { ...member, nick: "é".repeat(100) };
    const crowd = Array.from({ length: 3895 }, (_, i) => ({ ...row, userId: `${i + 1000}` }));
    const state = fixture({ ...baseline, members: [...baseline.members, ...crowd] });
    const value = { ...event, description: "é".repeat(67) + (extra ? "é" : "x") };
    const delta = patch({ topic: "events", op: "upsert", id: event.id, value });
    const candidate = { ...state, events: [value] };
    const snapshot = { ...snapshotEnvelope, topics: candidate };
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBe(1024 * 1024 + extra);
    expect(reduceLiveState(state, delta!) !== null).toBe(extra === 0);
    expect(snapshotTopics(candidate, guildId) !== null).toBe(extra === 0);
    expect((await pullTopics(async () => Response.json(snapshot))()) !== null).toBe(extra === 0);
  });

  it("drops the current baseline if a contiguous batch loses permission proof", async () => {
    const ordinaryRole = { ...role, id: "101" };
    const overwrite = { kind: "role", id: ordinaryRole.id, allow: "1024", deny: "0" };
    const state = fixture({
      ...baseline,
      roles: [role, ordinaryRole],
      members: [member, { ...guest, roleIds: [ordinaryRole.id] }],
      channels: [{ ...room, overwrites: [overwrite] }],
    });
    const delta = patch(removeRole(ordinaryRole.id));
    expect(reduceLiveState({ ...state, channels: fixture().channels }, delta!)).toEqual(baseline);
    const sequence = new LiveSequence(async () => ({ state, seq: 1 }), reduceLiveState);
    expect(await sequence.synchronize()).toBe(true);
    expect(await sequence.ingest(2, delta!)).toBe("unavailable");
    expect(sequence.current).toBeNull();
  });
});
