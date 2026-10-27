// Acceptance: admin unpublish from the featured list without revalidating
// the whole row.
//
// A moderator-only POST action alongside /featured/:id/delete sets only
// isPublished=false for one featured row. It is body-capped and throttled
// like the sibling action routes, admits only a canonical record ID, answers
// 404 for unknown/non-canonical IDs, and never revalidates any other stored
// field: a published row whose stored image host would fail today's
// full-form validation must still unpublish (that stale field is exactly why
// the full edit POST cannot pull the slot today). The stored row is
// otherwise byte-identical, a dirty-only audit + homepage-cache retirement
// are observed, and a second POST on an already-unpublished row is the pinned
// no-op: same success envelope, no new audit row. The list renderers (Hono
// FeaturedPage and the Kit twin) expose the action only on published rows.
//
// FAIL-FIRST: every "unpublish" test below is RED until the build lands —
// the route does not exist (404 where 303 is pinned), no list form targets
// it, and the Kit source carries no such form. The guard/cap/no-op/unknown-ID
// pins that only name today's outer shape (401/403 before the route table,
// 404 for unknown IDs) pass both before and after and exist to stop a build
// from widening any of those edges.
//
// Agent-runnable command (run-owned disposable DB per README):
//   DATABASE_URL="postgres://agent_test@agent-testdb:5432/two_web_next_tog<digits>" \
//     npx vitest run test/admin-featured-unpublish-acceptance.test.ts
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { FeaturedPage } from "../src/admin/pages";
import { adminApp } from "../src/admin/routes";
import type { FeaturedRow } from "../src/admin/store";
import { parseFeaturedListQuery } from "../src/admin/table-list";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { listVisibleFeatured } from "../src/featured";
import { isFeaturedImageUrl } from "../src/image-policy";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { isThrottleMiddleware } from "../src/throttle";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

// The incident shape: a published row whose stored image host was once
// allowed but is not on today's allowlist, so the full edit form 422s on
// image_url and the slot cannot be pulled through the edit POST at all.
type SeedSlot = {
  title: string;
  body: string | null;
  url: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  isPublished: boolean;
  position: number;
  startsAt: Date | null;
  endsAt: Date | null;
};
const STALE_SLOT: SeedSlot = {
  title: "Stale headline",
  body: "Stale body",
  url: "https://example.test/stale",
  imageUrl: "https://stale-images-public.example.net/slot.png",
  imageAlt: "Stale alt text",
  isPublished: true,
  position: 4,
  startsAt: null,
  endsAt: null,
};

const unpublishPath = (id: number | string) => `/featured/${id}/unpublish`;

describe(
  "admin featured unpublish: moderator POST sets only isPublished=false (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let sessions: SessionStore;
    let modCookie = "";
    let memberCookie = "";
    const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as EnvWithAdminDb;
    const admin = () => adminApp({ sessionStore: sessions, db: fixture.db });
    const unpublish = (id: number | string, init: { cookie?: string; body?: string } = {}) =>
      admin().request(
        unpublishPath(id),
        {
          method: "POST",
          headers: {
            cookie: init.cookie ?? modCookie,
            origin: env.APP_URL,
            // JSON negotiation pins guard refusals as 401/403, like the
            // sibling body-cap suite; a browser Accept gets the login 303.
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: init.body ?? "",
        },
        bindings(),
      );

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      sessions = createMemorySessionStore();
      modCookie = await cookieFor(sessions, MODERATOR);
      memberCookie = await cookieFor(sessions, MEMBER);
    });
    afterAll(() => fixture?.dispose());

    async function seed(slot: SeedSlot = STALE_SLOT) {
      const [seeded] = await fixture.db
        .insert(featuredContents)
        .values({ ...slot })
        .returning();
      return seeded!;
    }
    const rows = () => fixture.db.select().from(featuredContents);
    const audits = () => fixture.db.select().from(activityLog);

    it("unpublishes a published row whose stored image host fails today's full-form validation", async () => {
      // Premise: the stored host is NOT approved today, so a resubmit of the
      // whole row through parseFeaturedForm would 422 on image_url.
      expect(isFeaturedImageUrl(STALE_SLOT.imageUrl!, env.FEATURED_IMAGE_HOSTS)).toBe(false);
      const seeded = await seed();

      const res = await unpublish(seeded.id);

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/admin/featured");
      const [after] = await rows();
      expect(after).toBeDefined();
      // Only isPublished moved: every other stored value is byte-identical,
      // including the stale image host the edit form would have refused.
      expect(after).toMatchObject({ ...STALE_SLOT, isPublished: false, id: seeded.id });
      expect(after!.imageUrl).toBe(STALE_SLOT.imageUrl);
    });

    it("audits the unpublish dirty-only, under the moderator causer", async () => {
      const seeded = await seed();

      expect((await unpublish(seeded.id)).status).toBe(303);

      const logged = await audits();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        logName: "default",
        subjectType: "FeaturedContent",
        subjectId: String(seeded.id),
        causerId: MODERATOR.userId,
      });
      expect(logged[0]!.description).toContain(STALE_SLOT.title);
      // Same dirty() shape as the update audit: the only changed key is
      // isPublished true -> false; no other stored field is claimed changed.
      expect(logged[0]!.properties).toEqual({
        isPublished: { before: true, after: false },
      });
    });

    it("drops the row from guest-visible reads (cache retire observed through visible read)", async () => {
      const seeded = await seed();
      const before = await listVisibleFeatured(fixture.db, new Date());
      expect(before.map((r) => r.id)).toContain(seeded.id);

      expect((await unpublish(seeded.id)).status).toBe(303);

      // The committed unpublish retires the homepage guest cache like the
      // sibling writes; the visible read no longer serves the slot.
      expect(await listVisibleFeatured(fixture.db, new Date())).toEqual([]);
    });

    it("second POST on an already-unpublished row is the pinned no-op: 303, no new audit, row unchanged", async () => {
      const seeded = await seed();
      expect((await unpublish(seeded.id)).status).toBe(303);
      expect(await audits()).toHaveLength(1);
      const [afterFirst] = await rows();

      const second = await unpublish(seeded.id);

      expect(second.status).toBe(303);
      expect(second.headers.get("location")).toBe("/admin/featured");
      expect(await audits()).toHaveLength(1);
      expect(await rows()).toEqual([afterFirst]);
    });

    it("unknown id 404s and audits nothing", async () => {
      const res = await unpublish(424242);
      expect(res.status).toBe(404);
      expect(await audits()).toHaveLength(0);
    });

    it.each(["not-an-id", "007", "0", "-1", "2147483648"])(
      "non-canonical id %s 404s and audits nothing",
      async (raw) => {
        // Seed a real published row: a non-canonical spelling must never be
        // coerced onto it (007 must not unpublish row 7, 0/-1 must not widen).
        const seeded = await seed();
        const res = await unpublish(raw);
        expect(res.status, raw).toBe(404);
        expect(await audits()).toHaveLength(0);
        const [after] = await rows();
        expect(after!.id).toBe(seeded.id);
        expect(after!.isPublished).toBe(true);
      },
    );

    it("moderator-only: guest 401 and non-moderator 403 leave the row published and unaudited", async () => {
      const seeded = await seed();
      expect((await unpublish(seeded.id, { cookie: "" })).status).toBe(401);
      expect((await unpublish(seeded.id, { cookie: memberCookie })).status).toBe(403);
      const [after] = await rows();
      expect(after!.isPublished).toBe(true);
      expect(await audits()).toHaveLength(0);
    });

    it("body-capped like the sibling action routes: oversized body is 413 and changes nothing", async () => {
      const seeded = await seed();
      const res = await unpublish(seeded.id, {
        body: `pad=${"x".repeat(BODY_LIMIT_BYTES.action + 1)}`,
      });
      expect(res.status).toBe(413);
      const [after] = await rows();
      expect(after!.isPublished).toBe(true);
      expect(await audits()).toHaveLength(0);
    });

    it("approved-host published row also unpublishes (the stale host is not the gate)", async () => {
      const seeded = await seed({
        ...STALE_SLOT,
        title: "Fresh headline",
        imageUrl: "https://cdn.discordapp.com/slot.png",
      });
      const res = await unpublish(seeded.id);
      expect(res.status).toBe(303);
      const [after] = await rows();
      expect(after!.isPublished).toBe(false);
      expect(await audits()).toHaveLength(1);
    });
  },
);

