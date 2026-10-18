// route-inventory: GET /e/:key
// Acceptance: the Kit "Refresh attendees" link reloads the roster page the
// member is actually looking at. On ?attendees=N (N > 1) the rendered
// refresh href keeps that page; page 1 stays the bare event path; malformed
// or externally-flavoured values never reach the href and fall back to the
// bare event path.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Exactly one anchor data-testid="event-attendees-refresh" with the text
//   "Refresh attendees" renders for a member, as today.
// - Its href is /e/<key>?attendees=<N> when the resolved attendee page is a
//   valid N > 1, and exactly /e/<key> (no query) on page 1.
// - The page value is the resolver's validated page, never an echo of raw
//   search text: extra/foreign params (e.g. a next= URL) do not ride along,
//   and malformed values (0, negative, fractional, non-numeric, unsafe
//   arithmetic, absolute/protocol-relative URLs) resolve to page 1, exactly
//   as the existing attendeesPaging fallback already does.
// - Positive controls: pager hrefs (attendeesPaging + rendered prev/next)
//   are unchanged, and guests/non-members still get no roster, no refresh
//   link, and no attendee read at any ?attendees= value.
//
// Assertions read only the rendered anchor href and the pre-existing
// attendeesPaging model, so the builder may carry the page through any
// validated model/render channel. Hono behaviour is out of scope here.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type {
  EventAttendee,
  EventLink,
  EventNeighbors,
  PublicEvent,
  ViewerRsvp,
} from "../src/events/reads";
import type { SuggestedEvent } from "../src/events/suggestions";
import type { KitRequestSession } from "../src/kit-session";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_ID = "100000000000000001";
const PATH = `/e/${KEY}`;
const pad = (n: number) => String(n).padStart(3, "0");
// One full page plus the lookahead row, so a next page exists wherever the
// fake store is asked: pager controls below then prove the paging surface
// itself did not move while the refresh href is pinned.
const ATTENDEES: EventAttendee[] = Array.from({ length: 101 }, (_, i) => ({
  id: `500000000000000${pad(i)}`,
  name: `refresh-attendee-${pad(i)}`,
}));

function row(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
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

const NEIGHBORS: EventNeighbors = { previous: null, next: null };
const RELATED: EventLink[] = [];
const SUGGESTIONS: SuggestedEvent[] = [];
const ANSWER: ViewerRsvp = { status: "going", syncedToDiscordAt: null };

function fakeStore(attendees: EventAttendee[] = ATTENDEES): KitEventDetailStore {
  const event = { ...row(), goingCount: attendees.length } as PublicEvent;
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: async () => NEIGHBORS,
    relatedFn: async () => RELATED,
    attendeesFn: async () => attendees,
    viewerRsvpFn: async () => ANSWER,
    waitlistFn: async () => null,
    suggestionsFn: async () => SUGGESTIONS,
  };
}

const env = { APP_URL } as unknown as Env;
const GUEST: KitRequestSession = { status: "guest", session: null };
const MEMBER: KitRequestSession = {
  status: "authenticated",
  session: { userId: MEMBER_ID, username: "member", avatar: null, member: true, moderator: false },
};
const NONMEMBER: KitRequestSession = {
  status: "authenticated",
  session: { userId: MEMBER_ID, username: "viewer", avatar: null, member: false, moderator: false },
};

