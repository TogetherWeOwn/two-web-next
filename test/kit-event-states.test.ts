// route-inventory: GET /e/:key
// SvelteKit migration card 24/43: the /e/:key cancelled410 and missing404
// presentations share the sessionless models in src/kit-event-states.ts. The
// full detail family stays Hono-owned until the read/RSVP companions
// complete, so this suite pins the classifier, the header contract and the
// compiled Svelte presentations — never a live Kit route.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { normalizeSection } from "../ci/kit-section-contract.mjs";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { EventLink, PublicEvent } from "../src/events/reads";
import type { SuggestedEvent } from "../src/events/suggestions";
import { resolveEventState, type EventStateStore } from "../src/kit-event-states";
import { ROUTE_MANIFEST, resolveRouteOwner } from "../src/route-ownership";
import app from "./app";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECRET = "test-session-secret-at-least-32-bytes-long";

// A cancelled row with an upcoming same-game sibling for alternatives.
function cancelledRow(): typeof events.$inferSelect {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    purpose: null,
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "cancelled",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
  };
}

const RELATED: EventLink[] = [
  {
    id: 9,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    title: "Chess finals",
    startsAt: new Date("2030-02-01T19:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
  },
];

const SUGGESTIONS: SuggestedEvent[] = [
  {
    key: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
    title: "Game night",
    startsAt: new Date("2030-03-01T19:00:00Z"),
    location: "Voice channel",
  },
];

// Hermetic store: in-memory fakes behind the same seams the future Kit load
// will bind to the real reads. No session, cookie or viewer flows through
// any seam — the presentations are viewer-independent by construction.
function fakeStore(
  over: Partial<{
    event: PublicEvent | null;
    eventError: Error;
    related: EventLink[];
    relatedError: Error;
    suggestions: SuggestedEvent[];
    suggestionsError: Error;
    db: Db | null;
    dbError: Error;
  }> = {},
): { store: EventStateStore; calls: { setHeaders: Record<string, string>[] } } {
  const calls: { setHeaders: Record<string, string>[] } = { setHeaders: [] };
  const event = { ...(cancelledRow() as unknown as PublicEvent), goingCount: 3 };
  const store: EventStateStore = {
    dbForFn: async () => {
      if (over.dbError) throw over.dbError;
      return over.db === undefined ? ({} as Db) : over.db;
    },
    getEventFn: async () => {
      if (over.eventError) throw over.eventError;
      return over.event === undefined ? event : over.event;
    },
    relatedFn: async () => {
      if (over.relatedError) throw over.relatedError;
      return over.related ?? RELATED;
    },
    suggestionsFn: async () => {
      if (over.suggestionsError) throw over.suggestionsError;
      return over.suggestions ?? SUGGESTIONS;
    },
  };
  return { store, calls };
}

const env = { APP_URL } as unknown as Env;

async function resolve(
  key: string,
  store: EventStateStore,
  search = "",
  setHeaders?: (headers: Record<string, string>) => void,
) {
  const seen: Record<string, string>[] = [];
  const outcome = await resolveEventState({
    key,
    search,
    path: `/e/${key}`,
    env,
    setHeaders: setHeaders ?? ((headers) => seen.push(headers)),
    store,
  });
  return { outcome, seen };
}

describe("event-state route ownership", () => {
  it("keeps the /e/:key family on Hono: the detail entry stays disabled", () => {
    // Card 25/43 adds the disabled member-read entry for the live detail; the
    // renderer decision stays Hono until the RSVP companion passes.
    const entry = ROUTE_MANIFEST.find(
      (candidate) => candidate.method === "GET" && candidate.path === "/e/:key",
    );
    expect(entry).toMatchObject({ enabled: false });
    expect(resolveRouteOwner({ method: "GET", path: `/e/${KEY}` })).toBe("hono");
    expect(resolveRouteOwner({ method: "HEAD", path: `/e/${KEY}` })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: `/e/${KEY.toLowerCase()}` })).toBe("hono");
  });
});

