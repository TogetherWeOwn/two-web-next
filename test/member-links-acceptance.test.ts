// Acceptance: streaming link-in-bio page + member_links (spec section 9, S1).
//
// NOTE (route inventory): this file deliberately carries NO // route-inventory:
// comments: references to unregistered routes fail the inventory guard as
// stale. When the Builder registers the four routes, they add the four
// `// route-inventory: METHOD /pattern` comments to the BUILDER's own test
// file (never edit this acceptance file) plus exact entries in
// docs/parity.md or docs/url-freeze.md, and extend
// test/fixtures/route-inventory.json.
//
// S1 ships the free-to-every-member link-in-bio slice with NO billing and NO
// Cloudflare: a member_links row per member, CRUD on /profile/links
// (owner-only, throttled), and a public no-JS /members/:user/links page
// (avatar/bio/ordered links, report link, offline live-banner stub).
//
// Locked contract (the paired Builder satisfies this without editing this file):
// - Slice: the links routes live in the profiles slice (profilesApp) beside
//   the profile routes, reusing the session gate, the 30/min admission shape
//   and the one 429 envelope. New dep `linksStore` with ProfileStore-mirrored
//   methods `find(userId)` / `save(userId, links)`; `MemberLink` is
//   `{ label, url }`. This file defines the double; the Builder adds the dep.
// - Public page: GET /members/:user/links is PUBLIC (guests get 200, no
//   session, no set-cookie, zero access-log sink calls). Unknown/invalid ids
//   are 404 and leak nothing. The page carries data-testid="member-links-list"
//   (the ordered list), data-testid="member-links-avatar", and
//   data-testid="member-links-live-status" (offline stub: matches
//   /offline|not live/i, never the all-caps LIVE NOW banner — S5 wires it).
//   Member anchors are plain <a href> with rel including noopener; the page
//   ships zero <script> tags (no-JS usable) and a self canonical.
// - Editor + saves: GET /profile/links renders the owner's form (the <form>
//   itself carries data-testid="member-links-form", method=post,
//   action=/profile/links).
//   POST /profile/links saves the native form (links_text, one link per line
//   as `Label | https://...`, split on the FIRST `|`; absent/blank clears).
//   PATCH /profile/links saves JSON `{ links: [...] }` (whole-list replace;
//   absent `links` is 422). Guests: GET 302 /auth/discord, writes 303
//   /auth/recover?next=%2Fprofile%2Flinks. Signed-in non-members: 403.
// - Validation: max 12 links; label trimmed, non-blank, <= 80 chars (mirrors
//   games); url trimmed, https-only (http/javascript:/data:/protocol-relative
//   refused), <= 2048 chars; malicious-host denylist seeded with
//   `blocked-example.test` (exact + subdomains, case-insensitive); unknown
//   top-level JSON fields refused. JSON failures are 422 `{ errors }` with a
//   `links` key for list-level failures and `links[i].field` keys for
//   item-level failures; form failures are 422 HTML with role=alert and the
//   escaped draft preserved. Every 422 leaves the stored list byte-identical.
// - Throttle: writes call the injected throttle once per write with a bucket
//   containing `links` and the viewer id; a limited verdict answers the one
//   429 envelope (retry-after + { reason: "rate_limited" }).
// - No billing/Cloudflare: public read, editor and both saves succeed with
//   global fetch disabled; the migration mentions neither stripe nor
//   cloudflare. Links are free to every member: no subscription check exists.
// - Migration: a drizzle migration creates member_links (user_id text PK
//   references users(id) on delete cascade, links jsonb not null default
//   '[]', updated_at) and is journaled.
// - Gates: a11y coverage lists /members/:user/links and /profile/links with
//   real (non-skip) cases; the Lighthouse worker/config/admission inventories
//   include a /links path; the route-inventory helper labels the public GET
//   `public`.
// - Explicitly unpinned: member-viewer access-log attribution on the public
//   page (privacy review decides), response caching, empty-list copy,
//   duplicate-URL handling, JSON on the public page, body-cap bytes, and the
//   report link target (presence + same-origin honesty only).
//
// Hermetic: memory session/profile/links doubles, no DB binding, no
// DATABASE_URL in the request env, except the DB-gated migration section.

