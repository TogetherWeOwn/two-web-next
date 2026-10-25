// Acceptance-owned contract: admin events inventory finds saved nights by
// title OR game, and both inventories show the saved game in the Title cell.
//
// Owned by the independent acceptance author. The Builder incorporates this
// file (plus test/helpers/admin-event-find-saved-nights.ts) by merge and must
// never edit either file; justified corrections return through the acceptance
// author.
//
// Legend: RED tests fail on the current head (title-only `q` in
// src/admin/store-event-reads.ts, no game in src/admin/kit-events.ts rows,
// bare "Search" labels) and must pass after the combined tests-and-
// implementation PR. CONTROL tests pass now and must keep passing: they pin
// the behavior the change must preserve (title matching, null/blank games,
// NUL/length bounds, read shape, native GET/keyboard/no-JS structure, query
// state in sort/paging links, headers).
//
// Evidence honesty: store and route cases run against the disposable
// agent-testdb/CI fixture (skipped when DATABASE_URL is unset); Hono cases
// execute the real EventsPage component; Kit cases execute the real server
// load and the real +page.svelte compiled to SSR. No case in this file runs
// a browser: mobile wrapping, keyboard traversal, opened screenshots and the
// a11y/lighthouse/visual gates belong to the Builder's UI evidence, not here.
//
// Neighboring pins the Builder must evolve (not weaken): the exact-shape
// `serializeEventListRow` pin in test/kit-admin-events.test.ts gains the new
// game field; the "matches title only" sentence in
// docs/moderator-admin-guide.md is rewritten (pinned below). Retry/return
// links need no pin: this inventory has none, so preservation is by no-change
// plus the sort/paging CONTROLs below.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_PAGE_SIZE, parseEventListQuery } from "../src/admin/event-list";
import {
  buildEventListView,
  serializeEventListRow,
  type KitEventListView,
} from "../src/admin/kit-events";
import { EventsPage } from "../src/admin/pages";
import { adminApp } from "../src/admin/routes";
import { listEvents } from "../src/admin/store-event-reads";
import { rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  insertSavedNight,
  pageHref,
  savedNightRow,
  searchFieldText,
  searchFormTag,
  searchInputTag,
  titleCellFor,
  type SavedNightSeed,
} from "./helpers/admin-event-find-saved-nights";

// Count classified reads through the real implementation: the wrapper below
// observes resource names without changing behavior.
vi.mock("../src/member-reads", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/member-reads")>();
  return { ...mod, nonSensitiveRead: vi.fn(mod.nonSensitiveRead) };
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Compiled Kit events inventory: the real +page.server.ts load plus the real
// +page.svelte rendered to HTML, following
// test/featured-link-render-acceptance.test.ts. The cloudflare:workers env is
// the shared-object stub; each load test injects ADMIN_DB through it.
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile(source: string, options: Record<string, unknown>): { js: { code: string } };
};
const envKey = "__savedNightsAcceptanceEnv";
const sharedEnv: Record<string, unknown> = {};
let scratch = "";
let kit: {
  load(args: Record<string, unknown>): Promise<KitEventListView>;
  renderEvents(data: Record<string, unknown>): string;
};

