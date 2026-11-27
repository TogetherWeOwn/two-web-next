import { html, parseFragment } from "parse5";
import { expect, it } from "vitest";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

it.each([true, false])(
  "renders button and navigation states with safe native semantics with scripting enabled set to %s",
  async (scriptingEnabled) => {
    const { renderPage, cleanup } = await createKitSsrRenderer(
      "test/fixtures/kit-button-isolated.svelte",
    );
    try {
      const nodes = elements(parseFragment(renderPage({}), { scriptingEnabled }));
      const allButtons = nodes.filter((node) => node.tagName === "button");
      const hiddenButtons = allButtons.filter((button) => attr(button, "hidden") !== undefined);
      const buttons = allButtons.filter((button) => attr(button, "hidden") === undefined);
      const links = nodes.filter((node) => node.tagName === "a");
      expect(allButtons.every((button) => button.namespaceURI === html.NS.HTML)).toBe(true);
      expect(hiddenButtons).toHaveLength(4);
      for (const button of hiddenButtons) {
        expect(attr(button, "type")).toBe("submit");
        expect(attr(button, "disabled")).toBeDefined();
      }
      expect(buttons).toHaveLength(7);
      expect(links).toHaveLength(4);
      expect(links.every((link) => link.namespaceURI === html.NS.HTML)).toBe(true);
      expect(attr(buttons[0]!, "type")).toBe("submit");
      expect(attr(buttons[1]!, "type")).toBe("button");
      expect(attr(buttons[1]!, "aria-disabled")).toBe("true");
      expect(textOf(buttons[1]!).trim()).toBe("Join Raid Night · Event is full");
      expect(attr(buttons[1]!, "aria-label")).toBe("Join Raid Night · Event is full");
      expect(attr(buttons[2]!, "type")).toBe("button");
      expect(attr(buttons[2]!, "aria-busy")).toBe("true");
      expect(textOf(buttons[2]!).trim()).toBe("Saving…");
      expect(textOf(buttons[3]!)).toContain("leave");
      expect(attr(buttons[4]!, "class")?.split(/[\t\n\f\r ]+/)).toEqual(
        expect.arrayContaining(["on-accent", "lg", "full-width"]),
      );
      expect(textOf(buttons[4]!).trim()).toBe("Continue");
      expect(attr(links[0]!, "href")).toBe("/e/raid");
      expect(attr(links[0]!, "aria-label")).toBe("Details for Raid Night");
      for (const link of links.slice(1, 3)) {
        expect(attr(link, "aria-disabled")).toBe("true");
        expect(attr(link, "href")).toBeUndefined();
        for (const descendant of elements(link).slice(1)) {
          expect(attr(descendant, "href")).toBeUndefined();
        }
        expect(attr(link, "tabindex")).toBe("0");
      }
      expect(attr(links[1]!, "aria-label")).toBe("Reserve Raid Night · Event is full");
      expect(attr(links[2]!, "aria-busy")).toBe("true");
    } finally {
      cleanup();
    }
  },
  120000,
);
