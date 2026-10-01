import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "./app";
import { FALLBACK_INVITE } from "../src/invite";
import type { DiscordTransient } from "../src/events/discord-transients";
import { env } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APPROVED = "https://discord.gg/approved-invite";
const TRANSIENT: DiscordTransient = {
  discordId: "900000000000000001", status: "scheduled", title: "Transient night", description: null,
  location: null, startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 2 * 86_400_000),
};
type Surface = "never" | "error" | "transient";
const SURFACES: Record<Surface, { rows: DiscordTransient[]; failed: boolean; testid: string }> = {
  never: { rows: [], failed: false, testid: "discord-join" },
  error: { rows: [], failed: true, testid: "discord-join" },
  transient: { rows: [TRANSIENT], failed: false, testid: "event-discord-rsvp" },
};

describe.skipIf(!process.env.DATABASE_URL)("calendar invite destination (isolated agent-testdb schema)", () => {
  let fixture: MemberDataFixture;
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  afterEach(async () => { vi.restoreAllMocks(); await fixture?.reset(); });
  afterAll(() => fixture?.dispose());

  async function hrefs(surface: Surface, invite: string): Promise<{ hrefs: string[]; html: string }> {
    const s = SURFACES[surface];
    const res = await app.request("/events", {}, {
      ...env, DISCORD_INVITE_URL: invite, ADMIN_DB: fixture.db,
      DISCORD_EVENTS: { upcoming: async () => s.rows, lastReadFailed: () => s.failed },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const tag = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes(`data-testid="${s.testid}"`));
    expect(tag.length).toBeGreaterThan(0);
    return { hrefs: tag.map((t) => /href="([^"]*)"/.exec(t)![1]!), html };
  }

  it.each(Object.keys(SURFACES) as Surface[])("%s keeps an approved configured invite", async (surface) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await hrefs(surface, APPROVED)).hrefs).toEqual([APPROVED]);
    expect(err).not.toHaveBeenCalled();
  });

  it.each(Object.keys(SURFACES) as Surface[])("%s falls back for blank, malformed and disallowed values without logging them", async (surface) => {
    for (const bad of ["", "not a url", "http://discord.gg/x", "https://evil.example/join?x=<script>"]) {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await hrefs(surface, bad)).hrefs).toEqual([FALLBACK_INVITE]);
      if (bad) expect(JSON.stringify(err.mock.calls)).not.toContain(bad);
      err.mockRestore();
    }
  });

  it("escapes an approved invite containing markup characters", async () => {
    const tricky = "https://discord.gg/a?x=1&y=\"2\"";
    const { hrefs: h } = await hrefs("never", tricky);
    expect(h[0]).not.toContain('"');
    expect(h[0]).toContain("&amp;");
  });
});
