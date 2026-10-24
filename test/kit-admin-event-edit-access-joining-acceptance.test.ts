// Acceptance pins for the Kit moderator event-edit access/joining carry-through
// (GET /admin/events/:key through resolveKitEventEdit plus the Svelte page
// under web/src/routes/admin/events/[key]/). The Hono edit form renders four
// optional controls the Kit port currently drops: accessibility_notes (1000),
// organizer_name (500), join_url (2048, public http(s) policy) and
// join_instructions (5000). Kit posts to the Hono full-form update endpoint,
// where an omitted field parses as null and writes through, so a Kit save
// today silently wipes values a moderator set in Hono. These rows pin the
// carry-through: the four controls with Hono field names and matching
// label/help semantics, the limits, the URL policy refusal, the round-trip
// matrix (filled preserved, blanked deliberately cleared, Hono-set values
// surviving a carrying Kit save), inline field errors, the untouched
// route-ownership flag and the no-JS submit. Hermetic by construction: the
// resolver deps are fakes, validation is pure and the page pins are
// source-text, because the root Vitest suite cannot compile .svelte. No
// database, staging or production data is touched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditOutcome,
  type KitEventEditRow,
  type KitEventEditView,
} from "../src/admin/kit-event-edit";
import { parseEventForm } from "../src/admin/validation-event-form";
import { ValidationError } from "../src/admin/validation-shared";
import { ROUTE_MANIFEST } from "../src/route-ownership";

const db = {} as Db;
const now = new Date("2026-06-15T12:00:00.000Z");

const baseRow: KitEventEditRow = {
  eventKey: "EVTACC868",
  title: "Acceptance night",
  game: "Chess",
  description: "Casual play",
  startsAt: new Date("2026-07-01T19:00:00.000Z"),
  endsAt: new Date("2026-07-01T21:00:00.000Z"),
  timezone: "Europe/London",
  location: "Hall",
  capacity: 8,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
};

// Hono-set joining details the Kit read must carry: the stored row uses the
// EventRow column spellings (camel accessibilityNotes, snake joining trio).
const ACCESSIBILITY_NOTES = "Step-free side door; hearing loop fitted";
const ORGANIZER_NAME = "Jordan";
const JOIN_URL = "https://example.com/lobby";
const JOIN_INSTRUCTIONS = "Ask for the community table on level two";

const rowWithJoining = {
  ...baseRow,
  accessibilityNotes: ACCESSIBILITY_NOTES,
  organizer_name: ORGANIZER_NAME,
  join_url: JOIN_URL,
  join_instructions: JOIN_INSTRUCTIONS,
} as unknown as KitEventEditRow;

function depsFor(overrides: Partial<KitEventEditDeps> = {}): KitEventEditDeps {
  return {
    db,
    get: async () => ({ ...rowWithJoining }),
    list: async () => ({ rows: [], total: 0 }),
    now,
    ...overrides,
  };
}

async function okView(
  rawQuery: Parameters<typeof resolveKitEventEdit>[1] = {},
  overrides: Partial<KitEventEditDeps> = {},
): Promise<KitEventEditView> {
  const outcome: KitEventEditOutcome = await resolveKitEventEdit(
    baseRow.eventKey,
    rawQuery,
    depsFor(overrides),
  );
  if (outcome.kind !== "ok") throw new Error(`expected ok view, got ${outcome.kind}`);
  return outcome.view;
}

function validForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Tournament night",
    game: "Chess",
    description: "Casual play",
    starts_at: "2026-07-01 20:00",
    ends_at: "2026-07-01 22:00",
    timezone: "Europe/London",
    location: "Hall",
    capacity: "8",
    ...overrides,
  };
}

function fieldErrorOf(form: Record<string, unknown>, field: string): string | undefined {
  try {
    parseEventForm(form);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return err.fields[field];
  }
  return undefined;
}

const kitPage = readFileSync(
  fileURLToPath(new URL("../web/src/routes/admin/events/[key]/+page.svelte", import.meta.url).href),
  "utf8",
);
const kitLoad = readFileSync(
  fileURLToPath(
    new URL("../web/src/routes/admin/events/[key]/+page.server.ts", import.meta.url).href,
  ),
  "utf8",
);
const honoFields = readFileSync(
  fileURLToPath(new URL("../src/admin/pages/event-form-fields.tsx", import.meta.url).href),
  "utf8",
);
const honoRoutes = readFileSync(
  fileURLToPath(new URL("../src/admin/routes.tsx", import.meta.url).href),
  "utf8",
);
const storeWrites = readFileSync(
  fileURLToPath(new URL("../src/admin/store-event-writes.ts", import.meta.url).href),
  "utf8",
);