describe("unpublish route registration", () => {
  it("registers POST /featured/:id/unpublish behind the shared throttle middleware, like the sibling delete", () => {
    const app = adminApp({ sessionStore: createMemorySessionStore() });
    const hits = app.routes.filter(
      (r) => r.method === "POST" && r.path === "/featured/:id/unpublish",
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((r) => isThrottleMiddleware(r.handler))).toBe(true);
    // Sibling sanity: the delete action this route sits alongside is
    // registered the same way today, so the pin above names a real pattern.
    const sibling = app.routes.filter(
      (r) => r.method === "POST" && r.path === "/featured/:id/delete",
    );
    expect(sibling.some((r) => isThrottleMiddleware(r.handler))).toBe(true);
  });
});

describe("featured list renderers expose unpublish only on published rows", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");
  const base: FeaturedRow = {
    id: 7,
    legacyId: null,
    title: "Published slot",
    body: "Body",
    url: null,
    imageUrl: null,
    imageAlt: null,
    isPublished: true,
    position: 1,
    startsAt: null,
    endsAt: null,
    createdBy: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
  };
  const renderHono = (rows: FeaturedRow[]) =>
    String(jsx(FeaturedPage, { rows, query: parseFeaturedListQuery({}), now }));
  const unpublishForm = (id: number) =>
    new RegExp(
      `<form[^>]*method="post"[^>]*action="/admin/featured/${id}/unpublish"|<form[^>]*action="/admin/featured/${id}/unpublish"[^>]*method="post"`,
    );

  it("Hono list: published row carries a POST unpublish form to /admin/featured/:id/unpublish", () => {
    const html = renderHono([base]);
    expect(html).toContain(`data-testid="featured-status-${base.id}"`);
    expect(html).toMatch(unpublishForm(base.id));
    expect(html).toMatch(/>\s*Unpublish\s*<\/button>/);
  });

  it("Hono list: unpublished row carries no unpublish form (action visibility follows isPublished)", () => {
    const draft = { ...base, id: 8, title: "Draft slot", isPublished: false };
    const html = renderHono([draft]);
    expect(html).toContain(`data-testid="featured-status-${draft.id}"`);
    expect(html).not.toMatch(unpublishForm(draft.id));
    expect(html).not.toContain("/unpublish");
  });

  it("Kit list: the Svelte twin posts published rows to the same Hono unpublish endpoint", () => {
    const source = read("web/src/routes/admin/featured/+page.svelte");
    expect(source).toContain("unpublish");
    expect(source).toMatch(
      /<form[^>]*method="post"[^>]*action=\{`\/admin\/featured\/\$\{r\.id\}\/unpublish`\}/,
    );
    expect(source).toMatch(/>\s*Unpublish\s*<\/button>/);
  });
});