describe("event-state canonical redirect", () => {
  it("301s a lowercase ULID to the canonical key before any read, keeping the query", async () => {
    const { store } = fakeStore();
    const dbForFn = vi.fn(store.dbForFn);
    const { outcome, seen } = await resolve(KEY.toLowerCase(), { ...store, dbForFn }, "?tab=about");
    expect(outcome).toEqual({ kind: "redirect", location: `/e/${KEY}?tab=about` });
    // Canonicalization precedes every read: no database handle is opened.
    expect(dbForFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });
});

describe("event-state missing", () => {
  it("maps a forged key to missing without a database read", async () => {
    const { store } = fakeStore();
    const dbForFn = vi.fn(store.dbForFn);
    const { outcome, seen } = await resolve("nope!!", { ...store, dbForFn });
    expect(outcome.kind).toBe("missing");
    expect(dbForFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.status).toBe(404);
    expect(outcome.headers).toEqual({ "x-robots-tag": "noindex, nofollow" });
    expect(outcome.model.suggestions).toHaveLength(1);
    expect(outcome.model.suggestions[0]).toMatchObject({
      key: SUGGESTIONS[0]!.key,
      title: "Game night",
      location: "Voice channel",
    });
  });

  it("maps an unknown ULID row to missing with an empty calendar fallback", async () => {
    const { store } = fakeStore({ event: null, suggestions: [] });
    const { outcome } = await resolve(KEY, store);
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.model.suggestions).toEqual([]);
  });

  it("still renders missing when the suggestions lookup fails", async () => {
    const { store } = fakeStore({ event: null, suggestionsError: new Error("down") });
    const { outcome } = await resolve(KEY, store);
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("unreachable");
    expect(outcome.model.suggestions).toEqual([]);
  });
});

