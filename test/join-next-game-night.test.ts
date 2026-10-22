// Acceptance: next game night on the join page (roadmap item S2).
//
// RED test-only handoff. These tests FAIL against unmodified main: the join
// page (Hono `src/screens/join.tsx`, Kit `web/src/routes/join/+page.svelte`)
// carries zero event content today. The paired Builder turns them green
// WITHOUT editing this file.
//
// Contract the Builder implements (both renderers, same block/copy/testids):
// - A `<section data-testid="join-next-event" data-source="canonical"|"discord"
//   aria-labelledby="join-next-event-heading">` with
//   `<h2 id="join-next-event-heading">Next game night</h2>`, rendered AFTER the
//   `.join-layout` section (after the `join-preview` marker) and inside <main>.
// - Canonical rows: `<a data-testid="join-next-event-link" href="/e/:key">`
//   wrapping `<time data-testid="join-next-event-time" datetime=ISO>` with the
//   teaser's `cardTimeLabel(startsAt, timezone)` + ` (zone|UTC)` text, a
//   `<... data-testid="join-next-event-title">`, and a
//   `<... data-testid="join-next-event-venue">` with the location or "Online".
// - Discord-source rows: same shape, but the anchor is
//   `data-testid="join-next-event-discord"` with the invite href (like the
//   homepage teaser's `home-event-discord`).
// - Hono reads through the same seams as the homepage teaser: injected
//   `ADMIN_DB` (pg-proxy here) plus the `DISCORD_EVENTS` source, reusing the
//   teaser's read (same published/not-ended predicate, start order, batched
//   aggregates — one list select, at most the two batched RSVP aggregates, no
//   per-row reads). Only the soonest merged row renders. Empty/unavailable
//   schedules render byte-identical to the DB-free page (no hollow card);
//   /join never 500s on an event-read outage.
// - Kit load data carries `nextEvent: HomeUpcomingRow | null` (the teaser's
//   row type); the page renders the same block from it, null renders nothing.
// - Cache contract unchanged: flash -> private, no-store; presence snapshot
//   -> public, max-age=60; static -> public, max-age=3600; Vary: Cookie.
//
// Local fixtures only: pg-proxy records real Drizzle SQL; the Kit page is the
// real +page.svelte SSR-compiled with the web workspace's own compiler (the
// kit-about-parity shape). The Kit server load imports cloudflare:workers so
// it cannot run in this process; it is pinned by source text like
// join-kit-page.test.ts does.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { DiscordWidgetSnapshot } from "../src/discord-widget";
import { discordWidgetHealth } from "../src/discord-widget";
import type { Env } from "../src/env";
import { HOME_EVENTS_DB_TIMEOUT_MS } from "../src/events/reads";
import type { HomeUpcomingRow } from "../src/events/reads";
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from "../src/home-copy";
import { __resetHomeGuestCacheForTests } from "../src/home-cache";
import type { DiscordTransient } from "../src/islands/contracts";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";

const NOW = new Date("2030-07-04T18:00:00Z");
const INVITE_URL = "https://discord.gg/invite";
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: INVITE_URL,
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const PRESENCE: DiscordWidgetSnapshot = {
  guildId: "326474832151838730",
  name: "Together We Own",
  inviteUrl: null,
  presenceCount: 42,
  channels: [],
  members: [],
  fetchedAt: 0,
};
const FACADE_URL = "https://discord.com/widget?id=326474832151838730&theme=dark";

function event(
  id: number,
  overrides: Partial<typeof events.$inferSelect> = {},
): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: "Private host notes",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    capacity: null,
    status: "published",
    discordEventId: "discord-event-id",
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: "private-creator-id",
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function discordTransient(overrides: Partial<DiscordTransient> = {}): DiscordTransient {
  return {
    discordId: "discord-999",
    status: "scheduled",
    title: "Discord raid night",
    description: null,
    location: "Discord voice",
    startsAt: new Date(NOW.getTime() + 3600_000),
    endsAt: new Date(NOW.getTime() + 3 * 3600_000),
    ...overrides,
  };
}

