// route-inventory: ALL /*
// route-inventory: ALL /admin/*
// route-inventory: ALL /profile
// route-inventory: ALL /members/*
// W15 Pest port: assert exposure on the mounted worker, not only isolated routers.
// Legacy assertion mapping and intentional port differences: docs/w15-member-data-parity.md.
import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import rawApp from "../src/index";
import app from "./app";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { profiles } from "../src/db/schema";
import { createMemorySessionStore } from "../src/sessions";
import {
  cookieFor,
  env,
  EVENT_KEY,
  MEMBER,
  MODERATOR,
  OUTSIDER,
  PERSONAL_STRINGS,
  seed,
  SUBJECT,
} from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Nonempty, exhaustive inventories: a newly registered read needs an exposure
// case. This cannot quietly become [] == [] when a namespace is renamed.
const PROFILE_READS = ["/profile", "/members/:user"];
const ADMIN_REDIRECTS = [
  "/events/create",
  "/events/:key/edit",
  "/featured-contents",
  "/featured-contents/create",
  "/featured-contents/:id/edit",
];
const ADMIN_READS = [
  "/",
  "/activity-log",
  "/events",
  "/events/new",
  "/events/:key",
  "/featured",
  "/featured/new",
  "/featured/:id",
  "/join-attempts",
  "/join-attempts/:id",
  ...ADMIN_REDIRECTS,
];
const OPERATIONAL_READS = ["/queue/failed/:id/preview"];
const OTHER_READS = [
  "/",
  "/discord",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
  "/join",
  "/join/discord",
  "/join/callback",
  "/sitemap_index.xml",
  "/robots.txt",
  "/up",
  "/auth/discord",
  "/auth/discord/callback",
  "/auth/discord/redirect",
  "/login", // Vanity sign-in entry: DB-free 302 to /auth/discord, no member access.
  "/community", // Vanity lobby front: DB-free 302 to /, no member access.
  "/auth/status",
  "/auth/recover", // Public bool-only liveness and recovery HTML; neither grants member access.
  "/members", // Retired bare path: frozen 404, answered before the member gate.
  "/members/", // Trailing-slash form is retired before the same gate.
  "/events",
  "/events/past",
  "/events.json",
  "/events/:key",
  "/e/:key",
  "/events.ics",
  "/events.rss",
  "/events/:file{.+\\.ics}",
];
const readInventory = (router: { routes: { method: string; path: string }[] }) =>
  router.routes
    .filter((r) => r.method === "GET" || r.method === "ALL")
    .map((r) => `${r.method} ${r.path}`)
    .sort();

function assertReadInventory(router: Parameters<typeof readInventory>[0]) {
  expect(readInventory(router)).toEqual(
    [
      ...[...OTHER_READS, ...PROFILE_READS].map((path) => `GET ${path}`),
      ...[...ADMIN_READS, ...OPERATIONAL_READS].map(
        (path) => `GET /admin${path === "/" ? "" : path}`,
      ),
      // ALL includes middleware as well as handlers. Pin their multiplicity;
      // filtering wildcards or deduplicating would hide added ALL endpoints.
      // The six global ALL /* registrations are the composed security/robots
      // headers, strict per-environment trustHosts guard, same-origin guard,
      // auth-status controller injection, expired-write banner consumption and
      // the flag-gated freeze banner.
      // ALL /events/:key/rsvp is the W9 RSVP 405 fallback (PUT/DELETE only), not a read.
      // Six global ALL /*: headers, trustHosts, same-origin, auth-status injection, expired-write banner and freeze banner.
      // The event read boundary encloses its existing GET handler directly;
      // profile flash consumption stays inside the existing boundary middleware.
      "ALL /*",
      "ALL /*",
      "ALL /*",
      "ALL /*",
      "ALL /*",
      "ALL /*",
      "ALL /admin/*",
      "ALL /admin/queue/*",
      "ALL /events/:key/rsvp",
      "ALL /profile",
      "ALL /profile",
      "ALL /members/*",
      "ALL /members/*",
    ].sort(),
  );
}

it("keeps every mounted GET-capable profile/admin route in the non-vacuous exposure inventory", () => {
  assertReadInventory(rawApp);
});

