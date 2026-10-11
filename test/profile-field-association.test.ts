// Profile validation field association (TOG-21705). SSR: each field error
// exposes stable field/error ids, aria-invalid and associated error text;
// the server `games` key maps to the `games_text` control. Unknown/global
// errors stay in the summary without fabricated control associations.
import { jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { ProfilePage } from "../src/profiles/pages";

const member = {
  id: "100000000000000001",
  username: "Fixture",
  avatar: null,
  bio: "Original bio",
  games: ["Chess"],
  timezone: "UTC",
};
const base = {
  member,
  isOwner: true as const,
  appUrl: "https://next.example.test",
};

const render = (errors: Record<string, string>, values = { bio: "draft bio", games_text: "Go", timezone: "UTC" }) =>
  jsx(ProfilePage, { ...base, errors, values }).toString();

describe("profile SSR field association", () => {
  it("bio error links the summary to the bio control with invalid state", () => {
    const html = render({ bio: "Keep your bio to 1000 characters or fewer." });
    expect(html).toContain('id="profile-bio"');
    expect(html).toContain('id="profile-bio-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="profile-bio-error"');
    expect(html).toContain('href="#profile-bio"');
    expect(html).toContain("Keep your bio to 1000 characters or fewer.");
  });

  it("server games key maps to the games_text control", () => {
    const html = render({ games: "Keep each game name to 80 characters or fewer." });
    expect(html).toContain('id="profile-games-text"');
    expect(html).toContain('id="profile-games-text-error"');
    expect(html).toContain('aria-describedby="profile-games-text-error"');
    expect(html).toContain('href="#profile-games-text"');
    expect(html).toContain("Keep each game name to 80 characters or fewer.");
    expect(html).not.toContain('id="profile-games-error"');
  });

  it("timezone error links the summary to the timezone control", () => {
    const html = render({ timezone: "Choose a valid IANA timezone, e.g. Europe/London." });
    expect(html).toContain('id="profile-timezone"');
    expect(html).toContain('id="profile-timezone-error"');
    expect(html).toContain('href="#profile-timezone"');
  });

  it("unknown/global errors render safely without fabricated associations", () => {
    const html = render({ fields: "Only your bio, games and timezone can be changed." });
    expect(html).toContain("Only your bio, games and timezone can be changed.");
    expect(html).not.toContain('href="#profile-');
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("profile-bio-error");
    expect(html).not.toContain("profile-games-text-error");
    expect(html).not.toContain("profile-timezone-error");
  });

  it("error text is escaped and draft values are preserved", () => {
    const html = render(
      { bio: "<script>alert(1)</script>" },
      { bio: "<b>draft</b>", games_text: "<img>", timezone: "UTC" },
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;b&gt;draft&lt;/b&gt;");
  });

  it("every describedby token resolves to a node id, with no duplicate ids", () => {
    const html = render({
      bio: "Bad bio.",
      games: "Bad games.",
      timezone: "Bad zone.",
      fields: "Global problem.",
    });
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const tokens = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(/\s+/),
    );
    expect(tokens).toContain("profile-bio-error");
    expect(tokens).toContain("profile-games-text-error");
    expect(tokens).toContain("profile-timezone-error");
    for (const token of tokens) expect(ids, token).toContain(token);
  });
});
