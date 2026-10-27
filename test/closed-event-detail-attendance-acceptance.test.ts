// route-inventory: GET /e/:key
// Failing-first acceptance: a closed event detail shows final attendance,
// never a spots-left invitation (roadmap refresh).
//
// Owned by the Test Author; the Builder builds on this branch and never edits
// this file. Hermetic pg-proxy + fake-store fixtures: no DATABASE_URL, no
// network. RED tests pin the fixed rendering and fail at the base pin;
// CONTROL tests pass before and after, proving the fixtures are live and the
// preserved contract holds.
//
// Base-pin behavior this suite was written against:
// - Hono past detail (EventPage, showSpotsLeft: true) renders the going count
//   PLUS a spots-left/Full line; the RED tests fail on that line.
// - Hono cancelled detail (EventGonePage, 410) renders NO attendance line at
//   all; the RED tests fail on the missing existing-responses line.
// - Kit mirrors both (EventDetail.svelte hardcodes showSpotsLeft: true;
//   EventGone.svelte has no attendance block).
// GREEN contract (both twins): past shows the going count with no spots/full
// line; cancelled shows existingResponsesText with no capacity; published
// keeps count plus spots-left unchanged. Schedule cards already suppress both
// lines (src/events/pages-calendar-card.tsx:96-118) and are pinned as CONTROL.
// The two no-capacity past cases already pass at the base pin (an uncapped
// badge has no spots line to remove); they pin the shape the build must keep.
// RED run at the base pin: 20 failed, 16 passed (36 total).
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { jsx } from "hono/jsx/jsx-runtime";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { resolveEventState } from "../src/kit-event-states";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import { CalCard } from "../src/events/pages-calendar-card";
import type { EventLink, PublicEvent } from "../src/events/reads";
import {
  existingResponsesText,
  goingCountText,
  GOING_COUNT_TESTID,
  rsvpClosedCopy,
  RSVP_CLOSED_TESTID,
  SPOTS_LEFT_TESTID,
  spotsLeftText,
} from "../src/islands/contracts";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  cancellationEvent,
  publishedScheduleEvent,
  renderedText,
} from "./helpers/calendar-cancellation";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECRET = "test-session-secret-at-least-32-bytes-long";

