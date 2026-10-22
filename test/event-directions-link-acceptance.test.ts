// route-inventory: GET /e/:key
// Failing-first acceptance: a "Get directions" link for in-person venues.
//
// Owned by the Test Author; the Builder builds on this branch and never edits
// this file. Hermetic fixtures only: a disposable pg-proxy fixture for the
// served Hono page, the framework-free Kit resolver plus the real
// EventDetail.svelte SSR bundle for the Kit twin. No DATABASE_URL, no network.
//
// Venue renders today as plain text (`event-venue` testid, Where block) with
// no maps link on either renderer. RED tests fail on that head and pass only
// with the builder change; CONTROL tests pass before and after, proving the
// fixtures are live and the preserved contract holds.
//
// Binding Test-Author decisions (the roadmap is silent on these):
// - Shared testid `event-directions`, exact link copy "Get directions".
// - Maps shape is the documented Google Maps Universal URL:
//   `https://www.google.com/maps/search/?api=1&query=<venue>` with exactly
//   those two params; no tracking params beyond the query.
// - The link lives inside the Where block next to the venue text, as a plain
//   server-rendered anchor (no-JS works by construction). If it opens a new
//   tab, `rel` must contain `noopener`.
// - Exactly one directions link per page: related/neighbor cards keep plain-text locations.
// - Intentionally unpinned: past/draft/cancelled status behavior,
//   whitespace-only venues, and target/rel beyond the noopener implication.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { PublicEvent } from "../src/events/reads";
import {
  resolveKitEventDetail,
  type KitEventDetailModel,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";

const APP_URL = "https://next.example.test";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const PLAIN_VENUE = "The lobby";
const HOSTILE_VENUE = 'The "Lobby" & Café — 東京';
const BREAKOUT_VENUE = '"></a><script>alert("xss")</script><a href="';
const JOIN_URL = "https://call.example.test/room-7";

type EventRow = typeof events.$inferSelect;

function eventRow(over: Partial<EventRow> = {}): EventRow {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    accessibilityNotes: null,
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: PLAIN_VENUE,
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    capacity: 10,
    status: "published",
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 0,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

// Served Hono answers through a disposable pg-proxy fixture, as a guest: the
// directions link is viewer-independent, so no session or attendee reads run.
// Neighbors/related are decorative and fail open; the lone-event empty shapes
// keep this suite focused on the Where block.
async function honoHtml(row: EventRow): Promise<{ status: number; html: string }> {
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) {
      return sql.includes("count(*)") ? { rows: [[row.id, 0]] } : { rows: [] };
    }
    if (sql.includes('from "events"')) {
      // Predicate dispatch, not bare column names: the single-row lookup
      // selects every column, so only the key predicate without a status
      // predicate identifies it.
      if (sql.includes('"event_key" =') && !sql.includes('"status" =')) {
        if (!Array.isArray(params) || !params.includes(KEY)) return { rows: [] };
        return {
          rows: [
            columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
          ],
        };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });
  const honoEnv = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: createMemorySessionStore(),
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  const res = await app.request(`/e/${KEY}`, {}, honoEnv);
  return { status: res.status, html: await res.text() };
}

const GUEST: KitRequestSession = { status: "guest", session: null };

// Shared Kit model for the same event row, through the same resolver the Kit
// presentation binds to. No session, cookie or viewer flows through any seam.
function kitStore(event: PublicEvent): KitEventDetailStore {
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

async function kitModel(row: EventRow): Promise<KitEventDetailModel> {
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: `/e/${KEY}`,
    env: { APP_URL } as unknown as Env,
    session: GUEST,
    joinResult: null,
    setHeaders: () => {},
    store: kitStore({ ...row, goingCount: 0, goingOccupancy: 0 } as PublicEvent),
  });
  if (outcome.kind !== "ok") throw new Error(`expected an ok model, got ${outcome.kind}`);
  return outcome.model;
}

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

// The real Kit presentation, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild (same shape as the event-detail
// parity bundle: #lib/* resolves through the web alias). Built once per file:
// every test renders a model through the same bundle.
let detailBundle: Promise<{ renderDetail: (model: Record<string, unknown>) => string }> | null =
  null;

