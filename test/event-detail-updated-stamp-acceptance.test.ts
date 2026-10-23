// route-inventory: GET /e/:key
// Acceptance: last-updated stamp on the event detail page, both renderers.
//
// Hermetic: in-memory rows, a pg-proxy fake for the Hono route, and the
// framework-free Kit resolver rendered through the Svelte SSR bundle. No
// database, no account, no external requests.
//
// Locked contract (the paired implementation must satisfy this file unchanged):
// - Both renderers show the stamp only for edited events: updatedAt minus
//   createdAt strictly greater than SKEW_MS (60 s). Fresh rows (equal
//   instants), within-skew edits, and backwards rows (updatedAt before
//   createdAt) render no stamp at all.
// - The stamp is exactly one element with data-testid="event-updated", placed
//   inside the event-meta <dl>. Its visible text starts with "Updated " and it
//   holds one <time> whose datetime is updatedAt.toISOString() exactly; the
//   human text names the updated calendar year (fixtures keep created, starts,
//   ends, and updated years apart so the year proves the source instant).
// - Hono and Kit share the testid, the "Updated " copy, the visible text, and
//   the machine instant for the same row.
// - No new read: the stamp derives from the existing event row. The Hono route
//   issues identical SQL for edited and fresh rows with exactly one event-key
//   lookup, and the Kit resolver invokes identical store calls with one
//   getEventFn. The Kit store seam stays unchanged: no new store function.
// - Every test below renders an edited fixture, so every test fails until the
//   stamp exists; the fresh/within-skew/backwards assertions ride along and
//   pass only when the visibility rule above holds.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import type { KitRequestSession } from "../src/kit-session";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JSON_LD = '{"@type":"Event"}';
// Skew guard: fresh inserts stamp createdAt/updatedAt together (millisecond
// drift), while a real edit lands later. A full minute keeps fresh rows clean.
const SKEW_MS = 60_000;
// Distinct years prove the source instant: created 2028, updated 2029, the
// scheduled window 2030. An edit before the event is the ordinary case.
const CREATED = new Date("2028-05-01T12:00:00.000Z");
const UPDATED = new Date("2029-11-20T15:30:00.000Z");
const STARTS = new Date("2030-06-10T20:00:00.000Z");
const ENDS = new Date("2030-06-10T22:00:00.000Z");
const STAMP_ID = 'data-testid="event-updated"';

type EventRow = typeof events.$inferSelect;

function row(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: STARTS,
    endsAt: ENDS,
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
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
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...over,
  };
}

const editedRow = () => row();
const freshRow = () => row({ updatedAt: CREATED });
const withinSkewRow = () => row({ updatedAt: new Date(CREATED.getTime() + 30_000) });
const justOverSkewRow = () => row({ updatedAt: new Date(CREATED.getTime() + SKEW_MS + 1_000) });
const backwardsRow = () => row({ updatedAt: new Date(CREATED.getTime() - 3_600_000) });

function publicEvent(source: EventRow): PublicEvent {
  return { ...source, goingCount: 0, goingOccupancy: 0 };
}

function renderHono(
  e: PublicEvent,
  over: { session?: Session | null; member?: boolean } = {},
): string {
  const html = EventPage({
    e,
    neighbors: { previous: null, next: null },
    related: [],
    appUrl: APP_URL,
    jsonLd: JSON_LD,
    session: over.session ?? null,
    member: over.member ?? false,
  });
  if (!html) throw new Error("expected the Hono detail page to render");
  return html.toString() as string;
}

const MEMBER_SESSION: Session = {
  id: "member-fixture",
  username: "member",
  avatar: null,
  member: true,
  moderator: false,
};

const GUEST_KIT: KitRequestSession = { status: "guest", session: null };
const MEMBER_KIT: KitRequestSession = {
  status: "authenticated",
  session: {
    userId: "100000000000000001",
    username: "member",
    avatar: null,
    member: true,
    moderator: false,
  },
};

