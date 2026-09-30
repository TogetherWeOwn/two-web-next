// W15 Pest port: assert exposure on the mounted worker, not only isolated routers.
// Legacy assertion mapping and intentional port differences: docs/w15-member-data-parity.md.
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { profiles } from "../src/db/schema";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, EVENT_KEY, MEMBER, MODERATOR, OUTSIDER, PERSONAL_STRINGS, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Nonempty, exhaustive inventories: a newly registered read needs an exposure
// case. This cannot quietly become [] == [] when a namespace is renamed.
const PROFILE_READS = ["/profile", "/members/:user"];
const ADMIN_READS = ["/", "/events", "/events/new", "/events/:key", "/featured", "/featured/new", "/featured/:id", "/join-attempts"];
const OTHER_READS = [
  "/", "/discord", "/about", "/faq", "/rules", "/privacy", "/join", "/join/discord", "/join/callback",
  "/sitemap_index.xml", "/robots.txt", "/health", "/healthz", "/db-ping", "/up", "/auth/discord", "/auth/discord/callback",
  "/events", "/events/past", "/events.json", "/e/:key", "/events.ics", "/events.rss", "/events/:file{.+\\.ics}",
];
const readInventory = (router: { routes: { method: string; path: string }[] }) => router.routes
  .filter((r) => r.method === "GET" || r.method === "ALL")
  .map((r) => `${r.method} ${r.path}`).sort();

function assertReadInventory(router: Parameters<typeof readInventory>[0]) {
  expect(readInventory(router)).toEqual([
    ...[...OTHER_READS, ...PROFILE_READS].map((path) => `GET ${path}`),
    ...ADMIN_READS.map((path) => `GET /admin${path === "/" ? "" : path}`),
    // ALL includes middleware as well as handlers. Pin their multiplicity;
    // filtering wildcards or deduplicating would hide added ALL endpoints.
    "ALL /*", "ALL /admin/*", "ALL /profile", "ALL /profile", "ALL /members/*", "ALL /members/*",
  ].sort());
}

it("keeps every mounted GET-capable profile/admin route in the non-vacuous exposure inventory", () => {
  assertReadInventory(app);
});

it.each([
  ["GET", "/members/:member/export"], ["ALL", "/members/:member/export"],
  ["GET", "/admin/unlogged-export"], ["ALL", "/admin/unlogged-export"],
  ["ALL", "/members/*"], ["ALL", "/profile"],
  ["GET", "/directory"], ["ALL", "/directory"], ["ALL", "/*"],
])("detects a directly mounted %s %s outside the reviewed exposure inventory", (method, path) => {
  // Copy the actual mounted app, not a fresh child router; don't mutate the
  // singleton used by the role matrix or the other test files.
  const mounted = new Hono().route("/", app);
  assertReadInventory(mounted);
  mounted.on(method, path, (c) => c.text("unlogged member export"));
  expect(() => assertReadInventory(mounted)).toThrow();
});

