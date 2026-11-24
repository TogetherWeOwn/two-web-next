import { fitsUtf8ByteLimit } from "../http/length-limit";
import type { LiveState } from "./wire";

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const CONNECT = 1n << 20n;
const COUNT_FLOOR = 5;
const MAX_VALUE_BYTES = 64 * 1024;

type Channel = LiveState["channels"][number];
type Member = LiveState["members"][number];
export type LiveTopic = "voice" | "channels" | "members" | "events";

type Viewer =
  | { kind: "unknown" }
  | { kind: "public" }
  | { kind: "member"; userId: string; validUntil: number };

// Resolve this proof on the server for the current viewer/page. Socket messages
// may pick topics, but never supply proof, page scope, or a viewer identity.
type PageProof = {
  guildId: string;
  pageId: string;
  viewerId: string | null;
  validUntil: number;
  publicRoomIds?: ReadonlySet<string>;
  memberRoomIds?: ReadonlySet<string>;
  moveRoomIds?: ReadonlySet<string>;
  ownNickname?: true;
};

type Projection = {
  state: LiveState;
  guildId: string;
  pageId: string;
  // Local lease on a healthy synchronized source, not a producer timestamp.
  sourceUntil: number;
  viewer: Viewer;
  page: PageProof;
  now: number;
};

function fresh(until: number, now: number): boolean {
  return Number.isFinite(until) && Number.isFinite(now) && until > now;
}

function guildPermissions(state: LiveState, guildId: string, member?: Member) {
  const roles = new Map(state.roles.map(({ id, permissions }) => [id, BigInt(permissions)]));
  let bits = roles.get(guildId);
  if (bits === undefined) return null;
  const assigned = new Set(member?.roleIds);
  for (const id of assigned) {
    const permissions = roles.get(id);
    if (permissions === undefined) return null;
    bits |= permissions;
  }
  assigned.delete(guildId);
  const bypass =
    member !== undefined && (member.userId === state.guild.ownerId || !!(bits & ADMINISTRATOR));
  const userId = member?.userId;
  return (channel: Channel) => {
    if (bypass) return VIEW_CHANNEL | CONNECT;
    let effective = bits;
    let allow = 0n;
    let deny = 0n;
    let userAllow = 0n;
    let userDeny = 0n;
    for (const row of channel.overwrites) {
      if (row.kind === "role" && row.id === guildId) {
        effective = (effective & ~BigInt(row.deny)) | BigInt(row.allow);
      } else if (row.kind === "role" && assigned.has(row.id)) {
        allow |= BigInt(row.allow);
        deny |= BigInt(row.deny);
      } else if (row.kind === "member" && row.id === userId) {
        userAllow = BigInt(row.allow);
        userDeny = BigInt(row.deny);
      }
    }
    return (((effective & ~deny) | allow) & ~userDeny) | userAllow;
  };
}

function orderById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : Number(a.id !== b.id);
}

function projectedValue(
  { state, viewer, guildId, pageId, sourceUntil, page, now }: Projection,
  topic: LiveTopic,
) {
  // Calendar needs its own row admission and display policy, not voice-widget proof.
  if (
    topic === "events" ||
    viewer.kind === "unknown" ||
    page.guildId !== guildId ||
    page.pageId !== pageId ||
    page.viewerId !== (viewer.kind === "member" ? viewer.userId : null) ||
    !fresh(sourceUntil, now) ||
    !fresh(page.validUntil, now)
  )
    return null;
  const members = new Map(state.members.map((member) => [member.userId, member]));
  const member = viewer.kind === "member" ? members.get(viewer.userId) : undefined;
  if (
    viewer.kind === "member" &&
    (!member || member.pending || member.bot || !fresh(viewer.validUntil, now))
  )
    return null;

  if (topic === "members")
    return member && page.ownNickname ? { member: true, nick: member.nick } : null;
  if (!member && topic !== "voice") return null;
  const permissions = guildPermissions(state, guildId, member);
  if (!permissions) return null;
  const approvedRooms = member ? page.memberRoomIds : page.publicRoomIds;
  const visible = new Map<string, bigint>();
  const rooms = state.channels
    .filter((channel) => {
      if (
        !approvedRooms?.has(channel.id) ||
        (channel.kind !== "voice" && channel.kind !== "stage") ||
        channel.id === state.guild.afkChannelId
      )
        return false;
      const bits = permissions(channel);
      // Omit explicitly restricted rooms even if @everyone can see and join them.
      const publicBits = VIEW_CHANNEL | CONNECT;
      if (
        !(bits & VIEW_CHANNEL) ||
        (!member &&
          ((bits & publicBits) !== publicBits ||
            channel.overwrites.some((row) => BigInt(row.deny) & publicBits)))
      )
        return false;
      visible.set(channel.id, bits);
      return true;
    })
    .sort(orderById);

  if (!approvedRooms) return null;
  if (topic === "channels") {
    return {
      rooms: rooms.map(({ id, name, kind, position }) => ({ channelId: id, name, kind, position })),
    };
  }

  const counts = new Map<string, number>();
  let count = 0;
  for (const { userId, channelId } of state.voice) {
    const occupant = members.get(userId);
    if (!visible.has(channelId) || !occupant || occupant.bot || occupant.pending) continue;
    counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
    count++;
  }
  if (!member) return { count: count >= COUNT_FLOOR ? count : null };
  // Do not name occupants without current site-profile consent/identity proof.
  return {
    rooms: rooms.map(({ id, name, kind }) => ({
      channelId: id,
      name,
      count: counts.get(id) ?? 0,
      occupants: [],
      occupiedSince: null,
      eventKey: null,
      canMove:
        kind === "voice" &&
        page.moveRoomIds?.has(id) === true &&
        !!((visible.get(id) ?? 0n) & CONNECT),
    })),
  };
}

/** A deterministic JSON value (not a stream frame). Null means unavailable, never empty. */
export function encodeLiveProjection(input: Projection, topic: LiveTopic): string | null {
  const value = projectedValue(input, topic);
  if (value === null) return null;
  const json = JSON.stringify(value);
  return fitsUtf8ByteLimit(json, MAX_VALUE_BYTES) ? json : null;
}
