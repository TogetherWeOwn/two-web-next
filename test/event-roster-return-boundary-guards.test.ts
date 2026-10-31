// Builder-owned guard suite for the roster sign-in/join return boundary.
//
// The Test Author's acceptance file pins the oversized (over-cap) and
// tracking cases. It does not distinguish an inclusive cutoff from an
// exclusive one: every case there misses the cap by a wide margin, so
// `byteLength <= maxBytes` and `byteLength < maxBytes` both pass. Auth admits
// a destination of exactly MAX_RETURN_DESTINATION_BYTES (it refuses only
// `> max`), so the inclusive side is the production contract and needs its
// own pin at 511 / 512 / 513 UTF-8 bytes, driven through the real renderers
// and the real auth guard rather than a substitute.
//
// Hermetic: pg-proxy fakes for Hono, in-memory store fakes for Kit, the
// compiled Svelte SSR bundle for the Kit presentation. No DATABASE_URL.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { KitRequestSession } from "../src/kit-session";
import { MAX_RETURN_DESTINATION_BYTES, safeNext } from "../src/join/service";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import type { EventAttendee, PublicEvent } from "../src/events/reads";
import { archiveContext } from "../src/events/archive-context";
import { archiveEventHref, authReturnHref, attendeePageHref } from "../src/events/attendee-paths";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const OUTSIDER_ID = "100000000000000002";
const SECRET = "test-session-secret-test-session-secret";

const ATTENDEES: EventAttendee[] = [
  { id: "u1", name: "ann" },
  { id: "u2", name: "bob" },
];

// ---------------------------------------------------------------------------
// Boundary fixtures: the same archive search at 511, 512 and 513 UTF-8 bytes
// ---------------------------------------------------------------------------
//
// `棋` percent-encodes to nine bytes, so the emitted destination moves in
// exact nine-byte steps: 48 CJK code points plus k ASCII fillers give
// 501 + k bytes for `?attendees=2&archivePage=2&archiveQuery=…` on this key.
// That lands a case on 511 (fits, inclusive either way), exactly 512 (the
// inclusive cutoff: only `<=` retains it) and 513 (over: dropped whole).
const boundaryQuery = (asciiFiller: number) => "棋".repeat(48) + "x".repeat(asciiFiller);

type BoundaryCase = {
  label: string;
  search: string;
  archive: { page: number; q: string };
  bytes: number;
  keepsArchive: boolean;
};

const BOUNDARY_CASES: BoundaryCase[] = [
  { label: "511 bytes", ascii: 10 },
  { label: "512 bytes", ascii: 11 },
  { label: "513 bytes", ascii: 12 },
].map(({ label, ascii }) => {
  const q = boundaryQuery(ascii);
  const search = `?archivePage=2&archiveQuery=${encodeURIComponent(q)}&attendees=2`;
  const bytes = new TextEncoder().encode(archiveEventHref(KEY, { page: 2, q }, 2)).byteLength;
  return { label, search, archive: { page: 2, q }, bytes, keepsArchive: bytes <= 512 };
});

/** The destination each case must emit, spelled out rather than re-derived. */
function expectedDestination(item: BoundaryCase): string {
  if (!item.keepsArchive) return attendeePageHref(KEY, 2);
  const params = new URLSearchParams("attendees=2");
  params.set("archivePage", String(item.archive.page));
  params.set("archiveQuery", item.archive.q);
  return `${PATH}?${params}`;
}

// ---------------------------------------------------------------------------
// Hono fixture (pg-proxy fake; real route, real renderer)
// ---------------------------------------------------------------------------

