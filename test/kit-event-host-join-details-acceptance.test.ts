// route-inventory: GET /e/:key
// Acceptance contract for H4: host and joining details carried to Kit detail.
//
// ACCEPTANCE-OWNED: the paired Builder builds on this branch and never edits
// this file; corrections return to the Test Author. RED at base: the Hono
// twins (section A) pass and pin the shipped contract, while every Kit leg
// (sections B-D) fails because KitEventDetailModel carries no organizer/join
// fields and EventDetail.svelte renders no host/joining sections.
//
// Model contract the carry-over implements (camelCase, matching the existing
// Kit model style alongside eventKey/shareDescription/googleCalendarUrl):
//   organizerName: string | null — verified host display name; null when unset.
//   joinUrl: string | null — public joining link; null when unset.
//   joinInstructions: string | null — joining instructions; null when unset.
// The resolver maps them from the PublicEvent row on every ok outcome; the
// view renders the Hono twin's sections, testids, copy and gates verbatim:
// "Hosted by" + event-organizer; "How to join" + event-join-details /
// event-public-join-link / event-join-instructions; published rows linkify the
// URL ("Open the public joining link"), draft rows print it as plain text
// ("Public joining link: ..."); past rows keep the organizer but drop the
// join section; absent fields render nothing (the current Kit page preserved).
//
// Scheme validation lives at moderator entry (isPublicJoinUrl, pinned by
// test/event-verified-host-join-details-acceptance.test.ts) and is unchanged
// here; these render fixtures pin escaping plus structural parity for
// overlong/malformed values IF stored, never a new render-time link rule.
// The Accessibility section is explicitly excluded (open PR #1518 owns it).
// Renderer escaping differs cosmetically (Hono emits &quot;/&gt; in text,
// Svelte escapes & and < only), so hostile-text pins assert the shared &lt;
// prefix plus raw-markup absence on both renderers, never byte identity.
//
// Hermetic throughout: Hono legs run through the real route on a pg-proxy
// fixture, Kit legs through the framework-free resolver plus the real
// EventDetail.svelte SSR-compiled with the web workspace's own compiler.
// Local fixtures only; no database, no network, no staging/prod.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { beforeAll, describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  resolveKitEventDetail,
  type KitEventDetailModel,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import type {
  EventAttendee,
  EventLink,
  EventNeighbors,
  PublicEvent,
  ViewerRsvp,
} from "../src/events/reads";
import type { SuggestedEvent } from "../src/events/suggestions";
import app from "./app";

/** H4 model contract: the exact fields the carry-over adds to KitEventDetailModel. */
interface KitEventHostJoinFields {
  organizerName: string | null;
  joinUrl: string | null;
  joinInstructions: string | null;
}

/** Resolver-model access that typechecks at base (fields absent) and after the fix. */
type ModelWithHostJoin = KitEventDetailModel & Partial<KitEventHostJoinFields>;

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MOD_ID = "100000000000000002";
const PATH = `/e/${KEY}`;
const START = new Date("2030-01-10T20:00:00Z");

const ORGANIZER = "Riley Okafor";
const JOIN_URL = "https://meet.example.test/room-42";
const JOIN_INSTRUCTIONS = "Use the public lobby; doors open at seven.";
const HOSTILE_ORGANIZER = 'Riley <img src=x onerror="alert(1)"> & friends';
const HOSTILE_INSTRUCTIONS = "Lobby <b>rules</b> & rota";

