import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveKitEventEdit } from "../src/admin/kit-event-edit";
import type { Db } from "../src/db/index";
import { compileKitForms, eventRow, now } from "./helpers/admin-validation-correction";

// Execute the real SSR form before factoring its repeated error markup. A
// missing call, mismatched id/test id, unconditional error or unsafe HTML sink
// must fail here even when all source-level control pins still pass.
const fields = [
  ["title", "f-title"],
  ["game", "f-game"],
  ["description", "f-description"],
  ["accessibility_notes", "f-accessibility-notes"],
  ["starts_at", "f-starts-at"],
  ["ends_at", "f-ends-at"],
  ["timezone", "f-timezone"],
  ["location", "f-location"],
  ["organizer_name", "f-organizer-name"],
  ["join_url", "f-join-url"],
  ["join_instructions", "f-join-instructions"],
  ["capacity", "f-capacity"],
] as const;

let compiler: Awaited<ReturnType<typeof compileKitForms>>;
beforeAll(async () => {
  compiler = await compileKitForms();
});
afterAll(() => compiler?.dispose());

async function view() {
  const outcome = await resolveKitEventEdit(
    eventRow.eventKey,
    {},
    {
      db: {} as Db,
      get: async () => eventRow,
      list: async () => ({ rows: [], total: 0 }),
      now,
    },
  );
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.view;
}

describe("Kit edit inline errors retain the Hono DOM contract", () => {
  it("retains every value and the exact native control metadata in Hono order", async () => {
    const values = Object.fromEntries(fields.map(([name]) => [name, `retained-${name}`]));
    const html = compiler.renderForm(1, { view: { ...(await view()), values } });
    const form = html.match(/<form\b[^>]*data-event-editor=""[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    const controls = [...form.matchAll(/<(?:input|textarea)\b[^>]*name="([^"]+)"[^>]*>/g)];
    expect(controls.map((match) => match[1])).toEqual(fields.map(([name]) => name));
    const limits: Record<string, number> = {
      title: 100,
      game: 100,
      description: 1000,
      accessibility_notes: 1000,
      location: 255,
      organizer_name: 500,
      join_instructions: 5000,
    };
    for (const [name, id] of fields) {
      const tag = controls.find((match) => match[1] === name)![0];
      expect(tag).toContain(`id="${id}"`);
      expect(html).toContain(`<label for="${id}">`);
      if (["description", "accessibility_notes", "join_instructions"].includes(name)) {
        expect(tag).toContain("<textarea");
        expect(tag).toContain('rows="4"');
        expect(form).toMatch(
          new RegExp(`<textarea[^>]*name="${name}"[^>]*>retained-${name}<\\/textarea>`),
        );
      } else {
        expect(tag).toContain(`type="${name === "join_url" ? "url" : "text"}"`);
        expect(tag).toContain(`value="retained-${name}"`);
      }
      if (limits[name] !== undefined)
        expect(tag).toContain(`data-event-text-limit="${limits[name]}"`);
      else expect(tag).not.toContain("data-event-text-limit");
      expect(/\brequired(?:=""|\s|>)/.test(tag)).toBe(
        ["title", "starts_at", "ends_at"].includes(name),
      );
      if (name === "capacity") expect(tag).toContain('inputmode="numeric"');
    }
    expect(html.match(/src="\/islands\/admin-event-text-limits.js"/g)).toHaveLength(1);
    expect(html.match(/src="\/islands\/admin-event-editor.js"/g)).toHaveLength(1);
  });

  it.each(fields)("%s renders exactly its escaped, associated error", async (name, id) => {
    const error = `Invalid ${name} <img src=x> & retry`;
    const html = compiler.renderForm(1, {
      view: { ...(await view()), errors: { [name]: error }, hasErrors: true },
    });
    const paragraphs = [...html.matchAll(/<p\b[^>]*data-testid="error-[^"]+"[^>]*>[\s\S]*?<\/p>/g)];
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]![0]).toContain(`id="${id}-error"`);
    expect(paragraphs[0]![0]).toContain(`data-testid="error-${name}"`);
    expect(paragraphs[0]![0]).toContain('class="error"');
    expect(paragraphs[0]![0]).toContain('role="alert"');
    expect(paragraphs[0]![0]).toContain(`Invalid ${name} &lt;img src=x> &amp; retry`);
    expect(html).not.toContain("<img src=x>");
    const tag = html.match(new RegExp(`<(?:input|textarea)[^>]*name="${name}"[^>]*>`))?.[0];
    expect(tag).toContain('aria-invalid="true"');
    expect(tag).toMatch(new RegExp(`aria-describedby="[^"]*${id}-error`));
  });

  it("an error-free form renders no inline errors", async () => {
    const html = compiler.renderForm(1, { view: await view() });
    expect(html).not.toContain('data-testid="error-');
    expect(html).not.toContain('aria-invalid="true"');
  });
});