type StoreCalls = {
  db: number;
  get: number;
  neighbors: number;
  related: number;
  attendees: number;
  rsvp: number;
  waitlist: number;
  suggestions: number;
};

function countingStore(event: PublicEvent | null): {
  store: KitEventDetailStore;
  calls: StoreCalls;
} {
  const calls: StoreCalls = {
    db: 0,
    get: 0,
    neighbors: 0,
    related: 0,
    attendees: 0,
    rsvp: 0,
    waitlist: 0,
    suggestions: 0,
  };
  const store: KitEventDetailStore = {
    dbForFn: async () => {
      calls.db += 1;
      return {} as Db;
    },
    getEventFn: async () => {
      calls.get += 1;
      return event;
    },
    neighborsFn: async () => {
      calls.neighbors += 1;
      return { previous: null, next: null };
    },
    relatedFn: async () => {
      calls.related += 1;
      return [];
    },
    attendeesFn: async () => {
      calls.attendees += 1;
      return [];
    },
    viewerRsvpFn: async () => {
      calls.rsvp += 1;
      return null;
    },
    waitlistFn: async () => {
      calls.waitlist += 1;
      return null;
    },
    suggestionsFn: async () => {
      calls.suggestions += 1;
      return [];
    },
  };
  return { store, calls };
}

const kitEnv = { APP_URL } as unknown as Env;

async function resolveKit(event: PublicEvent, session: KitRequestSession = GUEST_KIT) {
  const { store, calls } = countingStore(event);
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: `/e/${KEY}`,
    env: kitEnv,
    session,
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error("expected the Kit detail model to resolve");
  return { model: outcome.model as unknown as Record<string, unknown>, calls };
}