beforeAll(async () => {
  (globalThis as Record<string, unknown>)[envKey] = sharedEnv;
  scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "saved-nights-ssr-"),
  );
  const outfile = join(scratch, "bundle.mjs");
  await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Events from ${JSON.stringify(join(root, "web/src/routes/admin/events/+page.svelte"))};
        export { load } from ${JSON.stringify(join(root, "web/src/routes/admin/events/+page.server.ts"))};
        export const renderEvents = data => render(Events, { props: { data } }).body;
      `,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "saved-nights-real-kit-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "saved-nights-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "saved-nights-fixture" }, () => ({
            contents: `export const env = globalThis[${JSON.stringify(envKey)}];`,
            loader: "js",
          }));
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
            contents: compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            }).js.code,
            loader: "js",
            resolveDir: dirname(path),
          }));
        },
      },
    ],
  });
  kit = (await import(pathToFileURL(outfile).href)) as typeof kit;
});
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>)[envKey];
});

function useEnv(bindings: Env) {
  for (const key of Object.keys(sharedEnv)) delete sharedEnv[key];
  Object.assign(sharedEnv, bindings);
}

/** Href of the sort link for one column, with entities decoded. */
function sortHref(html: string, label: string): string {
  const tags = html.match(/<a [^>]*>/g) ?? [];
  const tag = tags.find((candidate) => candidate.includes(`Sort by ${label}`));
  if (!tag) throw new Error(`No sort link found for ${label}`);
  const href = tag.match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!href) throw new Error(`No href on the ${label} sort link`);
  return href;
}

function strippedText(cell: string): string {
  // Token walk: skip each <...> tag without chained String.replace, so CodeQL
  // js/incomplete-multi-character-sanitization stays silent. Matches the old
  // /<[^>]*>/g strip: an unterminated "<" is kept literally.
  let stripped = "";
  let i = 0;
  while (i < cell.length) {
    if (cell[i] === "<") {
      const close = cell.indexOf(">", i + 1);
      if (close !== -1) {
        i = close + 1;
        continue;
      }
      stripped += "<";
      i += 1;
      continue;
    }
    const next = cell.indexOf("<", i);
    if (next === -1) {
      stripped += cell.slice(i);
      break;
    }
    stripped += cell.slice(i, next);
    i = next;
  }
  return stripped.replace(/\s+/g, " ").trim();
}

describe.skipIf(!process.env.DATABASE_URL)("saved-nights store search (live disposable DB)", () => {
  let fixture: MemberDataFixture;
  const keys = (params: Parameters<typeof listEvents>[1]) =>
    listEvents(fixture.db, params).then((rows) => rows.map((r) => r.eventKey));

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterAll(() => fixture?.dispose());
  beforeEach(() => fixture.reset());

  it("RED: finds a generically titled night by its saved game, case-insensitively", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "game-match",
      title: "Friday social",
      game: "Terraforming Mars",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "game-decoy",
      title: "Friday social planning",
      game: null,
    });
    for (const q of ["terraforming", "TERRAFORMING", "  Terraforming Mars  "]) {
      expect(await keys({ q, sort: "starts_at", order: "asc" })).toEqual(["game-match"]);
    }
  });

  it("RED: matches title OR game as a union without duplicating rows", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "or-both",
      title: "Chess club",
      game: "Chess",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "or-game",
      title: "Friday social",
      game: "Chess lessons",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "or-neither",
      title: "Go night",
      game: null,
    });
    expect(await keys({ q: "chess", sort: "starts_at", order: "asc" })).toEqual([
      "or-both",
      "or-game",
    ]);
  });

  it("RED: composes the game match inside the ANDed status/series/fill/RSVP predicates", async () => {
    const parent = await insertSavedNight(fixture.db, {
      eventKey: "filter-parent",
      title: "Series parent",
      game: "Other",
      recurrenceFrequency: "weekly",
    });
    const seed = async (eventKey: string, overrides: Partial<SavedNightSeed>) =>
      insertSavedNight(fixture.db, {
        eventKey,
        title: "Generic night",
        game: "FilterQuest",
        status: "published",
        capacity: 4,
        rsvpOpen: true,
        ...overrides,
      });
    const match = await seed("filter-match", {});
    await seed("filter-status", { status: "draft" });
    await seed("filter-series", { parentEventId: parent.id });
    const full = await seed("filter-fill", { capacity: 1 });
    await seed("filter-rsvp", { rsvpOpen: false });
    // One Going seat: the match has seats, the capacity-1 row is full.
    await fixture.db.insert(rsvps).values([
      { eventId: match.id, userId: "filter-member-1", status: "going" },
      { eventId: full.id, userId: "filter-member-2", status: "going" },
    ]);
    expect(
      await keys({
        q: "filterquest",
        status: "published",
        series: "standalone",
        fill: "has_seats",
        rsvp_open: "1",
      }),
    ).toEqual(["filter-match"]);
  });

  it("RED: matches Unicode game text case-insensitively", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "unicode-game",
      title: "Friday social",
      game: "Café Crosstalk",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "unicode-decoy",
      title: "Cafe night",
      game: null,
    });
    for (const q of ["café", "CAFÉ"]) {
      expect(await keys({ q, sort: "starts_at", order: "asc" })).toEqual(["unicode-game"]);
    }
  });

  it.each([
    ["100%", ["meta-percent"]],
    ["Raid_A", ["meta-underscore"]],
    ["Raid\\path", ["meta-backslash"]],
    ["%", ["meta-percent"]],
    ["_", ["meta-underscore"]],
    ["\\", ["meta-backslash"]],
  ])("RED: matches game metacharacter %j literally", async (q, expected) => {
    await fixture.reset();
    await insertSavedNight(fixture.db, {
      eventKey: "meta-percent",
      title: "Metachar night one",
      game: "Raid 100%",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "meta-underscore",
      title: "Metachar night two",
      game: "Raid_A",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "meta-backslash",
      title: "Metachar night three",
      game: "Raid\\path",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "meta-plain",
      title: "Metachar night four",
      game: "Raid night",
    });
    expect(await keys({ q, sort: "starts_at", order: "asc" })).toEqual(expected);
  });

  it("RED: strips NUL bytes before matching the saved game", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "nul-game",
      title: "Friday social",
      game: "Terraforming Mars",
    });
    expect(await keys({ q: "Te\u0000rraforming" })).toEqual(["nul-game"]);
  });

  it("RED: matches an HTML-shaped game as literal stored text", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "html-game",
      title: "Friday social",
      game: "<b>Go</b>",
    });
    expect(await keys({ q: "<b>go</b>" })).toEqual(["html-game"]);
  });

  it("RED: pages game matches with the 25+lookahead shape and deterministic ties", async () => {
    const expected: string[] = [];
    for (let i = 0; i < EVENT_PAGE_SIZE + 2; i++) {
      const eventKey = `paged-${String(i).padStart(2, "0")}`;
      expected.push(eventKey);
      await insertSavedNight(fixture.db, {
        eventKey,
        title: `Paged night ${eventKey}`,
        game: "Paged game",
        // Identical instants: ties must still order deterministically.
        startsAt: new Date("2026-11-01T20:00:00Z"),
        endsAt: new Date("2026-11-01T22:00:00Z"),
      });
    }
    const query = { q: "paged game", sort: "starts_at", order: "asc" } as const;
    const first = await keys(query);
    const second = await keys({ ...query, page: "2" });
    expect(first).toEqual(expected.slice(0, EVENT_PAGE_SIZE + 1));
    expect(second).toEqual(expected.slice(EVENT_PAGE_SIZE));
    expect([...first.slice(0, EVENT_PAGE_SIZE), ...second]).toEqual(expected);
    expect(await keys({ ...query, page: "3" })).toEqual([]);
  });

  it("RED: a game query issues the same single list read as a title query", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "reads-game",
      title: "Generic night",
      game: "ReadShape",
    });
    const { nonSensitiveRead } = await import("../src/member-reads");
    const spy = vi.mocked(nonSensitiveRead);
    spy.mockClear();
    expect(await keys({ q: "readshape" })).toEqual(["reads-game"]);
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["timeouts", "events", "going-counts"]);
  });

  it("CONTROL: title-only matches are preserved with games present", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "title-game",
      title: "Chess club open",
      game: "Chess",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "title-null",
      title: "Chess club closed",
      game: null,
    });
    await insertSavedNight(fixture.db, {
      eventKey: "title-other",
      title: "Go night",
      game: "Chess",
    });
    expect(await keys({ q: "chess club", sort: "starts_at", order: "asc" })).toEqual([
      "title-game",
      "title-null",
    ]);
  });

  it("CONTROL: null and blank games still match by title", async () => {
    for (const [eventKey, game] of [
      ["blank-null", null],
      ["blank-empty", ""],
      ["blank-spaces", "   "],
    ] as const) {
      await insertSavedNight(fixture.db, {
        eventKey,
        title: "Blank game night",
        game,
      });
    }
    expect(await keys({ q: "blank game" })).toEqual(["blank-null", "blank-empty", "blank-spaces"]);
  });

  it("CONTROL: an overlong query still falls back to absent, never truncated", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "long-a",
      title: "Long bound night",
      game: "BoundGame",
    });
    await insertSavedNight(fixture.db, {
      eventKey: "long-b",
      title: "Another night",
      game: null,
    });
    const unfiltered = await keys({});
    expect(unfiltered.sort()).toEqual(["long-a", "long-b"]);
    expect(await keys({ q: "x".repeat(129) })).toEqual(await keys({}));
    expect(await keys({ q: "x".repeat(128) })).toEqual([]);
  });

  it("CONTROL: title queries keep exactly the timeouts/list/counts read shape", async () => {
    await insertSavedNight(fixture.db, {
      eventKey: "reads-title",
      title: "ReadShape night",
      game: null,
    });
    const { nonSensitiveRead } = await import("../src/member-reads");
    const spy = vi.mocked(nonSensitiveRead);
    spy.mockClear();
    expect(await keys({ q: "readshape" })).toEqual(["reads-title"]);
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["timeouts", "events", "going-counts"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "saved-nights live inventory pages (Hono route + Kit loader)",
  () => {
    let fixture: MemberDataFixture;
    const store = createMemorySessionStore();
    let cookie = "";
    const app = () => adminApp({ sessionStore: store, db: fixture.db });
    const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(() => fixture?.dispose());
    beforeEach(async () => {
      await fixture.reset();
      cookie = await cookieFor(store, MODERATOR);
      await insertSavedNight(fixture.db, {
        eventKey: "live-game",
        title: "Friday social",
        game: "Terraforming Mars",
      });
      await insertSavedNight(fixture.db, {
        eventKey: "live-title",
        title: "Chess club open",
        game: null,
      });
      await insertSavedNight(fixture.db, {
        eventKey: "live-decoy",
        title: "Book club",
        game: "Scrabble",
      });
    });

    it("RED: GET /admin/events?q=<game> lists the saved night", async () => {
      const res = await app().request(
        "/events?q=terraforming",
        { headers: { cookie } },
        bindings(),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/admin/events/live-game"');
      expect(html).not.toContain('href="/admin/events/live-title"');
      expect(html).not.toContain('href="/admin/events/live-decoy"');
      expect(titleCellFor(html, "live-game")).toContain("Terraforming Mars");
    });

    it("CONTROL: title search and private/no-store responses are preserved", async () => {
      const res = await app().request("/events?q=chess", { headers: { cookie } }, bindings());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const html = await res.text();
      expect(html).toContain('href="/admin/events/live-title"');
      expect(html).not.toContain('href="/admin/events/live-game"');
      expect(html).not.toContain('href="/admin/events/live-decoy"');
    });

    it("RED: the Kit loader returns the game-matching rows", async () => {
      useEnv(bindings());
      const headers: Record<string, string> = {};
      const view = await kit.load({
        parent: async () => ({}),
        url: new URL(`${env.APP_URL}/admin/events?q=terraforming`),
        setHeaders: (next: Record<string, string>) => Object.assign(headers, next),
      });
      expect(view.rows.map((row) => row.eventKey)).toEqual(["live-game"]);
      expect(headers["cache-control"]).toBe("private, no-store");
    });

    it("CONTROL: the Kit loader keeps title matching and no-store headers", async () => {
      useEnv(bindings());
      const headers: Record<string, string> = {};
      const view = await kit.load({
        parent: async () => ({}),
        url: new URL(`${env.APP_URL}/admin/events?q=chess`),
        setHeaders: (next: Record<string, string>) => Object.assign(headers, next),
      });
      expect(view.rows.map((row) => row.eventKey)).toEqual(["live-title"]);
      expect(headers["cache-control"]).toBe("private, no-store");
    });
  },
);

describe("saved-nights Hono inventory render (executed EventsPage, no DB)", () => {
  const render = (
    rows: Parameters<typeof EventsPage>[0]["rows"],
    params: Parameters<typeof parseEventListQuery>[0],
    hasNext = false,
  ) => String(EventsPage({ rows, query: parseEventListQuery(params), hasNext }));

  it("RED: shows a nonblank saved game as secondary text in the Title cell", () => {
    const html = render(
      [savedNightRow("hono-game", { title: "Friday social", game: "Terraforming Mars" })],
      { q: "terraforming" },
    );
    const cell = titleCellFor(html, "hono-game");
    expect(cell).toContain('href="/admin/events/hono-game"');
    expect(cell).toContain("Friday social");
    expect(cell).toContain("Terraforming Mars");
  });

  it("RED: clarifies the Search field as a title-or-game search", () => {
    const html = render([savedNightRow("hono-label", { game: "Go" })], { q: "" });
    expect(searchFieldText(html).toLowerCase()).toContain("game");
  });

  it("RED: escapes an HTML-shaped game in the Title cell", () => {
    const html = render(
      [savedNightRow("hono-escape", { title: "Friday social", game: "<img src=x>" })],
      {},
    );
    const cell = titleCellFor(html, "hono-escape");
    expect(cell).toContain("&lt;img");
    expect(cell).not.toContain("<img");
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
  ] as const)(
    "CONTROL: a %s game adds no secondary text or placeholder to the Title cell",
    (_label, game) => {
      const html = render([savedNightRow("hono-blank", { title: "Friday social", game })], {});
      expect(strippedText(titleCellFor(html, "hono-blank"))).toBe("Friday social");
    },
  );

  it("CONTROL: search stays a native GET form with no page field, keyboard/no-JS intact", () => {
    const html = render([savedNightRow("hono-native")], { q: "go", page: "2" });
    const form = searchFormTag(html);
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/admin/events"');
    const input = searchInputTag(html);
    expect(input).toContain('name="q"');
    expect(input).toContain('type="search"');
    expect(input).toContain('value="go"');
    const field = html.match(/<form[\s\S]*?name="q"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(field).not.toContain('name="page"');
  });

  it("CONTROL: sort links preserve q and reset to page one; paging links preserve q", () => {
    const html = render([savedNightRow("hono-links")], { q: "go", page: "2" }, true);
    const titleSort = new URL(sortHref(html, "title"), env.APP_URL);
    expect(titleSort.searchParams.get("q")).toBe("go");
    expect(titleSort.searchParams.has("page")).toBe(false);
    const prev = new URL(pageHref(html, "prev")!, env.APP_URL);
    expect(prev.searchParams.get("q")).toBe("go");
    const next = new URL(pageHref(html, "next")!, env.APP_URL);
    expect(next.searchParams.get("q")).toBe("go");
    expect(next.searchParams.get("page")).toBe("3");
  });
});

describe("saved-nights Kit inventory (executed view model + compiled SSR, no DB)", () => {
  const viewFor = (
    rows: Parameters<typeof buildEventListView>[1],
    params: Parameters<typeof parseEventListQuery>[0],
  ) => buildEventListView(parseEventListQuery(params), rows);

  it("RED: serializes the saved game onto the Kit row", () => {
    expect(
      serializeEventListRow(savedNightRow("kit-row", { game: "Terraforming Mars" })),
    ).toMatchObject({ eventKey: "kit-row", game: "Terraforming Mars" });
  });

  it("RED: shows a nonblank saved game as secondary text in the Title cell", () => {
    const html = kit.renderEvents(
      viewFor([savedNightRow("kit-game", { title: "Friday social", game: "Terraforming Mars" })], {
        q: "terraforming",
      }) as unknown as Record<string, unknown>,
    );
    const cell = titleCellFor(html, "kit-game");
    expect(cell).toContain('href="/admin/events/kit-game"');
    expect(cell).toContain("Friday social");
    expect(cell).toContain("Terraforming Mars");
  });

  it("RED: clarifies the Search field as a title-or-game search", () => {
    const html = kit.renderEvents(
      viewFor([savedNightRow("kit-label", { game: "Go" })], {
        q: "",
      }) as unknown as Record<string, unknown>,
    );
    expect(searchFieldText(html).toLowerCase()).toContain("game");
  });

  it("RED: escapes an HTML-shaped game in the Title cell", () => {
    const html = kit.renderEvents(
      viewFor(
        [savedNightRow("kit-escape", { title: "Friday social", game: "<img src=x>" })],
        {},
      ) as unknown as Record<string, unknown>,
    );
    const cell = titleCellFor(html, "kit-escape");
    expect(cell).toContain("&lt;img");
    expect(cell).not.toContain("<img");
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
  ] as const)(
    "CONTROL: a %s game adds no secondary text or placeholder to the Title cell",
    (_label, game) => {
      const html = kit.renderEvents(
        viewFor([savedNightRow("kit-blank", { title: "Friday social", game })], {
          q: "",
        }) as unknown as Record<string, unknown>,
      );
      expect(strippedText(titleCellFor(html, "kit-blank"))).toBe("Friday social");
    },
  );

  it("CONTROL: search stays a native GET form with no page field, keyboard/no-JS intact", () => {
    const html = kit.renderEvents(
      viewFor([savedNightRow("kit-native")], {
        q: "go",
        page: "2",
      }) as unknown as Record<string, unknown>,
    );
    const form = searchFormTag(html);
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/admin/events"');
    const input = searchInputTag(html);
    expect(input).toContain('name="q"');
    expect(input).toContain('type="search"');
    expect(input).toContain('value="go"');
    const field = html.match(/<form[\s\S]*?name="q"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(field).not.toContain('name="page"');
  });

  it("CONTROL: sort links preserve q and reset to page one; paging links preserve q", () => {
    const rows = Array.from({ length: EVENT_PAGE_SIZE + 1 }, (_, i) =>
      savedNightRow(`kit-page-${i}`, { id: i + 1 }),
    );
    const html = kit.renderEvents(
      viewFor(rows, { q: "go", page: "2" }) as unknown as Record<string, unknown>,
    );
    const titleSort = new URL(sortHref(html, "title"), env.APP_URL);
    expect(titleSort.searchParams.get("q")).toBe("go");
    expect(titleSort.searchParams.has("page")).toBe(false);
    const prev = new URL(pageHref(html, "prev")!, env.APP_URL);
    expect(prev.searchParams.get("q")).toBe("go");
    const next = new URL(pageHref(html, "next")!, env.APP_URL);
    expect(next.searchParams.get("q")).toBe("go");
    expect(next.searchParams.get("page")).toBe("3");
  });
});

describe("saved-nights inventory guidance", () => {
  it("RED: the moderator guide documents title-or-game search, not title-only", () => {
    const guide = readFileSync(join(root, "docs/moderator-admin-guide.md"), "utf8");
    const eventsSection = guide.slice(guide.indexOf("## Create, edit and publish an event"));
    const step = eventsSection.slice(0, eventsSection.indexOf("2. Fill in the form"));
    const searchLine = step.split(/(?<=\.)\s+/).find((line) => line.includes("**Search**"));
    expect(searchLine, "events Search guidance line").toBeDefined();
    expect(searchLine!).not.toContain("title only");
    expect(searchLine!.toLowerCase()).toContain("game");
  });
});