import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi, beforeAll, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { AccessEntry } from "../src/access-log";
import type { Db } from "../src/db/index";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { routeInventory } from "./helpers/route-inventory";
import { stripTags } from "./helpers/html-text";
import type { Env } from "../src/env";
import app from "../src/index";
import { profilesApp, type ProfileDeps } from "../src/profiles/routes";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import { sameOrigin } from "../src/same-origin";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { auditPaths } from "../ci/lighthouse-paths";
// @ts-expect-error Standalone probe tooling has no declaration file.
import { coverage } from "../ci/a11y-cases.mjs";
// @ts-expect-error Standalone probe tooling has no declaration file.
import { auditCases } from "../ci/a11y-policy.mjs";

const require = createRequire(import.meta.url);
const lighthouserc = require("../ci/lighthouserc.cjs").ci;
const admission = require("../ci/lighthouse-admission.cjs");

// Locked contract constants: the Builder implements these exact bounds.
const MAX_LINKS = 12;
const LABEL_MAX = 80;
const URL_MAX = 2048;
const DENY_SEED = "blocked-example.test";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const ALICE = { userId: "100000000000000001", username: "alice", member: true, moderator: false };
const BOB = { userId: "100000000000000002", username: "bob", member: true, moderator: false };
const MOD = { userId: "100000000000000003", username: "mod", member: true, moderator: true };
const OUTSIDER = {
  userId: "100000000000000004",
  username: "outsider",
  member: false,
  moderator: false,
};

export type MemberLink = { label: string; url: string };
export type LinksStore = {
  find: (userId: string) => Promise<MemberLink[] | null>;
  save: (userId: string, links: MemberLink[]) => Promise<void>;
};

/** Test double with the locked-contract seam. Mirrors createMemoryProfileStore. */
export function createMemoryLinksStore(
  seed: [string, MemberLink[]][] = [],
): LinksStore & { rows: Map<string, MemberLink[]> } {
  const rows = new Map(seed.map(([id, links]) => [id, links.map((l) => ({ ...l }))]));
  return {
    rows,
    async find(id) {
      const links = rows.get(id);
      return links ? links.map((l) => ({ ...l })) : null;
    },
    async save(id, links) {
      rows.set(
        id,
        links.map((l) => ({ ...l })),
      );
    },
  };
}

const seedMembers = (): MemberView[] => [
  {
    id: ALICE.userId,
    username: "alice",
    avatar: null,
    bio: "Alice bio <b>x</b>",
    games: ["Chess"],
    timezone: "Europe/London",
  },
  { id: BOB.userId, username: "bob", avatar: "abc123", bio: null, games: [], timezone: null },
  { id: MOD.userId, username: "mod", avatar: null, bio: "Mod bio", games: [], timezone: null },
];

const seedLinks = (): [string, MemberLink[]][] => [
  [
    ALICE.userId,
    [
      { label: "Twitch", url: "https://twitch.tv/alice" },
      { label: "YouTube", url: "https://www.youtube.com/@alice" },
      { label: "Blog", url: "https://alice.example.com" },
    ],
  ],
  [MOD.userId, [{ label: "Stream", url: "https://example.com/live" }]],
];

type ThrottleVerdict = { limited: false } | { limited: true; retryAfter: number };

function harness(
  opts: {
    members?: MemberView[];
    links?: [string, MemberLink[]][];
    throttle?: (bucket: string) => Promise<ThrottleVerdict>;
  } = {},
) {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore(opts.members ?? seedMembers());
  const links = createMemoryLinksStore(opts.links ?? seedLinks());
  const log: AccessEntry[] = [];
  const buckets: string[] = [];
  const deps = {
    sessionStore: sessions,
    store,
    linksStore: links,
    accessLog: async (e: AccessEntry) => {
      const subjects = [...new Set(e.subjectUserIds.filter((s) => s !== e.viewerUserId))];
      if (subjects.length === 0) return false;
      log.push({ ...e, subjectUserIds: subjects });
      return true;
    },
    throttle: async (bucket: string): Promise<ThrottleVerdict> => {
      buckets.push(bucket);
      return opts.throttle ? opts.throttle(bucket) : { limited: false };
    },
  } as ProfileDeps;
  const app = profilesApp(deps);
  return { app, sessions, store, links, log, buckets };
}

