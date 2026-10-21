// route-inventory: GET /e/:key
// route-inventory: GET /e/:file{.+\.md}
// Acceptance: accessibility notes on the Kit detail twin and the Markdown alternate.
//
// Hono already renders the section (src/events/pages-detail.tsx): trimmed notes,
// `<h2 id="event-accessibility-heading">Accessibility</h2>`, after About, before
// the join pitch. The Kit resolver/shell and the `.md` builder drop the field
// although PublicEvent carries it. Failing-first tests pin the contract the
// Builder implements; tests marked PIN already pass and guard regressions.
//
// Builder contract (Builder must not edit this file):
// - Hono + Kit sections carry data-testid="event-accessibility".
// - KitEventDetailModel.accessibilityNotes: string | null, trimmed, null when blank.
// - MdEvent.accessibilityNotes?: string | null; mdEvent renders `## Accessibility`
//   after About, before the calendar links; the feed shape is unchanged.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { KitRequestSession } from "../src/kit-session";
import type { EventLink, EventNeighbors, PublicEvent } from "../src/events/reads";
import type { SuggestedEvent } from "../src/events/suggestions";
import {
  resolveKitEventDetail,
  type KitEventDetailModel,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import { MARKDOWN_MIME, mdEvent, type MdEvent } from "../src/ai-friendly/md";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const MD_APP_URL = "https://togetherweown.com";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MD_KEY = "01J0000000000000000000ABCD";
const SECRET = "test-session-secret-at-least-32-bytes-long";

const NOTES = "Step-free entrance; a quiet room is available.";
const PADDED_NOTES = `  ${NOTES}  \n`;
const HOSTILE_NOTES = '</script><script>alert("xss")</script>';
const MD_HOSTILE_NOTES = `${HOSTILE_NOTES}\n[details](https://x.example)\n\`\`\`\nABC`;

const ACCESSIBILITY_TESTID = "event-accessibility";
const ACCESSIBILITY_HEADING = '<h2 id="event-accessibility-heading">Accessibility</h2>';

// The Kit model gains this field; the cast keeps the suite typechecking while
// the resolver still drops it (undefined, failing the pins below).
type NotesModel = KitEventDetailModel & { accessibilityNotes: string | null };

function row(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
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
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

const GUEST: KitRequestSession = { status: "guest", session: null };
const kitEnv = { APP_URL } as unknown as Env;

function fakeStore(event: PublicEvent): KitEventDetailStore {
  const neighbors: EventNeighbors = { previous: null, next: null };
  const related: EventLink[] = [];
  const suggestions: SuggestedEvent[] = [];
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: async () => neighbors,
    relatedFn: async () => related,
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => suggestions,
  };
}

async function resolveOkModel(
  notes: string | null,
  description: string | null = "Bring a friend & a board.",
): Promise<NotesModel> {
  const event = {
    ...row({ description, accessibilityNotes: notes }),
    goingCount: 3,
  } as PublicEvent;
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: `/e/${KEY}`,
    env: kitEnv,
    session: GUEST,
    joinResult: null,
    setHeaders: () => {},
    store: fakeStore(event),
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.model as NotesModel;
}

// The real Kit presentation, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild (same shape as the kit-event-detail
// parity bundle).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitDetailBundle(): Promise<{
  renderDetail: (model: Record<string, unknown>) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-accessibility-notes-"));
  try {
    const entry = join(scratch, "kit-accessibility-notes-entry.mjs");
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
    const outfile = join(scratch, "kit-accessibility-notes.mjs");
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
          name: "kit-accessibility-notes-svelte-ssr",
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
    const { renderDetail } = (await import(pathToFileURL(outfile).href)) as {
      renderDetail: (model: Record<string, unknown>) => string;
    };
    return { renderDetail };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function kitGuestHtml(
  notes: string | null,
  description: string | null = "Bring a friend & a board.",
): Promise<string> {
  const model = await resolveOkModel(notes, description);
  const { renderDetail } = await buildKitDetailBundle();
  return renderDetail(model as unknown as Record<string, unknown>);
}

// The served Hono page behind a hermetic pg-proxy database (same shape as the
// kit-event-detail live-contract fixture): one published row, guest viewer.
async function honoGuestHtml(
  notes: string | null,
  description: string | null = "Bring a friend & a board.",
): Promise<string> {
  const base = row({ description, accessibilityNotes: notes });
  const columns = Object.keys(getTableColumns(events)) as (keyof ReturnType<typeof row>)[];
  const toRow = (r: ReturnType<typeof row>) =>
    columns.map((column) =>
      r[column] instanceof Date ? (r[column] as Date).toISOString() : r[column],
    );
  const db = drizzle(async (sql, params) => {
    if (sql.includes("row_number()")) return { rows: [] };
    if (sql.includes('from "rsvps"') && sql.includes("count(")) {
      return { rows: [[base.id, 0]] };
    }
    if (sql.includes('"users"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes('"event_key" =')) {
      const wanted = (params as unknown[]).includes(base.eventKey);
      return { rows: wanted ? [toRow(base)] : [] };
    }
    return { rows: [] };
  });
  Object.assign(db, {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  });
  const sessionStore = createMemorySessionStore();
  const honoEnv = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: sessionStore,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  const res = await app.request(`/e/${KEY}`, {}, honoEnv);
  expect(res.status).toBe(200);
  return res.text();
}

const mdRow = (o: Partial<MdEvent> = {}): MdEvent => ({
  eventKey: MD_KEY,
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
  ...o,
});

// MdEvent gains the optional field; Object.assign keeps the suite typechecking
// while the builder still ignores it.
const mdRowWithNotes = (notes: string | null, o: Partial<MdEvent> = {}): MdEvent =>
  Object.assign(mdRow(o), { accessibilityNotes: notes });

// Byte-stability pin: the exact no-notes detail output the Builder must not move.
const NO_NOTES_GOLDEN = `# Friday night Helldivers

> Canonical page: https://togetherweown.com/e/01J0000000000000000000ABCD · Markdown alternate: https://togetherweown.com/e/01J0000000000000000000ABCD.md

- Status: scheduled
- Starts: Wednesday, 15 July 2026 at 19:00 GMT+01:00 (Europe/London)
- Ends: Wednesday, 15 July 2026 at 21:00 GMT+01:00 (Europe/London)
- Game: Helldivers
- Where: Voice: General
- Lineup: 7 going

## About this event

Bring stims.

[Add to calendar (.ics)](https://togetherweown.com/events/01J0000000000000000000ABCD.ics) · [See upcoming events](https://togetherweown.com/events)
`;

describe("kit detail resolver: accessibility notes passthrough", () => {
  it("carries trimmed notes onto the model", async () => {
    const model = await resolveOkModel(PADDED_NOTES);
    expect(model.accessibilityNotes).toBe(NOTES);
  });

  it("nulls the model field when the event has no notes", async () => {
    const model = await resolveOkModel(null);
    expect(model.accessibilityNotes).toBeNull();
  });

  it("nulls the model field when notes are blank", async () => {
    const model = await resolveOkModel("  \n\t  ");
    expect(model.accessibilityNotes).toBeNull();
  });
});

describe("kit detail presentation: accessibility section", () => {
  it("renders the section with the pinned testid, heading and trimmed notes", async () => {
    const html = await kitGuestHtml(PADDED_NOTES);
    expect(html).toContain(`data-testid="${ACCESSIBILITY_TESTID}"`);
    expect(html).toContain(ACCESSIBILITY_HEADING);
    expect(html).toContain('aria-labelledby="event-accessibility-heading"');
    expect(html).toContain(NOTES);
    expect(html).not.toContain(PADDED_NOTES);
  });

  it("orders the section after About and before the join pitch", async () => {
    const html = await kitGuestHtml(PADDED_NOTES);
    const about = html.indexOf("About this event");
    const notes = html.indexOf(`data-testid="${ACCESSIBILITY_TESTID}"`);
    const pitch = html.indexOf('data-testid="event-join-pitch"');
    expect(about).toBeGreaterThanOrEqual(0);
    expect(notes).toBeGreaterThanOrEqual(0);
    expect(pitch).toBeGreaterThanOrEqual(0);
    expect(about).toBeLessThan(notes);
    expect(notes).toBeLessThan(pitch);
  });

  it("renders the section without About when the description is null", async () => {
    const html = await kitGuestHtml(NOTES, null);
    expect(html).not.toContain("event-description-heading");
    expect(html).toContain(`data-testid="${ACCESSIBILITY_TESTID}"`);
    expect(html).toContain(NOTES);
    expect(html.indexOf(`data-testid="${ACCESSIBILITY_TESTID}"`)).toBeLessThan(
      html.indexOf('data-testid="event-join-pitch"'),
    );
  });

  it("PIN: renders no section when notes are absent", async () => {
    const html = await kitGuestHtml(null);
    expect(html).not.toContain("event-accessibility");
  });

  it("escapes hostile notes", async () => {
    const html = await kitGuestHtml(HOSTILE_NOTES);
    expect(html).toContain(`data-testid="${ACCESSIBILITY_TESTID}"`);
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("&lt;/script>");
  });
});

describe("hono detail twin: accessibility section", () => {
  it("carries the same pinned testid, heading and trimmed notes", async () => {
    const html = await honoGuestHtml(PADDED_NOTES);
    expect(html).toContain(`data-testid="${ACCESSIBILITY_TESTID}"`);
    expect(html).toContain(ACCESSIBILITY_HEADING);
    expect(html).toContain(NOTES);
    expect(html).not.toContain(PADDED_NOTES);
  });

  it("PIN: orders the section after About and before the join pitch", async () => {
    const html = await honoGuestHtml(NOTES);
    const about = html.indexOf("About this event");
    const notes = html.indexOf("event-accessibility-heading");
    const pitch = html.indexOf('data-testid="event-join-pitch"');
    expect(about).toBeGreaterThanOrEqual(0);
    expect(notes).toBeGreaterThanOrEqual(0);
    expect(pitch).toBeGreaterThanOrEqual(0);
    expect(about).toBeLessThan(notes);
    expect(notes).toBeLessThan(pitch);
  });

  it("PIN: renders no section when notes are absent", async () => {
    const html = await honoGuestHtml(null);
    expect(html).not.toContain("event-accessibility");
  });

  it("PIN: escapes hostile notes", async () => {
    const html = await honoGuestHtml(HOSTILE_NOTES);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("twin parity: accessibility section", () => {
  it("both renderers share heading markup, testid and order", async () => {
    const [kit, hono] = await Promise.all([
      kitGuestHtml(PADDED_NOTES),
      honoGuestHtml(PADDED_NOTES),
    ]);
    for (const html of [kit, hono]) {
      expect(html).toContain(ACCESSIBILITY_HEADING);
      expect(html).toContain(`data-testid="${ACCESSIBILITY_TESTID}"`);
      const about = html.indexOf("About this event");
      const notes = html.indexOf(`data-testid="${ACCESSIBILITY_TESTID}"`);
      const pitch = html.indexOf('data-testid="event-join-pitch"');
      expect(about).toBeLessThan(notes);
      expect(notes).toBeLessThan(pitch);
    }
  });
});

describe("event .md builder: accessibility section", () => {
  it("carries notes under ## Accessibility after About, before the calendar links", () => {
    const body = mdEvent(MD_APP_URL, mdRowWithNotes(NOTES));
    expect(body).toContain("## Accessibility");
    expect(body).toContain(NOTES);
    const about = body.indexOf("## About this event");
    const notes = body.indexOf("## Accessibility");
    const links = body.indexOf("[Add to calendar (.ics)]");
    expect(about).toBeGreaterThanOrEqual(0);
    expect(notes).toBeGreaterThanOrEqual(0);
    expect(links).toBeGreaterThanOrEqual(0);
    expect(about).toBeLessThan(notes);
    expect(notes).toBeLessThan(links);
  });

  it("renders Accessibility without About when the description is null", () => {
    const body = mdEvent(MD_APP_URL, mdRowWithNotes(NOTES, { description: null }));
    expect(body).not.toContain("## About this event");
    expect(body).toContain("## Accessibility");
    expect(body).toContain(NOTES);
    expect(body.indexOf("## Accessibility")).toBeLessThan(body.indexOf("[Add to calendar (.ics)]"));
  });

  it("PIN: leaves no-notes output byte-stable", () => {
    const body = mdEvent(MD_APP_URL, mdRow());
    expect(body).toBe(NO_NOTES_GOLDEN);
    expect(body).not.toContain("Accessibility");
  });

  it("PIN: treats blank notes as no notes", () => {
    expect(mdEvent(MD_APP_URL, mdRowWithNotes("  \n "))).toBe(mdEvent(MD_APP_URL, mdRow()));
  });

  it("trims padded notes", () => {
    const body = mdEvent(MD_APP_URL, mdRowWithNotes(PADDED_NOTES));
    expect(body).toContain("## Accessibility");
    expect(body).toContain(NOTES);
    expect(body).not.toContain(PADDED_NOTES);
  });

  it("escapes hostile notes without swallowing the calendar links", () => {
    const body = mdEvent(MD_APP_URL, mdRowWithNotes(MD_HOSTILE_NOTES));
    expect(body).toContain("## Accessibility");
    expect(body).toContain("\\</script>\\<script>alert(\"xss\")\\</script>");
    expect(body).toContain("\\[details\\]");
    expect(body).toContain("\\```");
    expect(body).toContain("[Add to calendar (.ics)]");
    expect(body).toContain("[See upcoming events]");
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "event .md route: accessibility notes (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    const baseEnv = {
      APP_URL: MD_APP_URL,
      DISCORD_INVITE_URL: "https://discord.gg/test-invite",
      DISCORD_GUILD_ID: "123",
      SESSION_SECRET: SECRET,
      RULES_LAST_UPDATED: "2026-09-01",
    } as unknown as Env;
    const tReq = (path: string) =>
      app.request(path, {}, {
        ...baseEnv,
        get ADMIN_DB() {
          return db;
        },
      } as unknown as Env);
    const ins = (notes: string | null) =>
      db.insert(events).values({
        eventKey: MD_KEY,
        title: "Friday night Helldivers",
        game: "Helldivers",
        description: "Bring stims.",
        accessibilityNotes: notes,
        startsAt: new Date("2099-01-01T00:00:00Z"),
        endsAt: new Date("2099-01-02T00:00:00Z"),
        timezone: "UTC",
        location: "Voice: General",
        status: "published",
      } as never);

    beforeEach(async () => {
      await db.delete(events);
    });

    it("published .md carries the notes section", async () => {
      await ins(NOTES);
      const res = await tReq(`/e/${MD_KEY}.md`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
      const body = await res.text();
      expect(body).toContain("## Accessibility");
      expect(body).toContain(NOTES);
    });

    it("PIN: published .md without notes has no Accessibility section", async () => {
      await ins(null);
      const res = await tReq(`/e/${MD_KEY}.md`);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("Accessibility");
    });
  },
);
