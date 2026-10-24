// Kit event-create page contract: the Svelte port of EventFormPage mode="new"
// (src/admin/pages/event-form-page.tsx + event-form-fields.tsx) keeps the
// Hono panel's no-JS behaviour and progressive islands, so flipping the
// manifest entry cannot silently drop a field, a testid or an island.
//
// Source-text by design: the root Vitest suite cannot compile .svelte, and
// these pins are the exact selectors the admin create E2E suite drives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../web/src/routes/admin/events/new/+page.svelte", import.meta.url).href),
  "utf8",
);

describe("Kit event-create page contract", () => {
  it("posts a draft-first form to the Hono-owned create endpoint", () => {
    expect(source).toContain("<form");
    expect(source).toContain('method="post"');
    expect(source).toContain('action="/admin/events"');
    expect(source).toContain('data-event-editor=""');
    expect(source).toContain('data-testid="save-event"');
    expect(source).toContain("Create draft");
    expect(source).toContain('href="/admin/events">Cancel');
  });

  it("keeps every Hono field name, id and recurrence control the E2E suite drives", () => {
    for (const name of [
      "title",
      "game",
      "description",
      "starts_at",
      "ends_at",
      "timezone",
      "location",
      "capacity",
      "recurrence_frequency",
      "recurrence_count",
      "recurrence_ends_on",
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
      "f-recurrence-frequency",
      "f-recurrence-count",
      "f-recurrence-ends-on",
    ]) {
      expect(source).toContain(id);
    }
    expect(source).toContain("Does not repeat");
    expect(source).toContain('value="weekly"');
    expect(source).toContain("Occurrences (including the first, max 52)");
    expect(source).toContain("Repeat until (YYYY-MM-DD)");
  });

  it("renders the Hono 422 error shape with retained values and the draft marker", () => {
    expect(source).toContain('data-testid="form-errors"');
    expect(source).toContain("Check the highlighted fields and try again.");
    expect(source).toContain("data-event-draft");
    expect(source).toContain("error-title");
    expect(source).toContain("error-starts_at");
    expect(source).toContain("error-recurrence_count");
    expect(source).toContain('role="alert"');
    expect(source).toContain("aria-invalid=");
  });

  it("keeps the progressive text-limit and editor islands with no framework handlers", () => {
    expect(source).toContain("/islands/admin-event-text-limits.js");
    expect(source).toContain("/islands/admin-event-editor.js");
    expect(source).toContain("data-event-text-limit");
    expect(source).not.toContain("on:click");
    expect(source).not.toContain("onclick");
    expect(source).not.toMatch(/on:[a-z]+=/);
  });

  it("renders inside the admin chrome with its own title and ships no hydration bundle", () => {
    expect(source).toContain("<AdminShell");
    expect(source).toContain('title="New event"');
    const load = readFileSync(
      fileURLToPath(
        new URL("../web/src/routes/admin/events/new/+page.server.ts", import.meta.url).href,
      ),
      "utf8",
    );
    expect(load).toContain("csr = false");
  });
});
