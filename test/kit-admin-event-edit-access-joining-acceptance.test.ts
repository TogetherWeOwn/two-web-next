// Regression: the Kit moderator event edit (resolveKitEventEdit plus the Svelte
// page under web/src/routes/admin/events/[key]/) must carry the four optional
// controls the Hono edit form renders: accessibility_notes, organizer_name,
// join_url and join_instructions. Kit posts to the shared Hono full-form update
// endpoint, where an omitted field parses as null and writes through, so a Kit
// save that drops the controls silently wipes values a moderator set in Hono.
//
// Executable chain, no DB, browser or build output: a fake stored row ->
// resolveKitEventEdit -> the real Svelte page compiled in memory by
// compileKitForms and server-rendered -> parse5 extraction of the first form's
// native controls (what a no-JS browser submits) -> parseEventForm -> a fake
// stored row again -> resolveKitEventEdit. The shared parser is unchanged:
// omitted controls on a full-form parse are null, blanks clear, explicit values
// retain. No PATCH semantics are invented here.
//
// Adapted from the acceptance test of closed PR #1739 (e0457c82), authored by
// Together We Own / Rick7C2, keeping its limit, URL-policy and round-trip
// intent but replacing its source-string assertions with executed ones.
import {
  attr,
  controlNamed,
  disabled,
  elements,
  firstForm,
  submittedFields,
  textOf,
} from "./helpers/kit-edit-controls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileKitForms } from "./helpers/admin-validation-correction";
import type { Db } from "../src/db/index";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditRow,
  type KitEventEditView,
} from "../src/admin/kit-event-edit";
import { parseEventForm, type EventFormInput } from "../src/admin/validation-event-form";

const db = {} as Db;
const now = new Date("2026-06-15T12:00:00.000Z");
const KEY = "EVTACC868";

const ACCESS = ["accessibility_notes", "organizer_name", "join_url", "join_instructions"] as const;
const CORE = [
  "title",
  "game",
  "description",
  "starts_at",
  "ends_at",
  "timezone",
  "location",
  "capacity",
] as const;

// Stored row spellings: camel accessibilityNotes, snake joining trio.
const storedRow = {
  eventKey: KEY,
  title: "Acceptance night",
  game: "Chess",
  description: "Casual play",
  startsAt: new Date("2026-07-01T18:00:00.000Z"),
  endsAt: new Date("2026-07-01T20:00:00.000Z"),
  timezone: "Europe/London",
  location: "Hall",
  capacity: 8,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
  accessibilityNotes: "Step-free side door; hearing loop fitted",
  organizer_name: "Jordan",
  join_url: "https://example.com/lobby",
  join_instructions: "Ask for the community table on level two",
} as unknown as KitEventEditRow;

function depsFor(row: KitEventEditRow | null, overrides: Partial<KitEventEditDeps> = {}) {
  return {
    db,
    get: async () => (row ? { ...row } : null),
    list: async () => ({ rows: [], total: 0 }),
    now,
    ...overrides,
  } satisfies KitEventEditDeps;
}

async function viewOf(row: KitEventEditRow): Promise<KitEventEditView> {
  const outcome = await resolveKitEventEdit(KEY, {}, depsFor(row));
  if (outcome.kind !== "ok") throw new Error(`expected ok view, got ${outcome.kind}`);
  return outcome.view;
}

let compiler: Awaited<ReturnType<typeof compileKitForms>>;
beforeAll(async () => {
  compiler = await compileKitForms();
});
afterAll(() => compiler?.dispose());

const render = (view: KitEventEditView) => compiler.renderForm(1, { view });

/** The stored row after a Hono full-form update writes the parsed input. */
function applyUpdate(row: KitEventEditRow, input: EventFormInput): KitEventEditRow {
  return {
    ...row,
    title: input.title,
    game: input.game,
    description: input.description,
    startsAt: input.startsAtUtc,
    endsAt: input.endsAtUtc,
    timezone: input.timezone,
    location: input.location,
    capacity: input.capacity,
    accessibilityNotes: input.accessibilityNotes ?? null,
    organizer_name: input.organizer_name ?? null,
    join_url: input.join_url ?? null,
    join_instructions: input.join_instructions ?? null,
  } as unknown as KitEventEditRow;
}

