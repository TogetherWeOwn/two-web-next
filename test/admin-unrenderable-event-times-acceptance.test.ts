// Acceptance-owned: the Builder implements the fix without editing this file.
// A corrupt stored instant must not hide the event a moderator needs to repair.
// Fixtures represent already-decoded database rows; no database or network is used.
import { parseFragment } from "parse5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import { buildEventListView, serializeEventListRow } from "../src/admin/kit-events";
import { resolveKitEventEdit } from "../src/admin/kit-event-edit";
import type { Db } from "../src/db/index";
import { savedNightRow } from "./helpers/admin-event-find-saved-nights";
import {
  compileInventoryKit,
  renderInventory,
  type Renderer,
} from "./helpers/admin-inventory-recovery";
import { compileKitForms } from "./helpers/admin-validation-correction";

const identities = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  "01ARZ3NDEKTSV4RRFFQ69G5FAB",
  "01ARZ3NDEKTSV4RRFFQ69G5FAC",
] as const;
const start = "2099-11-01T18:00:00.000Z";
const end = "2099-11-01T21:00:00.000Z";
const cases = [
  { name: "invalid start", startBad: true, endBad: false },
  { name: "invalid end", startBad: false, endBad: true },
  { name: "both invalid", startBad: true, endBad: true },
] as const;

function finiteRows() {
  return identities.map((eventKey, i) =>
    savedNightRow(eventKey, {
      id: i + 1,
      title: ["Finite before", "Needs date repair", "Finite after"][i]!,
      game: "Chess",
      startsAt: new Date(start),
      endsAt: new Date(end),
      status: "draft",
      goingCount: 0,
    }),
  );
}

function corruptRows(startBad: boolean, endBad: boolean) {
  const rows = finiteRows();
  rows[1] = {
    ...rows[1]!,
    // Postgres infinity/out-of-JS-range timestamps arrive at this seam as invalid Dates.
    startsAt: startBad ? new Date(Number.NaN) : new Date(start),
    endsAt: endBad ? new Date(Number.NaN) : new Date(end),
  };
  return rows;
}

type HtmlNode = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
};
function nodes(node: HtmlNode, tag: string): HtmlNode[] {
  return [
    ...(node.nodeName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child) => nodes(child, tag)),
  ];
}
function attribute(node: HtmlNode, name: string) {
  return node.attrs?.find((attr) => attr.name === name)?.value;
}
function text(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  if (node.nodeName === "#comment" || attribute(node, "hidden") !== undefined) return "";
  return (node.childNodes ?? []).map(text).join("");
}
function rowMarkup(html: string, eventKey: string) {
  const row = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].find((match) =>
    match[0].includes(`href="/admin/events/${eventKey}"`),
  );
  expect(row, `event ${eventKey} stays visible with its repair link`).toBeDefined();
  return row![0];
}
function parsedRow(html: string, eventKey: string) {
  return parseFragment(`<table><tbody>${rowMarkup(html, eventKey)}</tbody></table>`);
}
function input(html: string, name: string) {
  const matches = nodes(parseFragment(html), "input").filter(
    (node) => attribute(node, "name") === name,
  );
  expect(matches, `one correctable ${name} input`).toHaveLength(1);
  return matches[0]!;
}
function expectEditable(node: HtmlNode, value: string) {
  expect(attribute(node, "value") ?? "").toBe(value);
  expect(attribute(node, "disabled")).toBeUndefined();
  expect(attribute(node, "readonly")).toBeUndefined();
}

let kitForms: Awaited<ReturnType<typeof compileKitForms>>;
beforeAll(async () => {
  await compileInventoryKit();
  kitForms = await compileKitForms();
});
afterAll(() => kitForms?.dispose());

for (const renderer of ["Hono", "Kit"] satisfies Renderer[]) {
  describe(`${renderer} moderator inventory with unrenderable stored times`, () => {
    it("CONTROL: an all-finite inventory keeps its existing time markup and rows", async () => {
      const result = await renderInventory(renderer, "events", "", finiteRows());
      expect(result.status).toBe(200);
      for (const [i, eventKey] of identities.entries()) {
        const row = parsedRow(result.html, eventKey);
        expect(text(row)).toContain(["Finite before", "Needs date repair", "Finite after"][i]);
        expect(text(row)).toContain("draft");
        const times = nodes(row, "time");
        expect(times).toHaveLength(1);
        expect(attribute(times[0]!, "datetime")).toBe(start);
        expect(text(times[0]!)).toBe(start);
      }
      expect(result.html).not.toContain("Invalid Date");
      // Preserve finite-row markup, excluding Svelte's non-visible hydration comments.
      expect(
        identities.map((eventKey) =>
          rowMarkup(result.html, eventKey).replace(/<!--[\s\S]*?-->/g, ""),
        ),
      ).toMatchSnapshot();
    });

    it.each(cases)("keeps every event openable with $name", async ({ startBad, endBad }) => {
      const control = await renderInventory(renderer, "events", "", finiteRows());
      expect(control.status).toBe(200);
      const result = await renderInventory(renderer, "events", "", corruptRows(startBad, endBad));
      expect(result.status, "one corrupt row must not turn the inventory into a 500").toBe(200);
      expect(result.headers.get("cache-control")).toContain("no-store");
      for (const eventKey of [identities[0], identities[2]]) {
        // Byte equality here checks isolation; the CONTROL above independently pins real content.
        expect(rowMarkup(result.html, eventKey)).toBe(rowMarkup(control.html, eventKey));
      }
      const badRow = parsedRow(result.html, identities[1]);
      const badText = text(badRow);
      expect(badText).toContain("Needs date repair");
      expect(badText).toContain("draft");
      expect(badText).toMatch(
        /unrenderable|unavailable|invalid time|invalid date|cannot (?:display|render)|unknown time/i,
      );
      expect(badText).not.toMatch(/Invalid Date|NaN|Infinity/);
      for (const time of nodes(badRow, "time")) {
        const remainingFiniteInstants = [startBad ? null : start, endBad ? null : end];
        expect(remainingFiniteInstants).toContain(attribute(time, "datetime"));
      }
      expect(result.probe.audits).toHaveLength(0);
    });
  });
}

