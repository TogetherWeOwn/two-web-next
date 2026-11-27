import { createRequire } from "node:module";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attr } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const require = createRequire(import.meta.url);
const { renderedElements, renderedText } = require("../ci/rendered-page.mjs") as {
  renderedElements: (root: Node, selector: { tag: string }) => Iterable<Element>;
  renderedText: (root: Node) => string;
};

let page: DefaultTreeAdapterMap["document"];
let cleanup: () => void;

beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-footer.svelte");
  cleanup = renderer.cleanup;
  page = parse(renderer.renderPage({}));
});

afterAll(() => cleanup?.());

describe("Ember footer", () => {
  it("renders the community description and labelled footer navigation", () => {
    const [footer] = renderedElements(page, { tag: "footer" });
    expect(footer).toBeDefined();
    const [description] = footer ? renderedElements(footer, { tag: "p" }) : [];
    expect(description).toBeDefined();
    expect(description && renderedText(description).replace(/\s+/g, " ").trim()).toBe(
      "Together We Own · adult gaming community · founded 1998",
    );
    const navs = footer ? [...renderedElements(footer, { tag: "nav" })] : [];
    const nav = navs.find((element) => attr(element, "aria-label") === "Footer");
    expect(nav).toBeDefined();
    const links = nav ? [...renderedElements(nav, { tag: "a" })] : [];
    for (const [path, label] of [
      ["/about", "About"],
      ["/faq", "FAQ"],
      ["/rules", "House rules"],
      ["/privacy", "Privacy"],
    ]) {
      const link = links.find((element) => attr(element, "href") === path);
      expect(link).toBeDefined();
      expect(link && renderedText(link).trim()).toBe(label);
    }
  });
});
