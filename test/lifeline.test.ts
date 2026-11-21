import { createRequire } from "node:module";
import { expect, it } from "vitest";
import type { LifelineFacts } from "../web/src/lib/lifeline";

// Node strips the types without making root Vitest resolve the Kit tsconfig.
const { composeLifeline } = createRequire(import.meta.url)(
  "../web/src/lib/lifeline.ts",
) as typeof import("../web/src/lib/lifeline");

const min = 60_000;
const eventKey = "raid";
const schedule = { eventKey, startsAt: 60 * min, endsAt: 120 * min };
const fact = (at: number, key = eventKey) => ({ eventKey: key, at });
const timeline = (now: number, facts: LifelineFacts = {}) => composeLifeline(schedule, facts, now);
const row = (id: string, now: number, facts?: LifelineFacts) =>
  timeline(now, facts).find((step) => step.id === id);

it("only records an event's opening and the viewer's site RSVP; never plans opening", () => {
  expect(row("opened", min)).toBeUndefined();
  expect(row("opened", min, { opened: fact(0, "other") })).toBeUndefined();
  expect(row("seat", min, { viewerRsvp: fact(2 * min) })).toBeUndefined();
  const open = { ...schedule, rsvpOpen: true };
  const rows = composeLifeline(open, { opened: fact(0) }, min);
  expect(rows[0]).toMatchObject({ id: "opened", state: "recorded", at: 0 });
  expect(rows[1]).toMatchObject({ id: "seat", state: "planned", at: undefined });
  expect(row("seat", min, { viewerRsvp: fact(min) })).toMatchObject({ state: "recorded", at: min });
});

it("records only aggregate terminal outcomes of this event's site reminder", () => {
  expect(row("reminder", min)).toMatchObject({ state: "next", at: 30 * min });
  expect(row("reminder", 40 * min)?.state).toBe("planned");
  expect(row("reminder", 40 * min + 1)?.detail).toBe("Waiting on the site.");
  const result = { ...fact(55 * min), sent: 4, unavailable: 1, memberIds: ["member-fixture"] };
  expect(row("reminder", 54 * min, { terminalSiteReminder: result })?.state).toBe("waiting");
  const recorded = row("reminder", 55 * min, { terminalSiteReminder: result });
  expect(recorded).toMatchObject({
    state: "recorded",
    at: 55 * min,
    detail: "4 sent · 1 unavailable",
  });
  expect(JSON.stringify(recorded)).not.toContain("member-fixture");
  const other = { ...result, eventKey: "other" };
  expect(row("reminder", 55 * min, { terminalSiteReminder: other })?.state).toBe("waiting");
});

it("requires a matching non-frozen room observed at or after start", () => {
  const snapshot = { observedAt: schedule.startsAt, fetchFailed: false, eventKeys: [eventKey] };
  const room = (now: number, patch = {}) =>
    row("room", now, { roomSnapshot: { ...snapshot, ...patch } });
  expect(room(62 * min)).toMatchObject({ state: "recorded", at: 60 * min });
  expect(room(62 * min + 1)?.detail).toBe("Last synced 2 min ago");
  expect(room(71 * min)?.detail).toBe("Waiting on the bot. Last synced 11 min ago");
  expect(room(60 * min, { fetchFailed: true })?.detail).toBe("Last synced 0 min ago");
  for (const patch of [
    { eventKeys: ["other"] },
    { observedAt: 60 * min - 1 },
    { observedAt: 63 * min },
  ]) {
    expect(room(62 * min, patch)?.state).not.toBe("recorded");
  }
});

it("ticks counting only after the window and waits for the real Echo row", () => {
  expect(row("counting", 45 * min - 1)?.state).toBe("next");
  expect(row("counting", 45 * min)?.state).toBe("current");
  expect(row("counting", 135 * min)?.state).toBe("current");
  expect(row("counting", 135 * min + 1)).toMatchObject({ state: "recorded", at: 135 * min });
  expect(row("echo", 145 * min)).toMatchObject({ state: "next", at: 145 * min });
  expect(row("echo", 155 * min)?.state).toBe("planned");
  expect(row("echo", 155 * min + 1)?.detail).toBe("Waiting on the site.");
  const echo = fact(170 * min);
  expect(row("echo", 172 * min, { echo })).toMatchObject({ state: "recorded", at: echo.at });
});

it("ends at the recorded cancellation and discards plans and later facts", () => {
  expect(row("cancelled", min, { cancelled: fact(2 * min) })).toBeUndefined();
  expect(row("cancelled", min, { cancelled: fact(0, "other") })).toBeUndefined();
  const cancelled = { ...fact(61 * min), reason: "Storm" };
  const roomSnapshot = { observedAt: 60 * min, fetchFailed: false, eventKeys: [eventKey] };
  const facts = { opened: fact(0), echo: fact(170 * min), cancelled, roomSnapshot };
  const rows = timeline(180 * min, facts);
  expect(rows).toEqual(timeline(cancelled.at, facts));
  expect(rows.map((step) => step.id)).toEqual(["opened", "room", "cancelled"]);
  expect(rows.at(-1)).toMatchObject({ state: "recorded", at: cancelled.at, detail: "Storm" });
});
