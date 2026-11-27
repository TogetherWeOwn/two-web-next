import { type DefaultTreeAdapterMap, parse } from "parse5";
import { afterAll, beforeAll, expect, it } from "vitest";
import { directory, emptyDirectory, guest } from "./fixtures/kit-members-directory-view";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";
import { decodedOutput } from "./helpers/refused-edit-roster";

let render: RenderPage;
let cleanup: () => void;
beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-members-directory-parts.svelte");
  render = renderer.renderPage;
  cleanup = renderer.cleanup;
});
afterAll(() => cleanup?.());

function emptyState(page: DefaultTreeAdapterMap["document"]) {
  const panel = elements(page).find((node) =>
    attr(node, "class")
      ?.split(/[\t\n\f\r ]+/)
      .includes("members-empty"),
  );
  if (!panel) throw new Error("no directory empty state rendered");
  return elements(panel);
}

it("renders the synthetic directory identity, rank, welcome and organizer affordances", () => {
  const nodes = elements(parse(render(directory)));
  const newcomers = nodes.find((node) => attr(node, "aria-labelledby") === "directory-newcomers");
  const welcome = newcomers && elements(newcomers).find((node) => node.tagName === "a");
  expect(welcome && attr(welcome, "aria-label")).toBe("Say hi to Sample Comet");
  const profile = nodes.find(
    (node) => node.tagName === "a" && attr(node, "href") === "/members/sample-comet",
  );
  expect(profile && textOf(profile).trim()).toBe("Sample Comet");
  expect(profile?.parentNode && textOf(profile.parentNode)).toContain("Soldier");
  const organizers = nodes.find((node) => attr(node, "aria-labelledby") === "directory-organizers");
  expect(organizers && textOf(organizers)).toContain("Event host");
});

it("emits an avatar tone without an inline background style", () => {
  const html = render(directory);
  const nodes = elements(parse(html));
  expect(
    nodes.some(
      (node) =>
        node.tagName === "span" &&
        attr(node, "class")
          ?.split(/[\t\n\f\r ]+/)
          .includes("directory-avatar") &&
        attr(node, "data-tone") === "6",
    ),
  ).toBe(true);
  expect(
    nodes.some((node) => /(?:^|;)\s*background-color\s*:/i.test(attr(node, "style") ?? "")),
  ).toBe(false);
  // parse5 discards duplicate attributes. Keep the original source tripwire.
  expect(html).not.toContain('style="background-color:');
});

it("renders only aggregate counts and a sign-in action to guests", () => {
  const html = render(guest);
  const nodes = elements(parse(html));
  expect(
    nodes.some(
      (node) =>
        node.tagName === "p" &&
        textOf(node).trim() === "814 members · 212 came to something this month",
    ),
  ).toBe(true);
  const signIn = nodes.find(
    (node) => node.tagName === "a" && attr(node, "href") === "/auth/discord",
  );
  expect(signIn && textOf(signIn).trim()).toBe("Sign in with Discord to see who's here");
  expect(decodedOutput(html)).not.toMatch(/Sample Comet|Joined this week|Who runs this/);
  // Keep a source check for privacy markers in bytes parse5 can discard, such as duplicate attributes.
  expect(html).not.toMatch(/Sample Comet|Joined this week|Who runs this/);
});

it("escapes no-match text and renders the supplied Clear search link", () => {
  const html = render(emptyDirectory("guides", "<sample>"));
  const page = parse(html, { sourceCodeLocationInfo: true });
  const panel = emptyState(page);
  const title = panel.find(
    (node) => node.tagName === "p" && textOf(node).trim() === 'Nobody matches "<sample>".',
  );
  expect(title).toBeDefined();
  expect(elements(page).some((node) => node.tagName === "sample")).toBe(false);
  // The parser decodes the escape, so check the source spelling as well.
  const location = title?.sourceCodeLocation;
  expect(location && html.slice(location.startOffset, location.endOffset)).toContain("&lt;sample");
  expect(html).not.toContain("<sample>");
  const clear = panel.find(
    (node) => node.tagName === "a" && textOf(node).trim() === "Clear search",
  );
  expect(clear && attr(clear, "href")).toBe("?filter=guides");
});

const limit = "🟠".repeat(32);
it.each([
  [limit, limit],
  [`${limit}x`, `${limit}…`],
])("bounds the displayed no-match query by code point (%#)", (query, shown) => {
  const panel = emptyState(parse(render(emptyDirectory("guides", query))));
  expect(
    panel.some(
      (node) => node.tagName === "p" && textOf(node).trim() === `Nobody matches "${shown}".`,
    ),
  ).toBe(true);
});

it.each([
  ["everyone", 0, "No members to list yet.", "Find an event", "/events"],
  ["active", 2, "No active members this month yet.", "Show everyone", "?filter=everyone"],
  ["guides", 2, "No Guides yet.", "Show everyone", "?filter=everyone"],
] as const)("renders the %s empty state", (filter, count, title, action, href) => {
  const panel = emptyState(parse(render(emptyDirectory(filter, "", count))));
  expect(panel.some((node) => node.tagName === "p" && textOf(node).trim() === title)).toBe(true);
  const link = panel.find((node) => node.tagName === "a" && textOf(node).trim() === action);
  expect(link).toBeDefined();
  expect(link && attr(link, "href")).toBe(href);
});
