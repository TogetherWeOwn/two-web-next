import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import app from "../src/index";
import { featuredContents } from "../src/db/admin-schema";
import { listVisibleFeatured } from "../src/featured";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { createMemorySessionStore } from "../src/sessions";
import type { Env } from "../src/env";
import type { EnvWithAdminDb } from "../src/admin/db";

const now = new Date("2026-09-30T12:00:00Z");
const before = new Date(now.getTime() - 1000);
const after = new Date(now.getTime() + 1000);
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

afterEach(() => vi.restoreAllMocks());

describe("featured homepage fallback (local fixtures)", () => {
  it("omits the section with no configured database", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('data-testid="featured-content"');
  });

  it("a database read failure omits the section, keeps the funnel and strict CSP", async () => {
    // Real Drizzle query construction with a local failing transport: no connection.
    const db = drizzle.mock();
    vi.spyOn(db, "select").mockImplementation(() => { throw new Error("database unavailable"); });
    const res = await app.request("/", {}, { ...env, ADMIN_DB: db } as Env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('data-testid="featured-content"');
    expect(html).toContain("The lobby is open.");
    expect(html).toContain('data-testid="join"');
    expect(html).not.toContain("database unavailable");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("featured homepage (isolated test Postgres)", () => {
  let fixture: MemberDataFixture;
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  beforeEach(async () => { await fixture.db.delete(featuredContents); });
  afterAll(async () => { await fixture?.dispose(); });

  const home = () => app.request("/", {}, {
    ...env,
    ADMIN_DB: fixture.db,
    SESSION_STORE: createMemorySessionStore(),
  } as EnvWithAdminDb);

  it("shows inside/open windows, hides drafts, future, past and exact-end rows", async () => {
    await fixture.db.insert(featuredContents).values([
      { title: "Inside", isPublished: true, startsAt: before, endsAt: after, position: 1 },
      { title: "Open", isPublished: true, position: 2 },
      { title: "Start exact", isPublished: true, startsAt: now, endsAt: after, position: 3 },
      { title: "No start", isPublished: true, endsAt: after, position: 4 },
      { title: "No end", isPublished: true, startsAt: before, position: 5 },
      { title: "Draft", startsAt: before, endsAt: after },
      { title: "Future", isPublished: true, startsAt: after },
      { title: "Past", isPublished: true, endsAt: before },
      { title: "End exact", isPublished: true, startsAt: before, endsAt: now },
    ]);
    expect((await listVisibleFeatured(fixture.db, now)).map((row) => row.title)).toEqual([
      "Inside", "Open", "Start exact", "No start", "No end",
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const res = await home();
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const title of ["Inside", "Open", "Start exact", "No start", "No end"]) expect(html).toContain(`<h3>${title}</h3>`);
      for (const title of ["Draft", "Future", "Past", "End exact"]) expect(html).not.toContain(`<h3>${title}</h3>`);
      expect(html.match(/data-testid="featured-item"/g)).toHaveLength(5);
    } finally { vi.useRealTimers(); }
  });

  it("orders by position then id and does not impose the upcoming-events cap", async () => {
    const rows = await fixture.db.insert(featuredContents).values([
      { title: "Last", isPublished: true, position: 9 },
      { title: "Tie first", isPublished: true, position: 1 },
      { title: "Tie second", isPublished: true, position: 1 },
      { title: "First", isPublished: true, position: -1 },
      { title: "Middle", isPublished: true, position: 4 },
    ]).returning();
    const visible = await listVisibleFeatured(fixture.db, now);
    expect(visible.map((row) => row.id)).toEqual([3, 1, 2, 4, 0].map((index) => rows[index]!.id));
    const html = await (await home()).text();
    expect(html.match(/data-testid="featured-item"/g)).toHaveLength(5);
    const offsets = visible.map((row) => html.indexOf(`<h3>${row.title}</h3>`));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("renders escaped titles/bodies, title-only links and accessible lazy images", async () => {
    await fixture.db.insert(featuredContents).values([
      {
        title: "Squad <night>", body: '<script>alert("body")</script>', isPublished: true,
        url: "https://example.test/squad?a=1&b=2", imageUrl: "/squad.jpg", imageAlt: "  Squad & friends  ",
      },
      { title: "Title fallback", isPublished: true, imageUrl: "/fallback.jpg", imageAlt: null },
      { title: "Blank fallback", isPublished: true, imageUrl: "/blank.jpg", imageAlt: "   " },
      { title: "Text only", isPublished: true },
    ]);
    const res = await home();
    const html = await res.text();
    expect(html).toContain('<h2 id="featured-heading">From the community team</h2>');
    expect(html).toContain('aria-labelledby="featured-heading"');
    expect(html).toContain('<h3><a href="https://example.test/squad?a=1&amp;b=2">Squad &lt;night&gt;</a></h3>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script\b|\sstyle=|\son\w+=/i);
    expect(html).toContain('alt="Squad &amp; friends"');
    expect(html).toContain('alt="Title fallback"');
    expect(html).toContain('alt="Blank fallback"');
    expect(html.match(/loading="lazy"/g)).toHaveLength(3);
    expect(html.match(/width="640" height="360"/g)).toHaveLength(3);
    expect(html.match(/decoding="async" referrerpolicy="no-referrer"/g)).toHaveLength(3);
    expect(html).not.toMatch(/<a[^>]*><img/);
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self' https://cdn.discordapp.com");
  });

  it("omits an empty published section", async () => {
    await fixture.db.insert(featuredContents).values({ title: "Moderator draft" });
    const res = await home();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('data-testid="featured-content"');
  });
});
