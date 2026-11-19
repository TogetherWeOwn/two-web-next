import { afterAll, beforeAll, expect, it } from "vitest";
import { directory, emptyDirectory, guest } from "./fixtures/kit-members-directory-view";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

let render: RenderPage;
let cleanup: () => void;
beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-members-directory-parts.svelte");
  render = renderer.renderPage;
  cleanup = renderer.cleanup;
});
afterAll(() => cleanup?.());

it("renders the synthetic directory identity, rank, welcome and organizer affordances", () => {
  const html = render(directory);
  expect(html).toContain('aria-label="Say hi to Sample Comet"');
  expect(html).toContain('href="/members/sample-comet"');
  expect(html).toContain("Soldier");
  expect(html).toContain("Event host");
});

it("emits an avatar tone without an inline background style", () => {
  const html = render(directory);
  expect(html).toContain('data-tone="6"');
  expect(html).not.toContain('style="background-color:');
});

it("renders only aggregate counts and a sign-in action to guests", () => {
  const html = render(guest);
  expect(html).toContain("814 members · 212 came to something this month");
  expect(html).toContain('href="/auth/discord"');
  expect(html).not.toMatch(/Sample Comet|Joined this week|Who runs this/);
});

it("escapes no-match text and renders the supplied Clear search link", () => {
  const html = render(emptyDirectory("guides", "<sample>"));
  expect(html).toMatch(/Nobody matches .*&lt;sample/);
  expect(html).not.toContain("<sample>");
  expect(html).toContain('href="?filter=guides"');
});

const limit = "🟠".repeat(32);
it.each([
  [limit, limit],
  [`${limit}x`, `${limit}…`],
])("bounds the displayed no-match query by code point (%#)", (query, shown) => {
  expect(render(emptyDirectory("guides", query))).toContain(`Nobody matches "${shown}".`);
});

it.each([
  ["everyone", 0, "No members to list yet.", "Find an event", "/events"],
  ["active", 2, "No active members this month yet.", "Show everyone", "?filter=everyone"],
  ["guides", 2, "No Guides yet.", "Show everyone", "?filter=everyone"],
] as const)("renders the %s empty state", (filter, count, title, action, href) => {
  const html = render(emptyDirectory(filter, "", count));
  expect(html).toContain(title);
  expect(html).toContain(action);
  expect(html).toContain(`href="${href}"`);
});