async function save(
  row: KitEventEditRow,
  edit: (fields: Record<string, string>) => Record<string, string> = (f) => f,
) {
  const submitted = edit(submittedFields(render(await viewOf(row))));
  const input = parseEventForm(submitted);
  const next = applyUpdate(row, input);
  return { submitted, input, next, view: await viewOf(next) };
}

describe("native edit control extraction", () => {
  it("excludes disabled, unchecked and submitter controls, but keeps readonly values", () => {
    expect(
      submittedFields(`<form>
        <input name="disabled-input" value="lost" disabled>
        <textarea name="disabled-textarea" disabled>lost</textarea>
        <fieldset disabled>
          <legend><input name="legend" value="kept"></legend>
          <input name="disabled-descendant" value="lost">
          <textarea name="disabled-descendant-text">lost</textarea>
        </fieldset>
        <input name="unchecked" type="checkbox" value="lost">
        <input name="unchecked-radio" type="radio" value="lost">
        <input name="submitter" type="submit" value="lost">
        <input name="readonly" value="kept" readonly>
        <input name="checked" type="checkbox" checked>
        <input name="radio" type="radio" value="kept" checked>
        <textarea name="text">kept</textarea>
      </form>`),
    ).toEqual({ legend: "kept", readonly: "kept", checked: "on", radio: "kept", text: "kept" });
  });
});

describe("Kit edit read carries the access/joining fields", () => {
  it("resolves the stored values into the edit view", async () => {
    const values = (await viewOf(storedRow)).values as unknown as Record<string, string>;
    expect(values.accessibility_notes).toBe("Step-free side door; hearing loop fitted");
    expect(values.organizer_name).toBe("Jordan");
    expect(values.join_url).toBe("https://example.com/lobby");
    expect(values.join_instructions).toBe("Ask for the community table on level two");
  });

  it("resolves null stored values to blank strings", async () => {
    const row = {
      ...storedRow,
      accessibilityNotes: null,
      organizer_name: null,
      join_url: null,
      join_instructions: null,
    } as unknown as KitEventEditRow;
    const values = (await viewOf(row)).values as unknown as Record<string, string>;
    for (const name of ACCESS) expect(values[name]).toBe("");
  });
});

describe("Kit edit page renders the access/joining controls", () => {
  it("renders native controls with Hono names, kinds, limits and stored values", async () => {
    const html = render(await viewOf(storedRow));
    const kinds: Record<(typeof ACCESS)[number], [string, string | undefined]> = {
      accessibility_notes: ["textarea", undefined],
      organizer_name: ["input", "text"],
      join_url: ["input", "url"],
      join_instructions: ["textarea", undefined],
    };
    for (const name of ACCESS) {
      const el = controlNamed(html, name);
      expect(el, name).toBeDefined();
      expect(el?.tagName).toBe(kinds[name][0]);
      expect(attr(el!, "type")).toBe(kinds[name][1]);
      expect(disabled(el!), name).toBe(false);
    }
    expect(attr(controlNamed(html, "accessibility_notes")!, "data-event-text-limit")).toBe("1000");
    expect(attr(controlNamed(html, "organizer_name")!, "data-event-text-limit")).toBe("500");
    expect(attr(controlNamed(html, "join_instructions")!, "data-event-text-limit")).toBe("5000");
    const submitted = submittedFields(html);
    expect(submitted.accessibility_notes).toBe("Step-free side door; hearing loop fitted");
    expect(submitted.organizer_name).toBe("Jordan");
    expect(submitted.join_url).toBe("https://example.com/lobby");
    expect(submitted.join_instructions).toBe("Ask for the community table on level two");
  });

  it("submits to the Hono update endpoint for the resolved key", async () => {
    const form = firstForm(render(await viewOf(storedRow)));
    expect(attr(form, "method")).toBe("post");
    expect(attr(form, "action")).toBe(`/admin/events/${KEY}`);
  });
});

