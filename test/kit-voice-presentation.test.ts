import { parseFragment } from "parse5";
import { afterAll, beforeAll, expect, it } from "vitest";
import { voiceViews } from "./fixtures/kit-voice-views";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

let renderer: Awaited<ReturnType<typeof createKitSsrRenderer>>;
beforeAll(async () => {
  renderer = await createKitSsrRenderer("test/fixtures/kit-voice-presentation.svelte");
});
afterAll(() => renderer?.cleanup());

function linkHref(html: string, label: string) {
  const link = elements(parseFragment(html)).find(
    (el) => el.tagName === "a" && textOf(el) === label,
  );
  return link && attr(link, "href");
}

it("renders the guest projection floor as an aggregate even during a live event", () => {
  const html = renderer.renderPage(voiceViews.guest);
  expect(html).toContain("Thursday Co-op is on right now.");
  expect(html).toContain("5 of us are in voice.");
  expect(html).toContain("Updated 12 s ago");
  expect(linkHref(html, "Join with Discord")).toBe("/join/discord");
  expect(html).not.toMatch(/Raid 1|Squad 2|Mika|Robin|Ari|visible rooms|<h3|<img|Pull me in/);
});

it("does not turn absent or privacy-suppressed voice into an observed zero", () => {
  const html = renderer.renderPage(voiceViews.absent);
  expect(html).toContain("Friday Raid is at 21:00 BST.");
  expect(html).toContain("Voice numbers are not available right now.");
  expect(html).not.toMatch(/0 in voice|0 people|quiet|Updated|Thursday Co-op|<ul/);
  const quiet = renderer.renderPage(voiceViews.quiet);
  expect(quiet).toContain("It's quiet in the rooms you can see.");
  expect(quiet).toContain("0 people");
});

it.each([1, 2])("does not call %i in voice quiet", (count) => {
  const { view, nextEvent } = voiceViews.quiet;
  const snapshot = { ...view.snapshot, rooms: [{ ...view.snapshot.rooms[0], count }] };
  const html = renderer.renderPage({ view: { ...view, snapshot }, nextEvent });
  expect(html).not.toContain("It's quiet");
  expect(html).toContain("Next up.");
  expect(html).toContain("Friday Raid is at 21:00 BST.");
  expect(html).toContain(`1 visible room · ${count} ${count === 1 ? "person" : "people"}`);
});

it("scopes live event counts and renders only projected room details", () => {
  const html = renderer.renderPage(voiceViews.member);
  expect(html).toContain("4 in event rooms you can see.");
  expect(html).toContain("2 visible rooms · 6 people");
  expect(html).toContain("Mika");
  expect(html).toContain("Updated 45 s ago");
  expect(linkHref(html, "See what's on")).toBe("/events");
  expect(html).not.toMatch(/<time|seats|Pull me in|6 of us|aria-live/);
});

it("keeps the last real counts with an honest age and no live claim or move", () => {
  const html = renderer.renderPage(voiceViews.frozen);
  expect(html).toContain("2 visible rooms · 6 people");
  expect(html).toContain("Last synced 3 min ago");
  expect(html).toContain("Live numbers are catching up.");
  expect(linkHref(html, "Open Discord")).toBe("/discord");
  expect(html).not.toMatch(/In voice now|Thursday Co-op|Updated|Pull me in/);
  const guest = renderer.renderPage({
    view: { audience: "guest", snapshot: { freshness: "frozen", ageMs: 18_000, count: 5 } },
    nextEvent: null,
  });
  expect(guest).toContain("5 in voice at last sync");
  expect(guest).toContain("Last synced 18 s ago");
  expect(guest).toContain("Nothing scheduled yet.");
  expect(guest).not.toMatch(/<ul|In voice now|5 of us/);
});

it("does not call an empty permission-filtered room list quiet", () => {
  const html = renderer.renderPage({
    view: { audience: "member", snapshot: { freshness: "fresh", ageMs: 0, rooms: [] } },
  });
  expect(html).toContain("No voice rooms to show.");
  expect(html).not.toMatch(/quiet|0 people|0 in voice/);
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
  const html = renderer.renderPage({ view, nextEvent: { title, timeLabel: "21:00 BST" } });
  const label = length === 72 ? title : `${"X".repeat(71)}…`;
  expect(html).toContain(`${label} is at 21:00 BST.`);
});
