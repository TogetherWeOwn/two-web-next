// TOG-12274: FeaturedContentPolicy parity (docs/parity.md §9).
//
// Legacy: every featured-content write is moderator-only; the public surface
// reads exactly the `currentlyVisible` rows (start inclusive, end exclusive,
// no homepage cap — src/featured.ts:11). TOG-8719 covered JoinAttempt +
// agent-event policies only; this file pins the featured half.
//
// Enforcement lives in the existing layers (no product change here beyond the
// reviewable statement in src/featured-policy.ts, which this file also pins):
// - writes: `ALL /admin/*` moderator middleware + adminGuard (guest 302
//   bounce to OAuth, signed-in non-moderator 403) + the outer same-origin 403;
// - public reads: listVisibleFeatured (isPublished + [startsAt, endsAt)).
// Refusal is asserted through the mounted app (child-root adminApp alone
// would answer a guest POST with the recovery 303, not the real 302).

import { readFileSync, readdirSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { EnvWithAdminDb } from "../src/admin/db";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import { listVisibleFeatured } from "../src/featured";
import {
  canCreateFeaturedContent,
  canDeleteFeaturedContent,
  canManageFeaturedContent,
  canPublishFeaturedContent,
  canUpdateFeaturedContent,
  FEATURED_WRITE_ROUTES,
  isFeaturedPubliclyVisible,
} from "../src/featured-policy";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import rawApp from "../src/index";
import app from "./app";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const root = new NodeURL("../", import.meta.url);
const read = (path: string) => readFileSync(new NodeURL(path, root), "utf8");

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new NodeURL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (entry.isFile() && (rel.endsWith(".ts") || rel.endsWith(".tsx"))) out.push(rel);
    }
  };
  walk("src/");
  return out.sort();
}

function filesMatching(re: RegExp): string[] {
  return srcFiles().filter((path) => re.test(read(path)));
}

function drizzleFiles(): string[] {
  return readdirSync(new NodeURL("drizzle/", root), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => `drizzle/${entry.name}`)
    .sort();
}

const now = new Date("2026-09-30T12:00:00Z");
const before = new Date(now.getTime() - 1000);
const after = new Date(now.getTime() + 1000);

describe("featured policy statement (pure, DB-free)", () => {
  it("refuses guests and non-moderators, admits moderators on every write verb", () => {
    for (const decide of [canManageFeaturedContent, canCreateFeaturedContent, canUpdateFeaturedContent, canDeleteFeaturedContent, canPublishFeaturedContent]) {
      expect(decide(null), decide.name).toBe(false);
      expect(decide(undefined), decide.name).toBe(false);
      expect(decide({ moderator: false }), decide.name).toBe(false);
      expect(decide({ moderator: true }), decide.name).toBe(true);
    }
  });

  it("public visibility is exactly currentlyVisible: start inclusive, end exclusive", () => {
    expect(isFeaturedPubliclyVisible({ isPublished: false, startsAt: before, endsAt: after }, now)).toBe(false);
    expect(isFeaturedPubliclyVisible({ isPublished: true, startsAt: null, endsAt: null }, now)).toBe(true);
    expect(isFeaturedPubliclyVisible({ isPublished: true, startsAt: now, endsAt: after }, now)).toBe(true);
    expect(isFeaturedPubliclyVisible({ isPublished: true, startsAt: before, endsAt: now }, now)).toBe(false);
    expect(isFeaturedPubliclyVisible({ isPublished: true, startsAt: before, endsAt: after }, now)).toBe(true);
    expect(isFeaturedPubliclyVisible({ isPublished: true, startsAt: after, endsAt: null }, now)).toBe(false);
    expect(isFeaturedPubliclyVisible({ isPublished: true, startsAt: null, endsAt: before }, now)).toBe(false);
  });

  it("names exactly the three mounted admin write routes", () => {
    expect([...FEATURED_WRITE_ROUTES].sort()).toEqual([
      "POST /admin/featured",
      "POST /admin/featured/:id",
      "POST /admin/featured/:id/delete",
    ]);
    // Hono lists one entry per handler in the middleware stack: dedupe like
    // the inventory guard (test/helpers/route-inventory.ts) before comparing.
    const mounted = [...new Set(rawApp.routes
      .filter((r) => r.method === "POST" && r.path.includes("featured"))
      .map((r) => `${r.method} ${r.path}`))].sort();
    expect(mounted).toEqual([...FEATURED_WRITE_ROUTES].sort());
  });
});