// The edit form is the first form on the Kit page; status and roster forms
// follow. Splitting on the first close keeps the new controls pinned inside
// the update form a no-JS browser submits.
const kitEditForm = kitPage.split("</form>")[0] ?? "";

// The control tag carrying a field name: the first input/textarea tag whose
// own attributes contain the name. The tag-name match skips the Hono Field
// wrapper (which repeats the name as a component prop) and the negated class
// cannot cross a tag boundary, so multi-line controls still match exactly.
// Empty when the control is absent, so the limit/kind assertions below fail
// for the missing control.
function controlTag(page: string, name: string): string {
  const match = page.match(new RegExp(`<(?:textarea|input)[^>]*name="${name}"[^>]*>`));
  return match ? match[0] : "";
}

describe("acceptance: Hono source of truth for the four controls", () => {
  it("the Hono edit form renders all four controls with snake_case names and control kinds", () => {
    for (const name of ["accessibility_notes", "organizer_name", "join_url", "join_instructions"]) {
      expect(honoFields).toContain(`name="${name}"`);
    }
    expect(controlTag(honoFields, "accessibility_notes")).toContain("<textarea");
    expect(controlTag(honoFields, "organizer_name")).toContain("<input");
    expect(controlTag(honoFields, "join_url")).toContain('type="url"');
    expect(controlTag(honoFields, "join_instructions")).toContain("<textarea");
  });

  it("the Hono edit form pins the text limits on its control tags", () => {
    expect(controlTag(honoFields, "accessibility_notes")).toContain("1000");
    expect(controlTag(honoFields, "organizer_name")).toContain("500");
    expect(controlTag(honoFields, "join_instructions")).toContain("5000");
  });

  it("the Hono edit values carry the four stored columns into the form", () => {
    expect(honoRoutes).toContain("accessibility_notes: row.accessibilityNotes");
    expect(honoRoutes).toContain("organizer_name: row.organizer_name");
    expect(honoRoutes).toContain("join_url: row.join_url");
    expect(honoRoutes).toContain("join_instructions: row.join_instructions");
  });
});

describe("acceptance: Kit edit renders the four access/joining controls", () => {
  it("renders the accessibility_notes textarea with the Hono field name, id and limit", () => {
    expect(kitPage).toContain('name="accessibility_notes"');
    expect(kitPage).toContain("f-accessibility-notes");
    const tag = controlTag(kitPage, "accessibility_notes");
    expect(tag).toContain("<textarea");
    expect(tag).toContain("1000");
  });

  it("renders the organizer_name input with the Hono field name, id and limit", () => {
    expect(kitPage).toContain('name="organizer_name"');
    expect(kitPage).toContain("f-organizer-name");
    const tag = controlTag(kitPage, "organizer_name");
    expect(tag).toContain("<input");
    expect(tag).toContain('type="text"');
    expect(tag).toContain("500");
  });

  it("renders the join_url input with the Hono field name and id as a url control", () => {
    expect(kitPage).toContain('name="join_url"');
    expect(kitPage).toContain("f-join-url");
    expect(controlTag(kitPage, "join_url")).toContain('type="url"');
  });

  it("renders the join_instructions textarea with the Hono field name, id and limit", () => {
    expect(kitPage).toContain('name="join_instructions"');
    expect(kitPage).toContain("f-join-instructions");
    const tag = controlTag(kitPage, "join_instructions");
    expect(tag).toContain("<textarea");
    expect(tag).toContain("5000");
  });

  it("matches the Hono label and safety-help semantics on all four controls", () => {
    expect(kitPage).toContain("Accessibility notes");
    expect(kitPage).toContain("Organizer display name");
    expect(kitPage).toContain("Public joining link");
    expect(kitPage).toContain("Public joining instructions");
    // Safety copy: moderators must see the confirmed-details and no-contact
    // guidance Hono shows, not bare labels.
    expect(kitPage).toContain("confirmed details");
    expect(kitPage).toContain("agreed to show publicly");
    expect(kitPage).toContain("visible to everyone");
    expect(kitPage).toContain("attendee-only");
    expect(kitPage).toContain("safe for anyone to see");
  });
});

