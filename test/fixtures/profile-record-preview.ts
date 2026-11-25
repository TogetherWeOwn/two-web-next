import type { FrozenEchoSnapshot } from "../../src/events/echoes";

export const profileRecordEntries = [
  {
    day: "2026-10-18",
    date: "18 Oct 2026",
    title: "Guide role given",
    detail: "Helps new members find their feet.",
    kind: "Guide",
  },
  {
    day: "2026-09-04",
    date: "4 Sep 2026",
    title: "Joined Together We Own",
    detail: "Joined the Discord community.",
    kind: "Joined",
  },
] as const;

type FrozenEvent = { title: string; snapshot: FrozenEchoSnapshot };
type EchoEntry = { day: string; title: string; kind: "Echo" };
type ProfileRecord = {
  echoTrail?: string[];
  record: readonly (EchoEntry | (typeof profileRecordEntries)[number])[];
};

// The dormant preview's self-read fixture accepts synthetic, settled events.
// Its trail carries positive event days only. Record rows use the event title and day.
export function profileRecordFixture(
  viewerId: string,
  subject: { id: string; leaderboardOptOut: boolean },
  events: readonly FrozenEvent[],
): ProfileRecord {
  if (viewerId !== subject.id || subject.leaderboardOptOut) {
    return { record: profileRecordEntries };
  }

  const echoes = events.flatMap<EchoEntry>(({ title, snapshot: { echo, members } }) => {
    const attended = members.some(
      (member) => member.userId === subject.id && member.minutes >= echo.thresholdMinutes,
    );
    return attended
      ? [{ day: echo.windowStartsAt.toISOString().slice(0, 10), title, kind: "Echo" }]
      : [];
  });
  if (echoes.length === 0) return { record: profileRecordEntries };

  const newestFirst = (a: { day: string }, b: { day: string }) => b.day.localeCompare(a.day);
  return {
    echoTrail: echoes.sort(newestFirst).map(({ day }) => day),
    record: [...profileRecordEntries, ...echoes].sort(newestFirst),
  };
}
