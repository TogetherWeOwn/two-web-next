// Acceptance contract: the event description textarea gets the same live
// code-point length feedback as the title/game/location inputs. The server
// rejects a description over 1000 code points ("Keep the description to
// 1000 characters."); before this contract the textarea carried no
// data-event-text-limit and the island binder only selected <input>
// controls, so an over-limit description was only caught on submit.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileKitForms,
  formFixtures,
  type FormFixture,
} from "./helpers/admin-validation-correction";
import { EventFormPage } from "../src/admin/pages";
import type { EventRow } from "../src/admin/store";

const DESCRIPTION_MAX = 1000;
const DESCRIPTION_MESSAGE = "Keep the description to 1000 characters.";

const base = {
  title: "Game night",
  game: "Chess",
  location: "Discord",
  timezone: "UTC",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
};
const row: EventRow = {
  id: 1,
  eventKey: "01J0000000000000000000ABCD",
  ...base,
  description: null,
  capacity: null,
  startsAt: new Date("2030-01-01T18:00:00Z"),
  endsAt: new Date("2030-01-01T19:00:00Z"),
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  status: "draft",
  rsvpOpen: true,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function textareaTag(markup: string): string {
  const tags = markup.match(/<textarea\b[^>]*>/g) ?? [];
  const tag = tags.find((candidate) => candidate.includes('name="description"'));
  if (!tag) throw new Error("No description textarea found in markup");
  return tag;
}

let compiler: Awaited<ReturnType<typeof compileKitForms>>;
let kitForms: FormFixture[];
beforeAll(async () => {
  compiler = await compileKitForms();
  kitForms = await formFixtures(compiler, false);
});
afterAll(() => compiler?.dispose());

describe("event description text limit templates", () => {
  it.each(["new", "edit"] as const)(
    "Hono %s form annotates the description textarea with the 1000 code-point limit",
    (mode) => {
      const html = String(EventFormPage({ mode, row, values: base, errors: {} }));
      const tag = textareaTag(html);
      expect(tag).toContain(`data-event-text-limit="${DESCRIPTION_MAX}"`);
      // Native maxlength counts UTF-16 units, not code points; the island
      // owns the measurement, as with the annotated inputs.
      expect(tag).not.toContain("maxlength");
    },
  );

  it.each([
    ["Kit new", "Kit event new"],
    ["Kit edit", "Kit event edit"],
  ] as const)(
    "%s page annotates the description textarea with the 1000 code-point limit",
    (_label, fixtureName) => {
      // Execute the real page: field metadata may be data-driven, but the
      // native textarea and its exact code-point limit must still render.
      const tag = textareaTag(kitForms.find((fixture) => fixture.name === fixtureName)!.html);
      expect(tag).toMatch(
        new RegExp(`data-event-text-limit=(?:"${DESCRIPTION_MAX}"|\\{${DESCRIPTION_MAX}\\})`),
      );
      expect(tag).not.toContain("maxlength");
    },
  );
});

// The served binder is the minified build output; load it the same way as
// test/admin-event-native-unicode.test.ts.
const source = readFileSync(
  new URL("../public/islands/admin-event-text-limits.js", import.meta.url),
  "utf8",
);
const { bindAdminEventTextLimits } = runInNewContext(
  source.replace(/(^|;)export (?=function |const |let |var |class )/gm, "$1") +
    "\n({ bindAdminEventTextLimits });",
  { queueMicrotask },
) as { bindAdminEventTextLimits: (root: unknown) => void };

type ErrorNode = {
  id: string;
  className: string;
  textContent: string;
  hidden: boolean;
  setAttribute: () => void;
};

function controlFixture(tagName: "INPUT" | "TEXTAREA", name: string, max: number, value: string) {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const errors: ErrorNode[] = [];
  const control = {
    tagName,
    name,
    value,
    id: `f-${name}`,
    dataset: { eventTextLimit: String(max) },
    message: "",
    ownerDocument: {
      createElement: (): ErrorNode => ({
        id: "",
        className: "",
        textContent: "",
        hidden: false,
        setAttribute: () => {},
      }),
    },
    form: { addEventListener: () => {} },
    setCustomValidity: (message: string) => {
      control.message = message;
    },
    getAttribute: (key: string) => attributes.get(key) ?? null,
    setAttribute: (key: string, attributeValue: string) => {
      attributes.set(key, attributeValue);
    },
    removeAttribute: (key: string) => {
      attributes.delete(key);
    },
    addEventListener: (type: string, callback: () => void) => {
      listeners.set(type, callback);
    },
    after: (error: ErrorNode) => {
      errors.push(error);
    },
  };
  return { control, attributes, listeners, errors };
}

type Fixture = ReturnType<typeof controlFixture>;

// Unlike a fixture that returns every control for any selector, this root
// honours the binder's selector (tag and [data-event-text-limit] parts), so
// a binder that never selects textareas leaves the textarea unbound here
// exactly as it would in a browser.
function rootFixture(fixtures: Fixture[]) {
  const controls = fixtures.map((fixture) => fixture.control);
  return {
    querySelectorAll: (selector: string) =>
      controls.filter((control) =>
        selector.split(",").some((part) => {
          const trimmed = part.trim();
          const isGroup = trimmed.match(/^:(?:is|where)\(([^)]*)\)/)?.[1];
          if (isGroup) {
            const tags = isGroup.split(",").map((tag) => tag.trim().toUpperCase());
            if (!tags.includes(control.tagName)) return false;
          } else {
            const tag = trimmed.match(/^(?:[a-zA-Z][\w-]*|\*)/)?.[0];
            if (tag && tag !== "*" && control.tagName !== tag.toUpperCase()) return false;
          }
          return [...trimmed.matchAll(/\[([\w-]+)(?:\s*=\s*["']?([^"'\]]*)["']?)?\]/g)].every(
            ([, attribute, expected]) => {
              if (attribute !== "data-event-text-limit") return false;
              if (control.dataset.eventTextLimit === undefined) return false;
              return !expected || control.dataset.eventTextLimit === expected;
            },
          );
        }),
      ),
  };
}

