import { describe, expect, it } from "vitest";
import { encodeLiveProjection } from "../src/live/projection";
import type { LiveState } from "../src/live/wire";

type Input = Parameters<typeof encodeLiveProjection>[0];
type Topic = Parameters<typeof encodeLiveProjection>[1];
const view = "1024";
const connect = "1048576";
const viewAndConnect = "1049600";
type Overwrites = LiveState["channels"][number]["overwrites"];
const room = (id: string, overwrites: Overwrites = []) => ({
  id,
  kind: "voice" as const,
  name: `room ${id}`,
  parentId: null,
  position: null,
  overwrites,
});
function acl(kind: "member" | "role", id: string, allow = "0", deny = "0") {
  return { kind, id, allow, deny };
}
const person = (userId: string, roleIds: string[] = [], flags = {}) => ({
  userId,
  roleIds,
  nick: "private nickname",
  bot: false,
  pending: false,
  ...flags,
});
const withViewer = (input: Input, userId: string | null): Input => ({
  ...input,
  viewer: userId === null ? { kind: "public" } : { kind: "member", userId, validUntil: 15 },
  page: { ...input.page, viewerId: userId },
});
const get = (input: Input, topic: Topic): unknown =>
  JSON.parse(encodeLiveProjection(input, topic) ?? "null");

const everyoneNoView = acl("role", "1", "0", view);
const roleView = acl("role", "20", view);
const regulars = ["100", "101", "102", "103", "104"];
function fixture(permissions = viewAndConnect, publicOverwrites: Overwrites = []): Input {
  return {
    guildId: "1",
    now: 10,
    sourceUntil: 20,
    viewer: { kind: "member", userId: "2", validUntil: 15 },
    pageId: "voice-widget",
    page: {
      pageId: "voice-widget",
      guildId: "1",
      viewerId: "2",
      validUntil: 20,
      publicRoomIds: new Set(["10", "11", "12", "16"]),
      memberRoomIds: new Set(["10", "11", "12", "13", "14"]),
      moveRoomIds: new Set(["10", "11"]),
      ownNickname: true,
    },
    state: {
      guild: { ownerId: "3", afkChannelId: "12" },
      channels: [
        room("10", [acl("role", "1", viewAndConnect)]),
        room("11", [everyoneNoView, roleView]),
        room("12"),
        room("13", [roleView, acl("member", "2", "0", view)]),
        room("14", [everyoneNoView, roleView, acl("role", "21", "0", view)]),
        room("15"),
        room("16", publicOverwrites),
      ],
      roles: [
        { id: "1", permissions },
        { id: "20", permissions: "0" },
        { id: "21", permissions: "0" },
        { id: "22", permissions: "8" },
      ],
      members: [
        person("2", ["20", "21"]),
        person("3"),
        person("4", ["22"]),
        ...regulars.concat("107", "108").map((id) => person(id)),
        person("105", [], { bot: true }),
        person("106", [], { pending: true }),
      ],
      voice: [
        ...regulars.concat("105", "106").map((userId) => ({ userId, channelId: "10" })),
        { userId: "107", channelId: "11" },
        { userId: "108", channelId: "12" },
        { userId: "2", channelId: "13" },
      ],
      events: [],
    },
  };
}

const metadata = (id: string) => ({
  channelId: id,
  name: `room ${id}`,
  kind: "voice",
  position: null,
});
const voiceRoom = (id: string, count: number, canMove = false) => ({
  channelId: id,
  name: `room ${id}`,
  count,
  occupants: [],
  occupiedSince: null,
  eventKey: null,
  canMove,
});

const publicCases: [reason: string, permissions: string, overwrites: Overwrites][] = [
  ["everyone CONNECT deny", viewAndConnect, [acl("role", "1", "0", connect)]],
  ["missing guild VIEW_CHANNEL", connect, []],
  ["missing guild CONNECT", view, []],
  ["role VIEW_CHANNEL deny", viewAndConnect, [acl("role", "20", "0", view)]],
  ["member CONNECT deny", viewAndConnect, [acl("member", "107", "0", connect)]],
];

