import { jsx } from "hono/jsx/jsx-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/env";
import { FALLBACK_INVITE, inviteDestination } from "../src/invite";
import { Home, type Notice } from "../src/pages";

const member: Session = {
  id: "member-1", username: "Member", avatar: null, member: true, moderator: false,
};

async function render(inviteUrl: string | undefined, session: Session | null, notice: Notice) {
  return await jsx(Home, {
    session, notice, inviteUrl, appUrl: "https://next.example.test",
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: [], eventsUnavailable: false, featured: [],
  }).toString();
}

const destinations = [
  { name: "missing configuration", url: undefined },
  { name: "blank configuration", url: "" },
  { name: "whitespace", url: " \t\n " },
  { name: "malformed URL", url: "not an invite" },
  { name: "JavaScript scheme", url: "javascript:alert(1)" },
  { name: "data scheme", url: "data:text/html,unsafe" },
  { name: "HTTP invite", url: "http://discord.gg/example" },
  { name: "protocol-relative invite", url: "//discord.gg/example" },
  { name: "lookalike host", url: "https://discord.gg.example.test/invite" },
  { name: "discord.gg campaign", url: "https://discord.gg/example?utm_source=web&utm_campaign=home#join" },
  { name: "discord.com campaign", url: "https://discord.com/invite/example?utm_source=web&utm_campaign=home#join" },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  { name: "guest recovery", session: null, notice: "join_failed" as const, links: 1 },
  { name: "member", session: member, notice: null, links: 1 },
  { name: "member recovery", session: member, notice: "join_failed" as const, links: 2 },
])("Home invite policy: $name", ({ session, notice, links }) => {
  it.each(destinations)("uses the existing destination for $name", async ({ url }) => {
    const destination = url === undefined ? FALLBACK_INVITE : inviteDestination(url);
    if (url?.includes("?utm_source=web")) expect(destination).toBe(url);
    const html = await render(url, session, notice);
    const inviteLinks = [...html.matchAll(/<a\b[^>]*href="(?!\/discord")([^"]*)"[^>]*>(Open Discord|Join with an invite link instead)<\/a>/g)];
    expect(inviteLinks).toHaveLength(links);
    expect(inviteLinks.map((link) => link[1])).toEqual(Array(links).fill(destination.replaceAll("&", "&amp;")));
    if (destination === FALLBACK_INVITE) expect(html).not.toContain(`href="${url}"`);
  });
});

it("normalizes once when both member invite links are visible", async () => {
  await render("javascript:alert(1)", member, "join_failed");
  expect(console.error).toHaveBeenCalledTimes(1);
});

it.each([
  { name: "guest", session: null, join: true },
  { name: "signed-in nonmember", session: { ...member, member: false }, join: true },
  { name: "member", session: member, join: false },
])("preserves $name CTA visibility and recovery notice", async ({ session, join }) => {
  const html = await render(FALLBACK_INVITE, session, "join_failed");
  expect(html.includes('data-testid="join"')).toBe(join);
  expect(html.includes("Open Discord")).toBe(!join);
  expect(html.includes('data-testid="signin"')).toBe(session === null);
  expect(html.includes('data-testid="home-events-join"')).toBe(session === null);
  expect(html).toContain("Signed in, but we couldn&#39;t add you to the Discord automatically. Use the invite link below.");
  expect(html).toContain("Join with an invite link instead");
  expect(html).not.toContain("data-island");
});
