const minute = 60_000;
const grace = 10 * minute;

export interface LifelineSchedule {
  eventKey: string;
  startsAt: number;
  endsAt: number;
  /** Whether to show an untimed RSVP plan for this viewer. */
  rsvpOpen?: boolean;
}

type EventFact = { eventKey: string; at: number };

/** Validated site projections, with epoch milliseconds and no member records. */
export interface LifelineFacts {
  opened?: EventFact;
  viewerRsvp?: EventFact;
  terminalSiteReminder?: EventFact & { sent: number; unavailable: number };
  roomSnapshot?: { observedAt: number; fetchFailed: boolean; eventKeys: readonly string[] };
  echo?: EventFact;
  cancelled?: EventFact & { reason?: string };
}

export interface LifelineStep {
  id: "opened" | "seat" | "reminder" | "room" | "counting" | "echo" | "cancelled";
  actor: "Bot" | "Site" | "You, on this site";
  state: "recorded" | "current" | "next" | "planned" | "waiting";
  title: string;
  at?: number;
  detail?: string;
}

export function composeLifeline(schedule: LifelineSchedule, facts: LifelineFacts, now: number) {
  const { eventKey, startsAt, endsAt } = schedule;
  const cancelled =
    facts.cancelled?.eventKey === eventKey && facts.cancelled.at <= now
      ? facts.cancelled
      : undefined;
  const cutoff = cancelled?.at ?? now;
  const matches = (fact?: EventFact) => fact?.eventKey === eventKey && fact.at <= cutoff;
  const windowStart = startsAt - 15 * minute;
  const windowEnd = endsAt + 15 * minute;
  const steps: LifelineStep[] = [];

  function add(
    id: LifelineStep["id"],
    actor: LifelineStep["actor"],
    title: string,
    state: LifelineStep["state"],
    at?: number,
    detail?: string,
  ) {
    steps.push({ id, actor, title, state, at, detail });
  }

  type StepId = LifelineStep["id"];
  function plan(id: StepId, actor: "Site" | "Bot", title: string, at: number, detail?: string) {
    if (cancelled) return;
    const waiting = now > at + grace;
    const prefix = waiting ? `Waiting on the ${actor.toLowerCase()}.` : undefined;
    const copy = [prefix, detail].filter(Boolean).join(" ") || undefined;
    add(id, actor, title, waiting ? "waiting" : "planned", at, copy);
  }

  const { opened, viewerRsvp, terminalSiteReminder: reminder, roomSnapshot, echo } = facts;
  const reminderAt = startsAt - 30 * minute;
  if (opened && matches(opened)) add("opened", "Bot", "Sign-ups opened", "recorded", opened.at);
  if (viewerRsvp && matches(viewerRsvp)) {
    add("seat", "You, on this site", "Your seat is saved", "recorded", viewerRsvp.at);
  } else if (schedule.rsvpOpen && !cancelled) {
    add("seat", "Site", "Save a seat while sign-ups are open", "planned");
  }
  if (reminder && matches(reminder)) {
    const counts = `${reminder.sent} sent · ${reminder.unavailable} unavailable`;
    add("reminder", "Site", "Reminder results recorded", "recorded", reminder.at, counts);
  } else {
    plan("reminder", "Site", "Reminder ping", reminderAt);
  }

  const snapshot = roomSnapshot && roomSnapshot.observedAt <= cutoff ? roomSnapshot : undefined;
  const age = snapshot ? now - snapshot.observedAt : 0;
  const frozen = snapshot && (age > 2 * minute || snapshot.fetchFailed);
  const linked = snapshot?.eventKeys.includes(eventKey);
  if (snapshot && !frozen && linked && snapshot.observedAt >= startsAt) {
    add("room", "Bot", "Event room seen", "recorded", snapshot.observedAt);
  } else {
    const freshness = frozen ? `Last synced ${Math.floor(age / minute)} min ago` : undefined;
    plan("room", "Bot", "Room opens", startsAt, freshness);
  }

  if (cutoff > windowEnd) {
    add("counting", "Bot", "Counting window closed", "recorded", windowEnd);
  } else if (!cancelled) {
    const state = now >= windowStart ? "current" : "planned";
    add("counting", "Bot", "Bot counts who’s in", state, windowStart);
  }
  if (echo && matches(echo)) add("echo", "Site", "Echo frozen", "recorded", echo.at);
  else plan("echo", "Site", "Echo freezes", windowEnd + grace);

  // Real timestamps can move a late fact past another step. Place an untimed
  // seat plan alongside the reminder, without giving it a displayed timestamp.
  steps.sort((a, b) => (a.at ?? reminderAt) - (b.at ?? reminderAt));
  const next = steps.find((step) => step.state === "planned" && (step.at ?? -Infinity) >= now);
  if (next) next.state = "next";
  if (cancelled)
    add("cancelled", "Bot", "Event cancelled", "recorded", cancelled.at, cancelled.reason);
  return steps;
}
