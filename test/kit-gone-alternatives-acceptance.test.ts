// route-inventory: GET /e/:key
// Acceptance-owned: the paired builder consumes this file unchanged.
// Kit-only alternatives must not change the served Hono 410 response.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { EventLink, PublicEvent } from "../src/events/reads";
import { resolveEventState, type EventStateStore } from "../src/kit-event-states";
import app from "./app";
import { visibleText } from "./helpers/event-ongoing-acceptance";
import { attribute, document, tag, testId } from "./helpers/schedule-search-context-acceptance";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIRST_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAC";
const SECOND_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAD";
const INSTANTS = ["2030-02-01T19:15:23.456Z", "2030-07-01T00:05:06.789Z"];

function cancelledRow(): typeof events.$inferSelect {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
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
    eventKey: FIRST_KEY,
    title: "Chess finals",
    startsAt: new Date("2030-02-01T14:15:23.456-05:00"),
    endsAt: new Date("2030-02-01T16:15:23.456-05:00"),
    timezone: "America/New_York",
    location: "The lobby",
    game: null,
    rsvpOpen: true,
  },
  {
    id: 10,
    eventKey: SECOND_KEY,
    title: "Summer chess",
    startsAt: new Date("2030-07-01T09:05:06.789+09:00"),
    endsAt: new Date("2030-07-01T11:05:06.789+09:00"),
    timezone: "Asia/Tokyo",
    location: null,
    game: null,
    rsvpOpen: true,
  },
];

async function resolveState(related: EventLink[] = RELATED, missing = false) {
  const store: EventStateStore = {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () =>
      missing ? null : ({ ...cancelledRow(), goingCount: 3 } as PublicEvent),
    relatedFn: async () => related,
    suggestionsFn: async () => [
      {
        key: FIRST_KEY,
        title: "Chess finals",
        startsAt: new Date("2030-02-01T19:15:23.456Z"),
        location: "The lobby",
      },
    ],
  };
  return resolveEventState({
    key: KEY,
    path: `/e/${KEY}`,
    search: "",
    env: { APP_URL } as Env,
    setHeaders: () => {},
    store,
  });
}

async function goneModel(related: EventLink[] = RELATED) {
  const outcome = await resolveState(related);
  expect(outcome.kind).toBe("gone");
  if (outcome.kind !== "gone") throw new Error("fixture did not resolve to gone");
  expect(outcome.status).toBe(410);
  return outcome.model;
}

