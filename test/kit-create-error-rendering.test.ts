import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEventCreateView } from "../src/admin/kit-event-create";
import { compileKitForms, summaryFragment } from "./helpers/admin-validation-correction";

const targets = {
  title: "f-title",
  game: "f-game",
  description: "f-description",
  starts_at: "f-starts-at",
  ends_at: "f-ends-at",
  timezone: "f-timezone",
  location: "f-location",
  capacity: "f-capacity",
  recurrence_frequency: "f-recurrence-frequency",
  recurrence_count: "f-recurrence-count",
  recurrence_ends_on: "f-recurrence-ends-on",
};
const entries = Object.entries(targets);
let compiler: Awaited<ReturnType<typeof compileKitForms>>;
beforeAll(async () => {
  compiler = await compileKitForms();
});
afterAll(() => compiler?.dispose());

function check(errors: Record<string, string>) {
  const html = compiler.renderForm(0, buildEventCreateView({}, errors));
  for (const [name, id] of entries) {
    const control = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes(`id="${id}"`));
    expect(control, name).toBeDefined();
    const paragraph = new RegExp(`<p\\b[^>]*id="${id}-error"[^>]*>([\\s\\S]*?)<\\/p>`).exec(html);
    if (errors[name]) {
      expect(paragraph?.[0], name).toContain('class="error"');
      expect(paragraph?.[0]).toContain('role="alert"');
      expect(paragraph?.[0]).toContain(`data-testid="error-${name}"`);
      expect(paragraph?.[1]).toContain("Bad &lt;img src=x> &amp; text");
      expect(control).toContain('aria-invalid="true"');
      expect(control).toMatch(new RegExp(`aria-describedby="[^"]*${id}-error`));
    } else {
      expect(paragraph, name).toBeNull();
      expect(control).not.toContain('aria-invalid="true"');
      expect(control).not.toContain(`${id}-error`);
    }
  }
  return html;
}

describe("compiled Kit create error renderers", () => {
  it("renders no inline errors for a clean form", () => {
    check({});
  });
  for (const [name] of entries) {
    it(`renders only ${name} with escaped text and its association`, () => {
      check({ [name]: "Bad <img src=x> & text" });
    });
  }
  it("renders all eleven errors together", () => {
    check(Object.fromEntries(entries.map(([name]) => [name, "Bad <img src=x> & text"])));
  });
  it("keeps global and unknown errors escaped in the summary without invented controls", () => {
    const html = check({ global: "Global <img> & text", unknown: "Unknown <img> & text" });
    const summary = summaryFragment(html);
    expect(summary).toContain("Global &lt;img> &amp; text");
    expect(summary).toContain("Unknown &lt;img> &amp; text");
    expect(summary).not.toContain("<img>");
    expect(summary).not.toMatch(/href="#(?:f-)?(?:global|unknown)/);
  });
});
