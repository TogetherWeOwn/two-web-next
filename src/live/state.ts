import { type LiveDelta, type LiveState, snapshotTopics } from "./wire";

const indexed = <R>(rows: R[], key: (row: R) => string) =>
  new Map(rows.map((row) => [key(row), row]));

/** Apply the whole batch before checking dependencies. Never mutate the previous baseline. */
export function reduceLiveState(state: LiveState, delta: LiveDelta): LiveState | null {
  const rows = {
    channels: indexed(state.channels, (row) => row.id),
    roles: indexed(state.roles, (row) => row.id),
    members: indexed(state.members, (row) => row.userId),
    voice: indexed(state.voice, (row) => row.userId),
    events: indexed(state.events, (row) => row.id),
  };
  let guild = state.guild;
  for (const op of delta.ops) {
    if (op.op === "remove") {
      rows[op.topic].delete(op.id);
      if (op.topic === "members") rows.voice.delete(op.id);
      if (op.topic === "channels") {
        for (const voice of rows.voice.values())
          if (voice.channelId === op.id) rows.voice.delete(voice.userId);
        for (const event of rows.events.values())
          if (event.channelId === op.id) rows.events.delete(event.id);
      }
      if (op.topic === "roles") {
        for (const member of rows.members.values()) {
          if (!member.roleIds.includes(op.id)) continue;
          rows.members.set(member.userId, {
            ...member,
            roleIds: member.roleIds.filter((id) => id !== op.id),
          });
        }
        // If a channel still references the deleted role, require a fresh baseline
        // rather than guessing whether removing a deny would widen room access.
      }
      continue;
    }
    switch (op.topic) {
      case "guild":
        guild = op.value;
        break;
      case "channels":
        rows.channels.set(op.id, op.value);
        break;
      case "roles":
        rows.roles.set(op.id, op.value);
        break;
      case "members":
        rows.members.set(op.id, op.value);
        break;
      case "voice":
        rows.voice.set(op.id, op.value);
        break;
      case "events":
        rows.events.set(op.id, op.value);
        break;
    }
  }
  const next: LiveState = {
    guild,
    channels: [...rows.channels.values()],
    roles: [...rows.roles.values()],
    members: [...rows.members.values()],
    voice: [...rows.voice.values()],
    events: [...rows.events.values()],
  };
  return snapshotTopics(next, delta.guild_id);
}
