// Kit event-edit page contract: the Svelte port of EventFormPage mode="edit"
// (src/admin/pages/event-form-page.tsx + event-form-fields.tsx,
// event-form-status.tsx, event-form-roster.tsx) keeps the Hono panel's no-JS
// behaviour and progressive islands, so flipping the manifest entry cannot
// silently drop a field, a transition button, a roster control or an island.
// The Hono POST /admin/events/:key update, the publish/cancel/RSVP-pause
// /RSVP-reopen transitions (422 re-render / 303 redirect) and the guarded
// /admin/events/:key/edit legacy redirect stay the single write authorities
// until a later write slice lands: every ported form keeps submitting to the
// unchanged Hono controllers during mixed mode. There is deliberately no
// event delete anywhere on this resource, and the Svelte port adds none.
//
// Source-text by design: the root Vitest suite cannot compile .svelte, and
// these pins are the exact selectors the admin edit E2E suite drives. The
// accessibility-notes field is the exception: it renders through the shared
// EventNotesField SSR component (like the host/join fields), so this suite
// pins the Svelte slot plus the executed shared output, not an inline template.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVENT_BASELINE_FIELD } from "../src/admin/event-baseline";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditRosterRow,
  type KitEventEditRow,
} from "../src/admin/kit-event-edit";
import { EventNotesField } from "../src/admin/pages/event-host-join-fields";
import type { Db } from "../src/db/index";

const source = readFileSync(
  fileURLToPath(new URL("../web/src/routes/admin/events/[key]/+page.svelte", import.meta.url).href),
  "utf8",
);
const load = readFileSync(
  fileURLToPath(
    new URL("../web/src/routes/admin/events/[key]/+page.server.ts", import.meta.url).href,
  ),
  "utf8",
);

