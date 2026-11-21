import { z } from "zod";
import { SNAPSHOT_BYTES, utcTimestamp } from "./transport";

// Compact envelope with a 20-digit guild ID, 16-digit sequence and nanosecond UTC timestamp.
const SNAPSHOT_ENVELOPE_BYTES = 121;
export const liveId = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((id) => id.length < 20 || id <= "18446744073709551615");
const permissions = z.string().regex(/^(0|[1-9][0-9]{0,39})$/);
const shortText = z.string().min(1).max(100);
const distinct = (ids: string[]) => new Set(ids).size === ids.length;
const guild = z.strictObject({ ownerId: liveId, afkChannelId: liveId.nullable() });
const channelRow = z.strictObject({
  id: liveId,
  name: shortText,
  kind: z.enum(["voice", "stage", "category", "other"]),
  parentId: liveId.nullable(),
  position: z.number().int().nonnegative().nullable(),
  overwrites: z
    .array(
      z.strictObject({
        kind: z.enum(["role", "member"]),
        id: liveId,
        allow: permissions,
        deny: permissions,
      }),
    )
    .max(100)
    .refine((rows) => distinct(rows.map(({ kind, id }) => `${kind}:${id}`))),
});
const channel = channelRow.refine(({ kind, parentId }) => kind !== "category" || parentId === null);
const role = z.strictObject({ id: liveId, permissions });
const member = z.strictObject({
  userId: liveId,
  roleIds: z.array(liveId).max(250).refine(distinct),
  nick: shortText.nullable(),
  bot: z.boolean(),
  pending: z.boolean(),
});
const voice = z.strictObject({ userId: liveId, channelId: liveId });
const event = z
  .strictObject({
    id: liveId,
    channelId: liveId.nullable(),
    status: z.enum(["scheduled", "active"]),
    title: shortText,
    description: z.string().max(1000).nullable(),
    location: shortText.nullable(),
    startsAt: utcTimestamp,
    endsAt: utcTimestamp.nullable(),
  })
  .refine(({ startsAt, endsAt }) => endsAt === null || Date.parse(endsAt) > Date.parse(startsAt));

const idOf = (row: { id: string }) => row.id;
const userIdOf = (row: { userId: string }) => row.userId;
const collection = <R>(schema: z.ZodType<R>, max: number, key: (row: R) => string) =>
  z
    .array(schema)
    .max(max)
    .refine((rows) => distinct(rows.map(key)));

const topics = z.strictObject({
  guild,
  channels: collection(channel, 500, idOf),
  roles: collection(role, 250, idOf),
  members: collection(member, 10_000, userIdOf),
  voice: collection(voice, 10_000, userIdOf),
  events: collection(event, 100, idOf),
});

export type LiveState = z.infer<typeof topics>;
export function snapshotTopics(value: unknown, guildId: string): LiveState | null {
  const result = topics.safeParse(value);
  if (!result.success) return null;
  const state = result.data;
  const channels = new Map(state.channels.map((row) => [row.id, row]));
  const users = new Set(state.members.map((row) => row.userId));
  const roles = new Set(state.roles.map((row) => row.id));
  if (!roles.has(guildId) || !users.has(state.guild.ownerId)) return null;
  const voiceRoom = (id: string) => {
    const kind = channels.get(id)?.kind;
    return kind === "voice" || kind === "stage";
  };
  if (state.guild.afkChannelId !== null && channels.get(state.guild.afkChannelId)?.kind !== "voice")
    return null;
  if (
    state.channels.some(
      ({ parentId, overwrites }) =>
        (parentId !== null && channels.get(parentId)?.kind !== "category") ||
        overwrites.some(({ kind, id }) => kind === "role" && !roles.has(id)),
    )
  )
    return null;
  if (state.members.some(({ roleIds }) => roleIds.some((id) => !roles.has(id)))) return null;
  if (state.voice.some(({ userId, channelId }) => !users.has(userId) || !voiceRoom(channelId)))
    return null;
  if (state.events.some(({ channelId: id }) => id !== null && !voiceRoom(id))) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  return bytes <= SNAPSHOT_BYTES - SNAPSHOT_ENVELOPE_BYTES ? state : null;
}

const upsert = <T extends string, R>(topic: T, value: z.ZodType<R>, key: (row: R) => string) =>
  z
    .strictObject({ topic: z.literal(topic), op: z.literal("upsert"), id: liveId, value })
    .refine(({ id, value }) => key(value) === id);

const operation = z.union([
  upsert("channels", channel, idOf),
  upsert("roles", role, idOf),
  upsert("members", member, userIdOf),
  upsert("voice", voice, userIdOf),
  upsert("events", event, idOf),
  z.strictObject({ topic: z.literal("guild"), op: z.literal("upsert"), id: liveId, value: guild }),
  z.strictObject({
    topic: z.enum(["channels", "roles", "members", "voice", "events"]),
    op: z.literal("remove"),
    id: liveId,
  }),
]);

const delta = z.strictObject({
  v: z.literal(1),
  guild_id: liveId,
  seq: z.number().int().positive(),
  occurred_at: utcTimestamp,
  ops: z.array(operation).min(1).max(128),
});

export type LiveDelta = z.infer<typeof delta>;
/** Only call with size-bounded, authenticated bytes. Never return partial batches. */
export function decodeLiveDelta(bytes: ArrayBuffer, guildId: string): LiveDelta | null {
  try {
    const json: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    const result = delta.safeParse(json);
    if (!result.success || result.data.guild_id !== guildId) return null;
    if (result.data.ops.some((op) => op.topic === "guild" && op.id !== guildId)) return null;
    return result.data;
  } catch {
    return null;
  }
}