describe("event-state gone", () => {
  it("answers cancelled with the sessionless 410 contract and alternatives/ICS, never RSVP", async () => {
    const { store } = fakeStore();
    const { outcome, seen } = await resolve(KEY, store);
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    expect(outcome.headers).toEqual({
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(seen).toHaveLength(1);
    expect(outcome.model).toMatchObject({
      title: "Chess night",
      game: "Chess",
      eventKey: KEY,
      icsUrl: `/events/${KEY}.ics`,
      markdownAlternate: `/e/${KEY}.md`,
      upcomingUrl: "/events",
    });
    expect(outcome.model.related).toHaveLength(1);
    expect(outcome.model.related[0]).toMatchObject({
      key: RELATED[0]!.eventKey,
      title: "Chess finals",
    });
    expect(outcome.model.jsonLd).toContain("https://schema.org/EventCancelled");
    expect(outcome.model.jsonLd).toContain("Chess night");
    expect(outcome.model.siteJsonLd).toContain("Together We Own");
  });

  it("still renders gone when the alternatives lookup fails", async () => {
    const { store } = fakeStore({ relatedError: new Error("down") });
    const { outcome } = await resolve(KEY, store);
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.model.related).toEqual([]);
    expect(outcome.model.icsUrl).toBe(`/events/${KEY}.ics`);
  });
});

describe("event-state safety rails", () => {
  it("keeps unauthorized drafts at 403: the sessionless presentations never render them", async () => {
    const { store } = fakeStore({
      event: { ...(cancelledRow() as unknown as PublicEvent), status: "draft", goingCount: 0 },
    });
    const { outcome, seen } = await resolve(KEY, store);
    expect(outcome.kind).toBe("forbidden");
    if (outcome.kind !== "forbidden") throw new Error("unreachable");
    expect(outcome.status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it("defers live and past rows to the full-detail companion, never a 200 snapshot", async () => {
    for (const status of ["published", "past"] as const) {
      const { store } = fakeStore({
        event: { ...(cancelledRow() as unknown as PublicEvent), status, goingCount: 3 },
      });
      const { outcome } = await resolve(KEY, store);
      expect(outcome).toEqual({ kind: "live" });
    }
  });

  it("maps a database outage to 503 without touching the event read", async () => {
    const { store } = fakeStore({ db: null });
    const getEventFn = vi.fn(store.getEventFn);
    const { outcome, seen } = await resolve(KEY, { ...store, getEventFn });
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.status).toBe(503);
    expect(outcome.headers).toEqual({ "cache-control": "private, no-store" });
    expect(getEventFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("maps a thrown database handle to 503 as well", async () => {
    const { store } = fakeStore({ dbError: new Error("connection refused") });
    const { outcome } = await resolve(KEY, store);
    expect(outcome.kind).toBe("unavailable");
  });

  it("maps a thrown event read to 503, never a 500", async () => {
    const { store } = fakeStore({ eventError: new Error("boom") });
    const { outcome } = await resolve(KEY, store);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.status).toBe(503);
  });
});

// The served Hono contract this port mirrors. Real app requests through a
// disposable pg-proxy fixture: the Kit presentations must agree with these
// answers when the route is eventually enabled.
function honoFixture(queryError?: Error) {
  const row = cancelledRow();
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const db = drizzle(async (sql, params) => {
    if (queryError && sql.includes('"event_key" =')) throw queryError;
    if (sql.includes('from "rsvps"'))
      return sql.includes("count(*)") ? { rows: [[row.id, 3]] } : { rows: [] };
    // Only the fixture key resolves: any other key is an unknown row, and
    // every other read (suggestions, neighbors) finds nothing.
    if (sql.includes('"event_key" =')) {
      if (!Array.isArray(params) || !params.includes(KEY)) return { rows: [] };
      return {
        rows: [
          columns.map((key) =>
            row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
          ),
        ],
      };
    }
    return { rows: [] };
  });
  const sessionStore = createMemorySessionStore();
  const honoEnv = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: sessionStore,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    honoEnv,
    async memberCookie() {
      const token = newSessionToken();
      await sessionStore.create({
        tokenHash: await hashToken(token),
        userId: "100000000000000001",
        username: "member",
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    },
    request(cookie?: string, path = `/e/${KEY}`) {
      return app.request(path, cookie ? { headers: { cookie } } : {}, honoEnv);
    },
  };
}

describe("served Hono /e/:key contract under port", () => {
  it("answers cancelled 410 to guests and session-cookie members alike, without RSVP", async () => {
    const source = honoFixture();
    const guest = await source.request();
    const member = await source.request(await source.memberCookie());
    expect(guest.status).toBe(410);
    expect(member.status).toBe(410);
    const guestHtml = await guest.text();
    const memberHtml = await member.text();
    // The cancelled page renders before any session read: the member answer
    // is byte-identical to the guest answer.
    expect(memberHtml).toBe(guestHtml);
    expect(guest.headers.get("cache-control")).toBe("private, no-store");
    expect(guest.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(guestHtml).toContain('data-testid="event-cancelled">Cancelled');
    expect(guestHtml).toContain("https://schema.org/EventCancelled");
    expect(guestHtml).not.toMatch(/rel="canonical"|og:|twitter:|event-join-pitch|event-copy-link/);
  });

  it("301s a lowercase ULID key and preserves the query string", async () => {
    const source = honoFixture();
    const res = await source.request(undefined, `/e/${KEY.toLowerCase()}?tab=about`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/e/${KEY}?tab=about`);
  });

  it("answers an outage 503 for the detail read", async () => {
    const source = honoFixture(new Error("connection refused"));
    const res = await source.request();
    expect(res.status).toBe(503);
  });

  it("lets a cancelled event's calendar entry download", async () => {
    const source = honoFixture();
    const res = await source.request(undefined, `/events/${KEY}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(await res.text()).toContain("STATUS:CANCELLED");
  });
});

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

// The real Kit presentations, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild (same shape as the rules parity
// bundle: #lib/* resolves through the web alias).
async function buildKitEventStatesBundle(): Promise<{
  renderGone: (model: Record<string, unknown>) => string;
  renderMissing: (model: Record<string, unknown>) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-event-states-"));
  try {
    const entry = join(scratch, "kit-event-states-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Gone from ${JSON.stringify(join(worktree, "web/src/lib/EventGone.svelte"))};
import Missing from ${JSON.stringify(join(worktree, "web/src/lib/EventMissing.svelte"))};
export function renderGone(model) {
  const { head, body } = render(Gone, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function renderMissing(model) {
  const { head, body } = render(Missing, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-event-states.mjs");
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-event-states-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    void result;
    const { renderGone, renderMissing } = (await import(pathToFileURL(outfile).href)) as {
      renderGone: (model: Record<string, unknown>) => string;
      renderMissing: (model: Record<string, unknown>) => string;
    };
    return { renderGone, renderMissing };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function heroSectionOf(html: string): string {
  const match = html.match(/<section[^>]*aria-label="Cancelled event"[\s\S]*?<\/section>/);
  if (!match) throw new Error("cancelled hero section is missing");
  return normalizeSection(match[0].replace(/<!---->/g, ""));
}

function suggestionsSectionOf(html: string): string {
  const match = html.match(
    /<section[^>]*aria-labelledby="error-events-heading"[\s\S]*?<\/section>/,
  );
  if (!match) throw new Error("suggestions section is missing");
  return normalizeSection(match[0].replace(/<!---->/g, ""));
}

describe("Kit cancelled presentation", () => {
  it("emits one event block and one site block, each parseable", async () => {
    const { store } = fakeStore();
    const { outcome } = await resolve(KEY, store);
    if (outcome.kind !== "gone") throw new Error("unreachable");
    const { renderGone } = await buildKitEventStatesBundle();
    const html = renderGone(outcome.model as unknown as Record<string, unknown>);
    const blocks = [
      ...html.matchAll(
        /<script type="application\/ld\+json" data-testid="([^"]+)">([\s\S]*?)<\/script>/g,
      ),
    ].map((m) => ({ testid: m[1], payload: JSON.parse(m[2]!) }));
    expect(blocks.map((b) => b.testid)).toEqual(["event-jsonld", "site-jsonld"]);
    expect(blocks[0]!.payload["@type"]).toBe("Event");
    expect(blocks[1]!.payload["@graph"]).toHaveLength(2);
  });

  it("renders the 410 contract: status copy, title, alternatives, ICS and JSON-LD, never share or RSVP", async () => {
    const { store } = fakeStore();
    const { outcome } = await resolve(KEY, store);
    if (outcome.kind !== "gone") throw new Error("unreachable");
    const { renderGone } = await buildKitEventStatesBundle();
    const html = renderGone(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    expect(html).toContain("<h1>Chess night</h1>");
    expect(html).toContain(`href="/events/${KEY}.ics"`);
    expect(html).toContain('data-testid="event-cancelled-ics"');
    expect(html).toContain("Chess finals");
    expect(html).toContain('href="/events"');
    expect(html).toContain("https://schema.org/EventCancelled");
    expect(html).toContain('data-testid="event-jsonld"');
    expect(html).toContain('data-testid="site-jsonld"');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toMatch(/rel="canonical"|og:|twitter:|event-join-pitch|event-copy-link|rsvp/i);
  });

  it("drops the account area on both renderers: the sessionless page offers no sign-in", async () => {
    const source = honoFixture();
    const honoHtml = await (await source.request()).text();
    expect(honoHtml).not.toContain("header-account");
    const { store } = fakeStore();
    const { outcome } = await resolve(KEY, store);
    if (outcome.kind !== "gone") throw new Error("unreachable");
    const { renderGone } = await buildKitEventStatesBundle();
    const kitHtml = renderGone(outcome.model as unknown as Record<string, unknown>);
    expect(kitHtml).not.toContain("header-account");
    expect(kitHtml).not.toContain('data-testid="signin"');
  });

  it("keeps the served Hono hero core inside the extended Kit hero", async () => {
    // The Kit hero deliberately extends the Hono one (alternatives + ICS are
    // the new acceptance), so parity is the shared core, not the section.
    const source = honoFixture();
    const honoHtml = await (await source.request()).text();
    const { store } = fakeStore();
    const { outcome } = await resolve(KEY, store);
    if (outcome.kind !== "gone") throw new Error("unreachable");
    const { renderGone } = await buildKitEventStatesBundle();
    const kitHtml = renderGone(outcome.model as unknown as Record<string, unknown>);
    const honoHero = heroSectionOf(honoHtml);
    const kitHero = heroSectionOf(kitHtml);
    for (const core of [
      '<p class="event-kicker">Chess</p>',
      'data-testid="event-cancelled">Cancelled',
      "<h1>Chess night</h1>",
      ">See upcoming events</a>",
    ]) {
      expect(honoHero).toContain(core);
      expect(kitHero).toContain(core);
    }
  });
});

describe("Kit missing presentation", () => {
  it("renders branded recovery with suggestions, search and browse links", async () => {
    const { store } = fakeStore({ event: null });
    const { outcome } = await resolve(KEY, store);
    if (outcome.kind !== "missing") throw new Error("unreachable");
    const { renderMissing } = await buildKitEventStatesBundle();
    const html = renderMissing(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain("We cannot find that page");
    expect(html).toContain('data-testid="error-event-suggestions"');
    expect(html).toContain('data-testid="error-event-suggestion"');
    expect(html).toContain("Game night");
    expect(html).toContain('data-testid="error-all-events"');
    expect(html).toContain('data-testid="error-events-search"');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it("renders the empty-calendar fallback when no suggestions exist", async () => {
    const { store } = fakeStore({ event: null, suggestions: [] });
    const { outcome } = await resolve(KEY, store);
    if (outcome.kind !== "missing") throw new Error("unreachable");
    const { renderMissing } = await buildKitEventStatesBundle();
    const html = renderMissing(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="error-events-empty"');
    expect(html).not.toContain('data-testid="error-event-suggestion"');
  });

  it("matches the served Hono suggestions section through the framework-tolerant treatment", async () => {
    const source = honoFixture();
    const missing = await source.request(undefined, "/e/01ARZ3NDEKTSV4RRFFQ69G5FA9");
    expect(missing.status).toBe(404);
    const honoHtml = await missing.text();
    // The Hono 404 for an unknown row carries no suggestions in this
    // fixture (the suggestion query finds no rows); the Kit empty model
    // must agree with exactly that section.
    const { store } = fakeStore({ event: null, suggestions: [] });
    const { outcome } = await resolve(KEY, store);
    if (outcome.kind !== "missing") throw new Error("unreachable");
    const { renderMissing } = await buildKitEventStatesBundle();
    const kitHtml = renderMissing(outcome.model as unknown as Record<string, unknown>);
    expect(suggestionsSectionOf(kitHtml)).toBe(suggestionsSectionOf(honoHtml));
  });
});
