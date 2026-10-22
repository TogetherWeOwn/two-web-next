// route-inventory: GET /join.md
// route-inventory: GET /llms.txt
// route-inventory: GET /events.md
// route-inventory: GET /e/:file{.+\.md}
// Acceptance: machine docs hand agents followable links.
//
// /join.md embeds the raw invite env while HTML surfaces resolve through the
// sanitized floor; llms.txt claims "times below" with no times below; the
// documented per-event Markdown URLs are literal /e/:key(.md) links that 404
// against the ULID parser. Agents fetch these docs literally, so each
// unfollowable link is a dead end with no human to reinterpret it.
//
// Locked contract (paired builder must satisfy without editing this file):
// - /join.md invite resolves through the same sanitized floor as HTML: raw,
//   empty and hostile env values degrade to the fallback, never a dead or
//   hostile href; valid values keep working; one source of truth.
// - llms.txt drops or corrects the "times below" line; remaining guidance
//   matches the file's actual content.
// - Documented per-event Markdown URLs are fetchable examples or explicitly
//   marked templates (no literal 404).
// - Pins: static-cache posture and viewer-independence unchanged; no HTML
//   copy touched.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { FALLBACK_INVITE, inviteDestination } from "../src/invite";
import { events } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { MARKDOWN_MIME, llmsTxt, mdEvents, type MdEvent } from "../src/ai-friendly/md";

const APP_URL = "https://togetherweown.com";
const STAGING_URL = "https://staging.example.test";

const baseEnv = (inviteUrl: string, appUrl = APP_URL) =>
  ({
    APP_URL: appUrl,
    DISCORD_INVITE_URL: inviteUrl,
    DISCORD_GUILD_ID: "123",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    RULES_LAST_UPDATED: "2026-09-01",
  }) as unknown as Env;

const req = (path: string, env: Env, init: RequestInit = {}) => app.request(path, init, env);

/** The invite the doc hands the agent: "Use <invite> instead". */
const docInvite = (body: string): string | null => body.match(/Use (.*?) instead/)?.[1] ?? null;

const sampleRow = (): MdEvent => ({
  eventKey: "01J0000000000000000000ABCD",
  title: "Friday night Helldivers",
  game: "Helldivers",
  description: "Bring stims.",
  startsAt: new Date("2026-07-15T18:00:00Z"),
  endsAt: new Date("2026-07-15T20:00:00Z"),
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: null,
  goingCount: 7,
  goingOccupancy: 7,
  status: "published",
});

const ULID_KEYS = /[0-9A-HJKMNP-TV-Z]{26}/i;
/** Template marking the builder may use instead of a fetchable example. */
const TEMPLATE_MARK = /template|replace|placeholder|\{key\}|<key>|\[key\]/i;