function honoRow(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
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

function honoFixture() {
  const row = honoRow();
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const toRow = () =>
    columns.map((key) => (row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key]));
  const db = drizzle(async (sql, params) => {
    if (sql.includes("row_number()")) return { rows: [] };
    if (
      sql.includes('from "rsvps"') &&
      sql.includes('inner join "users"') &&
      !sql.includes("group by")
    ) {
      return { rows: ATTENDEES.map((a) => [a.id, a.name]) };
    }
    if (sql.includes('from "rsvps"')) {
      if (sql.includes("count(*)")) {
        const n = sql.includes('inner join "users"') ? ATTENDEES.length : ATTENDEES.length;
        return { rows: [[row.id, n]] };
      }
      return { rows: [] };
    }
    if (sql.includes('"event_key" =')) return { rows: [toRow()] };
    return { rows: [] };
  });
  Object.assign(db, {
    transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
  });
  const store = createMemorySessionStore();
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  const cookieFor = async (userId: string, member: boolean) => {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId,
      username: member ? "member" : "outsider",
      avatar: null,
      member,
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
  };
  return {
    env,
    outsiderCookie: () => cookieFor(OUTSIDER_ID, false),
    request: (cookie?: string, path = PATH) =>
      app.request(path, cookie ? { headers: { cookie } } : {}, env),
  };
}

/** The roster shell's own markup, from its testid to the section close. */
function rosterSection(html: string, testid: string): string {
  const start = html.indexOf(`data-testid="${testid}"`);
  expect(start, `roster section ${testid}`).toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end === -1 ? undefined : end);
}

/**
 * Decode the served link, assert the production auth guard admits it as-is,
 * and return the raw destination the visitor will land on after sign-in.
 */
function admittedDestination(html: string, testid: string, joinPath: string): string {
  const section = rosterSection(html, testid);
  const match = /href="([^"]+)"/.exec(section);
  expect(match, `${testid} link`).not.toBeNull();
  const href = match![1]!;
  expect(href.startsWith(`${joinPath}?next=`), `${testid} href ${href}`).toBe(true);
  const next = new URL(href, APP_URL).searchParams.get("next");
  expect(next, `${testid} next`).not.toBeNull();
  expect(safeNext(next), `${testid} next must survive auth`).toBe(next);
  return next!;
}

// ---------------------------------------------------------------------------
// Kit fixture (in-memory store + compiled Svelte SSR)
// ---------------------------------------------------------------------------

const GUEST: KitRequestSession = { status: "guest", session: null };
const outsiderKitSession = (): KitRequestSession => ({
  status: "authenticated",
  session: {
    userId: OUTSIDER_ID,
    username: "outsider",
    avatar: null,
    member: false,
    moderator: false,
  },
});

