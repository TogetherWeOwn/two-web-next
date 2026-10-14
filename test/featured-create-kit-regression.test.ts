// Featured create-form Kit slice: regression coverage for the port that keeps
// the Hono create controller as the single write authority.
//
// Part A pins the Kit page contract (file-level, DB-free): the native page
// exists, stays a plain no-JS POST to the Hono-owned POST /admin/featured with
// the exact Hono field names, control kinds, hint copy, save testid and cancel
// destination, and its server file performs no database read (the shared layout
// guard authorizes through `await parent()`).
//
// Part B pins route ownership: the manifest carries the new page as a disabled
// GET with the Hono create reads, while POST /admin/featured and the guarded
// legacy create redirect stay Hono-owned.
//
// Part C pins the Hono create outcomes the slice preserves (live, agent-testdb):
// allowed/disallowed image hosts, inverted windows, missing-headline 422s with
// preserved values, escaped re-rendered content, the no-JS 303, and the legacy
// 301. Guest/member refusal already belongs to the featured policy suite.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { EnvWithAdminDb } from "../src/admin/db";
import { featuredContents } from "../src/db/admin-schema";
import { decideOwner, ROUTE_MANIFEST } from "../src/route-ownership";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import app from "./app";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p: string) => join(root, p);
const read = (p: string): string => readFileSync(path(p), "utf8");

const NEW_PAGE = "web/src/routes/admin/featured/new/+page.svelte";
const NEW_SERVER = "web/src/routes/admin/featured/new/+page.server.ts";

// The exact Hono field names the Kit form must carry (src/admin/pages/featured-form.tsx).
const HONO_FIELDS = [
  "title",
  "body",
  "url",
  "image_url",
  "image_alt",
  "is_published",
  "position",
  "starts_at",
  "ends_at",
] as const;

function tagWith(svelte: string, name: string): string {
  const match = new RegExp(`<(input|textarea|select)[^>]*name="${name}"[^>]*>`, "i").exec(svelte);
  expect(match, `form control named ${name}`).not.toBeNull();
  return match![0];
}

describe("featured create Kit page contract (DB-free file pins)", () => {
  it("ships the native create page and its server file", () => {
    expect(existsSync(path(NEW_PAGE)), NEW_PAGE).toBe(true);
    expect(existsSync(path(NEW_SERVER)), NEW_SERVER).toBe(true);
  });

  it("stays a plain no-JS POST form to the Hono-owned create route", () => {
    const svelte = read(NEW_PAGE);
    expect(svelte).toMatch(/export\s+const\s+csr\s*=\s*false/);
    expect(svelte).toContain('action="/admin/featured"');
    expect(svelte).toMatch(/<form[^>]*method="post"/i);
  });

  it("carries every Hono field name, so no submitted value is silently dropped", () => {
    const svelte = read(NEW_PAGE);
    for (const field of HONO_FIELDS) expect(svelte, field).toContain(`name="${field}"`);
  });

  it("mirrors the Hono control kinds for each field", () => {
    const svelte = read(NEW_PAGE);
    expect(tagWith(svelte, "title")).toMatch(/type="text"/i);
    expect(tagWith(svelte, "title")).toMatch(/required/);
    expect(tagWith(svelte, "body")).toMatch(/^<textarea/i);
    expect(tagWith(svelte, "url")).toMatch(/type="url"/i);
    expect(tagWith(svelte, "image_url")).toMatch(/type="url"/i);
    expect(tagWith(svelte, "image_alt")).toMatch(/type="text"/i);
    expect(tagWith(svelte, "is_published")).toMatch(/type="checkbox"/i);
    expect(tagWith(svelte, "position")).toMatch(/inputmode="numeric"/i);
    expect(tagWith(svelte, "starts_at")).toMatch(/type="text"/i);
    expect(tagWith(svelte, "ends_at")).toMatch(/type="text"/i);
  });

  it("mirrors the Hono labels and hint copy", () => {
    const svelte = read(NEW_PAGE);
    expect(svelte).toContain("Headline");
    expect(svelte).toContain("Image URL");
    expect(svelte).toContain("HTTPS URL on cdn.discordapp.com");
    expect(svelte).toContain("screen-reader");
    expect(svelte).toContain("lower appears first");
    expect(svelte).toContain("Show from (UTC");
    expect(svelte).toContain("Show until (UTC");
  });

  it("keeps the Hono save testid and cancel destination", () => {
    const svelte = read(NEW_PAGE);
    expect(svelte).toContain('data-testid="save-featured"');
    expect(svelte).toContain(">Create<");
    expect(svelte).toContain('href="/admin/featured"');
    expect(svelte).toContain(">Cancel<");
  });

  it("defines no Kit form actions: the Hono controller stays the only writer", () => {
    const server = read(NEW_SERVER);
    expect(server).not.toMatch(/export\s+const\s+actions/);
  });

  it("authorizes through the shared layout guard and performs no database read", () => {
    const server = read(NEW_SERVER);
    expect(server).toContain("parent()");
    expect(server).not.toContain("admin-schema");
    expect(server).not.toContain("drizzle-orm");
  });
});

