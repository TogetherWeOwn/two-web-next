import { createRequire } from "node:module";
import { type DefaultTreeAdapterMap, Parser, type Token } from "parse5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attr } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const require = createRequire(import.meta.url);
const { renderedElements, renderedText } = require("../ci/rendered-page.mjs") as {
  renderedElements: (root: Node, selector: { tag?: string; id?: string }) => Iterable<Element>;
  renderedText: (root: Node) => string;
};

let renderPage: RenderPage;
let cleanup: () => void;

const hrefs = (nodes: Iterable<Element>) => Array.from(nodes, (node) => attr(node, "href"));

function parseResponse(html: string) {
  const parser = new Parser<DefaultTreeAdapterMap>({
    scriptingEnabled: false,
    onParseError: ({ code }) => expect(code).toBe("missing-doctype"),
  });
  // Capture decoded tokens before HTML tree correction can discard them.
  const tags: Token.TagToken[] = [];
  const text: string[] = [];
  const observe =
    <T>(record: (token: T) => void, handle: (token: T) => void) =>
    (token: T) => {
      record(token);
      handle.call(parser, token);
    };
  const recordText = ({ chars }: Token.CharacterToken) => text.push(chars);
  parser.onStartTag = observe((token) => tags.push(token), parser.onStartTag);
  parser.onCharacter = observe(recordText, parser.onCharacter);
  parser.onWhitespaceCharacter = observe(recordText, parser.onWhitespaceCharacter);
  parser.onComment = observe(({ data }) => text.push(data), parser.onComment);
  parser.onDoctype = () => expect.unreachable("The renderer emits head and body only");
  parser.tokenizer.write(html, true);
  const attrs = tags.flatMap((tag) => tag.attrs);
  const tagText = ({ tagName, attrs }: Token.TagToken) =>
    [tagName, ...attrs.map(({ name, value }) => `${name} ${value}`)].join(" ");
  const content = [text.join(""), ...tags.map(tagText)].join("\n");
  // Opaque token values can carry markup for client-side use.
  for (const match of content.matchAll(/(?=(href|aria-label|data-testid)="([^"]*)")/g)) {
    attrs.push({ name: match[1]!, value: match[2]! });
  }
  const values = (name: string) =>
    attrs.filter((attr) => attr.name.endsWith(name)).map((attr) => attr.value);
  return { page: parser.document, tags, values, content };
}

beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-ember-shell.svelte");
  renderPage = renderer.renderPage;
  cleanup = renderer.cleanup;
});

afterAll(() => cleanup?.());

describe("Ember shell", () => {
  it("renders one skip link and ordered header, main content and footer without JavaScript", () => {
    const { page, tags, values, content } = parseResponse(renderPage({ menuFallbackOnly: true }));
    const anchors = [...renderedElements(page, { tag: "a" })];
    const skipLinks = anchors.filter((link) => attr(link, "href") === "#main");
    expect(values("href").filter((href) => href === "#main")).toHaveLength(1);
    expect(skipLinks.map(renderedText)).toEqual(["Skip to content"]);
    const landmarks = [...renderedElements(page, {})].filter((element) =>
      ["header", "main", "footer"].includes(element.tagName),
    );
    expect(landmarks.map((element) => element.tagName)).toEqual(["header", "main", "footer"]);
    const mainCount = tags.filter((tag) => /^main\b/.test(tag.tagName)).length;
    expect(mainCount + [...content.matchAll(/<main\b/g)].length).toBe(1);
    const [header, main, footer] = landmarks;
    expect(main && attr(main, "id")).toBe("main");
    expect(main && attr(main, "tabindex")).toBe("-1");
    expect(main && renderedText(main)).toContain("Shell content");
    const [footerNav] = footer ? renderedElements(footer, { tag: "nav" }) : [];
    expect(footerNav && attr(footerNav, "aria-label")).toBe("Footer");
    expect(header && hrefs(renderedElements(header, { tag: "a" }))).toContain("/auth/discord");
    expect(content).not.toContain("site-header-menu.js");
  });

  it("forwards navigation, membership and sign-in return state", () => {
    const { page, values, content } = parseResponse(
      renderPage({ activeNav: "events", member: true, loginReturnTo: "/events" }),
    );
    const [header] = renderedElements(page, { tag: "header" });
    const links = header ? [...renderedElements(header, { tag: "a" })] : [];
    const current = links.filter((link) => attr(link, "aria-current") === "page");
    expect(hrefs(current)).toContain("/events");
    expect(hrefs(links)).toContain("/leaderboards/members");
    expect(hrefs(links)).toContain("/auth/discord?next=%2Fevents");
    const [panel] = renderedElements(page, { tag: "div", id: "kit-menu-panel" });
    expect(hrefs(links.filter((link) => link.parentNode === header))).toContain("/join");
    expect(panel && hrefs(renderedElements(panel, { tag: "a" }))).toContain("/join");
    expect(values("href").filter((href) => href === "/join")).toHaveLength(2);
    expect(hrefs(links)).toContain("/about");
    expect(content.replace(/\s+/g, " ")).not.toMatch(/welcome, guest/i);
  });

  it("forwards custom account content and gives hidden-account state precedence", () => {
    const { page, values } = parseResponse(renderPage({ customAccount: true }));
    expect(hrefs(renderedElements(page, { tag: "a" }))).toContain("/profile");
    expect(values("data-testid")).not.toContain("signin");
    expect(values("href")).not.toContain("/join");
    const authenticated = parseResponse(renderPage({ authenticated: true }));
    expect(authenticated.values("href")).not.toContain("/join");

    const hidden = parseResponse(renderPage({ customAccount: true, hideAccount: true }));
    expect(hidden.values("href")).not.toContain("/profile");
    expect(hidden.values("aria-label")).not.toContain("Account");
  });

  it("omits the account area when requested", () => {
    const { page, values } = parseResponse(renderPage({ hideAccount: true }));
    expect(values("aria-label")).not.toContain("Account");
    expect(values("data-testid")).not.toContain("signin");
    const navs = [...renderedElements(page, { tag: "nav" })];
    expect(navs.map((nav) => attr(nav, "aria-label"))).toContain("Primary");
  });
});