async function cookieFor(store: SessionStore, row: typeof ALICE): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const jsonSave = (cookie: string, body: unknown, extra: Record<string, string> = {}) => ({
  method: "PATCH" as const,
  headers: {
    cookie,
    origin: APP_URL,
    "content-type": "application/json",
    accept: "application/json",
    ...extra,
  },
  body: JSON.stringify(body),
});

const formSave = (cookie: string, fields: Record<string, string>) => ({
  method: "POST" as const,
  headers: {
    cookie,
    origin: APP_URL,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams(fields),
});

/** Inner HTML of the first element tagged with the given testid, or null. */
function taggedInner(html: string, testid: string): string | null {
  const m = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)<\\/\\1>`,
  ).exec(html);
  return m ? m[2]! : null;
}

function liveStatusText(html: string): string | null {
  const inner = taggedInner(html, "member-links-live-status");
  return inner
    ? inner
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : null;
}

function reportAnchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(m[2]!).trim();
    if (/report/i.test(text)) {
      const href = /href="([^"]*)"/.exec(m[1]!)?.[1] ?? "";
      out.push({ href, text });
    }
  }
  return out;
}

function listAnchors(listInner: string): { href: string; rel: string; text: string }[] {
  const out: { href: string; rel: string; text: string }[] = [];
  for (const m of listInner.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1]!;
    out.push({
      href: /href="([^"]*)"/.exec(attrs)?.[1] ?? "",
      rel: /rel="([^"]*)"/.exec(attrs)?.[1] ?? "",
      text: stripTags(m[2]!).trim(),
    });
  }
  return out;
}

const storedLinks = async (links: LinksStore, userId: string) => links.find(userId);

describe("link-in-bio route registration (mounted app)", () => {
  it("registers the public page, the editor and both saves", () => {
    const routes = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes).toContain("GET /members/:user/links");
    expect(routes).toContain("GET /profile/links");
    expect(routes).toContain("POST /profile/links");
    expect(routes).toContain("PATCH /profile/links");
  });

  it("labels the public links page `public` in the reviewed inventory", () => {
    const entry = routeInventory(app).find(
      (e) => e.method === "GET" && e.path === "/members/:user/links",
    );
    expect(entry?.auth).toBe("public");
  });
});

describe("public link-in-bio page as a guest (memory doubles)", () => {
  it("renders 200 HTML with avatar fallback, name, bio and ordered links", async () => {
    const { app, log } = harness();
    const res = await app.request(`/members/${ALICE.userId}/links`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("alice");
    // Avatar fallback is the first two code points, uppercased (profile parity).
    expect(taggedInner(html, "member-links-avatar") ?? "").toContain("AL");
    // Bio renders (escaped: the seed carries markup).
    expect(html).toContain("Alice bio &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("Alice bio <b>x</b>");
    // Ordered links, exact hrefs, in stored order.
    const list = taggedInner(html, "member-links-list");
    expect(list).not.toBeNull();
    const anchors = listAnchors(list!);
    expect(anchors.map((a) => a.href)).toEqual([
      "https://twitch.tv/alice",
      "https://www.youtube.com/@alice",
      "https://alice.example.com",
    ]);
    expect(anchors.map((a) => a.text)).toEqual(["Twitch", "YouTube", "Blog"]);
    for (const a of anchors) expect(a.rel).toMatch(/noopener/);
    // TWO footer attribution.
    expect(html).toMatch(/Together We Own/);
    // Guests write no access-log rows.
    expect(log).toHaveLength(0);
  });

  it("sets no cookies for guests", async () => {
    const { app } = harness();
    const res = await app.request(`/members/${ALICE.userId}/links`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("renders the offline live-banner stub and never the LIVE NOW banner", async () => {
    const { app } = harness();
    const res = await app.request(`/members/${ALICE.userId}/links`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(liveStatusText(html) ?? "MISSING").toMatch(/offline|not live/i);
    expect(html).not.toContain("LIVE NOW");
  });

  it("carries a report link and a self canonical, with zero scripts (no-JS usable)", async () => {
    const { app } = harness();
    const res = await app.request(`/members/${ALICE.userId}/links`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    const reports = reportAnchors(html);
    expect(reports.length).toBeGreaterThanOrEqual(1);
    for (const r of reports) expect(r.href).not.toBe("");
    expect(html).toContain(
      `<link rel="canonical" href="${APP_URL}/members/${ALICE.userId}/links">`,
    );
    expect(html).not.toContain("<script");
    expect(html).toMatch(/<title>[^<]*alice[^<]*<\/title>/i);
  });

  it("same-origin report targets resolve (no dead report link)", async () => {
    const { app } = harness();
    const res = await app.request(`/members/${ALICE.userId}/links`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    const anchors = reportAnchors(html);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    for (const r of anchors) {
      if (!r.href.startsWith("/")) continue;
      const target = await app.request(r.href, {}, env);
      expect(target.status, `report target ${r.href}`).not.toBe(404);
    }
  });

  it("renders the member avatar image when one is set", async () => {
    const { app } = harness();
    const res = await app.request(`/members/${BOB.userId}/links`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(taggedInner(html, "member-links-avatar") ?? "").toContain("<img");
  });

  it("escapes hostile labels and URLs", async () => {
    const { app } = harness({
      links: [
        [
          ALICE.userId,
          [
            { label: `<b>Bold</b> & "quoted"`, url: "https://example.com/?a=1&b=2" },
            { label: "plain", url: "https://example.com/plain" },
          ],
        ],
      ],
    });
    const res = await app.request(`/members/${ALICE.userId}/links`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt;");
    expect(html).not.toContain("<b>Bold</b>");
    expect(html).toContain("https://example.com/?a=1&amp;b=2");
  });
});

describe("public link-in-bio page controls (memory doubles)", () => {
  it("unknown users are 404 and leak nothing, for guests and members", async () => {
    const { app, sessions } = harness();
    const memberHeaders = { headers: { cookie: await cookieFor(sessions, ALICE) } };
    for (const init of [{}, memberHeaders]) {
      const res = await app.request("/members/999999999999999999/links", init, env);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).not.toContain("twitch.tv/alice");
      expect(html).not.toContain("Alice bio");
    }
  });

  it("invalid ids are 404", async () => {
    const { app } = harness();
    expect((await app.request("/members/not-a-user/links", {}, env)).status).toBe(404);
  });

  it("members with no links still get a 200 page with identity and offline stub", async () => {
    const { app } = harness();
    const res = await app.request(`/members/${BOB.userId}/links`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("bob");
    expect(liveStatusText(html) ?? "MISSING").toMatch(/offline|not live/i);
    expect(html).not.toContain("LIVE NOW");
    const list = taggedInner(html, "member-links-list");
    if (list !== null) expect(listAnchors(list)).toHaveLength(0);
  });

  it("signed-in members and moderators see the same page, still offline in S1", async () => {
    const { app, sessions } = harness();
    for (const viewer of [ALICE, BOB, MOD]) {
      const cookie = await cookieFor(sessions, viewer);
      const res = await app.request(`/members/${ALICE.userId}/links`, { headers: { cookie } }, env);
      expect(res.status, viewer.username).toBe(200);
      const html = await res.text();
      expect(liveStatusText(html) ?? "MISSING", viewer.username).toMatch(/offline|not live/i);
      expect(html, viewer.username).not.toContain("LIVE NOW");
    }
  });
});

describe("links editor gates (memory doubles)", () => {
  it("the owner gets the native edit form", async () => {
    const { app, sessions } = harness();
    const res = await app.request(
      "/profile/links",
      { headers: { cookie: await cookieFor(sessions, ALICE) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="member-links-form"');
    const formTag = /<form\b[^>]*data-testid="member-links-form"[^>]*>/.exec(html)?.[0] ?? "";
    expect(formTag).toMatch(/method="post"/i);
    expect(formTag).toMatch(/action="\/profile\/links"/);
    expect(html).toContain('name="links_text"');
    // The draft shows the stored list.
    expect(html).toContain("twitch.tv/alice");
  });

  it("guests: the editor goes to OAuth, writes to explicit recovery", async () => {
    const { app, log, buckets } = harness();
    const editor = await app.request("/profile/links", {}, env);
    expect(editor.status).toBe(302);
    expect(editor.headers.get("location")).toBe("/auth/discord");
    for (const init of [
      formSave("nonsense", { links_text: "" }),
      jsonSave("nonsense", { links: [] }),
    ]) {
      const res = await app.request("/profile/links", init, env);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/auth/recover?next=%2Fprofile%2Flinks");
    }
    expect(log).toHaveLength(0);
    expect(buckets).toHaveLength(0);
  });

  it("signed-in non-members get 403 on the editor and both saves", async () => {
    const { app, sessions, links } = harness();
    const cookie = await cookieFor(sessions, OUTSIDER);
    expect((await app.request("/profile/links", { headers: { cookie } }, env)).status).toBe(403);
    expect(
      (await app.request("/profile/links", formSave(cookie, { links_text: "" }), env)).status,
    ).toBe(403);
    expect((await app.request("/profile/links", jsonSave(cookie, { links: [] }), env)).status).toBe(
      403,
    );
    expect(await storedLinks(links, ALICE.userId)).toHaveLength(3);
  });

  it("a member's save touches only their own row (owner-only by construction)", async () => {
    const { app, sessions, links } = harness();
    const before = await storedLinks(links, BOB.userId);
    const res = await app.request(
      "/profile/links",
      jsonSave(await cookieFor(sessions, ALICE), {
        links: [{ label: "Solo", url: "https://example.com/solo" }],
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await storedLinks(links, ALICE.userId)).toEqual([
      { label: "Solo", url: "https://example.com/solo" },
    ]);
    expect(await storedLinks(links, BOB.userId)).toEqual(before);
  });

  it("honors the throttle verdict with the one 429 envelope and a links bucket", async () => {
    const { app, sessions, buckets } = harness({
      throttle: async () => ({ limited: true, retryAfter: 17 }),
    });
    const cookie = await cookieFor(sessions, ALICE);
    const res = await app.request("/profile/links", jsonSave(cookie, { links: [] }), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 17 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatch(/links/);
    expect(buckets[0]).toContain(ALICE.userId);
  });

  it("calls the throttle once per write with the viewer's links bucket", async () => {
    const { app, sessions, buckets } = harness();
    const cookie = await cookieFor(sessions, ALICE);
    await app.request("/profile/links", jsonSave(cookie, { links: [] }), env);
    await app.request("/profile/links", formSave(cookie, { links_text: "" }), env);
    expect(buckets).toHaveLength(2);
    for (const bucket of buckets) {
      expect(bucket).toMatch(/links/);
      expect(bucket).toContain(ALICE.userId);
    }
  });

  it("wrong origin is refused before anything else", async () => {
    const { app, sessions, links } = harness();
    const mounted = new Hono<{ Bindings: Env }>().use("*", sameOrigin).route("/", app);
    const res = await mounted.request(
      "/profile/links",
      {
        ...formSave(await cookieFor(sessions, ALICE), {
          links_text: "Evil | https://evil.example",
        }),
        headers: {
          cookie: await cookieFor(sessions, ALICE),
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(await storedLinks(links, ALICE.userId)).toHaveLength(3);
  });
});

describe("links JSON validation (memory doubles)", () => {
  const attempt = async (
    body: unknown,
    opts: { contentType?: string } = {},
  ): Promise<{ status: number; json: unknown; stored: MemberLink[] | null }> => {
    const { app, sessions, links } = harness();
    const res = await app.request(
      "/profile/links",
      jsonSave(
        await cookieFor(sessions, ALICE),
        body,
        opts.contentType ? { "content-type": opts.contentType } : {},
      ),
      env,
    );
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, stored: await storedLinks(links, ALICE.userId) };
  };

  const link = (i: number): MemberLink => ({ label: `L${i}`, url: `https://example.com/${i}` });

  it(`accepts exactly ${MAX_LINKS} links and rejects ${MAX_LINKS + 1}, changing nothing`, async () => {
    const ok = await attempt({ links: Array.from({ length: MAX_LINKS }, (_, i) => link(i)) });
    expect(ok.status).toBe(200);
    expect(ok.stored).toHaveLength(MAX_LINKS);
    const over = await attempt({ links: Array.from({ length: MAX_LINKS + 1 }, (_, i) => link(i)) });
    expect(over.status).toBe(422);
    expect(over.json).toMatchObject({ errors: { links: expect.any(String) } });
    expect(over.stored).toHaveLength(3);
  });

  it.each([
    ["http scheme", "http://example.com/x"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data URI", "data:text/html,<h1>x</h1>"],
    ["protocol-relative", "//example.com/x"],
    ["bare host", "example.com/x"],
  ])("rejects %s, changing nothing", async (_name, url) => {
    const r = await attempt({ links: [{ label: "Bad", url }] });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ errors: expect.any(Object) });
    expect(r.stored).toHaveLength(3);
  });

  it("trims a padded https URL and stores the trimmed form", async () => {
    const r = await attempt({
      links: [{ label: "  Padded  ", url: "  https://example.com/padded  " }],
    });
    expect(r.status).toBe(200);
    expect(r.stored).toEqual([{ label: "Padded", url: "https://example.com/padded" }]);
  });

  it(`enforces the label bound (${LABEL_MAX} ok, ${LABEL_MAX + 1} refused)`, async () => {
    const ok = await attempt({
      links: [{ label: "l".repeat(LABEL_MAX), url: "https://example.com" }],
    });
    expect(ok.status).toBe(200);
    const over = await attempt({
      links: [{ label: "l".repeat(LABEL_MAX + 1), url: "https://example.com" }],
    });
    expect(over.status).toBe(422);
    expect(over.json).toMatchObject({ errors: expect.any(Object) });
    expect(over.stored).toHaveLength(3);
  });

  it(`enforces the URL bound (${URL_MAX} ok, ${URL_MAX + 1} refused)`, async () => {
    const base = "https://example.com/";
    const ok = await attempt({
      links: [{ label: "Long", url: base + "p".repeat(URL_MAX - base.length) }],
    });
    expect(ok.status).toBe(200);
    const over = await attempt({
      links: [{ label: "Long", url: base + "p".repeat(URL_MAX - base.length + 1) }],
    });
    expect(over.status).toBe(422);
    expect(over.stored).toHaveLength(3);
  });

  it.each([
    ["blank label", { label: "   ", url: "https://example.com" }],
    ["blank url", { label: "No URL", url: "   " }],
    ["missing url", { label: "No URL" }],
    ["missing label", { url: "https://example.com" }],
    ["non-object item", "https://example.com"],
  ])("rejects %s, changing nothing", async (_name, item) => {
    const r = await attempt({ links: [item] });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ errors: expect.any(Object) });
    expect(r.stored).toHaveLength(3);
  });

  it.each([
    ["non-array links", "nope"],
    ["missing links key", {}],
  ])("rejects %s, changing nothing", async (_name, body) => {
    const payload = body === "nope" ? { links: "nope" } : {};
    const r = await attempt(payload);
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ errors: { links: expect.any(String) } });
    expect(r.stored).toHaveLength(3);
  });

  it.each([
    ["exact denylisted host", `https://${DENY_SEED}/steal`],
    ["uppercase denylisted host", `https://${DENY_SEED.toUpperCase()}/steal`],
    ["denylisted subdomain", `https://shop.${DENY_SEED}/steal`],
  ])("rejects %s, changing nothing", async (_name, url) => {
    const r = await attempt({ links: [{ label: "Bad", url }] });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ errors: expect.any(Object) });
    expect(r.stored).toHaveLength(3);
  });

  it("does not confuse a lookalike host with the denylisted one", async () => {
    const r = await attempt({
      links: [{ label: "Fine", url: `https://not${DENY_SEED}/ok` }],
    });
    expect(r.status).toBe(200);
  });

  it.each([
    { field: "admin", value: true },
    { field: "user_id", value: BOB.userId },
  ])("refuses unknown top-level field $field, changing nothing", async ({ field, value }) => {
    const r = await attempt({ links: [], [field]: value });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ errors: expect.any(Object) });
    expect(r.stored).toHaveLength(3);
  });

  it("an empty list clears every link", async () => {
    const r = await attempt({ links: [] });
    expect(r.status).toBe(200);
    expect(r.stored).toEqual([]);
  });

  it("rejects a missing content type instead of wiping the list", async () => {
    const { app, sessions, links } = harness();
    const res = await app.request(
      "/profile/links",
      {
        method: "PATCH",
        headers: { cookie: await cookieFor(sessions, ALICE), origin: APP_URL },
        body: JSON.stringify({ links: [] }),
      },
      env,
    );
    expect(res.status).toBe(415);
    expect(await storedLinks(links, ALICE.userId)).toHaveLength(3);
  });
});