describe("Kit event-edit page contract", () => {
  it("posts the edit form to the Hono-owned update endpoint with the editor guard", () => {
    expect(source).toContain("<form");
    expect(source).toContain('method="post"');
    expect(source).toContain("action={`/admin/events/${data.view.key}`}");
    expect(source).toContain('data-event-editor=""');
    expect(source).toContain("data-event-draft");
    expect(source).toContain('data-testid="save-event"');
    expect(source).toContain(">Save<");
    expect(source).toContain('href="/admin/events">Cancel');
    // The Hono-owned update refuses a save without the current baseline, so
    // the ported form carries the view's mint under the shared carrier name.
    expect(source).toContain('type="hidden"');
    expect(source).toContain('name="saved_baseline"');
    expect(EVENT_BASELINE_FIELD).toBe("saved_baseline");
    expect(source).toContain("view.baseline");
  });

  it("keeps every Hono field name, id and label the E2E suite drives", () => {
    // Accessibility notes are not inline here: they render through the shared
    // EventNotesField SSR slot pinned below (like the host/join fields), so
    // the E2E selectors for notes bind the executed shared output instead.
    for (const name of [
      "title",
      "game",
      "description",
      "starts_at",
      "ends_at",
      "timezone",
      "location",
      "capacity",
    ]) {
      expect(source).toContain(`name="${name}"`);
    }
    for (const id of [
      "f-title",
      "f-game",
      "f-description",
      "f-starts-at",
      "f-ends-at",
      "f-timezone",
      "f-location",
      "f-capacity",
    ]) {
      expect(source).toContain(id);
    }
    expect(source).toContain("Starts (local wall time, YYYY-MM-DD HH:mm)");
    expect(source).toContain("Ends (local wall time, YYYY-MM-DD HH:mm)");
    expect(source).toContain("The IANA zone the wall time above is typed in. Storage is UTC.");
    expect(source).toContain("Capacity (empty = unlimited)");
  });

  it("shows the series-move note instead of the create-only recurrence fieldset", () => {
    expect(source).toContain('data-testid="series-info"');
    // The exact Hono sentence lives in the load's seriesNote (pinned by the
    // resolver suite); the page only places it.
    expect(source).toContain("{view.seriesNote}");
    expect(source).not.toContain('name="recurrence_frequency"');
    expect(source).not.toContain('name="recurrence_count"');
    expect(source).not.toContain('name="recurrence_ends_on"');
  });

  it("renders the Hono 422 error shape with retained values and the draft marker", () => {
    expect(source).toContain('data-testid="form-errors"');
    expect(source).toContain("Check the highlighted fields and try again.");
    expect(source).toContain("error-title");
    // Notes errors render through the shared slot pinned below, not inline.
    expect(source).toContain("error-starts_at");
    expect(source).toContain("error-timezone");
    expect(source).toContain("error-location");
    expect(source).toContain("error-capacity");
    expect(source).toContain('role="alert"');
    expect(source).toContain("aria-invalid=");
    expect(source).toContain("aria-describedby=");
  });

  it("renders accessibility notes through the shared SSR slot with the Hono contract", () => {
    // The page places the resolver's pre-rendered field; no inline duplicate
    // template ships in the client bundle.
    expect(source).toContain("{@html view.notesHtml}");
    expect(source).not.toContain('name="accessibility_notes"');
    expect(source).not.toContain("f-accessibility-notes");

    // The shared renderer owns the exact Hono contract: label, hint, limit,
    // control and error wiring. A dropped control or renamed field fails here.
    const html = EventNotesField({
      values: { accessibility_notes: "Step-free access confirmed." },
      errors: {},
    }).toString();
    expect(html).toContain('name="accessibility_notes"');
    expect(html).toContain('id="f-accessibility-notes"');
    expect(html).toContain("Accessibility notes");
    expect(html).toContain(
      "Optional; include only confirmed details, not personal contact information.",
    );
    expect(html).toContain('data-event-text-limit="1000"');
    expect(html).toContain("Step-free access confirmed.");
    expect(html).toContain('aria-describedby="f-accessibility-notes-hint"');
    expect(html).not.toContain('data-testid="error-accessibility_notes"');

    // Hostile values serialize escaped, never as markup.
    const hostile = EventNotesField({
      values: { accessibility_notes: '<b>&"notes"' },
      errors: {},
    }).toString();
    expect(hostile).not.toContain("<b>");
    expect(hostile).toContain("&lt;b&gt;");
    expect(hostile).toContain("&amp;");

    // Error state wires the Hono alert shape the E2E suite drives.
    const errored = EventNotesField({
      values: { accessibility_notes: "draft kept" },
      errors: { accessibility_notes: "Too long" },
    }).toString();
    expect(errored).toContain('data-testid="error-accessibility_notes"');
    expect(errored).toContain('role="alert"');
    expect(errored).toContain('aria-invalid="true"');
    expect(errored).toContain("f-accessibility-notes-error");
    expect(errored).toContain("Too long");
    expect(errored).toContain("draft kept");
  });

  it("mints notesHtml from the stored row through the shared renderer", async () => {
    const db = {} as Db;
    const row: KitEventEditRow = {
      eventKey: "EVTNOTES01",
      title: "Game night",
      game: "Chess",
      description: "Casual play",
      accessibilityNotes: "Step-free access confirmed.",
      organizer_name: null,
      join_url: null,
      join_instructions: null,
      startsAt: new Date("2026-07-01T19:00:00.000Z"),
      endsAt: new Date("2026-07-01T21:00:00.000Z"),
      timezone: "Europe/London",
      location: "Hall",
      capacity: 8,
      status: "draft",
      rsvpOpen: true,
      recurrenceFrequency: null,
    };
    const deps: KitEventEditDeps = {
      db,
      get: async () => ({ ...row }),
      list: async () => ({ rows: [] as KitEventEditRosterRow[], total: 0 }),
      now: new Date("2026-06-15T12:00:00.000Z"),
    };
    const outcome = await resolveKitEventEdit(row.eventKey, {}, deps);
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    // The slot's data source carries the stored notes through the shared
    // renderer: dropping the mint empties the placed field.
    expect(outcome.view.notesHtml).toContain('name="accessibility_notes"');
    expect(outcome.view.notesHtml).toContain("Step-free access confirmed.");
    expect(outcome.view.notesHtml).toContain("Accessibility notes");
    expect(outcome.view.values.accessibility_notes).toBe("Step-free access confirmed.");
  });

  it("keeps the Hono status actions posting to the unchanged transition endpoints", () => {
    expect(source).toContain('aria-label="Status"');
    expect(source).toContain("Status:");
    expect(source).toContain("/publish");
    expect(source).toContain('data-testid="publish-event"');
    expect(source).toContain(">Publish<");
    expect(source).toContain("/cancel");
    expect(source).toContain('data-testid="cancel-event"');
    expect(source).toContain("Cancel event");
    expect(source).toContain("rsvp-pause");
    expect(source).toContain("rsvp-reopen");
    expect(source).toContain("Pause RSVPs");
    expect(source).toContain("Reopen RSVPs");
  });

  it("adds no event delete: destructive actions stay absent on this resource", () => {
    expect(source.toLowerCase()).not.toContain("delete");
  });

  it("keeps the Hono roster section: search, sort, range, table and paging", () => {
    expect(source).toContain('data-testid="rsvp-roster"');
    expect(source).toContain('aria-label="RSVP roster"');
    expect(source).toContain("RSVPs (");
    expect(source).toContain("Save event changes before searching or sorting the roster.");
    expect(source).toContain('data-testid="roster-range"');
    expect(source).toContain('name="roster_q"');
    expect(source).toContain('name="roster_sort"');
    expect(source).toContain('name="roster_order"');
    expect(source).toContain("Search members");
    expect(source).toContain('data-testid="roster-table"');
    expect(source).toContain('data-testid="roster-empty"');
    expect(source).toContain('aria-label="RSVP roster pages"');
    expect(source).toContain('rel="prev"');
    expect(source).toContain('rel="next"');
  });

  it("keeps the progressive text-limit and editor islands with no framework handlers", () => {
    expect(source).toContain("/islands/admin-event-text-limits.js");
    expect(source).toContain("/islands/admin-event-editor.js");
    expect(source).toContain("data-event-text-limit");
    expect(source).not.toContain("on:click");
    expect(source).not.toContain("onclick");
    expect(source).not.toMatch(/on:[a-z]+=/);
  });

  it("renders inside the admin chrome with the edited title and ships no hydration bundle", () => {
    expect(source).toContain("AdminShell");
    expect(source).toContain("Edit ");
    expect(load).toContain("csr = false");
  });

  it("leaves the write and legacy routes to Hono: no Kit action, no edit alias", () => {
    expect(load).not.toContain("actions");
    expect(load).toContain("resolveKitEventEdit");
    expect(load).toContain("params.key");
  });
});
