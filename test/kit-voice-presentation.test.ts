import { afterAll, beforeAll, expect, it } from "vitest";
import { voiceViews } from "./fixtures/kit-voice-views";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

let render: RenderPage;
let cleanup: (() => void) | undefined;
beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-voice-presentation.svelte");
  render = renderer.renderPage;
  cleanup = renderer.cleanup;
});
afterAll(() => cleanup?.());

it("renders the guest projection floor as an aggregate even during a live event", () => {
  const html = render(voiceViews.guest);
  expect(html).toContain("Thursday Co-op is on right now.");
  expect(html).toContain("5 of us are in voice.");
  expect(html).toContain("Updated 12 s ago");
  expect(html).not.toMatch(/Raid 1|Squad 2|Mika|Robin|Ari|visible rooms|<h3|<img|Pull me in/);
});

it("does not turn absent or privacy-suppressed voice into an observed zero", () => {
  const html = render(voiceViews.absent);
  expect(html).toContain("Friday Raid is at 21:00 BST.");
  expect(html).toContain("Voice numbers are not available right now.");
  expect(html).not.toMatch(/0 in voice|0 people|quiet|Updated|Thursday Co-op|<ul/);
  const quiet = render(voiceViews.quiet);
  expect(quiet).toContain("It's quiet in the rooms you can see.");
  expect(quiet).toContain("0 people");
});

it.each([
  [1, "person"],
  [2, "people"],
])("does not call %i in voice quiet", (count, noun) => {
  const { view, nextEvent } = voiceViews.quiet;
  const html = render({
    view: {
      ...view,
      snapshot: { ...view.snapshot, rooms: [{ ...view.snapshot.rooms[0], count }] },
    },
    nextEvent,
  });
  expect(html).not.toContain("It's quiet");
  expect(html).toContain("Next up.");
  expect(html).toContain("Friday Raid is at 21:00 BST.");
  expect(html).toContain(`1 visible room · ${count} ${noun}`);
});

it("scopes live event counts and renders only projected room details", () => {
  const html = render(voiceViews.member);
  expect(html).toContain("4 in event rooms you can see.");
  expect(html).toContain("2 visible rooms · 6 people");
  expect(html).toContain("Mika");
  expect(html).toContain("Updated 45 s ago");
  expect(html).not.toMatch(/<time|seats|Pull me in|6 of us|aria-live/);
});

it("keeps the last real counts with an honest age and no live claim or move", () => {
  const html = render(voiceViews.frozen);
  expect(html).toContain("2 visible rooms · 6 people");
  expect(html).toContain("Last synced 3 min ago");
  expect(html).toContain("Live numbers are catching up.");
  expect(html).toContain("Open Discord");
  expect(html).not.toMatch(/In voice now|Thursday Co-op|Updated|Pull me in/);
  const guest = render({
    view: { audience: "guest", snapshot: { freshness: "frozen", ageMs: 18_000, count: 5 } },
    nextEvent: null,
  });
  expect(guest).toContain("5 in voice at last sync");
  expect(guest).toContain("Last synced 18 s ago");
  expect(guest).toContain("Nothing scheduled yet.");
  expect(guest).not.toMatch(/<ul|In voice now|5 of us/);
});

it("does not call an empty permission-filtered room list quiet", () => {
  const html = render({
    view: { audience: "member", snapshot: { freshness: "fresh", ageMs: 0, rooms: [] } },
  });
  expect(html).toContain("No voice rooms to show.");
  expect(html).not.toMatch(/quiet|0 people|0 in voice/);
});

it("keeps a long title within the headline budget without losing the time or scope", () => {
  const html = render({
    view: voiceViews.member.view,
    nextEvent: { title: "A very long synthetic event title ".repeat(4), timeLabel: "21:00 BST" },
  });
  const headline = (html.match(/<h1\b[^>]*>(.*?)<\/h1>/s)?.[1] ?? "").replace(/<[^>]*>/g, "");
  expect(headline).toMatch(/^6 in voice rooms you can see\. .+… is at 21:00 BST\.$/);
  expect(headline.length).toBeLessThan(120);
});