const eventDocUrls = (body: string): Array<{ url: string; line: string }> => {
  const urls = body.match(/https?:\/\/[^\s)"']*\/e\/[^\s)"']+/g) ?? [];
  const lines = body.split("\n");
  return urls.map((raw) => {
    const url = raw.replace(/[.,;]+$/, "");
    return { url, line: lines.find((l) => l.includes(raw)) ?? "" };
  });
};

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("/join.md invite resolves through the sanitized floor", () => {
  const invalidInvites = [
    "",
    "not a URL",
    "javascript:alert(1)",
    "https://evil.test/invite",
    "https://discord.gg.evil.test/Ab12",
    "http://discord.gg/Ab12",
    "https://discord.com/login",
    "https://synthetic-user:synthetic-password@discord.gg/Ab12",
    "https://discord.gg:8443/Ab12",
  ];

  it.each(invalidInvites)("degrades to the fallback, never raw config: %j", async (configured) => {
    const env = baseEnv(configured);
    const [md, discord] = await Promise.all([req("/join.md", env), req("/discord", env)]);
    expect(md.status).toBe(200);
    const body = await md.text();
    // Same floor as the HTML door: /discord already redirects here.
    expect(discord.status).toBe(302);
    expect(discord.headers.get("location")).toBe(FALLBACK_INVITE);
    expect(body).toContain(FALLBACK_INVITE);
    expect(docInvite(body)).toBe(FALLBACK_INVITE);
    if (configured) expect(body).not.toContain(configured);
    expect(body).not.toMatch(/Use\s+instead/);
    expect(body).not.toMatch(/javascript:/i);
    expect(body).not.toContain("evil.test");
  });

  it.each(["https://discord.gg/test-invite", "https://discord.com/invite/Ab_12-cD"])(
    "keeps serving a valid invite unchanged: %s",
    async (configured) => {
      const expected = inviteDestination(configured);
      const body = await (await req("/join.md", baseEnv(configured))).text();
      expect(body).toContain(expected);
      expect(docInvite(body)).toBe(expected);
    },
  );

  it("normalizes through the same floor (hostname case)", async () => {
    const configured = "https://DISCORD.GG/Ab12";
    const expected = inviteDestination(configured);
    expect(expected).not.toBe(configured);
    const [md, discord] = await Promise.all([
      req("/join.md", baseEnv(configured)),
      req("/discord", baseEnv(configured)),
    ]);
    expect(discord.headers.get("location")).toBe(expected);
    const body = await md.text();
    expect(body).toContain(expected);
    expect(docInvite(body)).toBe(expected);
  });
});

describe("llms.txt guidance matches its actual content", () => {
  it("carries no 'times below' phantom in the builder or the route", async () => {
    const routeBody = await (await req("/llms.txt", baseEnv(FALLBACK_INVITE))).text();
    for (const body of [llmsTxt(APP_URL), routeBody]) expect(body).not.toMatch(/times below/i);
  });

  it("names where event times actually render, never 'below'", () => {
    for (const body of [llmsTxt(APP_URL)]) {
      const lines = body.split("\n").filter((l) => /Starts and Ends/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toMatch(/below/i);
    }
  });

  it("keeps the legitimate 'pages below' pointer (pin)", () => {
    expect(llmsTxt(APP_URL)).toContain("Public pages below");
  });

  it("lists static Markdown alternates that all fetch 200 as Markdown (pin)", async () => {
    const body = llmsTxt(APP_URL);
    const mdUrls = [...body.matchAll(/https:\/\/[^\s)]+\.md/g)]
      .map((m) => m[0])
      .filter((u) => new URL(u).origin === new URL(APP_URL).origin)
      .filter((u) => !u.includes("/e/") && !u.endsWith("/events.md"));
    expect(mdUrls.length).toBeGreaterThanOrEqual(5);
    for (const url of mdUrls) {
      const res = await req(new URL(url).pathname, baseEnv(FALLBACK_INVITE));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
    }
    // The DB-backed list keeps its own contract: 503 Markdown, never HTML,
    // when no database is bound.
    const feed = await req("/events.md", baseEnv(FALLBACK_INVITE));
    expect(feed.status).toBe(503);
    expect(feed.headers.get("content-type")).toBe(MARKDOWN_MIME);
  });
});

describe("documented per-event Markdown URLs are examples or templates", () => {
  it("marks the events-collection footer URL (no literal /e/:key.md)", () => {
    for (const { url, line } of eventDocUrls(mdEvents(APP_URL, [sampleRow()]))) {
      if (url.includes(":key")) expect(line).toMatch(TEMPLATE_MARK);
      else expect(url).toMatch(ULID_KEYS);
    }
    expect(mdEvents(APP_URL, [sampleRow()])).toContain("/e/");
  });

  it("marks the llms.txt per-event URLs (no literal /e/:key)", () => {
    const found = eventDocUrls(llmsTxt(APP_URL));
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const { url, line } of found) {
      if (url.includes(":key")) expect(line).toMatch(TEMPLATE_MARK);
      else expect(url).toMatch(ULID_KEYS);
    }
  });

  it("serves the marked URLs on the /llms.txt route, not just the builder", async () => {
    const body = await (await req("/llms.txt", baseEnv(FALLBACK_INVITE))).text();
    const found = eventDocUrls(body);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const { url, line } of found) {
      if (url.includes(":key")) expect(line).toMatch(TEMPLATE_MARK);
      else expect(url).toMatch(ULID_KEYS);
    }
  });

  it("pins why the literal is unfollowable: /e/:key.md 404s against the key parser", async () => {
    const res = await req("/e/:key.md", baseEnv(FALLBACK_INVITE));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
  });
});

describe("machine-doc posture pins (unchanged)", () => {
  it.each(["/join.md", "/llms.txt"])(
    "%s keeps its static cache, Markdown MIME and cookie silence",
    async (path) => {
      const res = await req(path, baseEnv(FALLBACK_INVITE));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(res.headers.get("vary")).toBeNull();
    },
  );

  it("still noindexes the machine formats on staging", async () => {
    for (const path of ["/join.md", "/llms.txt"]) {
      const res = await req(path, baseEnv(FALLBACK_INVITE, STAGING_URL));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it.each(["/join.md", "/llms.txt"])("%s is viewer-independent", async (path) => {
    const env = baseEnv(FALLBACK_INVITE);
    const [anon, authed] = await Promise.all([
      req(path, env),
      req(path, env, { headers: { cookie: "__Host-two_session=synthetic" } }),
    ]);
    expect(authed.headers.get("set-cookie")).toBeNull();
    expect(await authed.text()).toBe(await anon.text());
  });

  it("touches no HTML copy", async () => {
    const env = baseEnv(FALLBACK_INVITE);
    const join = await (await req("/join", env)).text();
    for (const phrase of [
      "Approve once with Discord and we will add you to the server.",
      "/join/discord",
      'data-testid="join-oneclick"',
    ])
      expect(join).toContain(phrase);
    const about = await (await req("/about", env)).text();
    for (const phrase of ["Voice-first", "Est. 1998"]) expect(about).toContain(phrase);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("documented event URLs against live rows", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await db.delete(events);
  });
  const tReq = (path: string) =>
    app.request(path, {}, {
      ...baseEnv(FALLBACK_INVITE),
      get ADMIN_DB() {
        return db;
      },
    } as unknown as Env);

  it("marks the served /events.md footer URL while real event links stay fetchable", async () => {
    const key = "01J0000000000000000000E3V1";
    await db.insert(events).values({
      eventKey: key,
      title: "Template-marking probe night",
      description: "Bring stims.",
      startsAt: new Date("2099-01-01T00:00:00Z"),
      endsAt: new Date("2099-01-02T00:00:00Z"),
      timezone: "UTC",
      location: "Voice: General",
      status: "published",
    } as never);
    const body = await (await tReq("/events.md")).text();
    expect(body).toContain(`/e/${key}.md`);
    for (const { url, line } of eventDocUrls(body).filter(({ url }) => !url.includes(key))) {
      if (url.includes(":key")) expect(line).toMatch(TEMPLATE_MARK);
      else expect(url).toMatch(ULID_KEYS);
    }
    const detail = await tReq(`/e/${key}.md`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("content-type")).toBe(MARKDOWN_MIME);
  });
});