async function resolveModel(
  search: string,
  session: KitRequestSession = MEMBER,
  store: KitEventDetailStore = fakeStore(),
) {
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search,
    path: PATH,
    env,
    session,
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok outcome, got ${outcome.kind}`);
  return outcome.model as unknown as Record<string, unknown> & {
    attendeesPaging: { page: number; prevHref: string | null; nextHref: string | null };
  };
}

// The real Kit presentation, SSR-compiled with the web workspace's own
// svelte/compiler and bundled by esbuild (same recipe as
// test/kit-event-detail.test.ts).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitBundle() {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-roster-refresh-"));
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
          name: "kit-roster-refresh-ssr",
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

let bundlePromise: ReturnType<typeof buildKitBundle> | undefined;
async function renderMember(search: string, store?: KitEventDetailStore) {
  bundlePromise ??= buildKitBundle();
  const { renderDetail } = await bundlePromise;
  const model = await resolveModel(search, MEMBER, store);
  return { model, html: renderDetail(model) };
}

// Every rendered refresh anchor's href, in document order. Attribute order
// is deliberately not assumed.
function refreshHrefs(html: string): (string | null)[] {
  const hrefs: (string | null)[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    if (!m[0].includes('data-testid="event-attendees-refresh"')) continue;
    hrefs.push(m[0].match(/\bhref="([^"]*)"/)?.[1] ?? null);
  }
  return hrefs;
}

function attendeePageOf(href: string | null): string | null {
  if (!href) return null;
  return new URL(href, APP_URL).searchParams.get("attendees");
}

describe("Kit roster refresh link keeps the attendee page", () => {
  it.each([2, 3])("keeps page %i on the refresh link at a middle attendee page", async (page) => {
    const { model, html } = await renderMember(`?attendees=${page}`);
    expect(model.attendeesPaging.page).toBe(page);
    expect(html).toContain(">Refresh attendees<");
    const hrefs = refreshHrefs(html);
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toBe(`${PATH}?attendees=${page}`);
    expect(attendeePageOf(hrefs[0] ?? null)).toBe(String(page));
    // Same-origin, same event: never an absolute or protocol-relative URL.
    expect(hrefs[0]).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i);
  });

  it("keeps the resolved page on a past-end page, matching attendeesPaging.page", async () => {
    const { model, html } = await renderMember("?attendees=10", fakeStore([]));
    expect(model.attendeesPaging).toMatchObject({ page: 10, prevHref: PATH, nextHref: null });
    const hrefs = refreshHrefs(html);
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toBe(`${PATH}?attendees=10`);
  });

  it("does not let foreign params ride along on the refresh href", async () => {
    const search = `?attendees=2&next=${encodeURIComponent("https://evil.example/steal")}`;
    const { html } = await renderMember(search);
    const hrefs = refreshHrefs(html);
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toBe(`${PATH}?attendees=2`);
    expect(hrefs[0]).not.toContain("evil.example");
  });

  it.each(["", "?attendees=1"])(
    "stays the bare event path on page 1 (search %j)",
    async (search) => {
      const { model, html } = await renderMember(search);
      expect(model.attendeesPaging.page).toBe(1);
      const hrefs = refreshHrefs(html);
      expect(hrefs).toHaveLength(1);
      expect(hrefs[0]).toBe(PATH);
      expect(attendeePageOf(hrefs[0] ?? null)).toBeNull();
    },
  );

  it.each([
    "0",
    "-1",
    "abc",
    "1.5",
    "2x",
    " 2",
    "",
    "999999999999999999999",
    "https://evil.example/e/other",
    "//evil.example/e/other",
    "2?attendees=3",
  ])("falls back to the bare event path for invalid/external attendees=%j", async (raw) => {
    const { model, html } = await renderMember(`?attendees=${encodeURIComponent(raw)}`);
    expect(model.attendeesPaging.page).toBe(1);
    const hrefs = refreshHrefs(html);
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toBe(PATH);
    expect(hrefs[0]).not.toContain("evil.example");
  });

  it("leaves the pager hrefs unchanged on page 2 (positive control)", async () => {
    const { model, html } = await renderMember("?attendees=2");
    expect(model.attendeesPaging).toEqual({
      page: 2,
      prevHref: PATH,
      nextHref: `${PATH}?attendees=3`,
    });
    expect(html).toContain('data-testid="event-attendees-prev"');
    expect(html).toContain('data-testid="event-attendees-next"');
    expect(html).toContain(`href="${PATH}?attendees=3"`);
    expect(html).not.toContain("refresh-attendee-100"); // lookahead never rendered
  });

  it.each([
    ["guest", GUEST],
    ["non-member", NONMEMBER],
  ] as const)(
    "%s at ?attendees=2 gets no roster, no refresh link, no attendee read",
    async (_label, session) => {
      const store = fakeStore();
      const attendeesFn = vi.fn(store.attendeesFn);
      const model = await resolveModel("?attendees=2", session, { ...store, attendeesFn });
      expect(attendeesFn).not.toHaveBeenCalled();
      expect(model.attendees).toEqual([]);
      bundlePromise ??= buildKitBundle();
      const { renderDetail } = await bundlePromise;
      const html = renderDetail(model);
      expect(html).not.toContain('data-testid="event-attendees"');
      expect(html).not.toContain('data-testid="event-attendees-refresh"');
      expect(html).not.toContain("refresh-attendee-000");
      expect(refreshHrefs(html)).toHaveLength(0);
    },
  );
});