describe("full-form round trip through the shared parser", () => {
  it("retains every core and access field when the page is saved untouched", async () => {
    const { submitted, input, view } = await save(storedRow);
    expect(Object.keys(submitted)).toEqual(expect.arrayContaining([...CORE, ...ACCESS]));
    expect(input.title).toBe("Acceptance night");
    expect(input.game).toBe("Chess");
    expect(input.description).toBe("Casual play");
    expect(input.startsAtUtc).toEqual(storedRow.startsAt);
    expect(input.endsAtUtc).toEqual(storedRow.endsAt);
    expect(input.timezone).toBe("Europe/London");
    expect(input.location).toBe("Hall");
    expect(input.capacity).toBe(8);
    expect(input.accessibilityNotes).toBe("Step-free side door; hearing loop fitted");
    expect(input.organizer_name).toBe("Jordan");
    expect(input.join_url).toBe("https://example.com/lobby");
    expect(input.join_instructions).toBe("Ask for the community table on level two");
    // The second resolver pass shows exactly what the first one did.
    expect(view.values).toEqual((await viewOf(storedRow)).values);
  });

  it("keeps explicit edited values on the changed field only", async () => {
    const { next } = await save(storedRow, (f) => ({
      ...f,
      organizer_name: "Sam",
      join_url: "http://example.com/new",
    }));
    const values = (await viewOf(next)).values as unknown as Record<string, string>;
    expect(values.organizer_name).toBe("Sam");
    expect(values.join_url).toBe("http://example.com/new");
    expect(values.accessibility_notes).toBe("Step-free side door; hearing loop fitted");
    expect(values.join_instructions).toBe("Ask for the community table on level two");
    expect(values.title).toBe("Acceptance night");
  });

  it.each(ACCESS)("blanking %s clears only that field and keeps its siblings", async (name) => {
    const before = (await viewOf(storedRow)).values as unknown as Record<string, string>;
    const { next, view } = await save(storedRow, (f) => ({ ...f, [name]: "   " }));
    const after = view.values as unknown as Record<string, string>;
    expect(after[name]).toBe("");
    for (const other of [...CORE, ...ACCESS]) {
      if (other !== name) expect(after[other], other).toBe(before[other]);
    }
    const stored = next as unknown as Record<string, unknown>;
    expect(stored[name === "accessibility_notes" ? "accessibilityNotes" : name]).toBeNull();
  });

  it.each(["game", "description", "location", "capacity"] as const)(
    "blanking core %s clears only that field and keeps the access fields",
    async (name) => {
      const before = (await viewOf(storedRow)).values as unknown as Record<string, string>;
      const { view } = await save(storedRow, (f) => ({ ...f, [name]: "" }));
      const after = view.values as unknown as Record<string, string>;
      expect(after[name]).toBe("");
      for (const other of [...CORE, ...ACCESS]) {
        if (other !== name) expect(after[other], other).toBe(before[other]);
      }
    },
  );

  it("keeps blank access fields blank across a second save", async () => {
    const blank = {
      ...storedRow,
      accessibilityNotes: null,
      organizer_name: null,
      join_url: null,
      join_instructions: null,
    } as unknown as KitEventEditRow;
    const { input, view } = await save(blank);
    expect(input.accessibilityNotes).toBeNull();
    expect(input.organizer_name).toBeNull();
    expect(input.join_url).toBeNull();
    expect(input.join_instructions).toBeNull();
    expect(view.values).toEqual((await viewOf(blank)).values);
  });
});

describe("omitted controls keep the existing full-form null semantics", () => {
  it("parses each omitted access control as null and leaves core fields intact", async () => {
    const { input } = await save(storedRow, (f) => {
      const copy = { ...f };
      for (const name of ACCESS) delete copy[name];
      return copy;
    });
    expect(input.accessibilityNotes).toBeNull();
    expect(input.organizer_name).toBeNull();
    expect(input.join_url).toBeNull();
    expect(input.join_instructions).toBeNull();
    expect(input.title).toBe("Acceptance night");
    expect(input.game).toBe("Chess");
    expect(input.location).toBe("Hall");
    expect(input.capacity).toBe(8);
  });

  it.each(ACCESS)("omitting only %s nulls only that field", async (name) => {
    const { input } = await save(storedRow, (f) => {
      const copy = { ...f };
      delete copy[name];
      return copy;
    });
    const parsed: Record<(typeof ACCESS)[number], string | null | undefined> = {
      accessibility_notes: input.accessibilityNotes,
      organizer_name: input.organizer_name,
      join_url: input.join_url,
      join_instructions: input.join_instructions,
    };
    for (const other of ACCESS) {
      if (other === name) expect(parsed[other]).toBeNull();
      else expect(parsed[other]).toBeTruthy();
    }
  });
});