const RELATED: EventLink[] = [
  {
    id: 9,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    title: "Chess finals",
    startsAt: new Date("2030-02-01T19:00:00Z"),
    endsAt: new Date("2030-02-01T21:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    game: null,
    rsvpOpen: true,
  },
  {
    id: 11,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
    title: "Chess open",
    startsAt: new Date("2030-03-01T19:00:00Z"),
    endsAt: new Date("2030-03-01T21:00:00Z"),
    timezone: "UTC",
    location: null,
    game: null,
    rsvpOpen: true,
  },
];

interface DetailCounts {
  going: number;
  occupancy: number;
  capacity: number | null;
}

const CASES: ({ name: string } & DetailCounts)[] = [
  { name: "full", going: 10, occupancy: 10, capacity: 10 },
  { name: "nearly-full", going: 9, occupancy: 9, capacity: 10 },
  { name: "no-capacity", going: 4, occupancy: 4, capacity: null },
  { name: "zero-going", going: 0, occupancy: 0, capacity: 10 },
];

const CANCELLED_CASES: ({ name: string } & DetailCounts)[] = [
  ...CASES,
  { name: "singular", going: 1, occupancy: 1, capacity: 10 },
  { name: "divergent", going: 1, occupancy: 2, capacity: 10 },
];

type DetailStatus = "past" | "cancelled" | "published" | "draft";

function detailRow(status: DetailStatus, capacity: number | null): typeof events.$inferSelect {
  // Past uses elapsed dates; cancelled stays future-dated so the 410 proves
  // cancellation, not elapsed time, drives the rendering.
  const start =
    status === "past" ? new Date("2020-01-10T20:00:00Z") : new Date("2030-01-10T20:00:00Z");
  const end = new Date(start.getTime() + 2 * 3600_000);
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: end,
    timezone: "UTC",
    location: "The lobby",
    capacity,
    status,
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

// Served Hono answers through a disposable pg-proxy fixture. The SQL dispatch
// mirrors the reads the detail branches perform: the single-row lookup by key
// (getPublicEvent, no status predicate), the status-filtered sibling lookup
// (listRelatedEvents) and the two going-count aggregates (named join vs seat
// occupancy). Everything else finds nothing, as in the gone-alternatives and
// event-page suites.
function honoFixture(
  status: DetailStatus,
  counts: DetailCounts,
  overrides: Partial<typeof events.$inferSelect> = {},
) {
  const row = { ...detailRow(status, counts.capacity), ...overrides };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"')) {
      const grouped = sql.includes("group by");
      const joined = sql.includes('join "users"');
      // Combined aggregate: (event_id, named, occupied) in one row.
      if (grouped && sql.includes('left join "users"'))
        return { rows: [[row.id, counts.going, counts.occupancy]] };
      if (grouped && joined) return { rows: [[row.id, counts.going]] };
      if (grouped) return { rows: [[row.id, counts.occupancy]] };
      return { rows: [] };
    }
    if (sql.includes('from "events"')) {
      if (sql.includes('"event_key" =') && !sql.includes('"status" =')) {
        return {
          rows: [
            columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
          ],
        };
      }
      if (sql.includes('"status" =')) {
        return {
          rows: RELATED.map((link) => [
            link.id,
            link.eventKey,
            link.title,
            link.startsAt.toISOString(),
            link.endsAt.toISOString(),
            link.timezone,
            link.location,
            link.game,
            link.rsvpOpen,
          ]),
        };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });
  const sessions = createMemorySessionStore();
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: sessions,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    async moderatorCookie() {
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: "100000000000000002",
        username: "moderator",
        avatar: null,
        member: true,
        moderator: true,
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
    request(cookie?: string) {
      return app.request(`/e/${KEY}`, cookie ? { headers: { cookie } } : {}, env);
    },
  };
}

const GUEST: KitRequestSession = { status: "guest", session: null };

function kitStore(event: PublicEvent): KitEventDetailStore {
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => RELATED,
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

function kitEvent(status: DetailStatus, counts: DetailCounts): PublicEvent {
  return {
    ...detailRow(status, counts.capacity),
    goingCount: counts.going,
    goingOccupancy: counts.occupancy,
  } as PublicEvent;
}

// svelte lives in the web workspace only; the root workspace never sees its
// types, so the compiler is typed structurally (same shape as the
// kit-event-detail parity bundle: #lib/* resolves through the web alias).
const webRequire = createRequire(new NodeURL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitBundle(): Promise<{
  renderDetail: (model: Record<string, unknown>) => string;
  renderGone: (model: Record<string, unknown>) => string;
}> {
  const worktree = fileURLToPath(new NodeURL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-closed-detail-"));
  try {
    const entry = join(scratch, "kit-closed-detail-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
import Gone from ${JSON.stringify(join(worktree, "web/src/lib/EventGone.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function renderGone(model) {
  const { head, body } = render(Gone, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-closed-detail.mjs");
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
          name: "kit-closed-detail-svelte-ssr",
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
      renderGone: (model: Record<string, unknown>) => string;
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

let renderers: Awaited<ReturnType<typeof buildKitBundle>>;
beforeAll(async () => {
  renderers = await buildKitBundle();
}, 120_000);

function kitDetailOutcome(event: PublicEvent, session: KitRequestSession = GUEST) {
  return resolveKitEventDetail({
    key: KEY,
    search: "",
    path: `/e/${KEY}`,
    env: { APP_URL } as unknown as Env,
    session,
    joinResult: null,
    setHeaders: () => {},
    store: kitStore(event),
  });
}

async function kitDetailHtml(status: DetailStatus, counts: DetailCounts): Promise<string> {
  const outcome = await kitDetailOutcome(kitEvent(status, counts));
  if (status === "cancelled") {
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    return renderers.renderGone(outcome.model as unknown as Record<string, unknown>);
  }
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error("unreachable");
  return renderers.renderDetail(outcome.model as unknown as Record<string, unknown>);
}

// Visible copy only: head metadata, JSON-LD and scripts are not attendance.
// Parse HTML rather than filtering tags with regexes. A second pass reads only
// surviving text, including the separators inserted around adjacent elements.
let textParser: Miniflare | undefined;
afterAll(async () => {
  await textParser?.dispose();
});

async function visibleText(html: string): Promise<string> {
  textParser ??= new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-09-29",
      outboundService: async () => {
        throw new Error("External network forbidden in visible-copy parser");
      },
      script: `export default {
        async fetch(request) {
          const copy = new HTMLRewriter()
            .on("head, script", { element(element) { element.remove(); } })
            .on("*", { element(element) { element.before(" "); element.after(" "); } })
            .transform(new Response(await request.text()));
          let text = "";
          await new HTMLRewriter().onDocument({
            text(chunk) { text += chunk.text; }
          }).transform(copy).text();
          return new Response(text);
        }
      };`,
    }),
  );
  const response = await textParser.dispatchFetch("https://copy.example.test", {
    method: "POST",
    body: html,
  });
  return (await response.text()).replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();
}

it("visible copy excludes mixed-case head and script markup, not adjacent attendance", async () => {
  const html = `<HEAD data-note=">"><title>Full</title></hEaD><body>
    <SCRIPT type="application/ld+json">{"copy":"spots left"}</SCRIPT >
    <p>7 existing responses &amp; <b>friends</b></p>
    <sCrIpT>Full</sCrIpT data-end=">"><p>Still visible</p>
  </body>`;
  expect(await visibleText(html)).toBe("7 existing responses & friends Still visible");
});

async function expectPastLineup(html: string, counts: DetailCounts): Promise<void> {
  const text = await visibleText(html);
  expect(text).toContain(goingCountText(counts.going, counts.capacity));
  expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
  expect(text).not.toMatch(/spots left/i);
  expect(text).not.toMatch(/\bFull\b/);
}

async function expectCancelledLineup(html: string, counts: DetailCounts): Promise<void> {
  const text = await visibleText(html);
  expect(text).toContain(existingResponsesText(counts.going));
  expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
  expect(text).not.toMatch(/\bgoing\b/i);
  expect(text).not.toMatch(/spots left/i);
  expect(text).not.toMatch(/\bFull\b/);
  expect(text).not.toMatch(/\bof \d+ going\b/);
  // Capacity is meaningless after cancellation: no "of M" anywhere.
  if (counts.capacity !== null) expect(text).not.toMatch(new RegExp(`\\bof ${counts.capacity}\\b`));
}

describe("Hono past detail (RED: final attendance, no spots line)", () => {
  it.each(CASES)("shows the going count with no spots/full line ($name)", async (counts) => {
    const res = await honoFixture("past", counts).request();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="event-past">Past event');
    await expectPastLineup(html, counts);
  });
});

describe("Hono cancelled detail (RED: existing responses, no capacity)", () => {
  it.each(CANCELLED_CASES)("shows existing responses with no capacity ($name)", async (counts) => {
    const res = await honoFixture("cancelled", counts).request();
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    await expectCancelledLineup(html, counts);
  });
});

describe("Kit past detail (RED: final attendance, no spots line)", () => {
  it.each(CASES)("shows the going count with no spots/full line ($name)", async (counts) => {
    const html = await kitDetailHtml("past", counts);
    expect(html).toContain('data-testid="event-past">Past event');
    await expectPastLineup(html, counts);
  });
});

describe("Kit cancelled detail (RED: existing responses, no capacity)", () => {
  it.each(CANCELLED_CASES)("shows existing responses with no capacity ($name)", async (counts) => {
    const html = await kitDetailHtml("cancelled", counts);
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    await expectCancelledLineup(html, counts);
  });
});

// A published row can outlive its end before reconciliation changes status.
// The server's RSVP verdict, not a background status update or viewer clock,
// must close the invitation. A draft keeps its own notice and preview badge.
// These cases catch status-only spots guards and an endsAt < now boundary bug.
describe("server-time closure for still-published detail", () => {
  const NOW = new Date("2030-01-10T22:00:00.000Z");
  const counts: DetailCounts = { going: 9, occupancy: 9, capacity: 10 };
  const moderator: KitRequestSession = {
    status: "authenticated",
    session: {
      userId: "100000000000000002",
      username: "moderator",
      avatar: null,
      member: true,
      moderator: true,
    },
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  async function expectElapsedHtml(html: string) {
    expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
    const text = await visibleText(html);
    expect(text).toContain("This one has been and gone");
    expect(text).toContain("9 of 10 going");
    expect(html).not.toContain("data-rsvp-form");
    await expectPastLineup(html, counts);
  }

  async function expectInvitation(html: string) {
    expect(html).toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
    expect(await visibleText(html)).toContain("1 of 10 spots left");
    expect(await visibleText(html)).toContain("9 of 10 going");
  }

  it.each([
    { name: "elapsed by one millisecond", offset: -1 },
    { name: "exact end boundary", offset: 0 },
  ])("Hono published closes at server now ($name) (RED)", async ({ offset }) => {
    const res = await honoFixture("published", counts, {
      endsAt: new Date(NOW.getTime() + offset),
    }).request();
    expect(res.status).toBe(200);
    await expectElapsedHtml(await res.text());
  });

  it.each([
    { name: "elapsed by one millisecond", offset: -1 },
    { name: "exact end boundary", offset: 0 },
  ])("Kit published closes at server now ($name) (RED)", async ({ offset }) => {
    const outcome = await kitDetailOutcome({
      ...kitEvent("published", counts),
      endsAt: new Date(NOW.getTime() + offset),
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.rsvpClosed).toBe("past");
    expect(outcome.model.goingCount).toBe(9);
    const html = renderers.renderDetail(outcome.model as unknown as Record<string, unknown>);
    await expectElapsedHtml(html);
  });

  it("Hono published ending one millisecond later keeps spots (CONTROL)", async () => {
    const res = await honoFixture("published", counts, {
      endsAt: new Date(NOW.getTime() + 1),
    }).request();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
    await expectInvitation(html);
  });

  it("Kit published ending one millisecond later keeps spots (CONTROL)", async () => {
    const outcome = await kitDetailOutcome({
      ...kitEvent("published", counts),
      endsAt: new Date(NOW.getTime() + 1),
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.rsvpClosed).toBeNull();
    const html = renderers.renderDetail(outcome.model as unknown as Record<string, unknown>);
    expect(html).not.toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
    await expectInvitation(html);
  });

  it("Hono elapsed draft preserves moderator preview and draft closure (CONTROL)", async () => {
    const fixture = honoFixture("draft", counts, { endsAt: NOW });
    const res = await fixture.request(await fixture.moderatorCookie());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="event-draft">Draft');
    expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
    expect(await visibleText(html)).toContain("Not published yet");
    expect(await visibleText(html)).not.toContain("This one has been and gone");
    await expectInvitation(html);
  });

  it("Kit elapsed draft preserves moderator preview and draft closure (CONTROL)", async () => {
    const outcome = await kitDetailOutcome(
      { ...kitEvent("draft", counts), endsAt: NOW },
      moderator,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.model.rsvpClosed).toBe("draft");
    const html = renderers.renderDetail(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="event-draft">Draft');
    expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
    expect(await visibleText(html)).toContain("Not published yet");
    expect(await visibleText(html)).not.toContain("This one has been and gone");
    await expectInvitation(html);
  });

  it("Hono elapsed draft stays forbidden to guests (CONTROL)", async () => {
    const res = await honoFixture("draft", counts, { endsAt: NOW }).request();
    expect(res.status).toBe(403);
  });

  it("Kit elapsed draft stays forbidden to guests (CONTROL)", async () => {
    const outcome = await kitDetailOutcome({ ...kitEvent("draft", counts), endsAt: NOW });
    expect(outcome.kind).toBe("forbidden");
    if (outcome.kind !== "forbidden") throw new Error("unreachable");
    expect(outcome.status).toBe(403);
  });
});

// Named responses and occupied seats can diverge (for example after a user
// disappears). Cancellation is retained response history, not seat occupancy.
// Each resolver must carry the nonzero count to its real SSR consumer.
describe("cancelled divergent named-response history (CONTROL)", () => {
  const counts: DetailCounts = { going: 1, occupancy: 2, capacity: 10 };

  it("full-detail resolver and SSR retain one named response, not two occupied seats", async () => {
    const outcome = await kitDetailOutcome(kitEvent("cancelled", counts));
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    expect.soft(outcome.model.existingResponses).toBe(1);
    const html = renderers.renderGone(outcome.model as unknown as Record<string, unknown>);
    const text = await visibleText(html);
    expect.soft(text).toContain("1 existing response");
    expect(text).not.toMatch(/\b(?:0|2) existing responses\b|1 existing responses/);
    await expectCancelledLineup(html, counts);
  });

  it("sessionless resolver and SSR retain one named response, not a zero default", async () => {
    const outcome = await resolveEventState({
      key: KEY,
      search: "",
      path: `/e/${KEY}`,
      env: { APP_URL } as unknown as Env,
      setHeaders: () => {},
      store: kitStore(kitEvent("cancelled", counts)),
    });
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("unreachable");
    expect(outcome.status).toBe(410);
    expect.soft(outcome.model.existingResponses).toBe(1);
    const html = renderers.renderGone(outcome.model as unknown as Record<string, unknown>);
    const text = await visibleText(html);
    expect.soft(text).toContain("1 existing response");
    expect(text).not.toMatch(/\b(?:0|2) existing responses\b|1 existing responses/);
    await expectCancelledLineup(html, counts);
  });
});

// Shipped-binder harness over real SSR markup (same shape as the
// going-count-ssr-binder suite): the real public/islands/going-count.js source
// evaluates against the mount the page actually emits, with stubbed fetch only.
const binder = readFileSync(
  new NodeURL("../public/islands/going-count.js", import.meta.url),
  "utf8",
);

class BinderNode {
  attributes = new Map<string, string>();
  textContent = "";
  hidden = false;
  removed = false;
  private targets = new Map<string, BinderNode>();
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  remove() {
    this.removed = true;
  }
  querySelector(selector: string): BinderNode | null {
    const target = this.targets.get(selector);
    return target && !target.removed ? target : null;
  }
  addTarget(selector: string): BinderNode {
    const node = new BinderNode();
    this.targets.set(selector, node);
    return node;
  }
}

interface PendingRefresh {
  url: string;
  resolve: (response: { ok: boolean; status?: number; json: () => Promise<unknown> }) => void;
  reject: (error: Error) => void;
}

function browser(html: string) {
  const tag = html.match(/<span role="status" data-testid="event-going-count"[^>]*>/)?.[0];
  expect(tag, "SSR must emit the going-count mount span").toBeTruthy();
  const mount = new BinderNode();
  for (const name of ["data-event-key", "data-capacity"]) {
    const value = tag!.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    if (value !== undefined) mount.setAttribute(name, value);
  }
  const count = mount.addTarget("[data-count]");
  count.textContent = html.match(/<span data-count>([^<]*)<\/span>/)?.[1] ?? "";
  mount.addTarget("[data-announcement]");
  if (html.includes("data-spots")) {
    const spots = mount.addTarget("[data-spots]");
    spots.textContent = html.match(/data-spots>([^<]*)<\/span>/)?.[1] ?? "";
  }
  const listeners: ((event: { detail: { eventKey?: string; viewerState?: string } }) => void)[] =
    [];
  const requests: PendingRefresh[] = [];
  const documentEl = new BinderNode();
  runInNewContext(binder, {
    CustomEvent: class {
      constructor(
        public type: string,
        public options: { detail: unknown },
      ) {}
      get detail() {
        return this.options.detail;
      }
    },
    document: {
      documentElement: documentEl,
      addEventListener: (
        type: string,
        listener: (event: { detail: { eventKey?: string; viewerState?: string } }) => void,
      ) => {
        if (type === "going-count-updated") listeners.push(listener);
      },
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === '[data-island="going-count"]' ? [mount] : [],
      dispatchEvent: () => true,
    },
    fetch: (url: string) =>
      new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  });
  return {
    mount,
    count,
    requests,
    broadcast(eventKey: string, viewerState?: string) {
      for (const listener of listeners) listener({ detail: { eventKey, viewerState } });
    },
    async settle() {
      for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("island refresh keeps the closed-event rendering (RED: no spots node appears)", () => {
  const pastFull = CASES[0]!;
  const cancelledNearlyFull = CASES[1]!;

  it("Hono past: a full snapshot refreshes the count without materializing a spots node", async () => {
    const html = await (await honoFixture("past", pastFull).request()).text();
    expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
    const b = browser(html);
    expect(b.requests).toHaveLength(0);
    b.broadcast(KEY);
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.resolve({
      ok: true,
      json: async () => [
        { event_key: KEY, going_count: pastFull.going, going_occupancy: pastFull.occupancy },
      ],
    });
    await b.settle();
    expect(b.count.textContent).toBe(goingCountText(pastFull.going, pastFull.capacity));
    expect(b.mount.querySelector("[data-spots]")).toBeNull();
  });

  it("Kit past: a full snapshot refreshes the count without materializing a spots node", async () => {
    const html = await kitDetailHtml("past", pastFull);
    expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
    const b = browser(html);
    b.broadcast(KEY);
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.resolve({
      ok: true,
      json: async () => [
        { event_key: KEY, going_count: pastFull.going, going_occupancy: pastFull.occupancy },
      ],
    });
    await b.settle();
    expect(b.count.textContent).toBe(goingCountText(pastFull.going, pastFull.capacity));
    expect(b.mount.querySelector("[data-spots]")).toBeNull();
  });

  it("Hono cancelled: refresh leaves no spots node", async () => {
    const html = await (await honoFixture("cancelled", cancelledNearlyFull).request()).text();
    expect(await visibleText(html)).toContain(existingResponsesText(cancelledNearlyFull.going));
    if (!html.includes(`data-testid="${GOING_COUNT_TESTID}"`)) {
      // Static rendering is trivially refresh-safe: no island, no spots node.
      expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
      return;
    }
    const b = browser(html);
    b.broadcast(KEY);
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.resolve({
      ok: true,
      json: async () => [
        {
          event_key: KEY,
          going_count: cancelledNearlyFull.going,
          going_occupancy: cancelledNearlyFull.occupancy,
        },
      ],
    });
    await b.settle();
    expect(b.mount.querySelector("[data-spots]")).toBeNull();
  });

  it("Kit cancelled: refresh leaves no spots node", async () => {
    const html = await kitDetailHtml("cancelled", cancelledNearlyFull);
    expect(await visibleText(html)).toContain(existingResponsesText(cancelledNearlyFull.going));
    if (!html.includes(`data-testid="${GOING_COUNT_TESTID}"`)) {
      expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
      return;
    }
    const b = browser(html);
    b.broadcast(KEY);
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.resolve({
      ok: true,
      json: async () => [
        {
          event_key: KEY,
          going_count: cancelledNearlyFull.going,
          going_occupancy: cancelledNearlyFull.occupancy,
        },
      ],
    });
    await b.settle();
    expect(b.mount.querySelector("[data-spots]")).toBeNull();
  });
});

describe("published detail keeps count plus spots-left (CONTROL: green before and after)", () => {
  it.each(CASES)("Hono published keeps the invitation line ($name)", async (counts) => {
    const res = await honoFixture("published", counts).request();
    expect(res.status).toBe(200);
    const html = await res.text();
    const text = await visibleText(html);
    expect(text).toContain(goingCountText(counts.going, counts.capacity));
    if (counts.capacity === null) {
      expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
    } else {
      expect(html).toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
      expect(text).toContain(spotsLeftText(counts.occupancy, counts.capacity));
    }
  });

  it.each(CASES)("Kit published keeps the invitation line ($name)", async (counts) => {
    const html = await kitDetailHtml("published", counts);
    const text = await visibleText(html);
    expect(text).toContain(goingCountText(counts.going, counts.capacity));
    if (counts.capacity === null) {
      expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
    } else {
      expect(html).toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
      expect(text).toContain(spotsLeftText(counts.occupancy, counts.capacity));
    }
  });
});

describe("schedule cards already suppress both lines (CONTROL: green before and after)", () => {
  const card = (e: Parameters<typeof CalCard>[0]["e"], isPast: boolean) =>
    jsx(CalCard, {
      e,
      zone: "Europe/London",
      isPast,
      member: false,
      inviteUrl: "https://discord.gg/example",
      loginReturnTo: "/events",
    }).toString();

  it("cancelled cards show existing responses with no spots line", async () => {
    const html = await card(cancellationEvent({ goingCount: 100, goingOccupancy: 100 }), false);
    expect(renderedText(html)).toContain("100 existing responses");
    expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
    expect(html).not.toContain("Full");
  });

  it("past cards show the going count with no spots line", async () => {
    const html = await card(
      { ...publishedScheduleEvent(), capacity: 10, goingCount: 10, goingOccupancy: 10 },
      true,
    );
    expect(renderedText(html)).toContain("10 of 10 going");
    expect(html).not.toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
    expect(html).not.toContain("Full");
  });
});

describe("keyboard and no-JS detail journeys (CONTROL: green before and after)", () => {
  const full = CASES[0]!;

  async function expectPastJourney(html: string): Promise<void> {
    // Closed RSVP is a status notice, never a form: nothing to submit, focus,
    // or trap without JS.
    expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
    expect(await visibleText(html)).toContain(rsvpClosedCopy("past"));
    expect(html).not.toContain("data-rsvp-form");
    expect(html).not.toContain('data-testid="rsvp-going"');
    // The device-timezone action ships hidden with an empty live region; the
    // island unhides it only after it binds.
    expect(html).toContain('data-testid="event-device-timezone-starts-button"');
    expect(html).toContain('<button type="button" hidden');
    expect(html).toContain(
      '<p role="status" aria-live="polite" data-testid="event-device-timezone-starts-status"></p>',
    );
    // Share and calendar targets are native anchors: keyboard-reachable with
    // no JS enhancement.
    expect(html).toMatch(/<a href="[^"]*" data-copy-link=[^>]*data-testid="event-copy-link">/);
    expect(html).toContain('data-testid="event-ics"');
    expect(html).not.toMatch(/\son(?:click|keydown)=/);
  }

  function expectCancelledJourney(html: string): void {
    expect(html).toContain('data-testid="event-cancelled-alternatives"');
    expect(html).toContain('data-testid="event-cancelled-ics"');
    expect(html).toContain('href="/events"');
    expect(html).toContain("See upcoming events");
    expect(html).not.toMatch(/data-rsvp-form|data-island="rsvp-button"/);
    expect(html).not.toMatch(/\son(?:click|keydown)=/);
  }

  it("Hono past keeps the closed no-JS journey", async () => {
    await expectPastJourney(await (await honoFixture("past", full).request()).text());
  });

  it("Kit past keeps the closed no-JS journey", async () => {
    await expectPastJourney(await kitDetailHtml("past", full));
  });

  it("Hono cancelled keeps alternatives, ICS and the way back", async () => {
    expectCancelledJourney(await (await honoFixture("cancelled", full).request()).text());
  });

  it("Kit cancelled keeps alternatives, ICS and the way back", async () => {
    expectCancelledJourney(await kitDetailHtml("cancelled", full));
  });
});
