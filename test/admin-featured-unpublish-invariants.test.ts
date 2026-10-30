// Independent regression pins: real Hono/Kit list rendering stays DB-free.
// Persisted-row and cache proofs live under admin.test.ts's existing DB gate.
// route-inventory: POST /admin/featured/:id/unpublish
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileInventoryKit,
  inventoryRow,
  renderInventory,
} from "./helpers/admin-inventory-recovery";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
function elements(node: HtmlNode, name: string): HtmlElement[] {
  return [
    ...("tagName" in node && node.tagName === name ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap((child) => elements(child, name)) : []),
  ];
}
const attribute = (node: HtmlElement, name: string) =>
  node.attrs.find((attr) => attr.name === name)?.value;

// Removing scheduled/expired actions, adding a draft action, or retaining only
// source markup with no actual SSR form must fail for BOTH list renderers.
describe("featured list unpublish actions in real Hono and Kit SSR", () => {
  beforeAll(async () => {
    await compileInventoryKit();
  });
  it.each(["Hono", "Kit"] as const)(
    "%s renders actions for live, scheduled and expired published rows only",
    async (renderer) => {
      const rows = [
        { ...inventoryRow("featured", 71), title: "Live slot" },
        {
          ...inventoryRow("featured", 72),
          title: "Scheduled slot",
          startsAt: new Date("2099-12-01T00:00:00Z"),
        },
        {
          ...inventoryRow("featured", 73),
          title: "Expired slot",
          endsAt: new Date("2001-01-01T00:00:00Z"),
        },
        { ...inventoryRow("featured", 74), title: "Unpublished slot", isPublished: false },
      ];
      const result = await renderInventory(renderer, "featured", "", rows);
      expect(result.status).toBe(200);
      const document = parse(result.html);
      const actions = elements(document, "form").filter((form) =>
        attribute(form, "action")?.endsWith("/unpublish"),
      );
      expect(actions.map((form) => attribute(form, "action")).sort()).toEqual([
        "/admin/featured/71/unpublish",
        "/admin/featured/72/unpublish",
        "/admin/featured/73/unpublish",
      ]);
      for (const form of actions) {
        expect(attribute(form, "method")?.toLowerCase()).toBe("post");
        const buttons = elements(form, "button");
        expect(buttons).toHaveLength(1);
        expect(attribute(buttons[0]!, "type")).toBe("submit");
        expect(buttons[0]!.childNodes).toContainEqual(
          expect.objectContaining({ nodeName: "#text", value: "Unpublish" }),
        );
      }
      expect(result.html).toContain("Unpublished slot");
    },
  );
});