describe("links native form saves (memory doubles)", () => {
  it("saves two lines and 303s to a links page", async () => {
    const { app, sessions, links } = harness();
    const res = await app.request(
      "/profile/links",
      formSave(await cookieFor(sessions, ALICE), {
        links_text: "Twitch | https://twitch.tv/alice\nBlog|https://alice.example.com",
      }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/links");
    expect(await storedLinks(links, ALICE.userId)).toEqual([
      { label: "Twitch", url: "https://twitch.tv/alice" },
      { label: "Blog", url: "https://alice.example.com" },
    ]);
    const page = await (await app.request(`/members/${ALICE.userId}/links`, {}, env)).text();
    expect(page).toContain("https://twitch.tv/alice");
    expect(page).toContain("https://alice.example.com");
  });

  it("a blank form clears every link", async () => {
    const { app, sessions, links } = harness();
    const res = await app.request(
      "/profile/links",
      formSave(await cookieFor(sessions, ALICE), { links_text: "\n   \n" }),
      env,
    );
    expect(res.status).toBe(303);
    expect(await storedLinks(links, ALICE.userId)).toEqual([]);
  });

  it("a form without links_text clears, like the profile games blanking rule", async () => {
    const { app, sessions, links } = harness();
    const res = await app.request(
      "/profile/links",
      formSave(await cookieFor(sessions, ALICE), {}),
      env,
    );
    expect(res.status).toBe(303);
    expect(await storedLinks(links, ALICE.userId)).toEqual([]);
  });

  it.each([
    ["line without a separator", "Look <b>here</b> & now"],
    ["http URL", "Home | http://example.com"],
    ["denylisted host", `Free stuff | https://${DENY_SEED}/free`],
    [
      `${MAX_LINKS + 1} lines`,
      Array.from({ length: MAX_LINKS + 1 }, (_, i) => `L${i} | https://example.com/${i}`).join(
        "\n",
      ),
    ],
  ])(
    "native %s is 422 HTML with an alert and the escaped draft, changing nothing",
    async (_name, links_text) => {
      const { app, sessions, links } = harness();
      const res = await app.request(
        "/profile/links",
        formSave(await cookieFor(sessions, ALICE), { links_text }),
        env,
      );
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('role="alert"');
      // The rejected draft round-trips, escaped (first line proves preservation).
      const firstLine = links_text.split("\n")[0]!;
      const escapedFirst = firstLine
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      expect(html).toContain(escapedFirst);
      if (/[&<>]/.test(firstLine)) expect(html).not.toContain(firstLine);
      expect(await storedLinks(links, ALICE.userId)).toHaveLength(3);
    },
  );
});

describe("no billing or Cloudflare in S1 (memory doubles)", () => {
  it("public read, editor and both saves succeed with fetch disabled", async () => {
    const { app, sessions, links } = harness();
    const calls: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args: unknown[]) => {
      calls.push(String(args[0]));
      throw new Error("fetch disabled: S1 must not call billing or Cloudflare");
    });
    try {
      expect((await app.request(`/members/${ALICE.userId}/links`, {}, env)).status).toBe(200);
      const cookie = await cookieFor(sessions, ALICE);
      expect((await app.request("/profile/links", { headers: { cookie } }, env)).status).toBe(200);
      expect(
        (
          await app.request(
            "/profile/links",
            jsonSave(cookie, { links: [{ label: "A", url: "https://example.com/a" }] }),
            env,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(
            "/profile/links",
            formSave(cookie, { links_text: "B | https://example.com/b" }),
            env,
          )
        ).status,
      ).toBe(303);
      expect(await storedLinks(links, ALICE.userId)).toEqual([
        { label: "B", url: "https://example.com/b" },
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(0);
  });
});

describe("member_links migration files", () => {
  const drizzleUrl = new URL("../drizzle/", import.meta.url);
  const migrationFiles = () =>
    readdirSync(drizzleUrl)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => ({ name: f, ddl: readFileSync(new URL(f, drizzleUrl), "utf8") }));

  it("a journaled migration creates member_links with the spec shape", () => {
    const hits = migrationFiles().filter((f) => /create\s+table[^;]*member_links/is.test(f.ddl));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const ddl = hits[0]!.ddl;
    expect(ddl).toMatch(/user_id/i);
    expect(ddl).toMatch(/references\s+"?users"?\s*\(\s*"id"\s*\)/i);
    expect(ddl).toMatch(/on\s+delete\s+cascade/i);
    expect(ddl).toMatch(/links\s+jsonb/i);
    expect(ddl).toMatch(/default\s+'\[\]'/i);
    expect(ddl).toMatch(/updated_at/i);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", drizzleUrl), "utf8")) as {
      entries: { tag: string }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain(hits[0]!.name.replace(/\.sql$/, ""));
  });

  it("the member_links migration touches no billing or Cloudflare surface", () => {
    const hits = migrationFiles().filter((f) => /member_links/is.test(f.ddl));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const f of hits) expect(f.ddl).not.toMatch(/stripe|cloudflare|billing/i);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("member_links migration, live rows", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterEach(() => fixture?.reset());
  afterAll(() => fixture?.dispose());

  type ColumnRow = { column_name: string; data_type: string; column_default: string | null };

  it("creates the table with the spec columns", async () => {
    const rows = (await db.execute(
      sql`SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'member_links'`,
    )) as unknown as ColumnRow[];
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect([...byName.keys()].sort()).toEqual(["links", "updated_at", "user_id"]);
    expect(byName.get("links")!.data_type).toBe("jsonb");
    expect(byName.get("links")!.column_default).toContain("[]");
  });

  it("round-trips a links row and defaults to an empty list", async () => {
    await db.execute(
      sql`INSERT INTO users (id, username, member) VALUES ('100000000000000201', 'linker', true), ('100000000000000202', 'fresh', true)`,
    );
    await db.execute(
      sql`INSERT INTO member_links (user_id, links) VALUES ('100000000000000201', ${JSON.stringify([{ label: "Twitch", url: "https://twitch.tv/linker" }])}::jsonb)`,
    );
    await db.execute(sql`INSERT INTO member_links (user_id) VALUES ('100000000000000202')`);
    const rows = (await db.execute(
      sql`SELECT user_id AS "userId", links FROM member_links WHERE user_id IN ('100000000000000201', '100000000000000202') ORDER BY user_id`,
    )) as unknown as { userId: string; links: unknown }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      userId: "100000000000000201",
      links: [{ label: "Twitch", url: "https://twitch.tv/linker" }],
    });
    expect(rows[1]).toEqual({ userId: "100000000000000202", links: [] });
  });

  it("deleting the member deletes their links row", async () => {
    await db.execute(
      sql`INSERT INTO users (id, username, member) VALUES ('100000000000000203', 'leaver', true)`,
    );
    await db.execute(sql`INSERT INTO member_links (user_id) VALUES ('100000000000000203')`);
    await db.execute(sql`DELETE FROM users WHERE id = '100000000000000203'`);
    const rows = (await db.execute(
      sql`SELECT user_id FROM member_links WHERE user_id = '100000000000000203'`,
    )) as unknown as { user_id: string }[];
    expect(rows).toHaveLength(0);
  });
});

describe("link-in-bio gate wiring", () => {
  it("a11y coverage audits both links pages with real cases", () => {
    const table = coverage as Record<string, { skip?: unknown; cases?: { path: string }[] }>;
    for (const route of ["/members/:user/links", "/profile/links"]) {
      expect(table[route]?.skip, `${route} must not be skipped`).toBeFalsy();
      expect(table[route]?.cases?.length ?? 0, `${route} needs audit cases`).toBeGreaterThan(0);
    }
    const probeRoutes = ["404", "404-empty", "429", "500", "503"].map((probe) => ({
      method: "GET",
      path: `/__a11y/${probe}`,
    }));
    const scenarios = auditCases([...app.routes, ...probeRoutes], coverage) as { route: string }[];
    const routes = scenarios.map((s) => s.route);
    expect(routes).toContain("/members/:user/links");
    expect(routes).toContain("/profile/links");
  });

  it("the Lighthouse inventories include a links path", () => {
    expect(auditPaths.some((p: string) => p.includes("/links"))).toBe(true);
    const configUrls = lighthouserc.collect.url as string[];
    expect(configUrls.some((u) => u.includes("/links"))).toBe(true);
    expect((admission.paths as string[]).some((p) => p.includes("/links"))).toBe(true);
  });
});