// Minimal pg-proxy answering the teaser's reads: the events list select, the
// two batched RSVP aggregates, the hidden-event suppression probe and the
// past-zones probe. Copied from the home-events suite's routing so the join
// read is judged against the exact SQL the teaser issues.
function fixture(
  rows: (typeof events.$inferSelect)[] = [],
  opts: {
    failAt?: "events" | "rsvps";
    discord?: { rows?: DiscordTransient[]; failed?: boolean };
    named?: [number, number][];
  } = {},
) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "featured_contents"')) return { rows: [] };
    if (sql.includes("set_config") && params[0] !== `${HOME_EVENTS_DB_TIMEOUT_MS}ms`)
      return { rows: [] };
    queries.push({ sql, params });
    if (sql.includes("set_config")) return { rows: [] };
    if (opts.failAt && sql.includes(`from "${opts.failAt}"`))
      throw new Error("postgres://user:secret@host/db private-member private-session");
    if (sql.includes('from "rsvps"')) {
      const named: [number, number][] = opts.named ?? [
        [1, 2],
        [2, 1],
      ];
      // The attributable aggregate joins users; the occupancy aggregate reads
      // every going row. Occupancy defaults to the named rows.
      const countRows = (sql.includes('inner join "users"') ? named : named).filter(([id]) =>
        (params as unknown[]).includes(id),
      );
      return { rows: countRows };
    }
    // Hidden-event suppression probe: discord id only, no title column.
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) {
      return {
        rows: rows
          .filter((r) => r.discordEventId !== null && params.includes(r.discordEventId))
          .map((r) => [r.discordEventId]),
      };
    }
    // Past-zones probe: timezone-only select over ended non-draft rows.
    if (sql.includes('"timezone"') && !sql.includes('"title"')) {
      const cutoff = new Date(
        String(params.find((p) => !Number.isNaN(Date.parse(String(p)))) ?? NOW),
      );
      const past = rows
        .filter((r) => r.status !== "draft" && r.endsAt < cutoff)
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || b.id - a.id)
        .slice(0, Number(params.at(-1) ?? 20));
      return { rows: past.map((r) => [r.timezone]) };
    }
    // Honor the query's bound status, boundary and cap, not the reader's intent.
    let selected = [...rows];
    if (sql.includes('"status" =')) selected = selected.filter((r) => r.status === params[0]);
    if (sql.includes('"ends_at" >=')) {
      const bound = new Date(String(params[1]));
      selected = selected.filter((r) => r.endsAt >= bound);
    }
    if (sql.includes('order by "events"."starts_at" asc')) {
      selected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    }
    if (sql.includes("limit")) selected = selected.slice(0, Number(params.at(-1)));
    return {
      rows: selected.map((row) =>
        columns.map((key) => {
          const value = row[key];
          return value instanceof Date ? value.toISOString() : value;
        }),
      ),
    };
  }) as unknown as Db;
  // pg-proxy has no transactions; run the callback on this SQL-recording fixture.
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const discordRows = opts.discord?.rows ?? [];
  const discordFailed = opts.discord?.failed ?? false;
  const env = {
    ...baseEnv,
    ADMIN_DB: db,
    DISCORD_EVENTS: {
      upcoming: async () => discordRows,
      lastReadFailed: () => discordFailed,
    },
  } as Env;
  return {
    db,
    env,
    queries,
    request: (init?: RequestInit) => app.request("/join", init, env),
  };
}

function freezeNow() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

function pinWidgetFallback() {
  vi.spyOn(discordWidgetHealth, "url").mockReturnValue(null);
  vi.spyOn(discordWidgetHealth, "snapshot").mockReturnValue(null);
}

function pinWidgetPresence() {
  vi.spyOn(discordWidgetHealth, "url").mockReturnValue(FACADE_URL);
  vi.spyOn(discordWidgetHealth, "snapshot").mockReturnValue(PRESENCE);
}

