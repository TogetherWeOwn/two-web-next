// Kit moderator event-create view model: the serializable slice the new-event
// load renders. A fresh GET carries empty values and no errors; a rejected
// POST re-renders through the Hono owner with retained values and per-field
// errors, so the view mirrors that 422 shape (values + errors + dirty-draft
// marker) for parity when the route owns traffic.
import { describe, expect, it } from "vitest";
import { buildEventCreateView } from "../src/admin/kit-event-create";

describe("Kit event-create view model", () => {
  it("renders a fresh form with empty values and no errors", () => {
    expect(buildEventCreateView({}, {})).toEqual({
      values: {},
      errors: {},
      hasErrors: false,
      isDraft: false,
    });
  });

  it("retains submitted values and field errors for a rejected draft", () => {
    const view = buildEventCreateView(
      { title: "Rejected draft", capacity: "8", recurrence_frequency: "weekly" },
      { capacity: "Occurrences must be between 1 and 52." },
    );
    expect(view.values).toEqual({
      title: "Rejected draft",
      capacity: "8",
      recurrence_frequency: "weekly",
    });
    expect(view.errors).toEqual({ capacity: "Occurrences must be between 1 and 52." });
    expect(view.hasErrors).toBe(true);
    expect(view.isDraft).toBe(true);
  });

  it("aggregates event and recurrence errors together, like the Hono owner", () => {
    const view = buildEventCreateView(
      { title: "Game night", starts_at: "bad-start", recurrence_count: "99" },
      {
        starts_at: "Not a date and time (want YYYY-MM-DD HH:mm): bad-start",
        recurrence_count: "Occurrences must be between 1 and 52.",
      },
    );
    expect(Object.keys(view.errors).sort()).toEqual(["recurrence_count", "starts_at"]);
    expect(view.values.starts_at).toBe("bad-start");
    expect(view.hasErrors).toBe(true);
  });

  it("drops non-string values and empty error copy, so Svelte defaults apply", () => {
    const view = buildEventCreateView(
      { title: 42, capacity: "", timezone: "Europe/London" } as unknown as Record<string, unknown>,
      { title: "" },
    );
    expect(view.values).toEqual({ timezone: "Europe/London" });
    expect(view.errors).toEqual({});
    expect(view.hasErrors).toBe(false);
    expect(view.isDraft).toBe(false);
  });
});
