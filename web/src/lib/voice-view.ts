type Freshness = { freshness: "fresh" | "aging" | "frozen"; ageMs: number };
type Room = {
  name: string;
  count: number;
  eventKey?: string | undefined;
  occupants: readonly { name: string; avatarUrl?: string }[];
};

// Only pass the trusted audience projection, never wire rooms or raw IDs.
export type VoiceView =
  | { audience: "guest"; snapshot: (Freshness & { count: number }) | null }
  | { audience: "member"; snapshot: (Freshness & { rooms: readonly Room[] }) | null };

export type NextVoiceEvent = { title: string; timeLabel: string };
export type LiveVoiceEvent = { key: string; title: string };

export function freshnessLabel({ freshness, ageMs }: Freshness) {
  const seconds = Math.floor(ageMs / 1000);
  const age = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
  return `${freshness === "frozen" ? "Last synced" : "Updated"} ${age} ago`;
}

export function visibleCount(rooms: readonly Room[]) {
  return rooms.reduce((sum, room) => sum + room.count, 0);
}

// Keep the kit's sentence budget without truncating time, count or scope labels.
function eventPhrase(title: string, suffix: string, other: string) {
  const limit = 119 - suffix.length - (other ? other.length + 1 : 0);
  if (limit < 2) return "See what's on next.";
  const chars = [...title];
  const label =
    chars.length <= limit
      ? title
      : `${chars
          .slice(0, limit - 1)
          .join("")
          .trimEnd()}…`;
  return `${label}${suffix}`;
}

export function liveSentence(view: VoiceView, next?: NextVoiceEvent | null, live?: LiveVoiceEvent) {
  const nextPhrase = (other: string) => {
    if (next) return eventPhrase(next.title, ` is at ${next.timeLabel}.`, other);
    return next === null ? "Nothing scheduled yet." : "See what's on next.";
  };
  if (view.snapshot?.freshness === "frozen") {
    const accent = "Live numbers are catching up.";
    return { lead: nextPhrase(accent), accent };
  }
  if (view.snapshot && live) {
    const count =
      view.audience === "member"
        ? visibleCount(view.snapshot.rooms.filter((room) => room.eventKey === live.key))
        : view.snapshot.count;
    const accent =
      count < 3
        ? ""
        : view.audience === "guest"
          ? `${count} of us are in voice.`
          : `${count} in event rooms you can see.`;
    return { lead: eventPhrase(live.title, " is on right now.", accent), accent };
  }
  let lead = next ? "Next up." : "What's on.";
  if (view.snapshot && (view.audience === "guest" || view.snapshot.rooms.length > 0)) {
    const count =
      view.audience === "guest" ? view.snapshot.count : visibleCount(view.snapshot.rooms);
    lead =
      count < 3
        ? "It's quiet in the rooms you can see."
        : view.audience === "guest"
          ? `${count} of us are in voice right now.`
          : `${count} in voice rooms you can see.`;
  }
  return { lead, accent: nextPhrase(lead) };
}