describe("featured create route ownership (DB-free manifest pins)", () => {
  it("registers the new page as a disabled GET with the Hono create reads", () => {
    const entry = ROUTE_MANIFEST.find(
      (route) => route.method === "GET" && route.path === "/admin/featured/new",
    );
    expect(entry).toMatchObject({
      method: "GET",
      path: "/admin/featured/new",
      enabled: false,
      reads: {
        resource: "featured_contents",
        action: "view",
        route: "admin.featured.create",
      },
    });
  });

  it("leaves every featured write on Hono: no enabled Kit POST entry", () => {
    for (const route of ROUTE_MANIFEST) {
      if (route.method === "POST" && route.path.startsWith("/admin/featured")) {
        expect(route, `${route.method} ${route.path}`).toMatchObject({ enabled: false });
      }
      if (route.path.startsWith("/admin/featured-contents")) {
        expect(route, `${route.method} ${route.path}`).toMatchObject({ enabled: false });
      }
    }
  });

  it("dispatches POST /admin/featured to Hono", () => {
    const request = new Request("https://admin.example.test/admin/featured", {
      method: "POST",
    });
    expect(decideOwner(request)).toBe("hono");
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "featured create outcomes the Kit slice preserves",
  () => {
    let fixture: MemberDataFixture;
    let sessions: SessionStore;
    let modCookie = "";
    let memberCookie = "";
    const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as EnvWithAdminDb;
    const admin = () => adminApp({ sessionStore: sessions, db: fixture.db });
    const rows = () => fixture.db.select().from(featuredContents);
    const post = (fields: Record<string, string>, cookie: string) =>
      admin().request(
        "/featured",
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields),
        },
        bindings(),
      );
    const mounted = (path: string, init?: RequestInit, cookie?: string) =>
      app.request(
        path,
        { ...init, headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) } },
        { ...env, ADMIN_DB: fixture.db, SESSION_STORE: sessions } as EnvWithAdminDb,
      );

    beforeEach(async () => {
      if (!fixture) fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      sessions = createMemorySessionStore();
      modCookie = await cookieFor(sessions, MODERATOR);
      memberCookie = await cookieFor(sessions, MEMBER);
    });
    afterAll(() => fixture?.dispose());

    it("creates through the no-JS form shape with a 303 to the new slot", async () => {
      const create = await post(
        { title: "Kit slice slot", body: "Kept by Hono", position: "2" },
        modCookie,
      );
      expect(create.status).toBe(303);
      expect(create.headers.get("location")).toMatch(/^\/admin\/featured\/\d+$/);
      expect(await rows()).toHaveLength(1);
    });

    it("rejects a missing headline with a 422 that preserves the entered values", async () => {
      const res = await post({ body: "Kept body", position: "3" }, modCookie);
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("Give it a headline.");
      expect(html).toContain("Kept body");
      expect(html).toContain('data-testid="save-featured"');
      expect(html).toContain('data-testid="form-errors"');
      expect(await rows()).toHaveLength(0);
    });

    it("rejects an inverted show window with a 422", async () => {
      const res = await post(
        {
          title: "Backwards slot",
          position: "0",
          starts_at: "2026-11-04 11:15",
          ends_at: "2026-11-04 09:05",
        },
        modCookie,
      );
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("The window ends after it starts.");
      expect(await rows()).toHaveLength(0);
    });

    it("rejects an image host outside the approved allowlist with a 422", async () => {
      const res = await post(
        {
          title: "Off-host slot",
          position: "0",
          image_url: "https://photos.example.com/x.png",
          image_alt: "A photo somewhere unapproved.",
        },
        modCookie,
      );
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("approved public host");
      expect(await rows()).toHaveLength(0);
    });

    it("accepts the default Discord CDN host end to end", async () => {
      const create = await post(
        {
          title: "CDN slot",
          position: "0",
          image_url: "https://cdn.discordapp.com/attachments/1/x.png",
          image_alt: "Members playing together.",
        },
        modCookie,
      );
      expect(create.status).toBe(303);
      expect(await rows()).toHaveLength(1);
    });

    it("escapes a hostile headline when the form re-renders with errors", async () => {
      const res = await post(
        {
          title: "<script>alert(1)</script>",
          position: "0",
          image_url: "https://photos.example.com/x.png",
          image_alt: "A photo somewhere unapproved.",
        },
        modCookie,
      );
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>alert(1)");
    });

    it("keeps the guarded legacy create redirect on Hono with a 301 for moderators", async () => {
      const res = await mounted("/admin/featured-contents/create", {}, modCookie);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/featured/new");
      const member = await mounted("/admin/featured-contents/create", {}, memberCookie);
      expect(member.status).toBe(403);
    });
  },
);
