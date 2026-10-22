// Builder suite for the S1 link-in-bio slice (spec section 9, S1): the unit
// seams the acceptance file does not own — validator edges, store round-trip,
// crossed save shapes and page edge states. The acceptance file
// (test/member-links-acceptance.test.ts) owns the locked contract and is never
// edited here.
// route-inventory: GET /members/:user/links
// route-inventory: GET /profile/links
// route-inventory: POST /profile/links
// route-inventory: PATCH /profile/links
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { profilesApp, type ProfileDeps } from "../src/profiles/routes";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import {
  MEMBER_LINK_DENYLIST,
  MEMBER_LINK_LABEL_MAX,
  MEMBER_LINK_URL_MAX,
  MEMBER_LINKS_MAX,
  parseLinksFormText,
  validateLinksJson,
  validateLinksList,
} from "../src/profiles/links-validation";
import { createDbLinksStore, createMemoryLinksStore } from "../src/profiles/links-store";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { stripTags } from "./helpers/html-text";

describe("links validator bounds", () => {
  it("pins the locked contract constants", () => {
    expect(MEMBER_LINKS_MAX).toBe(12);
    expect(MEMBER_LINK_LABEL_MAX).toBe(80);
    expect(MEMBER_LINK_URL_MAX).toBe(2048);
    expect(MEMBER_LINK_DENYLIST).toContain("blocked-example.test");
  });

  it("accepts a trimmed list and stores the trimmed form", () => {
    const result = validateLinksList([{ label: "  Twitch  ", url: "  https://twitch.tv/alice  " }]);
    expect(result).toEqual({
      ok: true,
      links: [{ label: "Twitch", url: "https://twitch.tv/alice" }],
    });
  });

  it("keeps the URL as typed instead of URL-normalizing it", () => {
    const result = validateLinksList([{ label: "Root", url: "https://example.com" }]);
    expect(result.ok && result.links).toEqual([{ label: "Root", url: "https://example.com" }]);
  });

  it("rejects control characters in labels and URLs", () => {
    expect(validateLinksList([{ label: "a\0b", url: "https://example.com" }]).ok).toBe(false);
    expect(validateLinksList([{ label: "ok", url: "https://example.com/a\u0007b" }]).ok).toBe(
      false,
    );
  });

  it("rejects non-string fields with a type error", () => {
    const label = validateLinksList([{ label: 7, url: "https://example.com" }]);
    expect(label.ok).toBe(false);
    const url = validateLinksList([{ label: "ok", url: 7 }]);
    expect(url.ok).toBe(false);
  });

  it("rejects a trailing-dot denylisted host", () => {
    const result = validateLinksList([
      { label: "Bad", url: "https://blocked-example.test./steal" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("names unknown JSON fields instead of saving past them", () => {
    const result = validateLinksJson({ links: [], admin: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toMatchObject({ admin: expect.any(String) });
  });

  it("parses form lines on the first separator and drops blank lines", () => {
    const result = parseLinksFormText("A | https://a.example\n\n  \nB | https://b.example/x|y");
    expect(result).toEqual({
      ok: true,
      links: [
        { label: "A", url: "https://a.example" },
        { label: "B", url: "https://b.example/x|y" },
      ],
    });
  });

  it("an absent form text clears, a non-string text is 422-shaped", () => {
    expect(parseLinksFormText(undefined)).toEqual({ ok: true, links: [] });
    const bad = parseLinksFormText(["x"]);
    expect(bad.ok).toBe(false);
  });

  it("a separator-less line names its line", () => {
    const result = parseLinksFormText("no separator here");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toMatchObject({ "links[0]": expect.stringContaining("1") });
  });

  it("reports shape and item errors together, not one at a time", () => {
    const result = parseLinksFormText("no separator here\nBlog | http://example.com/nope");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toMatchObject({
      "links[0]": expect.stringContaining("1"),
      "links[1].url": expect.any(String),
    });
  });
});

describe("links memory store", () => {
  it("misses as null and copies across the seam", async () => {
    const store = createMemoryLinksStore();
    expect(await store.find("100000000000000001")).toBeNull();
    const input = [{ label: "Twitch", url: "https://twitch.tv/alice" }];
    await store.save("100000000000000001", input);
    input[0]!.label = "mutated";
    input.push({ label: "extra", url: "https://example.com" });
    const found = await store.find("100000000000000001");
    expect(found).toEqual([{ label: "Twitch", url: "https://twitch.tv/alice" }]);
    found![0]!.label = "mutated";
    expect(await store.find("100000000000000001")).toEqual([
      { label: "Twitch", url: "https://twitch.tv/alice" },
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("links database store", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(() => fixture?.dispose());

  it("upserts whole lists per member, including an empty clear", async () => {
    await db.execute(
      sql`INSERT INTO users (id, username, member) VALUES ('100000000000000211', 'saver', true)`,
    );
    const store = createDbLinksStore(db);
    expect(await store.find("100000000000000211")).toBeNull();
    await store.save("100000000000000211", [{ label: "Twitch", url: "https://twitch.tv/saver" }]);
    expect(await store.find("100000000000000211")).toEqual([
      { label: "Twitch", url: "https://twitch.tv/saver" },
    ]);
    await store.save("100000000000000211", []);
    expect(await store.find("100000000000000211")).toEqual([]);
  });
});

const BUILDER_SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const BUILDER_APP_URL = "https://next.example.test";
const builderEnv: Env = {
  APP_URL: BUILDER_APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: BUILDER_SESSION_SECRET,
};

const BUILDER_ALICE = {
  userId: "100000000000000001",
  username: "alice",
  member: true,
  moderator: false,
};

function builderHarness(
  opts: {
    members?: MemberView[];
    links?: [string, { label: string; url: string }[]][];
    linksStore?: ReturnType<typeof createMemoryLinksStore>;
  } = {},
) {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore(
    opts.members ?? [
      {
        id: BUILDER_ALICE.userId,
        username: "alice",
        avatar: null,
        bio: "Alice bio",
        games: [],
        timezone: null,
      },
    ],
  );
  const links =
    opts.linksStore ??
    createMemoryLinksStore(
      opts.links ?? [[BUILDER_ALICE.userId, [{ label: "Twitch", url: "https://twitch.tv/alice" }]]],
    );
  const buckets: string[] = [];
  const deps = {
    sessionStore: sessions,
    store,
    linksStore: links,
    throttle: async (bucket: string) => {
      buckets.push(bucket);
      return { limited: false as const };
    },
  } as ProfileDeps;
  return { app: profilesApp(deps), sessions, store, links, buckets };
}

async function builderCookieFor(store: SessionStore, row: typeof BUILDER_ALICE): Promise<string> {
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
  const serialized = await serializeSigned("__Host-two_session", token, BUILDER_SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

describe("links page document shape", () => {
  it("the public page carries the standards-gate basics and one h1", async () => {
    const { app } = builderHarness();
    const res = await app.request(`/members/${BUILDER_ALICE.userId}/links`, {}, builderEnv);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/^\s*<!doctype html>/i);
    expect(html).toMatch(/<html\b[^>]*\blang="[a-z]{2}/i);
    expect(html).toMatch(/<meta\b[^>]*name="viewport"/i);
    expect(html).toMatch(/<meta\b[^>]*name="description"[^>]*content="[^"]{20,}/i);
    expect(html.match(/<h1\b/gi)).toHaveLength(1);
  });

  it("member links open externally with a warning and noopener", async () => {
    const { app } = builderHarness();
    const html = await (
      await app.request(`/members/${BUILDER_ALICE.userId}/links`, {}, builderEnv)
    ).text();
    const list = /<ul[^>]*data-testid="member-links-list"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1];
    expect(list).toBeDefined();
    expect(list).toContain('target="_blank"');
    expect(list).toContain('rel="noopener nofollow ugc"');
    expect(list).toContain("opens in a new tab");
  });

  it("the report link is absolute so it never 404s in production", async () => {
    const { app } = builderHarness();
    const html = await (
      await app.request(`/members/${BUILDER_ALICE.userId}/links`, {}, builderEnv)
    ).text();
    const reports = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter((m) =>
      /report/i.test(stripTags(m[2]!)),
    );
    expect(reports.length).toBeGreaterThanOrEqual(1);
    for (const m of reports) {
      expect(/href="([^"]*)"/.exec(m[1]!)?.[1] ?? "").toMatch(/^https:\/\//);
    }
  });

  it("an empty list renders an empty list, not a missing one", async () => {
    const { app } = builderHarness({ links: [] });
    const html = await (
      await app.request(`/members/${BUILDER_ALICE.userId}/links`, {}, builderEnv)
    ).text();
    const list = /<ul[^>]*data-testid="member-links-list"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1];
    expect(list).toBeDefined();
    expect(list).not.toContain("<a ");
  });

  it("the public page fails closed when no store is configured", async () => {
    const app = profilesApp({});
    const res = await app.request(`/members/${BUILDER_ALICE.userId}/links`, {}, builderEnv);
    expect(res.status).toBe(503);
  });

  it("the editor fails closed when no session store is configured", async () => {
    const app = profilesApp({});
    const token = newSessionToken();
    const serialized = await serializeSigned("__Host-two_session", token, BUILDER_SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    const res = await app.request(
      "/profile/links",
      { headers: { cookie: serialized.split(";")[0]! } },
      builderEnv,
    );
    expect(res.status).toBe(503);
  });

  it("the editor 404s when the member row is gone", async () => {
    const { app, sessions } = builderHarness({ members: [] });
    const res = await app.request(
      "/profile/links",
      { headers: { cookie: await builderCookieFor(sessions, BUILDER_ALICE) } },
      builderEnv,
    );
    expect(res.status).toBe(404);
  });
});

describe("links crossed save shapes", () => {
  const attempt = async (
    method: "POST" | "PATCH",
    contentType: string,
    body: string,
  ): Promise<{ status: number; stored: unknown }> => {
    const { app, sessions, links } = builderHarness();
    const res = await app.request(
      "/profile/links",
      {
        method,
        headers: {
          cookie: await builderCookieFor(sessions, BUILDER_ALICE),
          origin: BUILDER_APP_URL,
          "content-type": contentType,
          accept: "application/json",
        },
        body,
      },
      builderEnv,
    );
    return { status: res.status, stored: await links.find(BUILDER_ALICE.userId) };
  };

  it("POST takes the native form, never JSON", async () => {
    const r = await attempt(
      "POST",
      "application/json",
      JSON.stringify({ links: [{ label: "X", url: "https://example.com/x" }] }),
    );
    expect(r.status).toBe(415);
    expect(r.stored).toHaveLength(1);
  });

  it("PATCH takes JSON, never the native form", async () => {
    const r = await attempt(
      "PATCH",
      "application/x-www-form-urlencoded",
      new URLSearchParams({ links_text: "X | https://example.com/x" }).toString(),
    );
    expect(r.status).toBe(415);
    expect(r.stored).toHaveLength(1);
  });

  it("PATCH with a non-object JSON body is a bad request, changing nothing", async () => {
    const r = await attempt("PATCH", "application/json", JSON.stringify(["nope"]));
    expect(r.status).toBe(400);
    expect(r.stored).toHaveLength(1);
  });
});

describe("links save failures", () => {
  it("a JSON save for a deleted member is 404, never an orphan row", async () => {
    const { app, sessions, links } = builderHarness({ members: [] });
    const res = await app.request(
      "/profile/links",
      {
        method: "PATCH",
        headers: {
          cookie: await builderCookieFor(sessions, BUILDER_ALICE),
          origin: BUILDER_APP_URL,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ links: [{ label: "X", url: "https://example.com/x" }] }),
      },
      builderEnv,
    );
    expect(res.status).toBe(404);
    expect(await links.find(BUILDER_ALICE.userId)).toHaveLength(1);
  });

  it("a store outage is 500 on both save shapes", async () => {
    for (const shape of ["form", "json"] as const) {
      const failing = createMemoryLinksStore([
        [BUILDER_ALICE.userId, [{ label: "Twitch", url: "https://twitch.tv/alice" }]],
      ]);
      failing.save = async () => {
        throw new Error("db down");
      };
      const { app, sessions } = builderHarness({ linksStore: failing });
      const cookie = await builderCookieFor(sessions, BUILDER_ALICE);
      const res = await app.request(
        "/profile/links",
        shape === "form"
          ? {
              method: "POST" as const,
              headers: {
                cookie,
                origin: BUILDER_APP_URL,
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ links_text: "X | https://example.com/x" }),
            }
          : {
              method: "PATCH" as const,
              headers: {
                cookie,
                origin: BUILDER_APP_URL,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({ links: [{ label: "X", url: "https://example.com/x" }] }),
            },
        builderEnv,
      );
      expect(res.status, shape).toBe(500);
    }
  });

  it("a JSON save without a JSON accept redirects to the links page", async () => {
    const { app, sessions, links } = builderHarness();
    const res = await app.request(
      "/profile/links",
      {
        method: "PATCH",
        headers: {
          cookie: await builderCookieFor(sessions, BUILDER_ALICE),
          origin: BUILDER_APP_URL,
          "content-type": "application/json",
          accept: "text/html",
        },
        body: JSON.stringify({ links: [{ label: "X", url: "https://example.com/x" }] }),
      },
      builderEnv,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/members/${BUILDER_ALICE.userId}/links`);
    expect(await links.find(BUILDER_ALICE.userId)).toEqual([
      { label: "X", url: "https://example.com/x" },
    ]);
  });
});
