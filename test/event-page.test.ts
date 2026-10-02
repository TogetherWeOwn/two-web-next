import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";

// Real Drizzle queries and Hono/session rendering; all data is local, no DB connection.
function fixture(over: Partial<typeof events.$inferSelect> = {}) {
  const start = new Date("2030-01-10T20:00:00Z");
  const row: typeof events.$inferSelect = {
    id: 1, icsSequence: 1n, eventKey: KEY, title: "Chess night", game: "Chess", description: "Bring a friend & a board.",
    startsAt: start, endsAt: new Date("2030-01-10T22:00:00Z"), timezone: "UTC",
    location: "The lobby & voice channel", capacity: 10, status: "published", rsvpOpen: true,
    discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    agentGrantId: null, proofMarker: null, agentVersion: 1,
    createdBy: null, recurrenceFrequency: null, recurrenceCount: null,
    recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null, createdAt: start, updatedAt: start,
    ...over,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const queries: string[] = [];
  const db = drizzle(async (sql) => {
    queries.push(sql);
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    // The going-count aggregate reads two positional columns; the viewer
    // answer read selects its own row and is empty in this fixture.
    if (sql.includes('from "rsvps"')) return sql.includes("count(*)") ? { rows: [[row.id, 3]] } : { rows: [] };
    if (sql.includes('"event_key" =')) {
      return { rows: [columns.map((key) => row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key])] };
    }
    return { rows: [] };
  });
  const store = createMemorySessionStore();
  const env = { APP_URL: `${APP_URL}/`, SESSION_SECRET: SECRET, SESSION_STORE: store, ADMIN_DB: db as unknown as Db } as unknown as Env;
  return {
    row, queries, env,
    async cookie(moderator = false, expired = false) {
      const token = newSessionToken();
      await store.create({ tokenHash: await hashToken(token), userId: "100000000000000001", username: "member", avatar: null,
        member: true, moderator, expiresAt: new Date(Date.now() + (expired ? -1000 : 3600_000)) });
      return (await serializeSigned("__Host-two_session", token, SECRET, {
        path: "/", secure: true, httpOnly: true, sameSite: "Lax",
      })).split(";")[0]!;
    },
    request(cookie?: string, path = PATH) {
      return app.request(path, cookie ? { headers: { cookie } } : {}, env);
    },
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

describe("Event page parity (fixture-only)", () => {
  it("renders published venue, guest pitch, calendar and canonical copy link without inline JS", async () => {
    const response = await fixture().request(undefined, `${PATH}?from=discord`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(html).toContain('data-testid="event-venue">The lobby &amp; voice channel');
    expect(html).toContain('data-testid="event-join-pitch"');
    expect(html).toContain(`href="/join?next=${encodeURIComponent(PATH)}"`);
    expect(html).toContain('data-testid="discord-join"');
    expect(html).toContain(`href="${APP_URL}${PATH}" data-copy-link="${APP_URL}${PATH}" data-testid="event-copy-link">Copy link</a>`);
    expect(html).toContain('role="status" aria-live="polite" data-testid="event-copy-toast"');
    expect(html).toContain('src="/islands/copy-link.js" defer');
    expect(html).toContain('data-testid="event-ics"');
    expect(html).toContain('data-testid="event-google-calendar"');
    expect(html).toContain("3 of 10 going");
    expect(html).not.toMatch(/data-testid="event-(?:draft|past|cancelled)"|name="robots"/);
    // The global preview-host middleware additionally suppresses indexing here.
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
    expect(scripts.every(([, attrs, body]) => attrs!.includes('type="application/ld+json"') || (attrs!.includes('src="') && body === ""))).toBe(true);
    expect(html).not.toMatch(/\son(?:click|keydown)=/);
  });

  it("hides guest pitch from a member without share-caching their session-dependent HTML", async () => {
    const source = fixture();
    const response = await source.request(await source.cookie());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).not.toContain('data-testid="event-join-pitch"');
    expect(html).not.toContain('data-testid="discord-join"');
    expect(html).toContain('data-testid="event-copy-link"');
    expect(response.headers.get("set-cookie")).toContain("__Host-two_session");
  });

  it("treats expired and forged sessions as guests", async () => {
    const source = fixture();
    for (const cookie of [await source.cookie(false, true), "__Host-two_session=forged"]) {
      const response = await source.request(cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toContain('data-testid="event-join-pitch"');
    }
  });

  it("shows a draft only to a moderator, with robots suppression", async () => {
    const source = fixture({ status: "draft" });
    for (const cookie of [undefined, await source.cookie()]) {
      expect((await source.request(cookie)).status).toBe(403);
    }
    const response = await source.request(await source.cookie(true));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(html).toContain('data-testid="event-draft">Draft');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toContain('data-testid="event-join-pitch"');
  });

  it("keeps a published event indexable on the production apex (local request only)", async () => {
    const source = fixture();
    source.env.APP_URL = "https://togetherweown.com";
    const response = await source.request(undefined, `${source.env.APP_URL}${PATH}`);
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(await response.text()).not.toContain('name="robots"');
  });

  it("uses the explicit past status and noindex, not an elapsed-time heuristic", async () => {
    const source = fixture({ status: "past" });
    source.env.APP_URL = "https://togetherweown.com";
    const response = await source.request(undefined, `${source.env.APP_URL}${PATH}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(html).toContain('data-testid="event-past">Past event');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    const elapsed = await (await fixture({ endsAt: new Date("2000-01-01T00:00:00Z") }).request()).text();
    expect(elapsed).not.toContain('data-testid="event-past"');
  });

  it("preserves cancelled 410, title and JSON-LD without canonical or share tags", async () => {
    const response = await fixture({ status: "cancelled" }).request();
    const html = await response.text();
    expect(response.status).toBe(410);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    expect(html).toContain("<h1>Chess night</h1>");
    expect(html).toContain("https://schema.org/EventCancelled");
    expect(html).not.toMatch(/rel="canonical"|og:|twitter:|event-join-pitch|event-copy-link/);
  });

  it("emits escaped per-event share tags and normalizes the canonical origin", async () => {
    const title = 'Chess "night" <script> & friends';
    const description = 'Bring <b>your board</b> & "friends". '.repeat(12);
    const html = await (await fixture({ title, description }).request()).text();
    expect(html).toContain(`rel="canonical" href="${APP_URL}${PATH}"`);
    expect(html).toContain(`property="og:url" content="${APP_URL}${PATH}"`);
    for (const tag of ['property="og:title"', 'name="twitter:title"']) {
      expect(html).toContain(`${tag} content="${esc(`${title} — Together We Own`)}"`);
    }
    // Legacy passes the full plain-text description; it has no truncation rule.
    for (const tag of ['property="og:description"', 'name="twitter:description"']) {
      expect(html).toContain(`${tag} content="${esc(description)}"`);
    }
    expect(html).toContain('name="twitter:card" content="summary"');
    expect(html).not.toContain("<script> & friends");
    expect(html).not.toContain("og:image");
  });

  it("omits empty venue and uses the legacy share-description fallback", async () => {
    const html = await (await fixture({ location: null, description: "" }).request()).text();
    expect(html).not.toContain('data-testid="event-venue"');
    expect(html).toContain('property="og:description" content="An event at Together We Own."');
    expect(html).toContain('name="twitter:description" content="An event at Together We Own."');
  });
});
