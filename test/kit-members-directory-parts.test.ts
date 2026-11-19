import { afterAll, beforeAll, expect, it } from "vitest";
import type { MembersDirectoryView } from "../web/src/lib/members-directory";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

let render: RenderPage;
let cleanup: () => void;
beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-members-directory-parts.svelte");
  render = renderer.renderPage;
  cleanup = renderer.cleanup;
});
afterAll(() => cleanup?.());

const counts = { members: 814, attendedThisMonth: 212 };
// Exercise the presentation boundary; the projection has its own spec.
const name = "Sample Comet";
const directory = {
  audience: "member",
  counts,
  selection: { filter: "active", query: "", page: 1 },
  filterCounts: { active: 1, everyone: 1, guides: 1 },
  resultCount: 1,
  pageCount: 1,
  rows: [
    {
      name,
      rank: 3,
      profileHref: "/members/sample-comet",
      role: "Guide",
      lastSeen: "Synthetic race · 2 d ago",
      games: ["Example Racing"],
    },
  ],
  newcomers: [{ name, day: "Today", sayHiHref: "/welcome/sample-comet" }],
  organizers: [{ name, role: "Event host" }],
} satisfies MembersDirectoryView;

it("renders the synthetic directory identity, rank, welcome and organizer affordances", () => {
  const html = render(directory);
  expect(html).toContain('aria-label="Say hi to Sample Comet"');
  expect(html).toContain('href="/members/sample-comet"');
  expect(html).toContain("Soldier");
  expect(html).toContain("Event host");
});

it("renders only aggregate counts and a sign-in action to guests", () => {
  const guest = { audience: "guest", counts } satisfies MembersDirectoryView;
  const html = render(guest);
  expect(html).toContain("814 members · 212 came to something this month");
  expect(html).toContain('href="/auth/discord"');
  expect(html).not.toMatch(/Sample Comet|Joined this week|Who runs this/);
});

it("escapes no-match text and renders the supplied Clear search link", () => {
  const html = render({
    ...directory,
    selection: { filter: "guides", query: "<sample>", page: 1 },
    resultCount: 0,
    rows: [],
  } satisfies MembersDirectoryView);
  expect(html).toMatch(/Nobody matches .*&lt;sample/);
  expect(html).not.toContain("<sample>");
  expect(html).toContain('href="?filter=guides"');
});