// Test-only text extraction for assertions (no HTML sink): walk angle
// brackets instead of a `<...>` regex replace so the helper does not read as
// an HTML sanitizer (CodeQL incomplete sanitization), mirroring the attendee
// paging acceptance helper.
function textOutsideTags(fragment: string, trim = true): string {
  let out = "";
  let inTag = false;
  for (const ch of fragment) {
    if (ch === "<" && !inTag) {
      out += " ";
      inTag = true;
    } else if (ch === ">" && inTag) {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  const collapsed = out.replace(/\s+/g, " ");
  return trim ? collapsed.trim() : collapsed;
}

function metaRegion(html: string): { start: number; end: number } {
  const match = /<dl\b[^>]*class="event-meta"[^>]*>[\s\S]*?<\/dl>/.exec(html);
  if (!match || match.index === undefined) throw new Error("expected the event-meta block");
  return { start: match.index, end: match.index + match[0].length };
}

function expectStamp(html: string, updated: Date): void {
  const iso = updated.toISOString();
  const year = iso.slice(0, 4);
  expect(html.split(STAMP_ID).length - 1, "exactly one updated stamp").toBe(1);
  const meta = metaRegion(html);
  const stampAt = html.indexOf(STAMP_ID);
  expect(stampAt, "stamp inside the event-meta block").toBeGreaterThan(meta.start);
  expect(stampAt, "stamp inside the event-meta block").toBeLessThan(meta.end);
  const tagEnd = html.indexOf(">", stampAt);
  expect(tagEnd, "stamp opening tag closes").toBeGreaterThan(stampAt);
  const timeOpen = `<time datetime="${iso}">`;
  expect(html.split(timeOpen).length - 1, "exactly one updated instant").toBe(1);
  const timeAt = html.indexOf(timeOpen);
  expect(timeAt, "updated instant after the stamp opens").toBeGreaterThan(tagEnd);
  expect(timeAt, "updated instant inside the event-meta block").toBeLessThan(meta.end);
  const prefix = textOutsideTags(html.slice(tagEnd + 1, timeAt), false).trimStart();
  expect(prefix.startsWith("Updated "), `stamp copy starts with "Updated " (saw ${prefix})`).toBe(
    true,
  );
  const timeClose = html.indexOf("</time>", timeAt);
  expect(timeClose, "updated time element closes").toBeGreaterThan(timeAt);
  const human = textOutsideTags(html.slice(timeAt + timeOpen.length, timeClose));
  expect(human.length, "updated stamp names a human date").toBeGreaterThan(0);
  expect(human, "human date names the updated year").toContain(year);
}

function expectNoStamp(html: string): void {
  expect(html, "no updated stamp").not.toContain(STAMP_ID);
}

function stampVisibleText(html: string): string {
  const stampAt = html.indexOf(STAMP_ID);
  if (stampAt < 0) throw new Error("expected the updated stamp for the parity read");
  const tagEnd = html.indexOf(">", stampAt);
  const timeClose = html.indexOf("</time>", tagEnd);
  if (tagEnd < 0 || timeClose < 0) throw new Error("expected the stamp time element");
  return textOutsideTags(html.slice(tagEnd + 1, timeClose));
}

// Kit parity: the framework-free resolver over a counting fake store, rendered
// through the Svelte SSR bundle. Hono a11y/visual gates do not exercise this
// renderer.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitBundle(): Promise<{
  renderDetail: (model: Record<string, unknown>) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "kit-updated-stamp-",
    ),
  );
  try {
    const entry = join(scratch, "entry.mjs");
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
    const outfile = join(scratch, "bundle.mjs");
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
          name: "kit-updated-stamp-ssr",
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
    return (await import(pathToFileURL(outfile).href)) as {
      renderDetail: (model: Record<string, unknown>) => string;
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type RouteFixture = {
  env: Env & { ADMIN_DB: Db; SESSION_STORE: SessionStore };
  queries: { sql: string; params: unknown[] }[];
  request: () => Promise<Response>;
};

function routeFixture(source: EventRow): RouteFixture {
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('"event_key" =')) {
      return {
        rows: [
          columns.map((key) => {
            const value = source[key];
            return value instanceof Date ? value.toISOString() : value;
          }),
        ],
      };
    }
    return { rows: [] };
  }) as unknown as Db;
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    ADMIN_DB: db,
    SESSION_STORE: createMemorySessionStore(),
  } as unknown as Env & { ADMIN_DB: Db; SESSION_STORE: SessionStore };
  return { env, queries, request: () => Promise.resolve(app.request(`/e/${KEY}`, {}, env)) };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("updated-stamp tests must remain offline");
    }),
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("Hono updated stamp (local fixtures)", () => {
  it("shows Updated with the row's updatedAt instant and hides it on a fresh row", () => {
    const edited = editedRow();
    const fresh = freshRow();
    // Distinct instants keep the assertions honest: the stamp's exact datetime
    // can only come from updatedAt.
    const instants = new Set(
      [edited.createdAt, edited.updatedAt, edited.startsAt, edited.endsAt].map((d) =>
        d.toISOString(),
      ),
    );
    expect(instants.size).toBe(4);
    expectStamp(renderHono(publicEvent(edited)), UPDATED);
    expectNoStamp(renderHono(publicEvent(fresh)));
  });

  it("hides a within-skew edit and shows a just-over-skew edit", () => {
    expectNoStamp(renderHono(publicEvent(withinSkewRow())));
    const over = justOverSkewRow();
    expectStamp(renderHono(publicEvent(over)), over.updatedAt);
  });

  it("hides a backwards updatedAt while the edited control shows", () => {
    expectNoStamp(renderHono(publicEvent(backwardsRow())));
    expectStamp(renderHono(publicEvent(editedRow())), UPDATED);
  });

  it("shows the identical stamp to signed-in members", () => {
    const guest = renderHono(publicEvent(editedRow()));
    const member = renderHono(publicEvent(editedRow()), {
      session: MEMBER_SESSION,
      member: true,
    });
    expectStamp(guest, UPDATED);
    expectStamp(member, UPDATED);
    expect(stampVisibleText(member)).toBe(stampVisibleText(guest));
  });

  it("adds no read for the stamp: identical SQL for edited and fresh rows", async () => {
    const edited = routeFixture(editedRow());
    const fresh = routeFixture(freshRow());
    const [editedRes, freshRes] = await Promise.all([edited.request(), fresh.request()]);
    expect(editedRes.status).toBe(200);
    expect(freshRes.status).toBe(200);
    expectStamp(await editedRes.text(), UPDATED);
    expectNoStamp(await freshRes.text());
    expect(edited.queries.length, "edited and fresh issue the same reads").toBe(
      fresh.queries.length,
    );
    expect(edited.queries.map((q) => q.sql).sort()).toEqual(fresh.queries.map((q) => q.sql).sort());
    for (const fixture of [edited, fresh]) {
      expect(
        fixture.queries.filter((q) => q.sql.includes('"event_key" =')),
        "exactly one event-row lookup",
      ).toHaveLength(1);
      expect(
        fixture.queries.some((q) => q.sql.includes("activity_log")),
        "no history read",
      ).toBe(false);
    }
  });
});