describe("featured write surface (DB-free source allowlist)", () => {
  it("registers exactly the three moderator write routes, no public featured writer", () => {
    const writes = [...new Set(adminApp(createMemorySessionStore())
      .routes.filter((r) => r.method === "POST" && r.path.includes("featured"))
      .map((r) => `${r.method} ${r.path}`))].sort();
    expect(writes).toEqual(["POST /featured", "POST /featured/:id", "POST /featured/:id/delete"]);
  });

  it("the featuredContents table object is touched only by schema, public read and the admin store", () => {
    expect(filesMatching(/\bfeaturedContents\b/)).toEqual([
      "src/admin/store.ts",
      "src/db/admin-schema.ts",
      "src/featured.ts",
    ]);
  });

  it("deleteFeatured is defined once and called only from the admin delete route", () => {
    expect(filesMatching(/deleteFeatured\(/)).toEqual(["src/admin/routes.tsx", "src/admin/store.ts"]);
  });

  it("no migration points a foreign key at featured_contents (safe delete)", () => {
    const referrers = drizzleFiles().filter((path) => /REFERENCES[^;]*featured_contents/i.test(read(path)));
    expect(referrers).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("featured policy (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let sessions: SessionStore;
  let modCookie = "";
  let memberCookie = "";
  const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as EnvWithAdminDb;
  const admin = () => adminApp({ sessionStore: sessions, db: fixture.db });
  const rows = () => fixture.db.select().from(featuredContents);
  const form = (fields: Record<string, string>, cookie: string) => ({
    method: "POST" as const,
    headers: { cookie, origin: env.APP_URL, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  // Refusals go through the mounted app: only there does a guest POST take
  // the real OAuth 302 (child-root adminApp alone answers the recovery 303).
  const mounted = (path: string, init?: RequestInit, cookie?: string) =>
    app.request(path, { ...init, headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) } }, {
      ...env, ADMIN_DB: fixture.db, SESSION_STORE: sessions,
    } as EnvWithAdminDb);

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

  it("guest writes bounce to OAuth and member writes 403, never 2xx, rows byte-identical", async () => {
    await fixture.db.insert(featuredContents).values({ title: "Seed slot", position: 0 });
    const draft = { title: "Guest slot", body: "Hello", position: "1" };
    const publishWindow = { title: "Seed slot", is_published: "on", position: "0", starts_at: "2026-11-04 09:05", ends_at: "2026-11-04 11:15" };
    const beforeRows = await rows();
    expect(beforeRows).toHaveLength(1);

    for (const [path, fields] of [
      ["/admin/featured", draft],
      ["/admin/featured/1", publishWindow],
      ["/admin/featured/1/delete", {}],
    ] as const) {
      const guest = await mounted(path, {
        method: "POST",
        headers: { origin: env.APP_URL, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
      expect(guest.status, `guest POST ${path}`).toBe(302);
      expect(guest.headers.get("location")).toBe("/auth/discord");

      const member = await mounted(path, {
        method: "POST",
        headers: { origin: env.APP_URL, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      }, memberCookie);
      expect(member.status, `member POST ${path}`).toBe(403);
    }
    expect(await rows()).toEqual(beforeRows);
  });

  it("guests redirect and members 403 on the admin featured reads", async () => {
    for (const path of ["/admin/featured", "/admin/featured/new", "/admin/featured/1"] as const) {
      const guest = await mounted(path);
      expect(guest.status, `guest GET ${path}`).toBe(302);
      expect(guest.headers.get("location")).toBe("/auth/discord");
      const member = await mounted(path, {}, memberCookie);
      expect(member.status, `member GET ${path}`).toBe(403);
    }
  });

  it("moderator full CRUD including the publish window, all audited", async () => {
    const create = await admin().request("/featured", form({ title: "Policy slot", body: "Hello", position: "2" }, modCookie), bindings());
    expect(create.status).toBe(303);
    const id = Number(new URL(create.headers.get("location")!, "https://x.test").pathname.split("/").pop());

    const publish = await admin().request(
      `/featured/${id}`,
      form({ title: "Policy slot", body: "Hello", is_published: "on", position: "0", starts_at: "2026-09-30 11:00", ends_at: "2026-09-30 13:00" }, modCookie),
      bindings(),
    );
    expect(publish.status).toBe(303);
    const [row] = await fixture.db.select().from(featuredContents).where(eq(featuredContents.id, id));
    expect(row).toMatchObject({ isPublished: true, position: 0 });

    const del = await admin().request(
      `/featured/${id}/delete`,
      { method: "POST", headers: { cookie: modCookie, origin: env.APP_URL } },
      bindings(),
    );
    expect(del.status).toBe(303);
    expect(await rows()).toHaveLength(0);

    const audits = await fixture.db.select().from(activityLog);
    expect(audits.map((a) => a.description)).toEqual([
      "created featured content Policy slot",
      "updated featured content Policy slot",
      "deleted featured content Policy slot",
    ]);
    expect(new Set(audits.map((a) => a.causerId))).toEqual(new Set([MODERATOR.userId]));
  });

  it("public reads return exactly the currentlyVisible rows, start-inclusive end-exclusive", async () => {
    await fixture.db.insert(featuredContents).values([
      { title: "Inside", isPublished: true, startsAt: before, endsAt: after, position: 1 },
      { title: "Open", isPublished: true, position: 2 },
      { title: "Start exact", isPublished: true, startsAt: now, endsAt: after, position: 3 },
      { title: "Draft", startsAt: before, endsAt: after, position: 0 },
      { title: "Future", isPublished: true, startsAt: after, position: 4 },
      { title: "Past", isPublished: true, endsAt: before, position: 5 },
      { title: "End exact", isPublished: true, startsAt: before, endsAt: now, position: 6 },
    ]);
    const visible = await listVisibleFeatured(fixture.db, now);
    expect(visible.map((r) => r.title)).toEqual(["Inside", "Open", "Start exact"]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const res = await app.request("/", {}, {
        ...env, ADMIN_DB: fixture.db, SESSION_STORE: createMemorySessionStore(),
      } as EnvWithAdminDb);
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const title of ["Inside", "Open", "Start exact"]) expect(html).toContain(`<h3>${title}</h3>`);
      for (const title of ["Draft", "Future", "Past", "End exact"]) expect(html).not.toContain(`<h3>${title}</h3>`);
      expect(html.match(/data-testid="featured-item"/g)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("safe delete removes the row, audits it, and a second delete 404s", async () => {
    const create = await admin().request("/featured", form({ title: "Doomed slot" }, modCookie), bindings());
    expect(create.status).toBe(303);
    const id = Number(new URL(create.headers.get("location")!, "https://x.test").pathname.split("/").pop());

    const first = await admin().request(
      `/featured/${id}/delete`,
      { method: "POST", headers: { cookie: modCookie, origin: env.APP_URL } },
      bindings(),
    );
    expect(first.status).toBe(303);
    expect(await rows()).toHaveLength(0);
    const audits = await fixture.db.select().from(activityLog);
    expect(audits.map((a) => a.description)).toEqual([
      "created featured content Doomed slot",
      "deleted featured content Doomed slot",
    ]);

    const second = await admin().request(
      `/featured/${id}/delete`,
      { method: "POST", headers: { cookie: modCookie, origin: env.APP_URL } },
      bindings(),
    );
    expect(second.status).toBe(404);
  });
});