function kitStore(): KitEventDetailStore {
  const event = {
    ...honoRow(),
    goingCount: ATTENDEES.length,
    goingOccupancy: ATTENDEES.length,
  } as PublicEvent;
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => ATTENDEES,
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

const kitEnv = { APP_URL } as unknown as Env;

async function kitModel(session: KitRequestSession, search: string) {
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search,
    path: PATH,
    env: kitEnv,
    session,
    joinResult: null,
    setHeaders: () => {},
    store: kitStore(),
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.model;
}

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally (same shape as the Kit detail
// parity bundle).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitDetailBundle() {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-roster-boundary-"));
  try {
    const entry = join(scratch, "kit-roster-boundary-entry.mjs");
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
    const outfile = join(scratch, "kit-roster-boundary.mjs");
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
          name: "kit-roster-boundary-svelte-ssr",
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
}

// ---------------------------------------------------------------------------
// The cutoff contract, exercised on the real builder
// ---------------------------------------------------------------------------

describe("auth return boundary byte table", () => {
  it("keeps the fixture on 511 / 512 / 513 UTF-8 bytes", () => {
    expect(BOUNDARY_CASES.map((c) => c.bytes)).toEqual([511, 512, 513]);
    // Every case is a valid archive search, so none of them is dropped for
    // an unrelated reason before the byte cutoff is consulted.
    for (const item of BOUNDARY_CASES) expect(archiveContext(item.search)).toEqual(item.archive);
  });

  it("includes the cap: 511 and 512 keep their archive, 513 drops it whole", () => {
    for (const item of BOUNDARY_CASES) {
      const emitted = authReturnHref(KEY, item.archive, 2, MAX_RETURN_DESTINATION_BYTES);
      expect(emitted, item.label).toBe(expectedDestination(item));
      // The untrimmed candidate is the fixture's advertised size; only the
      // over-cap case (513) is allowed to emit something shorter.
      const candidate = archiveEventHref(KEY, item.archive, 2);
      expect(new TextEncoder().encode(candidate).byteLength, item.label).toBe(item.bytes);
      const emittedBytes = new TextEncoder().encode(emitted).byteLength;
      expect(emittedBytes, item.label).toBeLessThanOrEqual(MAX_RETURN_DESTINATION_BYTES);
    }
  });

  it("never truncates a search: an over-cap destination keeps only the event page", () => {
    for (const item of BOUNDARY_CASES.filter((c) => !c.keepsArchive)) {
      const emitted = authReturnHref(KEY, item.archive, 2, MAX_RETURN_DESTINATION_BYTES);
      expect(emitted).toBe(PATH + "?attendees=2");
      expect(emitted).not.toContain("archiveQuery");
      expect(emitted).not.toContain("archivePage");
    }
  });

  it("every emitted destination is admitted by the unchanged auth guard", () => {
    for (const item of BOUNDARY_CASES) {
      const emitted = authReturnHref(KEY, item.archive, 2, MAX_RETURN_DESTINATION_BYTES);
      expect(safeNext(emitted), item.label).toBe(emitted);
    }
  });
});

// ---------------------------------------------------------------------------
// Hono twin, through the real route
// ---------------------------------------------------------------------------

describe.each([
  { audience: "guest sign-in", testid: "event-roster-guest-nudge", joinPath: "/join/discord" },
  { audience: "non-member join", testid: "event-roster-members-only", joinPath: "/join" },
])("Hono boundary: $audience", ({ testid, joinPath }) => {
  it.each(BOUNDARY_CASES)("$label lands on the expected destination", async (item) => {
    const source = honoFixture();
    const cookie =
      testid === "event-roster-members-only" ? await source.outsiderCookie() : undefined;
    const response = await source.request(cookie, `${PATH}${item.search}`);
    expect(response.status).toBe(200);
    const destination = admittedDestination(await response.text(), testid, joinPath);
    expect(destination).toBe(expectedDestination(item));
    expect(archiveContext(new URL(destination, APP_URL).search)).toEqual(
      item.keepsArchive ? item.archive : null,
    );
  });
});

// ---------------------------------------------------------------------------
// Kit twin, through the real resolver and compiled presentation
// ---------------------------------------------------------------------------

describe.each([
  { audience: "guest sign-in", testid: "event-roster-guest-nudge", joinPath: "/join/discord" },
  { audience: "non-member join", testid: "event-roster-members-only", joinPath: "/join" },
])("Kit boundary: $audience", ({ testid, joinPath }) => {
  it.each(BOUNDARY_CASES)("$label lands on the expected destination", async (item) => {
    const { renderDetail } = await buildKitDetailBundle();
    const model = await kitModel(
      testid === "event-roster-members-only" ? outsiderKitSession() : GUEST,
      item.search,
    );
    const html = renderDetail(model as unknown as Record<string, unknown>);
    const destination = admittedDestination(html, testid, joinPath);
    expect(destination).toBe(expectedDestination(item));
    expect(archiveContext(new URL(destination, APP_URL).search)).toEqual(
      item.keepsArchive ? item.archive : null,
    );
  });
});

// ---------------------------------------------------------------------------
// Wire-through: the load model hands the same bounded value to the view
// ---------------------------------------------------------------------------

describe("Kit load model carries the bounded return", () => {
  it.each(BOUNDARY_CASES)("$label", async (item) => {
    const model = await kitModel(GUEST, item.search);
    expect(model.joinReturnTo).toBe(expectedDestination(item));
    expect(safeNext(model.joinReturnTo)).toBe(model.joinReturnTo);
  });
});