describe("Kit updated stamp parity (local fixtures)", () => {
  let renderDetail: (model: Record<string, unknown>) => string;

  beforeAll(async () => {
    ({ renderDetail } = await buildKitBundle());
  });

  it("renders Updated with the row's updatedAt instant and hides it on a fresh row", async () => {
    const { model: edited } = await resolveKit(publicEvent(editedRow()));
    const { model: fresh } = await resolveKit(publicEvent(freshRow()));
    expectStamp(renderDetail(edited), UPDATED);
    expectNoStamp(renderDetail(fresh));
  });

  it("hides a within-skew edit and shows a just-over-skew edit", async () => {
    const { model: within } = await resolveKit(publicEvent(withinSkewRow()));
    const over = justOverSkewRow();
    const { model: overModel } = await resolveKit(publicEvent(over));
    expectNoStamp(renderDetail(within));
    expectStamp(renderDetail(overModel), over.updatedAt);
  });

  it("hides a backwards updatedAt while the edited control shows", async () => {
    const { model: backwards } = await resolveKit(publicEvent(backwardsRow()));
    const { model: edited } = await resolveKit(publicEvent(editedRow()));
    expectNoStamp(renderDetail(backwards));
    expectStamp(renderDetail(edited), UPDATED);
  });

  it("shows the identical stamp to signed-in members", async () => {
    const { model: guest } = await resolveKit(publicEvent(editedRow()), GUEST_KIT);
    const { model: member } = await resolveKit(publicEvent(editedRow()), MEMBER_KIT);
    const guestHtml = renderDetail(guest);
    const memberHtml = renderDetail(member);
    expectStamp(guestHtml, UPDATED);
    expectStamp(memberHtml, UPDATED);
    expect(stampVisibleText(memberHtml)).toBe(stampVisibleText(guestHtml));
  });

  it("adds no store read for the stamp: identical store calls for edited and fresh rows", async () => {
    const edited = await resolveKit(publicEvent(editedRow()));
    const fresh = await resolveKit(publicEvent(freshRow()));
    expect(edited.calls).toEqual(fresh.calls);
    expect(edited.calls).toMatchObject({
      db: 1,
      get: 1,
      neighbors: 1,
      related: 1,
      attendees: 0,
      rsvp: 0,
      waitlist: 0,
      suggestions: 0,
    });
    expectStamp(renderDetail(edited.model), UPDATED);
    expectNoStamp(renderDetail(fresh.model));
  });

  it("shares testid, copy, and instant with the Hono renderer", async () => {
    const { model } = await resolveKit(publicEvent(editedRow()));
    const kit = renderDetail(model);
    const hono = renderHono(publicEvent(editedRow()));
    expectStamp(hono, UPDATED);
    expectStamp(kit, UPDATED);
    expect(stampVisibleText(kit)).toBe(stampVisibleText(hono));
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});
