import { describe, expect, it } from "vitest";
import { eventContentBaseline } from "../src/admin/event-baseline";
import { type KitEventEditRow, resolveKitEventEdit } from "../src/admin/kit-event-edit";
import type { Db } from "../src/db/index";

const row: KitEventEditRow = {
  eventKey: "EVTREPAIR01",
  title: "Repairable game night",
  game: "Chess",
  description: "Keep the stored draft available for repair.",
  accessibilityNotes: "Step-free entrance.",
  organizer_name: "Riley",
  join_url: "https://meet.example.test/repair",
  join_instructions: "Use the public lobby.",
  startsAt: new Date("2030-07-01T19:00:00.000Z"),
  endsAt: new Date("2030-07-01T21:00:00.123Z"),
  timezone: "Europe/London",
  location: "Hall",
  capacity: 8,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
};

// Unguarded wall formatting or toISOString must not turn a repairable row
// into a 500. A valid peer instant and all non-time fields stay intact.
const cases = [
  {
    name: "nonfinite start with a finite end",
    changes: { startsAt: new Date(Number.NaN) },
    start: "",
    end: "2030-07-01 22:00",
    carrier: "2030-07-01T21:00:00.123Z",
  },
  {
    name: "nonfinite end with a finite start",
    changes: { endsAt: new Date(Number.NaN) },
    start: "2030-07-01 20:00",
    end: "",
    carrier: "",
  },
  {
    name: "two nonfinite instants",
    changes: { startsAt: new Date(Number.NaN), endsAt: new Date(Number.NaN) },
    start: "",
    end: "",
    carrier: "",
  },
  {
    name: "invalid stored timezone with finite instants",
    changes: { timezone: "Not/AZone" },
    start: "",
    end: "",
    carrier: "2030-07-01T21:00:00.123Z",
  },
  {
    name: "healthy instants and timezone (control)",
    changes: {},
    start: "2030-07-01 20:00",
    end: "2030-07-01 22:00",
    carrier: "2030-07-01T21:00:00.123Z",
  },
];

describe("Kit event edit: corrupt stored times remain repairable", () => {
  it.each(cases)("renders $name without losing the raw-row baseline", async (entry) => {
    const stored: KitEventEditRow = { ...row, ...entry.changes };
    const baseline = await eventContentBaseline(stored);
    const outcome = await resolveKitEventEdit(
      stored.eventKey,
      {},
      {
        db: {} as Db,
        get: async () => stored,
        list: async () => ({ rows: [], total: 0 }),
        now: new Date("2030-06-01T12:00:00.000Z"),
      },
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("Expected a repairable edit form");
    expect(outcome.view.values).toEqual({
      title: "Repairable game night",
      game: "Chess",
      description: "Keep the stored draft available for repair.",
      accessibility_notes: "Step-free entrance.",
      organizer_name: "Riley",
      join_url: "https://meet.example.test/repair",
      join_instructions: "Use the public lobby.",
      starts_at: entry.start,
      ends_at: entry.end,
      timezone: entry.changes.timezone ?? "Europe/London",
      location: "Hall",
      capacity: "8",
    });
    expect(outcome.view.endsAt).toBe(entry.carrier);
    expect(outcome.view.baseline).toBe(baseline);
    expect(outcome.view.baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.view.errors).toEqual({});
    expect(outcome.view.hasErrors).toBe(false);
    expect(outcome.view.isDraft).toBe(false);
  });
});