function kitDetailBundle(): Promise<{
  renderDetail: (model: Record<string, unknown>) => string;
}> {
  detailBundle ??= (async () => {
    const worktree = fileURLToPath(new URL("../", import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), "kit-directions-link-"));
    try {
      const entry = join(scratch, "kit-directions-link-entry.mjs");
      writeFileSync(
        entry,
        `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
      );
      const outfile = join(scratch, "kit-directions-link.mjs");
      await build({
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
            name: "kit-directions-link-svelte-ssr",
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
      const { renderDetail } = (await import(pathToFileURL(outfile).href)) as {
        renderDetail: (model: Record<string, unknown>) => string;
      };
      return { renderDetail };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return detailBundle;
}

async function kitHtml(row: EventRow): Promise<string> {
  const { renderDetail } = await kitDetailBundle();
  return renderDetail((await kitModel(row)) as unknown as Record<string, unknown>);
}

function unescapeHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    "#x27": "'",
  };
  return value.replace(
    /&(amp|lt|gt|quot|#39|#x27);/g,
    (match, name: string) => entities[name] ?? match,
  );
}

interface DirectionsAnchor {
  tag: string;
  href: string;
  text: string;
}

function directionsAnchors(html: string): DirectionsAnchor[] {
  const anchors: DirectionsAnchor[] = [];
  const pattern = /<a\b([^>]*data-testid="event-directions"[^>]*)>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const rawHref = attrs.match(/\bhref="([^"]*)"/)?.[1];
    if (rawHref === undefined) throw new Error("directions anchor without an href");
    anchors.push({ tag: match[0], href: unescapeHtml(rawHref), text: (match[2] ?? "").trim() });
  }
  return anchors;
}

function whereBlock(html: string): string | null {
  const match = html.match(/<div>\s*<dt>Where<\/dt>[\s\S]*?<\/div>/);
  return match ? match[0] : null;
}

function venueText(html: string): string | null {
  const match = html.match(/<p data-testid="event-venue">([\s\S]*?)<\/p>/);
  return match ? unescapeHtml(match[1] ?? "") : null;
}

// The pinned maps shape: the documented Google Maps Universal URL with exactly
// the api version and the venue query — no tracking params beyond the query.
function expectDirectionsUrl(href: string, venue: string): void {
  const url = new URL(href);
  expect(url.origin).toBe("https://www.google.com");
  expect(["/maps/search", "/maps/search/"]).toContain(url.pathname);
  expect([...url.searchParams.keys()].sort()).toEqual(["api", "query"]);
  expect(url.searchParams.get("api")).toBe("1");
  expect(url.searchParams.get("query")).toBe(venue);
  expect(href).not.toMatch(/utm_|fbclid|gclid|msclkid/);
}

// A plain server-rendered anchor carries no-JS support by construction: it is
// a link tag with an absolute href, not a scripted control.
function expectPlainAnchor(anchor: DirectionsAnchor): void {
  expect(anchor.tag.startsWith("<a")).toBe(true);
  expect(anchor.href.startsWith("https://")).toBe(true);
  expect(anchor.tag).not.toContain("onclick");
  if (/\btarget="_blank"/.test(anchor.tag)) {
    expect(anchor.tag).toMatch(/rel="[^"]*noopener[^"]*"/);
  }
}

function expectNoDirectionsArtifacts(html: string): void {
  expect(html).not.toContain('data-testid="event-directions"');
  expect(html).not.toContain("Get directions");
  expect(html).not.toContain("maps/search");
}

describe("Hono directions link (RED: missing until the build lands)", () => {
  it("shows a Get directions link with the shared testid when a venue is present", async () => {
    const { status, html } = await honoHtml(eventRow());
    expect(status).toBe(200);
    const anchors = directionsAnchors(html);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.text).toBe("Get directions");
    expectDirectionsUrl(anchors[0]!.href, PLAIN_VENUE);
    expectPlainAnchor(anchors[0]!);
    expect(venueText(html)).toBe(PLAIN_VENUE);
  });

  it("pins the maps-query encoding for hostile venue strings", async () => {
    const { status, html } = await honoHtml(eventRow({ location: HOSTILE_VENUE }));
    expect(status).toBe(200);
    const anchors = directionsAnchors(html);
    expect(anchors).toHaveLength(1);
    // The query round-trips byte-for-byte: quotes, ampersand and unicode all
    // survive the encode/decode pair.
    expectDirectionsUrl(anchors[0]!.href, HOSTILE_VENUE);
    // The ampersand is entity-escaped in the served bytes, never a raw
    // parameter separator; the unicode stays readable, not mojibake.
    expect(html).toContain("&amp;");
    expect(venueText(html)).toBe(HOSTILE_VENUE);
    expect(html).toContain("東京");
  });

  it("keeps a breakout venue inside the attribute and the text", async () => {
    const { html } = await honoHtml(eventRow({ location: BREAKOUT_VENUE }));
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain('"></a><script>');
    const anchors = directionsAnchors(html);
    expect(anchors).toHaveLength(1);
    expectDirectionsUrl(anchors[0]!.href, BREAKOUT_VENUE);
    expect(venueText(html)).toBe(BREAKOUT_VENUE);
  });

  it("places the link inside the Where block next to the venue text", async () => {
    const { html } = await honoHtml(eventRow());
    const where = whereBlock(html);
    expect(where, "Where block carries the venue and the directions link").not.toBeNull();
    expect(where).toContain('data-testid="event-venue"');
    expect(where).toContain('data-testid="event-directions"');
  });
});

describe("Kit directions link (RED: missing until the build lands)", () => {
  it("shows a Get directions link with the shared testid when a venue is present", async () => {
    const html = await kitHtml(eventRow());
    const anchors = directionsAnchors(html);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.text).toBe("Get directions");
    expectDirectionsUrl(anchors[0]!.href, PLAIN_VENUE);
    expectPlainAnchor(anchors[0]!);
    expect(venueText(html)).toBe(PLAIN_VENUE);
  });

  it("pins the maps-query encoding for hostile venue strings", async () => {
    const html = await kitHtml(eventRow({ location: HOSTILE_VENUE }));
    const anchors = directionsAnchors(html);
    expect(anchors).toHaveLength(1);
    expectDirectionsUrl(anchors[0]!.href, HOSTILE_VENUE);
    expect(html).toContain("&amp;");
    expect(venueText(html)).toBe(HOSTILE_VENUE);
    expect(html).toContain("東京");
  });

  it("keeps a breakout venue inside the attribute and the text", async () => {
    const html = await kitHtml(eventRow({ location: BREAKOUT_VENUE }));
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain('"></a><script>');
    const anchors = directionsAnchors(html);
    expect(anchors).toHaveLength(1);
    expectDirectionsUrl(anchors[0]!.href, BREAKOUT_VENUE);
    expect(venueText(html)).toBe(BREAKOUT_VENUE);
  });

  it("places the link inside the Where block next to the venue text", async () => {
    const html = await kitHtml(eventRow());
    const where = whereBlock(html);
    expect(where, "Where block carries the venue and the directions link").not.toBeNull();
    expect(where).toContain('data-testid="event-venue"');
    expect(where).toContain('data-testid="event-directions"');
  });
});

describe("Hono/Kit directions parity (RED: byte-identical hrefs)", () => {
  it.each([PLAIN_VENUE, HOSTILE_VENUE])(
    "serves the same href on both renderers for %s",
    async (venue) => {
      const { html: hono } = await honoHtml(eventRow({ location: venue }));
      const kit = await kitHtml(eventRow({ location: venue }));
      const honoAnchors = directionsAnchors(hono);
      const kitAnchors = directionsAnchors(kit);
      expect(honoAnchors).toHaveLength(1);
      expect(kitAnchors).toHaveLength(1);
      expect(kitAnchors[0]!.href).toBe(honoAnchors[0]!.href);
    },
  );
});

describe("absent venue (CONTROL: byte-identical to today, green before and after)", () => {
  it("renders no Where block and no directions artifacts when the venue is null (Hono)", async () => {
    const { status, html } = await honoHtml(eventRow({ location: null }));
    expect(status).toBe(200);
    expect(html).not.toContain("<dt>Where</dt>");
    expect(html).not.toContain(PLAIN_VENUE);
    expectNoDirectionsArtifacts(html);
  });

  it("treats an empty venue like no venue (Hono)", async () => {
    const { status, html } = await honoHtml(eventRow({ location: "" }));
    expect(status).toBe(200);
    expect(html).not.toContain("<dt>Where</dt>");
    expectNoDirectionsArtifacts(html);
  });

  it("renders no Where block and no directions artifacts when the venue is null (Kit)", async () => {
    const html = await kitHtml(eventRow({ location: null }));
    expect(html).not.toContain("<dt>Where</dt>");
    expect(html).not.toContain(PLAIN_VENUE);
    expectNoDirectionsArtifacts(html);
  });

  it("shows no directions for an online event with join details but no venue", async () => {
    const row = eventRow({
      location: null,
      join_url: JOIN_URL,
      join_instructions: "Bring headphones.",
    });
    const { status, html } = await honoHtml(row);
    expect(status).toBe(200);
    expectNoDirectionsArtifacts(html);
    // The fixture is live and the join surface is untouched: the online-only
    // event keeps its public joining link and gains no directions link.
    expect(html).toContain('data-testid="event-public-join-link"');
    expect(html).toContain("How to join");
    const kit = await kitHtml(row);
    expectNoDirectionsArtifacts(kit);
    expect(kit).not.toContain("<dt>Where</dt>");
  });

  it("keeps the venue text byte-identical on both renderers", async () => {
    const { html: hono } = await honoHtml(eventRow());
    expect(venueText(hono)).toBe(PLAIN_VENUE);
    expect(venueText(await kitHtml(eventRow()))).toBe(PLAIN_VENUE);
  });
});
