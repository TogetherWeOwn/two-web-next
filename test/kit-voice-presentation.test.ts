import { createRequire } from "node:module";
import { type DefaultTreeAdapterMap, parse, parseFragment } from "parse5";
import { afterAll, beforeAll, expect, it } from "vitest";
import { voiceViews } from "./fixtures/kit-voice-views";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const require = createRequire(import.meta.url);
const { renderedElements, renderedText } = require("../ci/rendered-page.mjs") as {
  renderedElements: (node: Node, selector: { tag?: string }) => Iterable<Element>;
  renderedText: typeof textOf;
};

let renderer: Awaited<ReturnType<typeof createKitSsrRenderer>>;
beforeAll(async () => {
  renderer = await createKitSsrRenderer("test/fixtures/kit-voice-presentation.svelte");
});
afterAll(() => renderer?.cleanup());

function render(data: Parameters<typeof renderer.renderPage>[0]) {
  const page = parse(renderer.renderPage(data), { scriptingEnabled: false });
  return { page, text: renderedText(page) };
}

function linkHref(page: Node, label: string) {
  const link = [...renderedElements(page, { tag: "a" })].find((el) => renderedText(el) === label);
  return link && attr(link, "href");
}

// Privacy and live-region exclusions also apply to inactive markup.
function markupNodes(node: Node): Node[] {
  const children = "content" in node ? [node.content] : "childNodes" in node ? node.childNodes : [];
  return [node, ...children.flatMap(markupNodes)];
}

function markupElements(page: Node) {
  return markupNodes(page).filter((node) => "tagName" in node);
}

function markupText(page: Node) {
  const parts = [textOf(page)];
  for (const node of markupNodes(page)) {
    if ("tagName" in node) parts.push(...node.attrs.flatMap(({ name, value }) => [name, value]));
    if ("data" in node) parts.push(node.data);
    if ("content" in node) parts.push(textOf(node.content));
    if ("value" in node) parts.push(node.value);
  }
  return parts.join("\n");
}

it("renders the guest projection floor as an aggregate even during a live event", () => {
  const { page, text } = render(voiceViews.guest);
  expect(text).toContain("Thursday Co-op is on right now.");
  expect(text).toContain("5 of us are in voice.");
  expect(text).toContain("Updated 12 s ago");
  expect(linkHref(page, "Join with Discord")).toBe("/join/discord");
  expect(markupText(page)).not.toMatch(/Raid 1|Squad 2|Mika|Robin|Ari|visible rooms|Pull me in/);
  expect(markupElements(page).filter((el) => ["h3", "img"].includes(el.tagName))).toEqual([]);
});

it("does not turn absent or privacy-suppressed voice into an observed zero", () => {
  const { page, text } = render(voiceViews.absent);
  expect(text).toContain("Friday Raid is at 21:00 BST.");
  expect(text).toContain("Voice numbers are not available right now.");
  expect(markupText(page)).not.toMatch(/0 in voice|0 people|quiet|Updated|Thursday Co-op/);
  expect(markupElements(page).map((el) => el.tagName)).not.toContain("ul");
  const { text: quiet } = render(voiceViews.quiet);
  expect(quiet).toContain("It's quiet in the rooms you can see.");
  expect(quiet).toContain("0 people");
});

it.each([1, 2])("does not call %i in voice quiet", (count) => {
  const { view, nextEvent } = voiceViews.quiet;
  const snapshot = { ...view.snapshot, rooms: [{ ...view.snapshot.rooms[0], count }] };
  const { page, text } = render({ view: { ...view, snapshot }, nextEvent });
  expect(markupText(page)).not.toContain("It's quiet");
  expect(text).toContain("Next up.");
  expect(text).toContain("Friday Raid is at 21:00 BST.");
  expect(text).toContain(`1 visible room · ${count} ${count === 1 ? "person" : "people"}`);
});

it("scopes live event counts and renders only projected room details", () => {
  const { page, text } = render(voiceViews.member);
  expect(text).toContain("4 in event rooms you can see.");
  expect(text).toContain("2 visible rooms · 6 people");
  expect(text).toContain("Mika");
  expect(text).toContain("Updated 45 s ago");
  expect(linkHref(page, "See what's on")).toBe("/events");
  expect(markupText(page)).not.toMatch(/seats|Pull me in|6 of us/);
  const markup = markupElements(page);
  expect(markup.map((el) => el.tagName)).not.toContain("time");
  expect(markup.some((el) => attr(el, "aria-live") !== undefined)).toBe(false);
});

it("keeps the last real counts with an honest age and no live claim or move", () => {
  const { page, text } = render(voiceViews.frozen);
  expect(text).toContain("2 visible rooms · 6 people");
  expect(text).toContain("Last synced 3 min ago");
  expect(text).toContain("Live numbers are catching up.");
  expect(linkHref(page, "Open Discord")).toBe("/discord");
  expect(markupText(page)).not.toMatch(/In voice now|Thursday Co-op|Updated|Pull me in/);
  const { page: guestPage, text: guest } = render({
    view: { audience: "guest", snapshot: { freshness: "frozen", ageMs: 18_000, count: 5 } },
    nextEvent: null,
  });
  expect(guest).toContain("5 in voice at last sync");
  expect(guest).toContain("Last synced 18 s ago");
  expect(guest).toContain("Nothing scheduled yet.");
  expect(markupText(guestPage)).not.toMatch(/In voice now|5 of us/);
  expect(markupElements(guestPage).map((el) => el.tagName)).not.toContain("ul");
});

it("does not call an empty permission-filtered room list quiet", () => {
  const { page, text } = render({
    view: { audience: "member", snapshot: { freshness: "fresh", ageMs: 0, rooms: [] } },
  });
  expect(text).toContain("No voice rooms to show.");
  expect(markupText(page)).not.toMatch(/quiet|0 people|0 in voice/);
});

it("keeps a long title within the headline budget without losing the time or scope", () => {
  const html = renderer.renderPage({
    view: voiceViews.member.view,
    nextEvent: { title: "A very long synthetic event title ".repeat(4), timeLabel: "21:00 BST" },
  });
  const heading = elements(parseFragment(html)).find((el) => el.tagName === "h1");
  const headline = heading ? textOf(heading) : "";
  expect(headline).toMatch(/^6 in voice rooms you can see\. .+… is at 21:00 BST\.$/);
  expect(headline.length).toBeLessThan(120);
});

it.each([72, 73])("handles a %i-character title at the headline cutoff", (length) => {
  const title = "X".repeat(length);
  const view = voiceViews.member.view;
  const { page } = render({ view, nextEvent: { title, timeLabel: "21:00 BST" } });
  const label = length === 72 ? title : `${"X".repeat(71)}…`;
  const [heading] = renderedElements(page, { tag: "h1" });
  expect(heading && renderedText(heading)).toContain(`${label} is at 21:00 BST.`);
});
