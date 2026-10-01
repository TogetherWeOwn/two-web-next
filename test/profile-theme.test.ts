import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { Home, Layout } from "../src/pages";
import { ProfilePage } from "../src/profiles/pages";
import type { MemberView } from "../src/profiles/store";
import type { MemberStats } from "../src/profiles/stats";

const member: MemberView = {
  id: "100000000000000001", username: "Player <script>", avatar: null,
  bio: "A bio <b>with markup</b>", games: ["Chess", "Go <script>"], timezone: "Europe/London",
  rank: "Existing rank", joinedAt: new Date("2024-06-15T00:00:00Z"),
};
const stats: MemberStats = { rankKey: "community_regular", joinedAt: new Date("2025-01-01T00:00:00Z"), tenureDays: 0, isCurrentMember: true, milestones: [] };
const render = (overrides = {}) => ProfilePage({ member, isOwner: true, appUrl: "https://next.example.test", ...overrides })!.toString();

describe("member profile base theme", () => {
  it("loads the base tokens and profile-only layout without changing other shells", () => {
    const html = render();
    expect(html).toContain('<body class="profile-theme"><a class="sl bd"');
    expect(html).toContain('rel="stylesheet" href="/theme.css"');
    expect(html).toContain('rel="stylesheet" href="/profile-theme.css"');
    expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
    expect(Layout({ title: "Leaf" })!.toString()).not.toContain("/profile-theme.css");
    expect(Home({ session: null, notice: null, inviteUrl: "/discord", appUrl: "https://next.example.test", counts: { memberCount: null, onlineCount: null, ranks: [] }, upcomingEvents: [], eventsUnavailable: false, featured: [] })!.toString()).not.toContain("/profile-theme.css");
  });

  it("groups identity, about and games while escaping every member value", () => {
    const html = render();
    expect(html).toContain('class="profile-player" aria-labelledby="member-heading"');
    expect(html).toContain('aria-labelledby="profile-about-heading"');
    expect(html).toContain('aria-labelledby="profile-games-heading"');
    expect(html).toContain("Player &lt;script&gt;");
    expect(html).toContain("A bio &lt;b&gt;with markup&lt;/b&gt;");
    expect(html).toContain("Go &lt;script&gt;");
    expect(html).not.toContain("<b>with markup</b>");
    expect(html).not.toContain("<script>");
  });

  it("keeps optional stats absent rather than fabricating empty tiles", () => {
    const html = render();
    expect(html).not.toContain('data-testid="profile-stats"');
    expect(html).toContain('data-testid="profile-rank">Existing rank');
    expect(html).toContain("Joined June 2024");
    const empty = render({ member: { ...member, bio: null, games: [], timezone: null } });
    expect(empty).toContain("No bio yet.");
    expect(empty).toContain("No games listed yet.");
    expect(empty).toContain('data-testid="profile-timezone" hidden=""');
  });

  it("renders real stat tiles including zero tenure and milestone count without duplicate fallback fields", () => {
    const html = render({ stats });
    expect(html).toContain('<dl class="profile-stats-grid">');
    expect(html).toContain("<dt>Tenure</dt><dd>0 days</dd>");
    expect(html).toContain("<dt>Milestones</dt><dd>0</dd>");
    expect(html).toContain("No milestones yet.");
    expect(html.match(/data-testid="profile-rank"/g)).toHaveLength(1);
    expect(html.match(/data-testid="profile-joined"/g)).toHaveLength(1);
    expect(html).not.toContain("Existing rank");
  });

  it("keeps the plain form, trap, labels, island focus targets and owner-only editing", () => {
    const html = render();
    expect(html).toContain('method="post" action="/members/100000000000000001"');
    expect(html).toContain('name="_method" value="PATCH"');
    for (const field of ["bio", "games_text", "timezone", "website", "formOpenedAt"]) expect(html).toContain(`name="${field}"`);
    expect(html).toContain('<label class="profile-field">Bio <textarea');
    expect(html).toContain('<label class="profile-field">Games (one per line) <textarea');
    expect(html).toContain('<label class="profile-field">Timezone <input');
    expect(html).toContain('id="edit-heading" tabindex="-1"');
    expect(html).toContain('data-island="member-profile"');
    expect(render({ isOwner: false })).not.toContain('data-testid="profile-form"');
  });

  it("preserves join confirmation and its reinvite action inside the themed shell", () => {
    const html = render({ joinResult: "already_member" });
    expect(html).toContain('class="nt" role="status" data-testid="join-result"');
    expect(html).toContain('href="/discord" data-testid="reinvite-link"');
    expect(html.indexOf('data-testid="join-result"')).toBeLessThan(html.indexOf('class="profile-player"'));
  });

  it("keeps accessible server errors and submitted values", () => {
    const html = render({ errors: { timezone: "Choose a valid timezone" }, values: { bio: "New <bio>", games_text: "Chess\nGo", timezone: "Invalid/Zone" } });
    expect(html).toContain('<div role="alert" tabindex="-1" data-testid="profile-error"><ul>');
    expect(html).toContain("New &lt;bio&gt;");
    expect(html).toContain('value="Invalid/Zone"');
  });

  it("keeps styling external, compact and responsive for dynamic island lists/notices", () => {
    const css = readFileSync(new URL("../public/profile-theme.css", import.meta.url), "utf8");
    expect(css.length).toBeLessThan(8000);
    expect(css).toContain("@media (max-width: 48rem)");
    expect(css).toContain("@media (max-width: 30rem)");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("[data-testid='profile-games'] li");
    expect(css).toContain("[role='alert']");
    expect(css).toContain("[role='status']");
    expect(css).toContain("[hidden] { display: none; }");
    expect(css).not.toMatch(/@import|https:\/\//);
    expect(render()).not.toMatch(/<style|\sstyle=/);
  });
});