describe("per-viewer live projection", () => {
  it.each(publicCases)("excludes from public voice: %s", (_, permissions, overwrites) => {
    const input = withViewer(fixture(permissions, overwrites), null);
    const { state } = input;
    expect(get(input, "voice")).toEqual({ count: 5 });
    state.voice = state.voice.filter(({ userId }) => userId !== "107");
    expect(get(input, "voice")).toEqual({ count: 5 });
    state.voice.push({ userId: "107", channelId: "16" });
    expect(get(input, "voice")).toEqual({ count: 5 });
    state.voice = state.voice.filter(({ userId }) => userId !== "104");
    expect(get(input, "voice")).toEqual({ count: null });
    state.voice = [];
    expect(get(input, "voice")).toEqual({ count: null });
    for (const topic of ["channels", "members", "events"] as const) {
      expect(encodeLiveProjection(input, topic)).toBeNull();
    }
  });

  it("applies everyone, role unions and final member overwrites; never includes other users' identities", () => {
    const input = fixture();
    expect(get(input, "channels")).toEqual({ rooms: ["10", "11", "14"].map(metadata) });
    expect(get(input, "voice")).toEqual({
      rooms: [voiceRoom("10", 5, true), voiceRoom("11", 1, true), voiceRoom("14", 0)],
    });
    expect(get(input, "members")).toEqual({ member: true, nick: "private nickname" });
    const [target, stage] = input.state.channels;
    if (!target || !stage) throw new Error("missing fixture rooms");
    stage.kind = "stage";
    target.overwrites.push(acl("role", "20", "0", view));
    expect(get(input, "voice")).toEqual({ rooms: [voiceRoom("11", 1), voiceRoom("14", 0)] });
    target.overwrites.push(acl("member", "2", view, connect));
    expect(get(input, "voice")).toEqual({
      rooms: [voiceRoom("10", 5), voiceRoom("11", 1), voiceRoom("14", 0)],
    });
    input.state.members = input.state.members.map((m) => (m.userId === "2" ? person("2") : m));
    target.overwrites = [acl("member", "2", viewAndConnect)];
    expect(get(input, "channels")).toEqual({ rooms: [metadata("10")] });
    expect(get(input, "voice")).toEqual({ rooms: [voiceRoom("10", 5, true)] });
  });

  it("lets owner and administrator bypass Discord overwrites but not the page room boundary", () => {
    const input = fixture();
    for (const userId of ["3", "4"]) {
      expect(get(withViewer(input, userId), "channels")).toEqual({
        rooms: ["10", "11", "13", "14"].map(metadata),
      });
    }
  });

  it("requires fresh source, page, site and Discord membership proof", () => {
    const input = fixture();
    const invalid = [
      { ...input, sourceUntil: input.now },
      { ...input, page: { ...input.page, validUntil: input.now } },
      { ...input, viewer: { kind: "unknown" as const } },
      { ...input, viewer: { kind: "member" as const, userId: "2", validUntil: input.now } },
      withViewer(input, "999"),
      withViewer(input, "106"),
      { ...input, viewer: withViewer(input, "3").viewer },
      { ...input, viewer: { kind: "public" as const } },
      { ...input, pageId: "other-page" },
      { ...input, guildId: "9" },
    ];
    for (const expired of invalid) {
      for (const topic of ["voice", "channels", "members", "events"] as const) {
        expect(encodeLiveProjection(expired, topic)).toBeNull();
      }
    }
    const noGrant = {
      ...input,
      page: { guildId: input.guildId, pageId: input.pageId, viewerId: "2", validUntil: 20 },
    };
    expect(encodeLiveProjection(noGrant, "voice")).toBeNull();
    expect(encodeLiveProjection(noGrant, "members")).toBeNull();
  });

  it("leaves calendar data unavailable even to a fresh member with a valid source row", () => {
    const input = fixture();
    input.state.events.push({
      id: "40",
      channelId: "10",
      status: "scheduled",
      title: "Calendar event",
      description: null,
      location: null,
      startsAt: "2026-11-21T03:00:00Z",
      endsAt: null,
    });
    expect(encodeLiveProjection(input, "events")).toBeNull();
  });

  it("produces stable equality independent of wire order and refuses oversized UTF-8 values", () => {
    const input = fixture();
    const value = encodeLiveProjection(input, "voice");
    input.state.channels.reverse();
    input.state.voice.reverse();
    expect(encodeLiveProjection(input, "voice")).toBe(value);
    input.state.channels = Array.from({ length: 250 }, (_, i) => ({
      ...room(String(i + 200)),
      name: "真".repeat(100),
    }));
    input.page.memberRoomIds = new Set(input.state.channels.map(({ id }) => id));
    expect(encodeLiveProjection(input, "channels")).toBeNull();
  });
});
