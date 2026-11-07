import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import app from "./app";
import { featuredContents } from "../src/db/admin-schema";
import { FEATURED_READ_DEADLINE_MS, listVisibleFeatured } from "../src/featured";
import * as eventReads from "../src/events/reads";
import * as featuredReads from "../src/featured";
import { featuredImageAllowed, featuredImageSrc } from "../src/featured-image";
import { adminApp } from "../src/admin/routes";
import { serializeSigned } from "hono/utils/cookie";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { waitForNoLockWaiters } from "./helpers/wait-for-no-lock-waiters";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import type { Env } from "../src/env";
import type { EnvWithAdminDb } from "../src/admin/db";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../src/home-cache";

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

afterEach(() => {
  vi.restoreAllMocks();
  // The homepage guest cache is module state: one fixture object shared across
  // cases would otherwise serve a previous case's featured rows here.
  __resetHomeGuestCacheForTests();
});

describe("featured homepage fallback (local fixtures)", () => {
  it("omits the section with no configured database", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('data-testid="featured-content"');
  });

  it("a database read failure omits the section, keeps the funnel and strict CSP", async () => {
    // Real Drizzle query construction with a local failing transport: no connection.
    const db = drizzle.mock();
    const session = Reflect.get(db, "session") as { prepareQuery: () => unknown };
    vi.spyOn(session, "prepareQuery").mockImplementation(() => {
      throw new Error("database unavailable");
    });
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

  it("serves guest 200 at the deadline when featured connection acquisition stalls", async () => {
    const db = drizzle.mock();
    let rejectRead!: (error: Error) => void;
    vi.spyOn(eventReads, "loadHomeUpcomingMerged").mockResolvedValue({
      items: [],
      unavailable: false,
      discordFailed: false,
    }); // only featured stalls in this test
    const session = Reflect.get(db, "session") as { transaction: () => Promise<unknown> };
    const transaction = vi.spyOn(session, "transaction").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRead = reject;
        }),
    );
    vi.useFakeTimers();
    try {
      const response = app.request("/", {}, { ...env, ADMIN_DB: db } as Env);
      await vi.advanceTimersByTimeAsync(0);
      expect(transaction).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(FEATURED_READ_DEADLINE_MS);
      const res = await response;
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-testid="join"');
      expect(html).not.toContain('data-testid="featured-content"');
      expect(vi.getTimerCount()).toBe(0);
      // A transport error arriving after the response is still handled.
      rejectRead(new Error("late database failure"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the configured allowlist for remote image rendering and CSP on the homepage", async () => {
    const imageUrl = "https://images.unsplash.com/photo.jpg";
    expect(featuredImageAllowed(imageUrl, env.APP_URL, "images.unsplash.com")).toBe(true);
    expect(featuredImageSrc(imageUrl, env.APP_URL, "images.unsplash.com")).toBe(imageUrl);
    expect(featuredImageSrc(imageUrl, env.APP_URL)).toBeNull();
    for (const host of ["images.corp", "images.mail", "localhost.localdomain", "images.alt"]) {
      expect(featuredImageSrc(`https://${host}/photo.jpg`, env.APP_URL, host)).toBeNull();
    }
    vi.spyOn(eventReads, "loadHomeUpcomingMerged").mockResolvedValue({
      items: [],
      unavailable: false,
      discordFailed: false,
    });
    // The homepage reads the published base through the guest cache and
    // applies the live window per request; the open window here is always live.
    vi.spyOn(featuredReads, "listPublishedFeatured").mockResolvedValue([
      {
        id: 1,
        title: "Configured photo",
        body: null,
        url: null,
        imageUrl,
        imageAlt: "Squad photo",
        startsAt: null,
        endsAt: null,
      },
    ]);
    const bindings = {
      ...env,
      ADMIN_DB: drizzle.mock(),
      FEATURED_IMAGE_HOSTS: "images.unsplash.com",
    } as Env;
    const res = await app.request("/", {}, bindings);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`src="${imageUrl}" alt="Squad photo"`);
    expect(res.headers.get("content-security-policy")).toContain(
      "img-src 'self' https://cdn.discordapp.com https://images.unsplash.com",
    );
    const unconfigured = await app.request("/", {}, { ...bindings, FEATURED_IMAGE_HOSTS: "" });
    expect(await unconfigured.text()).not.toContain(imageUrl);
  });

  it.each([
    ["/local.jpg", true],
    ["https://next.example.test/photo.jpg", true],
    ["https://cdn.discordapp.com/attachments/photo.jpg", true],
    ["https://images.example.test/photo.jpg", false],
    ["http://cdn.discordapp.com/photo.jpg", false],
    ["https://cdn.discordapp.com:8443/photo.jpg", false],
    ["https://cdn.discordapp.com.evil.test/photo.jpg", false],
    ["//evil.test/photo.jpg", false],
    ["data:image/png;base64,AAAA", false],
    ["javascript:alert(1)", false],
    ["https://user:password@cdn.discordapp.com/photo.jpg", false],
  ])("matches the strict image policy for %s", (url, allowed) => {
    expect(featuredImageAllowed(url, env.APP_URL)).toBe(allowed);
  });

  it.each([
    ["/local.jpg", "/local.jpg"],
    ["https://next.example.test/photo.jpg?a=1#frag", "/photo.jpg?a=1#frag"],
    [
      "https://cdn.discordapp.com/attachments/photo.jpg",
      "https://cdn.discordapp.com/attachments/photo.jpg",
    ],
    ["https://images.example.test/photo.jpg", null],
    ["https://next.example.test//evil.test/photo.jpg", null],
  ])("renders a 'self'-safe src for %s", (url, src) => {
    expect(featuredImageSrc(url, env.APP_URL)).toBe(src);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("featured homepage (isolated test Postgres)", () => {
  let fixture: MemberDataFixture;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 2 });
  });
  beforeEach(async () => {
    await fixture.db.delete(featuredContents);
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const home = () =>
    app.request("/", {}, {
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
      "Inside",
      "Open",
      "Start exact",
      "No start",
      "No end",
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const res = await home();
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const title of ["Inside", "Open", "Start exact", "No start", "No end"])
        expect(html).toContain(`<h3>${title}</h3>`);
      for (const title of ["Draft", "Future", "Past", "End exact"])
        expect(html).not.toContain(`<h3>${title}</h3>`);
      expect(html.match(/data-testid="featured-item"/g)).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders by position then id and does not impose the upcoming-events cap", async () => {
    const rows = await fixture.db
      .insert(featuredContents)
      .values([
        { title: "Last", isPublished: true, position: 9 },
        { title: "Tie first", isPublished: true, position: 1 },
        { title: "Tie second", isPublished: true, position: 1 },
        { title: "First", isPublished: true, position: -1 },
        { title: "Middle", isPublished: true, position: 4 },
      ])
      .returning();
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
        title: "Squad <night>",
        body: '<script>alert("body")</script>',
        isPublished: true,
        url: "https://example.test/squad?a=1&b=2",
        imageUrl: "/squad.jpg",
        imageAlt: "  Squad & friends  ",
      },
      { title: "Title fallback", isPublished: true, imageUrl: "/fallback.jpg", imageAlt: null },
      { title: "Blank fallback", isPublished: true, imageUrl: "/blank.jpg", imageAlt: "   " },
      { title: "Text only", isPublished: true },
    ]);
    const res = await home();
    const html = await res.text();
    expect(html).toContain('<h2 id="featured-heading">From the community team</h2>');
    expect(html).toContain('aria-labelledby="featured-heading"');
    expect(html).toContain(
      '<h3><a href="https://example.test/squad?a=1&amp;b=2">Squad &lt;night&gt;</a></h3>',
    );
    expect(html).toContain("&lt;script&gt;");
    const withoutJsonLd = html.replace(
      /<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g,
      "",
    );
    expect(withoutJsonLd).not.toMatch(/<script\b|\sstyle=|\son\w+=/i);
    expect(html).toContain('alt="Squad &amp; friends"');
    expect(html).toContain('alt="Title fallback"');
    expect(html).toContain('alt="Blank fallback"');
    const featuredHtml = html.match(
      /<section\b[^>]*data-testid="featured-content"[^>]*>[\s\S]*?<\/section>/,
    )?.[0];
    expect(featuredHtml).toBeDefined();
    expect(featuredHtml!.match(/loading="lazy"/g)).toHaveLength(3);
    expect(featuredHtml!.match(/width="640" height="360"/g)).toHaveLength(3);
    expect(featuredHtml!.match(/decoding="async" referrerpolicy="no-referrer"/g)).toHaveLength(3);
    expect(featuredHtml).not.toMatch(/<a[^>]*><img/);
    expect(res.headers.get("content-security-policy")).toContain(
      "img-src 'self' https://cdn.discordapp.com",
    );
  });

  it("keeps homepage 200 and cancels a lock-blocked SELECT in Postgres", async () => {
    await fixture.db
      .insert(featuredContents)
      .values({ title: "Locked feature", isPublished: true });
    await fixture.client.begin(async (tx) => {
      await tx`lock table featured_contents in access exclusive mode`;
      const start = Date.now();
      const res = await home();
      expect(res.status).toBe(200);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(await res.text()).not.toContain('data-testid="featured-content"');
      expect(
        await waitForNoLockWaiters(
          async () =>
            (
              await tx`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'active' and wait_event_type = 'Lock' and query ilike '%featured_contents%' and pid <> pg_backend_pid()`
            )[0]!.n,
          { timeoutMs: 800 },
        ),
      ).toBe(true);
    });
    // Transaction-scoped settings do not leak; subsequent reads still work.
    expect((await listVisibleFeatured(fixture.db)).map((row) => row.title)).toEqual([
      "Locked feature",
    ]);
  });

  it("publishes CSP-allowed photos through admin create/edit, rejects blocked hosts, and suppresses old blocked images", async () => {
    const store = createMemorySessionStore();
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: "featured-mod",
      username: "moderator",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const cookie = (
      await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    const admin = adminApp({ sessionStore: store, db: fixture.db });
    const publish = (path: string, title: string, imageUrl: string) =>
      admin.request(
        path,
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            title,
            image_url: imageUrl,
            image_alt: "Squad photo",
            is_published: "on",
          }),
        },
        { ...env, ADMIN_DB: fixture.db } as EnvWithAdminDb,
      );
    for (const imageUrl of [
      "https://images.example.test/photo.jpg",
      "http://cdn.discordapp.com/photo.jpg",
    ]) {
      const rejected = await publish("/featured", "Rejected photo", imageUrl);
      expect(rejected.status).toBe(422);
      expect(await rejected.text()).toContain("HTTPS on an approved public host");
    }
    expect(await listVisibleFeatured(fixture.db)).toEqual([]);
    const accepted = await publish(
      "/featured",
      "Published photo",
      "https://cdn.discordapp.com/attachments/photo.jpg",
    );
    expect(accepted.status).toBe(303);
    const [row] = await listVisibleFeatured(fixture.db);
    expect(row!.imageUrl).toBe("https://cdn.discordapp.com/attachments/photo.jpg");
    expect(await (await home()).text()).toContain(
      'src="https://cdn.discordapp.com/attachments/photo.jpg" alt="Squad photo"',
    );
    const rejectedEdit = await publish(
      `/featured/${row!.id}`,
      "Bad edit",
      "https://images.example.test/photo.jpg",
    );
    expect(rejectedEdit.status).toBe(422);
    const rejectedLocal = await publish(
      `/featured/${row!.id}`,
      "Local photo",
      `${env.APP_URL}/local.jpg`,
    );
    expect(rejectedLocal.status).toBe(422); // New URLs need an approved public host, even on this site.
    const edited = await publish(
      `/featured/${row!.id}`,
      "Edited photo",
      "https://cdn.discordapp.com/attachments/edited.jpg",
    );
    expect(edited.status).toBe(303);
    await fixture.db.insert(featuredContents).values([
      {
        title: "Old imported photo",
        imageUrl: "https://images.example.test/old.jpg",
        isPublished: true,
      },
      { title: "Legacy local photo", imageUrl: `${env.APP_URL}/local.jpg`, isPublished: true },
    ]);
    const res = await home();
    const html = await res.text();
    expect(html).toContain('src="/local.jpg"');
    expect(html).not.toContain(`src="${env.APP_URL}/local.jpg"`);
    expect(html).toContain("Old imported photo");
    expect(html).not.toContain("https://images.example.test/old.jpg");
    expect(res.headers.get("content-security-policy")).toContain(
      "img-src 'self' https://cdn.discordapp.com",
    );
  });

  it("omits an empty published section", async () => {
    await fixture.db.insert(featuredContents).values({ title: "Moderator draft" });
    const res = await home();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('data-testid="featured-content"');
  });

  describe("row and text bounds", () => {
    const cap = featuredReads.FEATURED_ROW_CAP;
    const cached = (at: Date) =>
      cachedFeatured({ ...env, ADMIN_DB: fixture.db } as EnvWithAdminDb, async () => fixture.db, at);
    const bulk = (count: number, make: (i: number) => Partial<typeof featuredContents.$inferInsert>) =>
      fixture.db.insert(featuredContents).values(
        Array.from({ length: count }, (_, i) => ({
          title: `Row ${i}`,
          isPublished: true,
          ...make(i),
        })),
      );
    const readers = {
      published: (at: Date, status?: { saturated: boolean }) =>
        featuredReads.listPublishedFeatured(fixture.db, at, status),
      visible: (at: Date) => listVisibleFeatured(fixture.db, at),
    };

    it("returns the first cap rows by position then id from both readers", async () => {
      const inserted = await bulk(cap + 5, (i) => ({ position: (cap + 5 - i) % 7 }))
        .returning();
      const expected = [...inserted]
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .slice(0, cap)
        .map((row) => row.id);
      expect(cap).toBe(100);
      for (const read of Object.values(readers)) {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect((await read(now)).map((row) => row.id)).toEqual(expected);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.any(String), { limit: 100, returned: 100 });
        warn.mockRestore();
      }
    });

    it("does not warn or report saturation at exactly the cap", async () => {
      await bulk(cap, () => ({}));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const status = { saturated: true };
      expect(await readers.published(now, status)).toHaveLength(cap);
      expect(status.saturated).toBe(false);
      expect(await readers.visible(now)).toHaveLength(cap);
      expect(warn).not.toHaveBeenCalled();
    });

    const bounds = [
      ["title", 255],
      ["url", 255],
      ["imageUrl", 255],
      ["imageAlt", 255],
      ["body", 1000],
    ] as const;
    it.each(bounds)("skips a whole row whose %s exceeds %i characters", async (field, max) => {
      // Multibyte values at exactly the limit count characters, not bytes or UTF-16 units.
      const exact = { é: "é".repeat(max), "😀": "😀".repeat(max) };
      const mk = (title: string, value: string) =>
        field === "title" ? { title: value } : { title, [field]: value };
      await fixture.db.insert(featuredContents).values([
        { ...mk("over", "x".repeat(max + 1)), isPublished: true, position: 1 },
        { ...mk("over-multibyte", "😀".repeat(max + 1)), isPublished: true, position: 2 },
        { ...mk("exact-latin", exact["é"]), isPublished: true, position: 3 },
        { ...mk("exact-astral", exact["😀"]), isPublished: true, position: 4 },
        { title: "plain", isPublished: true, position: 5 },
      ]);
      for (const read of Object.values(readers)) {
        const rows = await read(now);
        expect(rows).toHaveLength(3);
        const titles = rows.map((row) => row.title);
        expect(titles).not.toContain("over");
        expect(titles).not.toContain("over-multibyte");
        expect(titles).toContain("plain");
        // The url policy may drop an unsafe stored link; the row itself stays.
        if (field !== "url") {
          const values = rows.slice(0, 2).map((row) => String(row[field]));
          expect(values).toEqual([exact["é"], exact["😀"]]);
        }
      }
    });

    it("keeps null optional fields", async () => {
      await fixture.db
        .insert(featuredContents)
        .values({ title: "Nulls", isPublished: true, body: null, imageAlt: null });
      for (const read of Object.values(readers))
        expect((await read(now)).map((row) => row.title)).toEqual(["Nulls"]);
    });

    it("does not let expired rows beyond the cap crowd out current or future rows", async () => {
      await bulk(cap + 1, () => ({ position: 0, endsAt: before }));
      await fixture.db.insert(featuredContents).values([
        { title: "Exact end", isPublished: true, position: 0, endsAt: now },
        { title: "Current", isPublished: true, position: 1 },
        { title: "Future", isPublished: true, position: 2, startsAt: after },
      ]);
      const status = { saturated: true };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const base = await readers.published(now, status);
      expect(base.map((row) => row.title)).toEqual(["Current", "Future"]);
      expect(status.saturated).toBe(false);
      const live = await cached(now);
      expect(live.map((row) => row.title)).toEqual(["Current"]);
      // The public DTO carries the six display fields, never the window bounds.
      expect(Object.keys(live[0]!).sort()).toEqual(
        ["body", "id", "imageAlt", "imageUrl", "title", "url"].sort(),
      );
      // The cached base keeps the future row: it appears once its start passes.
      expect((await cached(new Date(after.getTime() + 1))).map((row) => row.title)).toEqual([
        "Current",
        "Future",
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("falls back to the visible reader when future rows saturate the base, without caching it", async () => {
      await bulk(cap, (i) => ({ title: `Future ${i}`, position: i, startsAt: after }));
      await fixture.db
        .insert(featuredContents)
        .values({ title: "Live beyond cap", isPublished: true, position: cap + 50 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const status = { saturated: false };
      const base = await readers.published(now, status);
      expect(status.saturated).toBe(true);
      expect(base.every((row) => row.title.startsWith("Future"))).toBe(true);
      expect((await cached(now)).map((row) => row.title)).toEqual(["Live beyond cap"]);
      // A poisoned stored base would now hide the live row from a repeat request.
      expect((await cached(now)).map((row) => row.title)).toEqual(["Live beyond cap"]);
      const later = await cached(new Date(after.getTime() + 1));
      expect(later).toHaveLength(cap);
      expect(later.every((row) => row.title.startsWith("Future"))).toBe(true);
      warn.mockRestore();
    });
  });
});
