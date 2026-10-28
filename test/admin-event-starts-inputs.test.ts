import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import { buildEventListView } from "../src/admin/kit-events";

// These native controls are server HTML, like the existing pause reviews: the
// inert Kit client template must not duplicate their labels or field markup.
describe("server-rendered UTC planning controls", () => {
  it("renders both native date fields with the normalized bound values", () => {
    const view = buildEventListView(
      parseEventListQuery({ starts_from: "2032-02-29", starts_before: "2032-03-02" }),
      [],
    );
    expect(view.startsInputsHtml).toContain('name="starts_from" type="date" value="2032-02-29"');
    expect(view.startsInputsHtml).toContain('name="starts_before" type="date" value="2032-03-02"');
    expect(view.startsInputsHtml).toContain("Starts from (UTC date, included)");
    expect(view.startsInputsHtml).toContain("Starts before (UTC date, excluded)");
  });

  it("escapes even hostile values supplied outside the normalizer", () => {
    const query = {
      ...parseEventListQuery({}),
      startsWindow: {
        from: '\" autofocus onfocus=\"alert(1)',
        before: "<script>alert(2)</script>",
      },
    };
    const html = buildEventListView(query, []).startsInputsHtml;
    expect(html).toContain("&quot; autofocus onfocus=&quot;alert(1)");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).not.toContain('value="" autofocus');
    expect(html).not.toContain("<script>");
  });

  it("delivers the controls as load data rather than duplicating client template copy", () => {
    const page = readFileSync("web/src/routes/admin/events/+page.svelte", "utf8");
    expect(page).toContain("{@html startsInputsHtml}");
    expect(page).not.toContain("Starts from (UTC date, included)");
    expect(page).not.toContain("Starts before (UTC date, excluded)");
  });
});
