import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LiveSequence } from "../src/live/sequence";
import { reduceLiveState } from "../src/live/state";
import { signedLiveSnapshot } from "../src/live/transport";
import { decodeLiveDelta, type LiveState, snapshotTopics } from "../src/live/wire";

const guildId = "100";
const room = {
  id: "200",
  name: "Test room",
  kind: "voice",
  parentId: null,
  position: 1,
  overwrites: [],
};
const member = { userId: "300", roleIds: [], nick: null, bot: false, pending: false };
const role = { id: guildId, permissions: "1024" };
const occupant = { userId: member.userId, channelId: room.id };
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
  members: [member],
  voice: [occupant],
  events: [event],
};
const update = { topic: "voice", op: "upsert", id: member.userId, value: occupant };
const envelope = { v: 1, guild_id: guildId, seq: 2, occurred_at: event.startsAt, ops: [update] };

const decode = (value: unknown, id = guildId) =>
  decodeLiveDelta(new Uint8Array(new TextEncoder().encode(JSON.stringify(value))).buffer, id);
const patch = (...ops: unknown[]) => decode({ ...envelope, ops: [update, ...ops] });

function completeState(raw: unknown = baseline): LiveState {
  const state = snapshotTopics(raw, guildId);
  if (!state) throw new Error("Invalid live state fixture");
  return state;
}

describe("live wire allowlist", () => {
  it("admits the whole parent-format batch and a complete snapshot", () => {
    expect(decode(envelope)).toEqual(envelope);
    expect(completeState()).toEqual(baseline);
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
    expect(patch({ ...update, id: "301" })).toBeNull();
    expect(patch({ ...update, value: { ...occupant, token: "fixture-only" } })).toBeNull();
    expect(patch({ ...update, op: "remove" })).toBeNull();
    expect(patch({ topic: "guild", op: "upsert", id: "101", value: baseline.guild })).toBeNull();
    expect(patch({ topic: "presence", op: "remove", id: member.userId })).toBeNull();
    expect(decodeLiveDelta(Uint8Array.of(255).buffer, guildId)).toBeNull();
  });

  it("requires unique keys and complete permission dependencies in snapshot topics", () => {
    expect(snapshotTopics({ ...baseline, members: [member, member] }, guildId)).toBeNull();
    expect(
      snapshotTopics({ ...baseline, members: [{ ...member, roleIds: ["101"] }] }, guildId),
    ).toBeNull();
    expect(snapshotTopics({ ...baseline, roles: [] }, guildId)).toBeNull();
    expect(snapshotTopics({ ...baseline, channels: [] }, guildId)).toBeNull();
    expect(snapshotTopics({ ...baseline, rawDiscord: {} }, guildId)).toBeNull();
  });
});

it("recovers complete state on a gap through one exact signed snapshot pull", async () => {
  const config = {
    keyId: "fixture",
    secret: "offline signing fixture",
    origin: "https://producer.example",
    guildId,
  };
  const snapshot = {
    v: 1,
    guild_id: guildId,
    seq: 8,
    observed_at: event.startsAt,
    topics: baseline,
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot));
  const pull = signedLiveSnapshot(config, (topics) => snapshotTopics(topics, guildId), fetcher);
  const load = vi
    .fn()
    .mockResolvedValueOnce({ seq: 2, state: completeState() })
    .mockImplementation(pull);
  const sequence = new LiveSequence(load, reduceLiveState);
  expect(await sequence.synchronize()).toBe(true);
  const recovery = sequence.ingest(8, { ...decode(envelope)!, seq: 8 });
  expect(sequence.current).toBeNull();
  expect(await recovery).toBe("resynced");
  expect(sequence.current).toEqual({ seq: 8, state: baseline });
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  const body = '{"action":"live.snapshot","guild_id":"100"}';
  expect(url).toBe("https://producer.example/internal/actions");
  expect(init).toMatchObject({ method: "POST", redirect: "manual", body });
  const headers = new Headers(init?.headers);
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = [
    "POST",
    "/internal/actions",
    headers.get("X-TWO-Timestamp"),
    headers.get("X-TWO-Nonce"),
    digest,
  ].join("\n");
  expect(headers.get("X-TWO-Key-Id")).toBe(config.keyId);
  expect(headers.get("X-TWO-Signature")).toBe(
    `sha256=${createHmac("sha256", config.secret).update(canonical).digest("hex")}`,
  );
});

describe("live batch reduction", () => {
  it("commits a move and room creation atomically, irrespective of dependency order", () => {
    const newRoom = { ...room, id: "201" };
    const move = { ...update, value: { ...occupant, channelId: newRoom.id } };
    const delta = patch(move, { topic: "channels", op: "upsert", id: newRoom.id, value: newRoom });
    const state = completeState();
    expect(reduceLiveState(state, delta!)?.voice).toEqual([move.value]);
    expect(state.voice).toEqual([occupant]);
  });

  it("withdraws voice and linked events on a channel removal", () => {
    const state = completeState();
    const delta = patch({ topic: "channels", op: "remove", id: room.id });
    expect(reduceLiveState(state, delta!)).toEqual({
      ...baseline,
      voice: [],
      events: [],
      channels: [],
    });
  });

  it("drops the current baseline if a contiguous batch loses permission proof", async () => {
    const state = completeState();
    const delta = patch({ topic: "roles", op: "remove", id: guildId });
    const sequence = new LiveSequence(async () => ({ state, seq: 1 }), reduceLiveState);
    expect(await sequence.synchronize()).toBe(true);
    expect(await sequence.ingest(2, delta!)).toBe("unavailable");
    expect(sequence.current).toBeNull();
  });
});