describe("Kit inventory serialization of unrenderable stored times", () => {
  it("CONTROL: finite rows retain their exact serialized public-to-admin shape", () => {
    expect(serializeEventListRow(finiteRows()[1]!)).toEqual({
      eventKey: identities[1],
      title: "Needs date repair",
      game: "Chess",
      status: "draft",
      startsAt: start,
      endsAt: end,
      capacity: 8,
      rsvpOpen: true,
      goingCount: 0,
    });
  });

  it.each(cases)(
    "serializes all rows without inventing a finite replacement for $name",
    ({ startBad, endBad }) => {
      const control = buildEventListView(parseEventListQuery({}), finiteRows());
      const view = buildEventListView(parseEventListQuery({}), corruptRows(startBad, endBad));
      expect(view.rows.map((row) => row.eventKey)).toEqual([...identities]);
      expect(view.rows[0]).toEqual(control.rows[0]);
      expect(view.rows[2]).toEqual(control.rows[2]);
      expect(view.hasNext).toBe(false);
      const bad = view.rows[1]!;
      expect(bad).toMatchObject({
        eventKey: identities[1],
        title: "Needs date repair",
        status: "draft",
      });
      if (startBad) expect(Number.isFinite(Date.parse(bad.startsAt ?? ""))).toBe(false);
      else expect(bad.startsAt).toBe(start);
      if (endBad) expect(Number.isFinite(Date.parse(bad.endsAt ?? ""))).toBe(false);
      else expect(bad.endsAt).toBe(end);
      expect(JSON.parse(JSON.stringify(view)).rows).toHaveLength(3);
    },
  );
});

describe("Kit edit presentation for a correctable unrenderable event", () => {
  async function edit(startBad: boolean, endBad: boolean) {
    return resolveKitEventEdit(
      identities[1],
      {},
      {
        db: {} as Db,
        get: async () => corruptRows(startBad, endBad)[1]!,
        list: async () => ({ rows: [], total: 0 }),
        now: new Date("2099-10-01T12:00:00.000Z"),
      },
    );
  }

  it("CONTROL: finite edit times keep their stored UTC wall values", async () => {
    const outcome = await edit(false, false);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("Expected the saved event edit page");
    expect(outcome.view.values).toMatchObject({
      title: "Needs date repair",
      starts_at: "2099-11-01 18:00",
      ends_at: "2099-11-01 21:00",
      timezone: "UTC",
    });
    expect(outcome.view.endsAt).toBe(end);
    const html = kitForms.renderForm(1, { view: outcome.view });
    expectEditable(input(html, "starts_at"), "2099-11-01 18:00");
    expectEditable(input(html, "ends_at"), "2099-11-01 21:00");
  });

  it.each(cases)(
    "opens $name as blank editable fields instead of throwing",
    async ({ startBad, endBad }) => {
      const outcome = await edit(startBad, endBad);
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok")
        throw new Error("The moderator must be able to repair the saved event");
      expect(outcome.view.key).toBe(identities[1]);
      expect(outcome.view.values.title).toBe("Needs date repair");
      expect(outcome.view.values.timezone).toBe("UTC");
      expect(outcome.view.values.starts_at).toBe(startBad ? "" : "2099-11-01 18:00");
      expect(outcome.view.values.ends_at).toBe(endBad ? "" : "2099-11-01 21:00");
      if (endBad) expect(Number.isFinite(Date.parse(outcome.view.endsAt ?? ""))).toBe(false);
      else expect(outcome.view.endsAt).toBe(end);
      const html = kitForms.renderForm(1, { view: outcome.view });
      expectEditable(input(html, "title"), "Needs date repair");
      expectEditable(input(html, "starts_at"), startBad ? "" : "2099-11-01 18:00");
      expectEditable(input(html, "ends_at"), endBad ? "" : "2099-11-01 21:00");
      const tree = parseFragment(html);
      const saveForm = nodes(tree, "form").find(
        (form) => attribute(form, "action") === `/admin/events/${identities[1]}`,
      );
      expect(saveForm, "the ordinary correction POST stays available").toBeDefined();
      expect(attribute(saveForm!, "method")?.toLowerCase()).toBe("post");
      expect(
        nodes(saveForm!, "button").some(
          (button) => /save/i.test(text(button)) && attribute(button, "disabled") === undefined,
        ),
      ).toBe(true);
      expect(text(tree)).not.toMatch(/Invalid Date|NaN|Infinity/);
    },
  );
});
