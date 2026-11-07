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
// these pins are the exact selectors the admin edit E2E suite drives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import {
  resolveKitEventEdit,
  type KitEventEditRosterRow,
  type KitEventEditRow,
} from "../src/admin/kit-event-edit";

const eventRow: KitEventEditRow = {
  eventKey: "EVTPAGE01",
  title: "Page night",
  game: null,
  description: null,
  startsAt: new Date("2026-07-01T19:00:00.000Z"),
  endsAt: new Date("2026-07-01T21:00:00.000Z"),
  timezone: "Europe/London",
  location: null,
  capacity: null,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
};
const rosterRow: KitEventEditRosterRow = {
  username: "mod",
  status: "going",
  answeredAt: new Date("2026-06-01T12:00:00.000Z"),
};

// The roster is server-rendered by the resolver (shared Hono EventRosterSection),
// so its markup contract is asserted on the real rosterHtml, not the .svelte text.
async function rosterHtmlFor(
  rawQuery: Record<string, string>,
  list: { rows: KitEventEditRosterRow[]; total: number },
): Promise<string> {
  const outcome = await resolveKitEventEdit(eventRow.eventKey, rawQuery, {
    db: {} as Db,
    get: async () => ({ ...eventRow }),
    list: async () => list,
    now: new Date("2026-06-15T12:00:00.000Z"),
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok view, got ${outcome.kind}`);
  return outcome.view.rosterHtml;
}

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
  });

  it("keeps every Hono field name, id and label the E2E suite drives", () => {
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
    expect(source).toContain("error-starts_at");
    expect(source).toContain("error-timezone");
    expect(source).toContain("error-location");
    expect(source).toContain("error-capacity");
    expect(source).toContain('role="alert"');
    expect(source).toContain("aria-invalid=");
    expect(source).toContain("aria-describedby=");
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
    // Pause renders through pre-rendered server HTML ({@html}): the action
    // and copy live in the load data, never as literals here (client gzip
    // ceiling). Reopen stays an inlined one-click form.
    expect(source).toContain('view.rsvpAction === "rsvp-pause"');
    expect(source).toContain("{@html view.pauseReviewHtml");
    expect(source).not.toMatch(/action=\{[^}]*rsvp-pause/);
    expect(source).not.toMatch(/action="[^"]*rsvp-pause/);
    expect(source).toContain("rsvp-reopen");
    expect(source).toContain("Reopen RSVPs");
  });

  it("adds no event delete: destructive actions stay absent on this resource", () => {
    expect(source.toLowerCase()).not.toContain("delete");
  });

  it("injects the shared server-rendered roster instead of a duplicate Svelte section", () => {
    expect(source).toContain("{@html view.rosterHtml}");
    // The roster markup lives only in the shared Hono EventRosterSection; a
    // second hand-written copy in the client bundle is the duplication this
    // contract refuses.
    expect(source).not.toContain("formatAdminTime");
    expect(source).not.toContain("roster.entries");
    expect(source).not.toContain('data-testid="rsvp-roster"');
  });

  it("keeps the Hono roster section: search, sort, range, table and paging", async () => {
    const html = await rosterHtmlFor({ roster_page: "2" }, { rows: [rosterRow], total: 150 });
    expect(html).toContain('data-testid="rsvp-roster"');
    expect(html).toContain('aria-label="RSVP roster"');
    expect(html).toContain("RSVPs (150)");
    expect(html).toContain("Save event changes before searching or sorting the roster.");
    expect(html).toContain('data-testid="roster-range"');
    expect(html).toContain('name="roster_q"');
    expect(html).toContain('name="roster_sort"');
    expect(html).toContain('name="roster_order"');
    expect(html).toContain("Search members");
    expect(html).toContain('data-testid="roster-table"');
    expect(html).toContain('aria-label="RSVP roster pages"');
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    const empty = await rosterHtmlFor({}, { rows: [], total: 0 });
    expect(empty).toContain('data-testid="roster-empty"');
  });

  it("labels roster instants in UTC like Hono and keeps bad rows visible", async () => {
    const html = await rosterHtmlFor(
      {},
      {
        rows: [
          rosterRow,
          { username: "broken", status: "going", answeredAt: new Date(Number.NaN) },
        ],
        total: 2,
      },
    );
    expect(html).toContain("latest response update in UTC");
    expect(html).toContain('class="admin-chronology"');
    expect(html).toContain('<time datetime="2026-06-01T12:00:00.000Z">');
    expect(html).toContain("broken");
    expect(html.match(/<time\b/g) ?? []).toHaveLength(1);
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