it.each([
  ["GET", "/members/:member/export"],
  ["ALL", "/members/:member/export"],
  ["GET", "/admin/unlogged-export"],
  ["ALL", "/admin/unlogged-export"],
  ["ALL", "/members/*"],
  ["ALL", "/profile"],
  ["GET", "/directory"],
  ["ALL", "/directory"],
  ["ALL", "/*"],
])("detects a directly mounted %s %s outside the reviewed exposure inventory", (method, path) => {
  // Copy the actual mounted app, not a fresh child router; don't mutate the
  // singleton used by the role matrix or the other test files.
  const mounted = new Hono().route("/", rawApp);
  assertReadInventory(mounted);
  mounted.on(method, path, (c) => c.text("unlogged member export"));
  expect(() => assertReadInventory(mounted)).toThrow();
});

describe.skipIf(!process.env.DATABASE_URL)(
  "member exposure on the mounted worker (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    let sessions = createMemorySessionStore();
    let remoteFetch: MockInstance<typeof fetch>;
    const bindings = () => ({
      ...env,
      ADMIN_DB: db,
      SESSION_STORE: sessions,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    });
    const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings());
    const headers = async (actor: typeof MEMBER) => ({ cookie: await cookieFor(sessions, actor) });

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });
    beforeEach(async () => {
      remoteFetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected external fetch"));
      await fixture.reset();
      await seed(db);
      sessions = createMemorySessionStore();
    });
    afterEach(async () => {
      try {
        await fixture?.reset();
        expect(remoteFetch).not.toHaveBeenCalled();
      } finally {
        remoteFetch?.mockRestore();
      }
    });
    afterAll(() => fixture?.dispose());

    it.each(["text/html", "application/json"])(
      "guest %s: no profile/member data or writes",
      async (accept) => {
        for (const path of [
          "/profile",
          `/members/${SUBJECT.userId}`,
          "/members/999999999999999999",
        ]) {
          const res = await request(path, { headers: { accept } });
          expect(res.status, path).toBe(302);
          expect(res.headers.get("location")).toBe("/auth/discord");
          const body = await res.text();
          for (const personal of PERSONAL_STRINGS) expect(body).not.toContain(personal);
        }
        for (const method of ["POST", "PATCH"]) {
          for (const contentType of ["application/json", "application/x-www-form-urlencoded"]) {
            const json = accept === "application/json" || contentType === "application/json";
            const body =
              contentType === "application/json"
                ? JSON.stringify({ bio: "smuggled" })
                : `${method === "POST" ? "_method=PATCH&" : ""}bio=smuggled`;
            const write = await request(`/members/${SUBJECT.userId}`, {
              method,
              headers: { accept, origin: env.APP_URL, "content-type": contentType },
              body,
            });
            // Unsafe guest requests never redirect into OAuth or replay the body.
            expect(write.status).toBe(json ? 401 : 303);
            if (json) {
              expect(write.headers.get("location")).toBeNull();
              expect(await write.clone().json()).toEqual({
                error: "Unauthorized",
                recovery: "/auth/recover?next=%2Fprofile",
              });
            } else expect(write.headers.get("location")).toBe("/auth/recover?next=%2Fprofile");
            const responseBody = await write.text();
            for (const personal of [...PERSONAL_STRINGS, "smuggled"])
              expect(responseBody).not.toContain(personal);
            expect((await db.select().from(profiles))[0]!.bio).toBe(PERSONAL_STRINGS[1]);
            expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
          }
        }
      },
    );

    it.each(["guest", "non-member", "member", "moderator"])(
      "%s: every registered admin GET has the same gate",
      async (role) => {
        const actor = role === "moderator" ? MODERATOR : role === "member" ? MEMBER : OUTSIDER;
        for (const pattern of ADMIN_READS) {
          const path = `/admin${pattern === "/" ? "" : pattern.replace(":key", EVENT_KEY).replace(":id", "999999999")}`;
          const res = await request(path, {
            headers: role === "guest" ? {} : await headers(actor),
          });
          const expected =
            role === "guest"
              ? 302
              : role !== "moderator"
                ? 403
                : ["/featured/:id", "/featured-contents/:id/edit", "/join-attempts/:id"].includes(
                      pattern,
                    )
                  ? 404
                  : ADMIN_REDIRECTS.includes(pattern)
                    ? 301
                    : 200;
          expect(res.status, path).toBe(expected);
          const body = await res.text();
          if (role !== "moderator") {
            for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId])
              expect(body, path).not.toContain(personal);
            if (role === "guest") expect(res.headers.get("location")).toBe("/auth/discord");
            else expect(res.headers.get("location")).toBeNull();
          } else expect(res.headers.get("cache-control")).toBe("private, no-store");
        }
        if (role !== "moderator")
          expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
      },
    );

    it("operational reads remain opaque to every role when disabled on the mounted Worker", async () => {
      for (const actor of [null, OUTSIDER, MEMBER, MODERATOR]) {
        for (const pattern of OPERATIONAL_READS) {
          const res = await request(`/admin${pattern.replace(":id", "7")}`, {
            headers: actor ? await headers(actor) : {},
          });
          expect(res.status).toBe(404);
          for (const personal of PERSONAL_STRINGS)
            expect(await res.clone().text()).not.toContain(personal);
          expect(res.headers.get("cache-control")).toBe("private, no-store");
        }
      }
    });

    it("non-member: profile reads and direct/form writes expose and change nothing", async () => {
      for (const [method, path, body] of [
        ["GET", "/profile", undefined],
        ["GET", `/members/${SUBJECT.userId}`, undefined],
        ["PATCH", `/members/${SUBJECT.userId}`, "bio=smuggled"],
        ["POST", `/members/${SUBJECT.userId}`, "_method=PATCH&bio=smuggled"],
      ] as const) {
        const res = await request(path, {
          method,
          headers: {
            ...(await headers(OUTSIDER)),
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        });
        expect(res.status).toBe(403);
        for (const personal of PERSONAL_STRINGS)
          expect(await res.clone().text()).not.toContain(personal);
      }
      expect((await db.select().from(profiles))[0]!.bio).toBe(PERSONAL_STRINGS[1]);
      expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
    });

    it("members and moderators see identical escaped profile fields, without an edit affordance", async () => {
      const member = await request(`/members/${SUBJECT.userId}`, {
        headers: await headers(MEMBER),
      });
      const moderator = await request(`/members/${SUBJECT.userId}`, {
        headers: await headers(MODERATOR),
      });
      expect(member.status).toBe(200);
      expect(moderator.status).toBe(200);
      const html = await member.text();
      // A moderator's header adds only the /admin shortcut; no member data differs.
      const adminLink =
        '<a class="btn profile-secondary" href="/admin" data-testid="profile-admin-link">Moderator admin</a>';
      const moderatorHtml = await moderator.text();
      expect(html).not.toContain("/admin");
      expect(moderatorHtml).toContain(adminLink);
      expect(moderatorHtml.replace(adminLink, "")).toBe(html);
      for (const personal of PERSONAL_STRINGS) expect(html).toContain(personal);
      expect(html).not.toContain("Edit your profile");
      expect(html).toContain('name="robots" content="noindex, nofollow"');
      expect(member.headers.get("cache-control")).toBe("private, no-store");
      expect(await db.select().from(memberDataAccessLogs)).toHaveLength(2);
    });

    it("public pages contain no member data in HTML/source; RSVP counts remain public", async () => {
      for (const path of [
        "/",
        "/events",
        "/events/past",
        "/join",
        "/about",
        "/faq",
        "/rules",
        "/privacy",
        "/auth/recover",
        "/auth/status",
        "/sitemap_index.xml",
        `/e/${EVENT_KEY}`,
      ]) {
        const res = await request(path);
        expect(res.status, path).toBe(200);
        const body = await res.text();
        for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId])
          expect(body, path).not.toContain(personal);
        if (path === "/events" || path.startsWith("/e/")) expect(body).toContain("1 going");
      }
      expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
    });

    it.each(["guest", "non-member", "member", "moderator"])(
      "%s: public calendar feeds never expose member data",
      async (role) => {
        const actor = role === "moderator" ? MODERATOR : role === "member" ? MEMBER : OUTSIDER;
        for (const path of ["/events.ics", "/events.rss", `/events/${EVENT_KEY}.ics`]) {
          const res = await request(path, {
            headers: role === "guest" ? {} : await headers(actor),
          });
          expect(res.status, path).toBe(200);
          const body = await res.text();
          expect(body).toContain("Friday night games");
          for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId])
            expect(body, path).not.toContain(personal);
        }
        expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
      },
    );

    it.each(["application/json", "text/html"])(
      "guest %s member-adjacent JSON is refused without returning attendees",
      async (accept) => {
        for (const path of ["/events.json", `/events/${EVENT_KEY}`]) {
          const res = await request(path, { headers: { accept } });
          expect(res.status).toBe(accept === "text/html" ? 302 : 401);
          if (accept === "text/html")
            expect(res.headers.get("location")).toBe(
              `/join/discord?next=${encodeURIComponent(path)}`,
            );
          const body = await res.text();
          for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId])
            expect(body).not.toContain(personal);
        }
      },
    );
  },
);