async function signedFlashCookie(result: "added" | "already_member"): Promise<string> {
  return (
    await serializeSigned(JOIN_RESULT_COOKIE, result, baseEnv.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

beforeEach(() => {
  __resetHomeGuestCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// The card both renderers must agree on: content plus the keyed attributes,
// whitespace-tolerant (framework serializers differ in trivia, never here).
function cardTuple(html: string) {
  const clean = html.replace(/<!---->/g, "");
  const sectionOpen = clean.match(/<section[^>]*data-testid="join-next-event"[^>]*>/)?.[0];
  if (!sectionOpen) throw new Error("join next-event card section is missing");
  const end = clean.indexOf("</section>", clean.indexOf(sectionOpen));
  const body = clean.slice(clean.indexOf(sectionOpen), end);
  const leaf = (testid: string) => {
    const m = body.match(new RegExp(`<[^>]*data-testid="${testid}"[^>]*>([^<]*)<`));
    if (!m) throw new Error(`join next-event is missing ${testid}`);
    return m[1]!.replace(/\s+/g, " ").trim();
  };
  const heading = body
    .match(/<h2[^>]*id="join-next-event-heading"[^>]*>([^<]*)</)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  if (!heading) throw new Error("join next-event heading is missing");
  const linkOpen =
    body.match(/<a[^>]*data-testid="join-next-event-link"[^>]*>/)?.[0] ??
    body.match(/<a[^>]*data-testid="join-next-event-discord"[^>]*>/)?.[0];
  if (!linkOpen) throw new Error("join next-event link is missing");
  const timeOpen = body.match(/<time[^>]*data-testid="join-next-event-time"[^>]*>/)?.[0];
  if (!timeOpen) throw new Error("join next-event time element is missing");
  return {
    source: sectionOpen.match(/data-source="([^"]*)"/)?.[1] ?? null,
    heading,
    title: leaf("join-next-event-title"),
    time: leaf("join-next-event-time"),
    datetime: timeOpen.match(/datetime="([^"]*)"/)?.[1] ?? null,
    venue: leaf("join-next-event-venue"),
    href: linkOpen.match(/href="([^"]*)"/)?.[1] ?? null,
    linkTestid: linkOpen.includes("join-next-event-discord")
      ? "join-next-event-discord"
      : "join-next-event-link",
  };
}

// One pinned position, both renderers: a section after the join-layout block
// (past the join-preview marker) and inside <main>, so the CTA panel keeps
// the top of the page and the card never lands in the header or footer.
function expectPinnedPosition(html: string) {
  const clean = html.replace(/<!---->/g, "");
  expect(clean).toMatch(/<section[^>]*data-testid="join-next-event"/);
  const card = clean.indexOf('data-testid="join-next-event"');
  expect(card).toBeGreaterThan(clean.indexOf("join-preview"));
  expect(card).toBeLessThan(clean.indexOf("</main>"));
}

function expectCardCount(html: string, n: number) {
  const clean = html.replace(/<!---->/g, "");
  expect(clean.match(/<section[^>]*data-testid="join-next-event"/g) ?? []).toHaveLength(n);
}

describe("Hono GET /join next game night card", () => {
  it("renders the soonest upcoming event with time, venue and detail link", async () => {
    freezeNow();
    pinWidgetFallback();
    const f = fixture([event(2), event(3), event(1)]);
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("vary")).toBe("Cookie");
    const html = await response.text();
    expectCardCount(html, 1);
    expectPinnedPosition(html);
    expect(cardTuple(html)).toEqual({
      source: "canonical",
      heading: "Next game night",
      title: "Game night 1",
      time: "Thu 4 Jul, 20:00 (Europe/London)",
      datetime: "2030-07-04T19:00:00.000Z",
      venue: "Voice lobby",
      href: "/e/event-1",
      linkTestid: "join-next-event-link",
    });
    expect(html).not.toContain("Game night 2");
    expect(html).not.toContain("Game night 3");
    for (const privateValue of [
      "private-creator-id",
      "discord-event-id",
      "Private host notes",
      "user_id",
    ]) {
      expect(html).not.toContain(privateValue);
    }
  });

  it("skips drafts, cancelled, past and ended rows; all-ineligible renders no card", async () => {
    freezeNow();
    pinWidgetFallback();
    const f = fixture([
      event(1, { status: "draft" }),
      event(2, { status: "cancelled" }),
      event(3, { status: "past" }),
      event(4, { endsAt: new Date(NOW.getTime() - 1) }),
      event(5),
    ]);
    const html = await (await f.request()).text();
    expectCardCount(html, 1);
    expect(cardTuple(html).href).toBe("/e/event-5");
    expect(html).not.toContain("Game night 1");

    const g = fixture([
      event(1, { status: "draft" }),
      event(2, { endsAt: new Date(NOW.getTime() - 1) }),
    ]);
    const empty = await (await g.request()).text();
    expect(empty).not.toContain('data-testid="join-next-event"');
  });

  it("renders the Online line for venue-less events", async () => {
    freezeNow();
    pinWidgetFallback();
    const html = await (await fixture([event(1, { location: null })]).request()).text();
    expectCardCount(html, 1);
    expect(cardTuple(html).venue).toBe("Online");
  });

  it("links Discord-source rows to the invite like the teaser", async () => {
    freezeNow();
    pinWidgetFallback();
    const f = fixture([], { discord: { rows: [discordTransient()] } });
    const html = await (await f.request()).text();
    expectCardCount(html, 1);
    expectPinnedPosition(html);
    expect(cardTuple(html)).toEqual({
      source: "discord",
      heading: "Next game night",
      title: "Discord raid night",
      time: "Thu 4 Jul, 19:00 (UTC)",
      datetime: "2030-07-04T19:00:00.000Z",
      venue: "Discord voice",
      href: INVITE_URL,
      linkTestid: "join-next-event-discord",
    });
    expect(html).not.toContain('href="/e/');
  });

  it("issues one bounded list read with the teaser predicate and batched aggregates", async () => {
    freezeNow();
    pinWidgetFallback();
    const f = fixture([event(3), event(1), event(2)]);
    const response = await f.request();
    expect(response.status).toBe(200);
    await response.text();
    const listSelects = f.queries.filter(
      (q) => q.sql.includes('from "events"') && q.sql.includes('"title"'),
    );
    // The read exists and runs once: a per-row follow-up would add list
    // selects, and a bespoke predicate would miss the teaser's clauses.
    expect(listSelects).toHaveLength(1);
    expect(listSelects[0]!.sql).toContain('"events"."status" =');
    expect(listSelects[0]!.sql).toContain('"events"."ends_at" >=');
    expect(listSelects[0]!.sql).toContain('order by "events"."starts_at" asc');
    // Batched aggregates like the teaser: one query per aggregate however
    // many candidate rows the list select returned, never one per row.
    expect(f.queries.filter((q) => q.sql.includes('from "rsvps"')).length).toBeLessThanOrEqual(2);
    expect(f.queries.length).toBeLessThanOrEqual(7);
  });

  it("escapes hostile titles and venues", async () => {
    freezeNow();
    pinWidgetFallback();
    const html = await (
      await fixture([
        event(1, {
          title: "<script>alert(1)</script>",
          location: '"><img src=x onerror=alert(1)>',
        }),
      ]).request()
    ).text();
    expectCardCount(html, 1);
    // Both serializers escape `<` (the security-relevant behavior); they
    // differ on `>` (Hono emits `&gt;`, Svelte a bare `>`), so the pin stops
    // at the escaped open bracket.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script");
    expect(html).toContain("&lt;img");
    expect(cardTuple(html).title).toContain("alert(1)");
  });

  it("renders the card alongside the presence snapshot and the one-shot flash", async () => {
    freezeNow();
    pinWidgetPresence();
    const html = await (await fixture([event(1)]).request()).text();
    expect(html).toContain('data-testid="join-widget-presence"');
    expectCardCount(html, 1);
    expect(cardTuple(html).href).toBe("/e/event-1");

    pinWidgetFallback();
    const cookie = await signedFlashCookie("added");
    const flashed = await fixture([event(1)]).request({ headers: { cookie } });
    expect(flashed.status).toBe(200);
    expect(flashed.headers.get("cache-control")).toBe("private, no-store");
    const flashedHtml = await flashed.text();
    expectCardCount(flashedHtml, 1);
    expect(cardTuple(flashedHtml).href).toBe("/e/event-1");
  });
});

describe("Hono GET /join schedule-edge behavior", () => {
  it("renders an empty schedule byte-identical to the DB-free page", async () => {
    freezeNow();
    pinWidgetFallback();
    const withDb = await fixture([]).request();
    expect(withDb.status).toBe(200);
    expect(withDb.headers.get("cache-control")).toBe("public, max-age=3600");
    const withDbHtml = await withDb.text();
    const withoutDbHtml = await (await app.request("/join", {}, baseEnv)).text();
    expect(withDbHtml).toBe(withoutDbHtml);
    expect(withDbHtml).not.toContain('data-testid="join-next-event"');
    expect(withDbHtml).not.toContain("join-next");
    expect(withDbHtml).toContain(
      "Live server preview is unavailable — the join button above still works.",
    );
  });

  it("keeps /join at 200 with no card when the event read fails", async () => {
    freezeNow();
    pinWidgetFallback();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = await fixture([event(1)], { failAt: "events" }).request();
    expect(failed.status).toBe(200);
    const failedHtml = await failed.text();
    expect(failedHtml).not.toContain('data-testid="join-next-event"');
    expect(failedHtml).not.toContain("secret@host");
    expect(failedHtml).not.toContain("postgres://");
    expect(failedHtml).toContain('data-testid="join-widget-fallback"');

    // Empty canonical plus a failed Discord read is unavailable, never a card.
    const discordFailed = await fixture([], { discord: { failed: true } }).request();
    expect(discordFailed.status).toBe(200);
    expect(await discordFailed.text()).not.toContain('data-testid="join-next-event"');
  });

  it("keeps the private/no-store contract unchanged with events present", async () => {
    freezeNow();
    // A consumed flash stays viewer-specific even when a card renders.
    pinWidgetFallback();
    const cookie = await signedFlashCookie("already_member");
    const flashed = await fixture([event(1)]).request({ headers: { cookie } });
    expect(flashed.headers.get("cache-control")).toBe("private, no-store");
    expect(flashed.headers.get("vary")).toBe("Cookie");
    // Presence without a flash keeps the 60 s shared TTL.
    pinWidgetPresence();
    const presence = await fixture([event(1)]).request();
    expect(presence.headers.get("cache-control")).toBe("public, max-age=60");
    expect(presence.headers.get("vary")).toBe("Cookie");
  });
});

// The real Kit page, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild (same shape as kit-about-parity:
// #lib/* resolves through the web alias, relative src/* through the worktree).
const webRequire = createRequire(new NodeURL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitJoinBundle(): Promise<{
  renderPage: (data: Record<string, unknown>) => string;
}> {
  const worktree = fileURLToPath(new NodeURL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-join-next-"));
  try {
    const entry = join(scratch, "kit-join-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/join/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-join.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new NodeURL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-join-next-svelte-ssr",
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
    const { renderPage } = (await import(pathToFileURL(outfile).href)) as {
      renderPage: (data: Record<string, unknown>) => string;
    };
    return { renderPage };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function kitData(nextEvent: HomeUpcomingRow | null): Record<string, unknown> {
  return {
    inviteUrl: INVITE_URL,
    joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
    widgetUrl: null,
    widgetSnapshot: null,
    oneClickHref: "/join/discord",
    appUrl: baseEnv.APP_URL,
    joinResult: null,
    nextEvent,
  };
}

const kitCanonical: HomeUpcomingRow = {
  source: "canonical",
  eventKey: "event-1",
  title: "Game night 1",
  startsAt: new Date("2030-07-04T19:00:00.000Z"),
  timezone: "Europe/London",
  location: "Voice lobby",
  goingCount: 2,
  capacity: null,
};

const kitDiscord: HomeUpcomingRow = {
  source: "discord",
  discordId: "discord-999",
  title: "Discord raid night",
  startsAt: new Date("2030-07-04T19:00:00.000Z"),
  timezone: "UTC",
  location: "Discord voice",
};

describe("Kit /join next game night parity", () => {
  let renderPage: (data: Record<string, unknown>) => string;

  beforeAll(async () => {
    ({ renderPage } = await buildKitJoinBundle());
  }, 60_000);

  it("renders the same card block from nextEvent load data", () => {
    const html = renderPage(kitData(kitCanonical));
    expectCardCount(html, 1);
    expectPinnedPosition(html);
    expect(cardTuple(html)).toEqual({
      source: "canonical",
      heading: "Next game night",
      title: "Game night 1",
      time: "Thu 4 Jul, 20:00 (Europe/London)",
      datetime: "2030-07-04T19:00:00.000Z",
      venue: "Voice lobby",
      href: "/e/event-1",
      linkTestid: "join-next-event-link",
    });
  });

  it("links Discord-source nextEvent to the invite", () => {
    const html = renderPage(kitData(kitDiscord));
    expectCardCount(html, 1);
    expect(cardTuple(html)).toEqual({
      source: "discord",
      heading: "Next game night",
      title: "Discord raid night",
      time: "Thu 4 Jul, 19:00 (UTC)",
      datetime: "2030-07-04T19:00:00.000Z",
      venue: "Discord voice",
      href: INVITE_URL,
      linkTestid: "join-next-event-discord",
    });
    expect(html).not.toContain('href="/e/');
  });

  it("renders the Online line and escapes hostile copy", () => {
    const online = renderPage(kitData({ ...kitCanonical, location: null }));
    expect(cardTuple(online).venue).toBe("Online");
    const hostile = renderPage(
      kitData({
        ...kitCanonical,
        title: "<script>alert(1)</script>",
        location: '"><img src=x onerror=alert(1)>',
      }),
    );
    expect(hostile).not.toContain("<script>alert(1)</script>");
    expect(hostile).not.toContain("<img src=x");
    expect(hostile).toContain("&lt;script");
    expect(hostile).toContain("&lt;img");
  });

  it("renders no card when nextEvent is null", () => {
    for (const html of [renderPage(kitData(null))]) {
      expect(html).not.toContain('data-testid="join-next-event"');
      expect(html).not.toContain("join-next");
      expect(html).toContain(
        "Live server preview is unavailable — the join button above still works.",
      );
    }
  });

  it("pins the Kit page and load to the shared contract", () => {
    const page = readFileSync(
      new NodeURL("../web/src/routes/join/+page.svelte", import.meta.url),
      "utf8",
    );
    const load = readFileSync(
      new NodeURL("../web/src/routes/join/+page.server.ts", import.meta.url),
      "utf8",
    );
    for (const needle of [
      "nextEvent",
      'data-testid="join-next-event"',
      'data-testid="join-next-event-title"',
      'data-testid="join-next-event-time"',
      'data-testid="join-next-event-venue"',
      "Next game night",
      "join-next-event-heading",
    ]) {
      expect(page, `page missing ${needle}`).toContain(needle);
    }
    // The link testid is source-conditional (the home teaser's
    // `data-testid={...}` ternary shape), so the pin is the bare testid, not
    // a static attribute: the SSR tests above prove each value lands on the
    // rendered anchor.
    for (const needle of ["join-next-event-link", "join-next-event-discord"]) {
      expect(page, `page missing ${needle}`).toContain(needle);
    }
    // The load provides nextEvent from the teaser's read, never a bespoke
    // query: the home load's cachedHomeUpcoming plus the readers it wraps.
    expect(load).toContain("nextEvent");
    expect(load).toMatch(
      /cachedHomeUpcoming|loadHomeUpcomingMerged|listHomeUpcoming|mergeHomeUpcoming|HomeUpcoming/,
    );
  });

  it("matches the Hono card tuple exactly", async () => {
    freezeNow();
    pinWidgetFallback();
    const honoHtml = await (await fixture([event(2), event(1)]).request()).text();
    const kitHtml = renderPage(kitData(kitCanonical));
    expect(cardTuple(kitHtml)).toEqual(cardTuple(honoHtml));
  });
});