describe("acceptance: field limits pinned on the shared parser", () => {
  it("refuses over-limit values with the Hono field messages", () => {
    expect(
      fieldErrorOf(validForm({ accessibility_notes: "a".repeat(1001) }), "accessibility_notes"),
    ).toBe("Keep accessibility notes to 1000 characters.");
    expect(fieldErrorOf(validForm({ organizer_name: "a".repeat(501) }), "organizer_name")).toBe(
      "Keep the organizer name to 500 characters.",
    );
    expect(fieldErrorOf(validForm({ join_url: "a".repeat(2049) }), "join_url")).toBe(
      "Keep the public joining link to 2048 characters.",
    );
    expect(
      fieldErrorOf(validForm({ join_instructions: "a".repeat(5001) }), "join_instructions"),
    ).toBe("Keep joining instructions to 5000 characters.");
  });

  it("accepts at-limit values on all four fields", () => {
    const joinUrl = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`;
    expect(joinUrl).toHaveLength(2048);
    const input = parseEventForm(
      validForm({
        accessibility_notes: "a".repeat(1000),
        organizer_name: "a".repeat(500),
        join_url: joinUrl,
        join_instructions: "a".repeat(5000),
      }),
    );
    expect(input.accessibilityNotes).toHaveLength(1000);
    expect(input.organizer_name).toHaveLength(500);
    expect(input.join_url).toHaveLength(2048);
    expect(input.join_instructions).toHaveLength(5000);
  });
});

describe("acceptance: join_url public http(s) policy", () => {
  it("accepts public http and https links", () => {
    expect(parseEventForm(validForm({ join_url: JOIN_URL })).join_url).toBe(JOIN_URL);
    expect(parseEventForm(validForm({ join_url: "http://example.com/lobby" })).join_url).toBe(
      "http://example.com/lobby",
    );
  });

  it("refuses private, credentialed and malformed links with one message", () => {
    const refusal = "Enter a valid public HTTP or HTTPS link without sign-in credentials.";
    for (const bad of [
      "ftp://example.com/lobby",
      "javascript:alert(1)",
      "/relative/path",
      "//example.com/lobby",
      "https://user:pass@example.com/lobby",
      "https://example.com/has space",
      "https://example.com\\back",
      "https://",
      "not a url",
    ]) {
      expect(fieldErrorOf(validForm({ join_url: bad }), "join_url")).toBe(refusal);
    }
  });

  it("the Kit edit form posts to the Hono update endpoint, so the policy governs Kit saves", () => {
    expect(kitPage).toContain("action={`/admin/events/${data.view.key}`}");
    expect(kitEditForm).toContain('method="post"');
  });
});

describe("acceptance: access/joining round-trip matrix", () => {
  it("the Kit read carries Hono-set values into the edit values", async () => {
    const view = await okView();
    const values = view.values as unknown as Record<string, unknown>;
    expect(values.accessibility_notes).toBe(ACCESSIBILITY_NOTES);
    expect(values.organizer_name).toBe(ORGANIZER_NAME);
    expect(values.join_url).toBe(JOIN_URL);
    expect(values.join_instructions).toBe(JOIN_INSTRUCTIONS);
  });

  it("Hono-set values survive a carrying Kit save through the shared parser", async () => {
    const view = await okView();
    const carried = view.values as unknown as Record<string, unknown>;
    const input = parseEventForm({
      title: String(carried.title ?? ""),
      game: String(carried.game ?? ""),
      description: String(carried.description ?? ""),
      accessibility_notes: String(carried.accessibility_notes ?? ""),
      starts_at: String(carried.starts_at ?? ""),
      ends_at: String(carried.ends_at ?? ""),
      timezone: String(carried.timezone ?? "Europe/London"),
      location: String(carried.location ?? ""),
      organizer_name: String(carried.organizer_name ?? ""),
      join_url: String(carried.join_url ?? ""),
      join_instructions: String(carried.join_instructions ?? ""),
      capacity: String(carried.capacity ?? ""),
    });
    expect(input.accessibilityNotes).toBe(ACCESSIBILITY_NOTES);
    expect(input.organizer_name).toBe(ORGANIZER_NAME);
    expect(input.join_url).toBe(JOIN_URL);
    expect(input.join_instructions).toBe(JOIN_INSTRUCTIONS);
  });

  it("filled values are preserved through the shared parser", () => {
    const input = parseEventForm(
      validForm({
        accessibility_notes: ACCESSIBILITY_NOTES,
        organizer_name: ORGANIZER_NAME,
        join_url: JOIN_URL,
        join_instructions: JOIN_INSTRUCTIONS,
      }),
    );
    expect(input.accessibilityNotes).toBe(ACCESSIBILITY_NOTES);
    expect(input.organizer_name).toBe(ORGANIZER_NAME);
    expect(input.join_url).toBe(JOIN_URL);
    expect(input.join_instructions).toBe(JOIN_INSTRUCTIONS);
  });

  it("blanked values are deliberately cleared to null, like Hono", () => {
    const input = parseEventForm(
      validForm({
        accessibility_notes: "",
        organizer_name: "   ",
        join_url: "",
        join_instructions: "   ",
      }),
    );
    expect(input.accessibilityNotes).toBeNull();
    expect(input.organizer_name).toBeNull();
    expect(input.join_url).toBeNull();
    expect(input.join_instructions).toBeNull();
  });

  it("omitted values parse as null: a Kit save that drops the controls wipes Hono-set values", () => {
    const input = parseEventForm(validForm());
    expect(input.accessibilityNotes).toBeNull();
    expect(input.organizer_name).toBeNull();
    expect(input.join_url).toBeNull();
    expect(input.join_instructions).toBeNull();
  });

  it("the store writes the four parsed columns through on update", () => {
    expect(storeWrites).toContain("accessibilityNotes: input.accessibilityNotes");
    expect(storeWrites).toContain("organizer_name: input.organizer_name");
    expect(storeWrites).toContain("join_url: input.join_url");
    expect(storeWrites).toContain("join_instructions: input.join_instructions");
  });
});

describe("acceptance: access/joining field errors render inline on Kit", () => {
  it("renders an alert error block per field with the Kit test id", () => {
    for (const name of ["accessibility_notes", "organizer_name", "join_url", "join_instructions"]) {
      expect(kitPage).toContain(`errors.${name}`);
      expect(kitPage).toContain(`data-testid="error-${name}"`);
    }
    expect(kitPage).toContain("error-accessibility_notes");
    expect(kitPage).toContain('role="alert"');
  });

  it("wires aria-invalid and aria-describedby per field, like the existing Kit controls", () => {
    for (const [name, id] of [
      ["accessibility_notes", "f-accessibility-notes-error"],
      ["organizer_name", "f-organizer-name-error"],
      ["join_url", "f-join-url-error"],
      ["join_instructions", "f-join-instructions-error"],
    ]) {
      expect(kitPage).toContain(`errors.${name} ? "true"`);
      expect(kitPage).toContain(id);
    }
  });
});

describe("acceptance: route ownership stays on Hono", () => {
  it("the edit GET stays disabled: no enablement flip rides this change", () => {
    const entry = ROUTE_MANIFEST.find(
      (route) => route.method === "GET" && route.path === "/admin/events/:key",
    );
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(false);
  });

  it("no POST edit entry exists: the update and transitions stay Hono-owned", () => {
    expect(
      ROUTE_MANIFEST.filter(
        (route) => route.method === "POST" && route.path.startsWith("/admin/events/"),
      ),
    ).toEqual([]);
  });

  it("the legacy create bookmark stays pinned to Hono", () => {
    const entry = ROUTE_MANIFEST.find(
      (route) => route.method === "GET" && route.path === "/admin/events/create",
    );
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(false);
  });
});

describe("acceptance: no-JS submit carries the four controls", () => {
  it("ships server-rendered only with no framework handlers", () => {
    expect(kitLoad).toContain("export const csr = false;");
    expect(kitPage).not.toMatch(/\son(click|submit|input|change|keydown)=/);
    expect(kitPage).not.toContain("on:");
  });

  it("renders all four controls inside the update form a no-JS browser submits", () => {
    for (const name of ["accessibility_notes", "organizer_name", "join_url", "join_instructions"]) {
      expect(kitEditForm).toContain(`name="${name}"`);
    }
    expect(kitEditForm).toContain('data-testid="save-event"');
  });
});