describe("admin event text limit binder: description textarea", () => {
  it("binds a description textarea at 1001 code points with a live error, aria-invalid and custom validity, then clears on correction", () => {
    // Astral characters: 1001 code points is 2002 UTF-16 units, so only a
    // code-point count (like the server's) judges this value correctly.
    const description = controlFixture(
      "TEXTAREA",
      "description",
      DESCRIPTION_MAX,
      "😀".repeat(DESCRIPTION_MAX + 1),
    );
    bindAdminEventTextLimits(rootFixture([description]));

    expect(description.errors).toHaveLength(1);
    expect(description.errors[0]).toMatchObject({
      hidden: false,
      textContent: DESCRIPTION_MESSAGE,
    });
    expect(description.control.message).toBe(DESCRIPTION_MESSAGE);
    expect(description.control.message).not.toBe("");
    expect(description.attributes.get("aria-invalid")).toBe("true");
    expect(description.attributes.get("aria-describedby")).toBe("f-description-limit-error");

    description.control.value = "😀".repeat(DESCRIPTION_MAX);
    description.listeners.get("input")!();
    expect(description.control.message).toBe("");
    expect(description.errors[0]).toMatchObject({ hidden: true, textContent: "" });
    expect(description.attributes.has("aria-invalid")).toBe(false);
  });

  it("still binds annotated inputs alongside the textarea", () => {
    const title = controlFixture("INPUT", "title", 100, "x".repeat(101));
    const description = controlFixture("TEXTAREA", "description", DESCRIPTION_MAX, "");
    bindAdminEventTextLimits(rootFixture([title, description]));

    expect(title.errors).toHaveLength(1);
    expect(title.control.message).toBe("Keep the title to 100 characters.");
    expect(title.attributes.get("aria-invalid")).toBe("true");
    expect(description.errors).toHaveLength(1);
    expect(description.control.message).toBe("");
  });
});