// Hono legs: the real detail route on a pg-proxy fixture (same shape as the
// shipped host/join acceptance suite); no database, no network.
function honoFixture(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: START,
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
    createdAt: START,
    updatedAt: START,
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    ...over,
  };
  const row: typeof events.$inferSelect = values as typeof events.$inferSelect;
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"') && sql.includes("count(*)")) {
      return { rows: [[row.id, 3]] };
    }
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes('"event_key" =')) {
      return {
        rows: [
          columns.map((key) => (row[key] instanceof Date ? row[key]!.toISOString() : row[key])),
        ],
      };
    }
    return { rows: [] };
  });
  Object.assign(db, {
    transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
  });
  const sessions = createMemorySessionStore();
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET,
    SESSION_STORE: sessions,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    row,
    env,
    async cookie(moderator = false) {
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: "100000000000000001",
        username: "member",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    },
    request: (path = PATH, cookie?: string) =>
      app.request(path, cookie ? { headers: { cookie } } : {}, env),
  };
}

// Kit legs: in-memory row + hermetic store behind the same seams the Kit load binds.
function kitRow(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: START,
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
    createdAt: START,
    updatedAt: START,
    ...over,
  };
}

const NEIGHBORS: EventNeighbors = {
  previous: null,
  next: {
    id: 9,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    title: "Chess finals",
    startsAt: new Date("2030-02-01T19:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
  },
};

const RELATED: EventLink[] = [NEIGHBORS.next!];

const ATTENDEES: EventAttendee[] = [
  { id: "100000000000000003", name: "ann" },
  { id: "100000000000000004", name: "bob" },
];

const ANSWER: ViewerRsvp = { status: "going", syncedToDiscordAt: null };

const SUGGESTIONS: SuggestedEvent[] = [
  {
    key: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
    title: "Game night",
    startsAt: new Date("2030-03-01T19:00:00Z"),
    location: "Voice channel",
  },
];

const GUEST: KitRequestSession = { status: "guest", session: null };
const moderatorSession = (): KitRequestSession => ({
  status: "authenticated",
  session: { userId: MOD_ID, username: "mod", avatar: null, member: true, moderator: true },
});

function fakeStore(over: Partial<{ event: PublicEvent | null }> = {}): KitEventDetailStore {
  const event = { ...kitRow(), goingCount: 3, goingOccupancy: 3 } as PublicEvent;
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => (over.event === undefined ? event : over.event),
    neighborsFn: async () => NEIGHBORS,
    relatedFn: async () => RELATED,
    attendeesFn: async () => ATTENDEES,
    viewerRsvpFn: async () => ANSWER,
    waitlistFn: async () => null,
    suggestionsFn: async () => SUGGESTIONS,
  };
}

const kitEnv = { APP_URL } as unknown as Env;

async function resolveOk(
  over: Partial<typeof events.$inferSelect>,
  session: KitRequestSession = GUEST,
): Promise<KitEventDetailModel> {
  const event = { ...kitRow(over), goingCount: 3, goingOccupancy: 3 } as PublicEvent;
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: PATH,
    env: kitEnv,
    session,
    joinResult: null,
    setHeaders: () => {},
    store: fakeStore({ event }),
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.model;
}

/** Overlay the H4 model contract onto a resolved model: the resolver legs pin
 * that the carry-over maps these itself (so the overlay matches the resolved
 * values after the fix); the presentation legs isolate the view. */
