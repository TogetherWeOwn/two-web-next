import { afterAll, beforeAll, expect, it } from "vitest";
import { projectMembersDirectory } from "../web/src/lib/members-directory";
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
const input = {
  audience: "member",
  counts,
  weekStartsAt: 0,
  snapshotAt: 100,
  members: [
    {
      name: "Sample Comet",
      handle: "sample_comet",
      active: true,
      rank: 3,
      profileHref: "/members/sample-comet",
      role: "Guide",
      organizerRole: "Event host",
      lastSeen: "Synthetic race · 2 d ago",
      games: ["Example Racing"],
      welcome: { joinedAt: 99, day: "Today", sayHiHref: "/welcome/sample-comet" },
    },
  ],
} as const;

it("renders the synthetic directory identity, rank, welcome and organizer affordances", () => {
  const html = render(projectMembersDirectory(input, new URLSearchParams()));
  expect(html).toContain('aria-label="Say hi to Sample Comet"');
  expect(html).toContain('href="/members/sample-comet"');
  expect(html).toContain("Soldier");
  expect(html).toContain("Event host");
});

it("renders only aggregate counts and a sign-in action to guests", () => {
  const html = render(
    projectMembersDirectory({ audience: "guest", counts }, new URLSearchParams()),
  );
  expect(html).toContain("814 members · 212 came to something this month");
  expect(html).toContain('href="/auth/discord"');
  expect(html).not.toMatch(/Sample Comet|Joined this week|Who runs this/);
});

it("escapes no-match text and keeps the selected filter on Clear search", () => {
  const html = render(
    projectMembersDirectory(input, new URLSearchParams({ filter: "guides", q: "<sample>" })),
  );
  expect(html).toMatch(/Nobody matches .*&lt;sample/);
  expect(html).not.toContain("<sample>");
  expect(html).toContain('href="?filter=guides"');
});