describe.skipIf(!process.env.DATABASE_URL)("member exposure on the mounted worker (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  let sessions = createMemorySessionStore();
  const bindings = () => ({ ...env, ADMIN_DB: db, SESSION_STORE: sessions });
  const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings());
  const headers = async (actor: typeof MEMBER) => ({ cookie: await cookieFor(sessions, actor) });

  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); db = fixture.db; });
  beforeEach(async () => { await fixture.reset(); await seed(db); sessions = createMemorySessionStore(); });
  afterEach(() => fixture?.reset());
  afterAll(() => fixture?.dispose());

  it.each(["text/html", "application/json"])("guest %s: no profile/member data or writes", async (accept) => {
    for (const path of ["/profile", `/members/${SUBJECT.userId}`, "/members/999999999999999999"]) {
      const res = await request(path, { headers: { accept } });
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
      const body = await res.text();
      for (const personal of PERSONAL_STRINGS) expect(body).not.toContain(personal);
    }
    const write = await request(`/members/${SUBJECT.userId}`, {
      method: "PATCH", headers: { accept, origin: env.APP_URL, "content-type": "application/json" }, body: JSON.stringify({ bio: "smuggled" }),
    });
    expect(write.status).toBe(302); // W7 restores an owner-only HTTP writer, unlike legacy Livewire.
    expect((await db.select().from(profiles))[0]!.bio).toBe(PERSONAL_STRINGS[1]);
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });

  it.each(["guest", "non-member", "member", "moderator"])("%s: every registered admin GET has the same gate", async (role) => {
    const actor = role === "moderator" ? MODERATOR : role === "member" ? MEMBER : OUTSIDER;
    for (const pattern of ADMIN_READS) {
      const path = `/admin${pattern === "/" ? "" : pattern.replace(":key", EVENT_KEY).replace(":id", "999999999")}`;
      const res = await request(path, { headers: role === "guest" ? {} : await headers(actor) });
      const expected = role === "guest" ? 302 : role !== "moderator" ? 403 : pattern === "/featured/:id" ? 404 : 200;
      expect(res.status, path).toBe(expected);
      const body = await res.text();
      if (role !== "moderator") {
        for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId]) expect(body, path).not.toContain(personal);
        if (role === "guest") expect(res.headers.get("location")).toBe("/auth/discord");
        else expect(res.headers.get("location")).toBeNull();
      } else expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    if (role !== "moderator") expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });

  it("non-member: profile reads and direct/form writes expose and change nothing", async () => {
    for (const [method, path, body] of [
      ["GET", "/profile", undefined], ["GET", `/members/${SUBJECT.userId}`, undefined],
      ["PATCH", `/members/${SUBJECT.userId}`, "bio=smuggled"],
      ["POST", `/members/${SUBJECT.userId}`, "_method=PATCH&bio=smuggled"],
    ] as const) {
      const res = await request(path, { method, headers: { ...await headers(OUTSIDER), origin: env.APP_URL, "content-type": "application/x-www-form-urlencoded" }, body });
      expect(res.status).toBe(403);
      for (const personal of PERSONAL_STRINGS) expect(await res.clone().text()).not.toContain(personal);
    }
    expect((await db.select().from(profiles))[0]!.bio).toBe(PERSONAL_STRINGS[1]);
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });

  it("members and moderators see identical escaped profile fields, without an edit affordance", async () => {
    const member = await request(`/members/${SUBJECT.userId}`, { headers: await headers(MEMBER) });
    const moderator = await request(`/members/${SUBJECT.userId}`, { headers: await headers(MODERATOR) });
    expect(member.status).toBe(200);
    expect(moderator.status).toBe(200);
    const html = await member.text();
    expect(await moderator.text()).toBe(html);
    for (const personal of PERSONAL_STRINGS) expect(html).toContain(personal);
    expect(html).not.toContain("Edit your profile");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(member.headers.get("cache-control")).toBe("private, no-store");
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(2);
  });

  it("public pages contain no member data in HTML/source; RSVP counts remain public", async () => {
    for (const path of ["/", "/events", "/events/past", "/join", "/about", "/faq", "/rules", "/privacy", "/sitemap_index.xml", `/e/${EVENT_KEY}`]) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
      const body = await res.text();
      for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId]) expect(body, path).not.toContain(personal);
      if (path === "/events" || path.startsWith("/e/")) expect(body).toContain("1 going");
    }
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });

  it.each(["guest", "non-member", "member", "moderator"])("%s: public calendar feeds never expose member data", async (role) => {
    const actor = role === "moderator" ? MODERATOR : role === "member" ? MEMBER : OUTSIDER;
    for (const path of ["/events.ics", "/events.rss", `/events/${EVENT_KEY}.ics`]) {
      const res = await request(path, { headers: role === "guest" ? {} : await headers(actor) });
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body).toContain("Friday night games");
      for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId]) expect(body, path).not.toContain(personal);
    }
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });

  it("guest member-adjacent JSON is refused without returning attendees", async () => {
    const res = await request("/events.json");
    expect(res.status).toBe(401); // W8 JSON denial, rather than Laravel's login redirect.
    const body = await res.text();
    for (const personal of [...PERSONAL_STRINGS, SUBJECT.userId]) expect(body).not.toContain(personal);
  });
});