function withHostJoin(
  model: Record<string, unknown>,
  fields: KitEventHostJoinFields,
): Record<string, unknown> {
  return { ...model, ...fields };
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
// svelte/compiler and bundled by esbuild (#lib/* resolves through the web alias).
async function buildKitEventDetailBundle(): Promise<{
  renderDetail: (model: Record<string, unknown>) => string;
}> {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-host-join-detail-"));
  try {
    const entry = join(scratch, "kit-host-join-detail-entry.mjs");
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
    const outfile = join(scratch, "kit-host-join-detail.mjs");
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
          name: "kit-host-join-detail-svelte-ssr",
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

let renderDetail: (model: Record<string, unknown>) => string;

beforeAll(async () => {
  renderDetail = (await buildKitEventDetailBundle()).renderDetail;
}, 60000);

describe("H4 host/join acceptance: Hono twins (pinned, green at base)", () => {
  it("published detail renders the host and joining sections", async () => {
    const html = await (
      await honoFixture({
        organizer_name: ORGANIZER,
        join_url: JOIN_URL,
        join_instructions: JOIN_INSTRUCTIONS,
      }).request()
    ).text();
    expect(html).toContain("Hosted by");
    expect(html).toContain(`data-testid="event-organizer">${ORGANIZER}`);
    expect(html).toContain('data-testid="event-join-details"');
    expect(html).toContain('<h2 id="event-join-details-heading">How to join</h2>');
    expect(html).toContain('data-testid="event-public-join-link"');
    expect(html).toContain("Open the public joining link");
    expect(html).toContain(`href="${JOIN_URL}"`);
    expect(html).toContain(`data-testid="event-join-instructions">${JOIN_INSTRUCTIONS}`);
  });

  it("detail without host/join fields renders no host or joining sections", async () => {
    const html = await (await honoFixture().request()).text();
    expect(html).toContain('data-testid="event-venue">The lobby');
    expect(html).not.toContain('data-testid="event-organizer"');
    expect(html).not.toContain('data-testid="event-join-details"');
    expect(html).not.toContain('data-testid="event-public-join-link"');
    expect(html).not.toContain('data-testid="event-join-instructions"');
  });

  it("draft shows the organizer and instructions but no public link to moderators", async () => {
    const source = honoFixture({
      status: "draft",
      organizer_name: "Draft organizer",
      join_url: "https://meet.example.test/draft-room",
      join_instructions: "Draft instructions",
    });
    expect((await source.request()).status).toBe(403);
    const response = await source.request(PATH, await source.cookie(true));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-testid="event-draft">Draft');
    expect(html).toContain('data-testid="event-organizer">Draft organizer');
    expect(html).toContain('data-testid="event-join-details"');
    expect(html).toContain("Public joining link: https://meet.example.test/draft-room");
    expect(html).not.toContain('data-testid="event-public-join-link"');
    expect(html).toContain('data-testid="event-join-instructions">Draft instructions');
  });

  it("past detail keeps the organizer but drops the join section", async () => {
    const html = await (
      await honoFixture({
        status: "past",
        organizer_name: "Past organizer",
        join_url: "https://meet.example.test/past-room",
        join_instructions: "Past instructions",
      }).request()
    ).text();
    expect(html).toContain('data-testid="event-organizer">Past organizer');
    expect(html).not.toContain('data-testid="event-join-details"');
    expect(html).not.toContain('data-testid="event-public-join-link"');
    expect(html).not.toContain('data-testid="event-join-instructions"');
  });

  it("escapes hostile host and joining text", async () => {
    const html = await (
      await honoFixture({
        organizer_name: HOSTILE_ORGANIZER,
        join_url: JOIN_URL,
        join_instructions: HOSTILE_INSTRUCTIONS,
      }).request()
    ).text();
    expect(html).toContain('data-testid="event-organizer"');
    expect(html).toContain("Riley &lt;img");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Lobby &lt;b");
    expect(html).not.toContain("<b>rules</b>");
    expect(html).toContain("&amp; friends");
  });

  it("renders overlong and malformed joining values safely when stored", async () => {
    const longOrganizer = "O".repeat(501);
    const longInstructions = "I".repeat(5001);
    const html = await (
      await honoFixture({
        organizer_name: longOrganizer,
        join_url: "https://",
        join_instructions: longInstructions,
      }).request()
    ).text();
    // Entry would 422 these (pinned by the shipped host/join suite); the
    // render carries stored values through, which the Kit twin must match.
    expect(html).toContain('data-testid="event-join-details"');
    expect(html).toContain('data-testid="event-public-join-link"');
    expect(html).toContain('href="https://"');
    expect(html).toContain(longOrganizer);
    expect(html).toContain(longInstructions.slice(0, 100));
  });

  it("attribute-escapes a hostile joining link", async () => {
    const html = await (
      await honoFixture({
        organizer_name: ORGANIZER,
        join_url: 'https://meet.example.test/"onmouseover="alert(1)',
        join_instructions: null,
      }).request()
    ).text();
    expect(html).toContain('data-testid="event-public-join-link"');
    expect(html).not.toContain('"onmouseover="');
  });
});

describe("H4 host/join acceptance: Kit resolver legs (RED at base)", () => {
  it("carries the organizer and joining fields for published events", async () => {
    const model = (await resolveOk({
      organizer_name: ORGANIZER,
      join_url: JOIN_URL,
      join_instructions: JOIN_INSTRUCTIONS,
    })) as ModelWithHostJoin;
    expect(model.organizerName).toBe(ORGANIZER);
    expect(model.joinUrl).toBe(JOIN_URL);
    expect(model.joinInstructions).toBe(JOIN_INSTRUCTIONS);
  });

  it("carries the organizer and joining fields for moderator drafts", async () => {
    const model = (await resolveOk(
      {
        status: "draft",
        organizer_name: "Draft organizer",
        join_url: "https://meet.example.test/draft-room",
        join_instructions: "Draft instructions",
      },
      moderatorSession(),
    )) as ModelWithHostJoin;
    expect(model.organizerName).toBe("Draft organizer");
    expect(model.joinUrl).toBe("https://meet.example.test/draft-room");
    expect(model.joinInstructions).toBe("Draft instructions");
  });

  it("nulls the organizer and joining fields when unset", async () => {
    const model = (await resolveOk({})) as ModelWithHostJoin;
    expect(model.organizerName).toBeNull();
    expect(model.joinUrl).toBeNull();
    expect(model.joinInstructions).toBeNull();
  });
});

describe("H4 host/join acceptance: Kit presentation legs (RED at base)", () => {
  it("published detail renders the host and joining sections", async () => {
    const model = withHostJoin((await resolveOk({})) as unknown as Record<string, unknown>, {
      organizerName: ORGANIZER,
      joinUrl: JOIN_URL,
      joinInstructions: JOIN_INSTRUCTIONS,
    });
    const html = renderDetail(model);
    expect(html).toContain("Hosted by");
    expect(html).toContain('data-testid="event-organizer"');
    expect(html).toContain(ORGANIZER);
    expect(html).toContain('data-testid="event-join-details"');
    expect(html).toContain("How to join");
    expect(html).toContain('data-testid="event-public-join-link"');
    expect(html).toContain("Open the public joining link");
    expect(html).toContain(`href="${JOIN_URL}"`);
    expect(html).toContain('data-testid="event-join-instructions"');
    expect(html).toContain(JOIN_INSTRUCTIONS);
  });

  it("detail without host/join fields renders no host or joining sections", async () => {
    // Preservation pin, green at base: the carry-over must not add empty sections.
    const model = withHostJoin((await resolveOk({})) as unknown as Record<string, unknown>, {
      organizerName: null,
      joinUrl: null,
      joinInstructions: null,
    });
    const html = renderDetail(model);
    expect(html).toContain('data-testid="event-venue"');
    expect(html).toContain("The lobby");
    expect(html).not.toContain('data-testid="event-organizer"');
    expect(html).not.toContain('data-testid="event-join-details"');
    expect(html).not.toContain('data-testid="event-public-join-link"');
    expect(html).not.toContain('data-testid="event-join-instructions"');
  });

  it("draft shows the organizer and instructions but no public link to moderators", async () => {
    const resolved = await resolveOk({ status: "draft" }, moderatorSession());
    const model = withHostJoin(resolved as unknown as Record<string, unknown>, {
      organizerName: "Draft organizer",
      joinUrl: "https://meet.example.test/draft-room",
      joinInstructions: "Draft instructions",
    });
    const html = renderDetail(model);
    expect(html).toContain('data-testid="event-draft"');
    expect(html).toContain('data-testid="event-organizer"');
    expect(html).toContain("Draft organizer");
    expect(html).toContain('data-testid="event-join-details"');
    expect(html).toContain("Public joining link: https://meet.example.test/draft-room");
    expect(html).not.toContain('data-testid="event-public-join-link"');
    expect(html).toContain('data-testid="event-join-instructions"');
    expect(html).toContain("Draft instructions");
  });

  it("past detail keeps the organizer but drops the join section", async () => {
    const resolved = await resolveOk({ status: "past" });
    const model = withHostJoin(resolved as unknown as Record<string, unknown>, {
      organizerName: "Past organizer",
      joinUrl: "https://meet.example.test/past-room",
      joinInstructions: "Past instructions",
    });
    const html = renderDetail(model);
    expect(html).toContain('data-testid="event-organizer"');
    expect(html).toContain("Past organizer");
    expect(html).not.toContain('data-testid="event-join-details"');
    expect(html).not.toContain('data-testid="event-public-join-link"');
    expect(html).not.toContain('data-testid="event-join-instructions"');
  });

  it("escapes hostile host and joining text", async () => {
    const model = withHostJoin((await resolveOk({})) as unknown as Record<string, unknown>, {
      organizerName: HOSTILE_ORGANIZER,
      joinUrl: JOIN_URL,
      joinInstructions: HOSTILE_INSTRUCTIONS,
    });
    const html = renderDetail(model);
    expect(html).toContain('data-testid="event-organizer"');
    expect(html).toContain("Riley &lt;img");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Lobby &lt;b");
    expect(html).not.toContain("<b>rules</b>");
    expect(html).toContain("&amp; friends");
  });

  it("renders overlong and malformed joining values with the Hono structure", async () => {
    const longOrganizer = "O".repeat(501);
    const longInstructions = "I".repeat(5001);
    const model = withHostJoin((await resolveOk({})) as unknown as Record<string, unknown>, {
      organizerName: longOrganizer,
      joinUrl: "https://",
      joinInstructions: longInstructions,
    });
    const html = renderDetail(model);
    expect(html).toContain('data-testid="event-join-details"');
    expect(html).toContain('data-testid="event-public-join-link"');
    expect(html).toContain('href="https://"');
    expect(html).toContain(longOrganizer);
    expect(html).toContain(longInstructions.slice(0, 100));
  });

  it("attribute-escapes a hostile joining link", async () => {
    const model = withHostJoin((await resolveOk({})) as unknown as Record<string, unknown>, {
      organizerName: ORGANIZER,
      joinUrl: 'https://meet.example.test/"onmouseover="alert(1)',
      joinInstructions: null,
    });
    const html = renderDetail(model);
    expect(html).toContain('data-testid="event-public-join-link"');
    expect(html).not.toContain('"onmouseover="');
  });
});

describe("H4 host/join acceptance: cross-renderer parity (RED at base)", () => {
  it("published host/join fixtures share testids and copy across both renderers", async () => {
    const honoHtml = await (
      await honoFixture({
        organizer_name: ORGANIZER,
        join_url: JOIN_URL,
        join_instructions: JOIN_INSTRUCTIONS,
      }).request()
    ).text();
    const kitHtml = renderDetail(
      withHostJoin((await resolveOk({})) as unknown as Record<string, unknown>, {
        organizerName: ORGANIZER,
        joinUrl: JOIN_URL,
        joinInstructions: JOIN_INSTRUCTIONS,
      }),
    );
    const pins = [
      "Hosted by",
      'data-testid="event-organizer"',
      ORGANIZER,
      'data-testid="event-join-details"',
      "How to join",
      'data-testid="event-public-join-link"',
      "Open the public joining link",
      JOIN_URL,
      'data-testid="event-join-instructions"',
      JOIN_INSTRUCTIONS,
    ];
    for (const pin of pins) {
      expect(honoHtml, pin).toContain(pin);
      expect(kitHtml, pin).toContain(pin);
    }
  });
});
