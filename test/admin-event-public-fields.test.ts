import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { resolveKitEventEdit, type KitEventEditRow } from "../src/admin/kit-event-edit";
import { EventFormFields } from "../src/admin/pages/event-form-fields";
import { EventEditableFields } from "../src/admin/pages/event-editable-fields";
import {
  EventAccessibilityField,
  EventHostFields,
  renderEventPublicFieldsHtml,
} from "../src/admin/pages/event-public-fields";

const values = {
  accessibility_notes: '</textarea><script>alert("notes")</script>',
  organizer_name: 'Sam " & <host>',
  join_url: 'https://example.test/?a=1&b="two"',
  join_instructions: "<img src=x onerror=alert(1)>",
};
const page = readFileSync(
  new URL("../web/src/routes/admin/events/[key]/+page.svelte", import.meta.url).pathname,
  "utf8",
);

describe("shared event public fields", () => {
  it("uses the same escaped fields in Hono and the Kit view, at the same form positions", async () => {
    const row: KitEventEditRow = {
      eventKey: "PUBLIC01",
      title: "Public fields",
      game: null,
      description: null,
      accessibilityNotes: values.accessibility_notes,
      organizer_name: values.organizer_name,
      join_url: values.join_url,
      join_instructions: values.join_instructions,
      startsAt: new Date("2026-07-01T19:00:00Z"),
      endsAt: new Date("2026-07-01T20:00:00Z"),
      timezone: "Europe/London",
      location: null,
      capacity: null,
      status: "draft",
      rsvpOpen: true,
      recurrenceFrequency: null,
    };
    const result = await resolveKitEventEdit(
      row.eventKey,
      {},
      {
        db: {} as Db,
        get: async () => row,
        list: async () => ({ rows: [], total: 0 }),
      },
    );
    if (result.kind !== "ok") throw new Error("expected edit view");
    const rendered = renderEventPublicFieldsHtml(values);
    const kit = result.view.fieldsHtml;
    expect(kit).toContain(rendered.accessibilityFieldHtml);
    expect(kit).toContain(rendered.hostFieldsHtml);
    expect(kit).toBe(String(EventEditableFields({ values: result.view.values, errors: {} })));
    expect(page).toContain("{@html view.fieldsHtml}");
    const hono = String(
      EventFormFields({ mode: "edit", values, errors: {}, action: "/admin/events/PUBLIC01" }),
    );
    expect(hono).toContain(rendered.accessibilityFieldHtml);
    expect(hono).toContain(rendered.hostFieldsHtml);
    expect(kit.indexOf('name="description"')).toBeLessThan(
      kit.indexOf(rendered.accessibilityFieldHtml),
    );
    expect(kit.indexOf(rendered.accessibilityFieldHtml)).toBeLessThan(
      kit.indexOf('name="starts_at"'),
    );
    expect(kit.indexOf('name="location"')).toBeLessThan(kit.indexOf(rendered.hostFieldsHtml));
    expect(kit.indexOf(rendered.hostFieldsHtml)).toBeLessThan(kit.indexOf('name="capacity"'));
    for (const name of Object.keys(values)) {
      expect(hono).toContain(`name="${name}"`);
      expect(page).not.toContain(`name="${name}"`);
    }
    expect(rendered.accessibilityFieldHtml).toContain("&lt;/textarea&gt;&lt;script&gt;");
    expect(rendered.hostFieldsHtml).toContain("&lt;img");
    expect(rendered.hostFieldsHtml).toContain("&quot;");
    expect(rendered.hostFieldsHtml).not.toContain("<img");
    expect(rendered.accessibilityFieldHtml).not.toContain("<script>");
  });

  it.each([
    "title",
    "game",
    "description",
    "starts_at",
    "ends_at",
    "timezone",
    "location",
    "capacity",
  ])("shares retained %s values and error associations without active markup", (name) => {
    const retained = { [name]: '</textarea><script>alert("draft")</script>' };
    const errors = { [name]: "Correct <this>" };
    const html = String(EventEditableFields({ values: retained, errors }));
    const hono = String(
      EventFormFields({ mode: "edit", values: retained, errors, action: "/admin/events/PUBLIC01" }),
    );
    const id = `f-${name.replaceAll("_", "-")}`;
    expect(hono).toContain(html);
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`name="${name}"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(
      `aria-describedby="${id}${name === "timezone" ? "-hint " + id : ""}-error"`,
    );
    expect(html).toContain(`data-testid="error-${name}"`);
    expect(html).toContain("Correct &lt;this&gt;");
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(page).not.toContain(`name="${name}"`);
  });

  it.each([
    ["accessibility_notes", EventAccessibilityField],
    ["organizer_name", EventHostFields],
    ["join_url", EventHostFields],
    ["join_instructions", EventHostFields],
  ] as const)(
    "keeps retained input and hint/error associations for %s on Hono refusals",
    (name, render) => {
      const id = `f-${name.replaceAll("_", "-")}`;
      const html = String(render({ values, errors: { [name]: "Correct <this>" } }));
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain(`aria-describedby="${id}-hint ${id}-error"`);
      expect(html).toContain(`data-testid="error-${name}"`);
      expect(html).toContain("Correct &lt;this&gt;");
      expect(html).not.toContain("<script>");
    },
  );
});