async function buildPresentations(): Promise<{
  gone: (model: unknown) => string;
  missing: (model: unknown) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "gone-alternatives-",
    ),
  );
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "presentations.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Gone from ${JSON.stringify(join(worktree, "web/src/lib/EventGone.svelte"))};
import Missing from ${JSON.stringify(join(worktree, "web/src/lib/EventMissing.svelte"))};
export const gone = model => render(Gone, { props: { model } }).body;
export const missing = model => render(Missing, { props: { model } }).body;
`,
    );
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      tsconfigRaw: { compilerOptions: {} },
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": join(worktree, "web/src/lib") },
      plugins: [
        {
          name: "gone-alternatives-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const { js } = compile(readFileSync(args.path, "utf8"), {
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
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function honoGone() {
  const row = cancelledRow();
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) {
      return sql.includes("count(*)") ? { rows: [[row.id, 3]] } : { rows: [] };
    }
    if (sql.includes('"event_key" =') && params.includes(KEY)) {
      return {
        rows: [
          columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
        ],
      };
    }
    return { rows: [] };
  });
  return app.request(`/e/${KEY}`, {}, {
    APP_URL: `${APP_URL}/`,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env);
}

function links(page: ReturnType<typeof document>, testid: string) {
  return testId(page, testid)
    .filter((node) => node.tagName === "a")
    .map((link) => ({
      href: attribute(link, "href"),
      text: visibleText(link),
    }));
}

describe("Kit gone alternatives acceptance", () => {
  let render: Awaited<ReturnType<typeof buildPresentations>>;
  let model: Awaited<ReturnType<typeof goneModel>>;
  let page: ReturnType<typeof document>;

  beforeAll(async () => {
    // No fixture may fall through to a network dependency.
    vi.stubGlobal("fetch", () => {
      throw new Error("unexpected fixture network request");
    });
    render = await buildPresentations();
    model = await goneModel();
    // A complete renderer input isolates presentation defects from mapping defects.
    page = document(
      render.gone({
        ...model,
        related: model.related.map((alternative, index) => ({
          ...alternative,
          datetime: INSTANTS[index],
        })),
      }),
    );
  });

  afterAll(() => vi.unstubAllGlobals());

  it("preserves each alternative's full machine instant in the resolved model", () => {
    expect(model.related).toMatchObject([
      { key: FIRST_KEY, title: "Chess finals", location: "The lobby", datetime: INSTANTS[0] },
      { key: SECOND_KEY, title: "Summer chess", location: null, datetime: INSTANTS[1] },
    ]);
  });

  it("renders each alternative's machine instant on its own time element", () => {
    const items = tag(page, "li");
    for (const [key, instant] of [
      [FIRST_KEY, INSTANTS[0]],
      [SECOND_KEY, INSTANTS[1]],
    ]) {
      const item = items.find((candidate) =>
        tag(candidate, "a").some((link) => attribute(link, "href") === `/e/${key}`),
      );
      expect(item, `alternative ${key} must be a list item`).toBeDefined();
      const [time] = tag(item!, "time");
      expect(time, `alternative ${key} must show its time`).toBeDefined();
      expect(attribute(time!, "datetime")).toBe(instant);
      expect(visibleText(time!)).not.toBe("");
    }
  });

  it("exposes stable per-link testids without replacing the alternative destinations", () => {
    expect(links(page, "event-cancelled-alternative")).toEqual([
      { href: `/e/${FIRST_KEY}`, text: "Chess finals" },
      { href: `/e/${SECOND_KEY}`, text: "Summer chess" },
    ]);
    expect(testId(page, "event-cancelled-alternatives").length).toBeGreaterThan(0);
  });

  it("associates the alternatives section with a visible second-level heading", () => {
    const section = tag(page, "section").find((candidate) =>
      tag(candidate, "a").some((link) => attribute(link, "href") === `/e/${FIRST_KEY}`),
    );
    expect(section, "alternatives need a section").toBeDefined();
    const labels =
      attribute(section!, "aria-labelledby")
        ?.split(/[\t\n\f\r ]+/)
        .filter(Boolean) ?? [];
    const heading = tag(section!, "h2").find((candidate) =>
      labels.includes(attribute(candidate, "id") ?? ""),
    );
    expect(heading, "aria-labelledby must reference the alternatives h2").toBeDefined();
    expect(visibleText(heading!)).not.toBe("");
    const list = tag(section!, "ul").find(
      (candidate) => attribute(candidate, "data-testid") === "event-cancelled-alternatives",
    );
    expect(list).toBeDefined();
    expect(tag(list!, "a").map((link) => attribute(link, "href"))).toEqual([
      `/e/${FIRST_KEY}`,
      `/e/${SECOND_KEY}`,
    ]);
  });

  it("keeps the empty 410 fallback usable without a phantom alternatives section", async () => {
    const empty = document(render.gone(await goneModel([])));
    expect(links(empty, "event-cancelled-alternative")).toEqual([]);
    expect(testId(empty, "event-cancelled-alternatives")).toHaveLength(0);
    expect(links(empty, "event-cancelled-ics").map((link) => link.href)).toContain(
      `/events/${KEY}.ics`,
    );
    expect(tag(empty, "a").map((link) => attribute(link, "href"))).toContain("/events");
  });

  it("keeps missing suggestions' existing link and datetime contract", async () => {
    const outcome = await resolveState([], true);
    expect(outcome.kind).toBe("missing");
    if (outcome.kind !== "missing") throw new Error("fixture did not resolve to missing");
    expect(outcome.status).toBe(404);
    const missing = document(render.missing(outcome.model));
    expect(links(missing, "error-event-suggestion")).toEqual([
      { href: `/e/${FIRST_KEY}`, text: "Chess finals" },
    ]);
    const [suggestions] = testId(missing, "error-event-suggestions");
    expect(suggestions).toBeDefined();
    expect(attribute(suggestions!, "aria-labelledby")).toBe("error-events-heading");
    const item = tag(suggestions!, "li").find((candidate) =>
      testId(candidate, "error-event-suggestion").some((link) => link.tagName === "a"),
    );
    expect(item).toBeDefined();
    expect(tag(item!, "time").map((time) => attribute(time, "datetime"))).toContain(INSTANTS[0]);
  });

  it("pins the served Hono 410 bytes and headers unchanged", async () => {
    const response = await honoGone();
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Re-captured after combining the Ember Hours font/theme chrome with
    // Logo/Icon 1's header lockup, favicon and og:image card, then after the
    // Mona Sans preload moved to mona-sans-latin-wght.woff2 (the only byte
    // change: renaming it back reproduces the previous pin). The gone-page
    // content and response headers retain their existing contract.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "f8b21e6394dd0a8ed4d494d6b055995d9162f5e041d7ed9d9bce7ef120c028cc",
    );
  });

  it("keeps the shared gone core while only Kit extends the alternatives surface", async () => {
    const response = await honoGone();
    expect(response.status).toBe(410);
    const honoPage = document(await response.text());
    for (const gonePage of [honoPage, page]) {
      expect(testId(gonePage, "event-cancelled").map(visibleText)).toContain("Cancelled");
      expect(tag(gonePage, "h1").map(visibleText)).toContain("Chess night");
      expect(tag(gonePage, "a").map(visibleText)).toContain("See upcoming events");
    }
    expect(visibleText(honoPage)).not.toContain("Chess finals");
    expect(testId(honoPage, "event-cancelled-alternative")).toHaveLength(0);
    expect(visibleText(page)).toContain("Chess finals");
    expect(links(page, "event-cancelled-alternative")).toHaveLength(2);
  });
});
