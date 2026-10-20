// Acceptance pins for the Kit moderator event-edit read
// (GET /admin/events/:key through resolveKitEventEdit plus the Svelte page
// and load under web/src/routes/admin/events/[key]/). These rows cover the
// moderator-visible behaviours the unit suites do not pin end to end:
// roster page boundaries at exact page multiples and past the end, the
// wall-clock fill across DST folds and gaps, the full status-transition
// admission table, duplicate reads/rows/params, audit-failure refusal with
// no roster leak, and the no-JS form semantics a browser without scripts
// relies on. Hermetic by construction: the resolver deps are fakes and the
// page pins are source-text, because the root Vitest suite cannot compile
// .svelte. No database, staging or production data is touched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditOutcome,
  type KitEventEditRosterRow,
  type KitEventEditRow,
  type KitEventEditView,
} from "../src/admin/kit-event-edit";
import { ROSTER_PAGE_SIZE } from "../src/admin/table-list";

const db = {} as Db;
const now = new Date("2026-06-15T12:00:00.000Z");
const answeredAt = new Date("2026-06-01T12:00:00.000Z");

const baseRow: KitEventEditRow = {
  eventKey: "EVTACC868",
  title: "Acceptance night",
  game: "Chess",
  description: "Casual play",
  startsAt: new Date("2026-07-01T19:00:00.000Z"),
  endsAt: new Date("2026-07-01T21:00:00.000Z"),
  timezone: "Europe/London",
  location: "Hall",
  capacity: 8,
  status: "draft",
  rsvpOpen: true,
  recurrenceFrequency: null,
};

function rows(n: number): KitEventEditRosterRow[] {
  return Array.from({ length: n }, (_, i) => ({
    username: `member-${i}`,
    status: "going",
    answeredAt,
  }));
}

function depsFor(overrides: Partial<KitEventEditDeps> = {}): KitEventEditDeps {
  return {
    db,
    get: async () => ({ ...baseRow }),
    list: async () => ({ rows: rows(2), total: 2 }),
    now,
    ...overrides,
  };
}

async function okView(
  rawQuery: Parameters<typeof resolveKitEventEdit>[1] = {},
  overrides: Partial<KitEventEditDeps> = {},
): Promise<KitEventEditView> {
  const outcome: KitEventEditOutcome = await resolveKitEventEdit(
    baseRow.eventKey,
    rawQuery,
    depsFor(overrides),
  );
  if (outcome.kind !== "ok") throw new Error(`expected ok view, got ${outcome.kind}`);
  return outcome.view;
}

describe("acceptance: roster paging boundaries", () => {
  it("an exactly-full final page offers no next page (total = page * page size)", async () => {
    const view = await okView(
      { roster_page: "2" },
      { list: async () => ({ rows: rows(ROSTER_PAGE_SIZE), total: 2 * ROSTER_PAGE_SIZE }) },
    );
    expect(view.roster.rangeStart).toBe(ROSTER_PAGE_SIZE + 1);
    expect(view.roster.rangeEnd).toBe(2 * ROSTER_PAGE_SIZE);
    expect(view.roster.hasNext).toBe(false);
    expect(view.roster.nextUrl).toBeNull();
    expect(view.roster.hasPrev).toBe(true);
    // Page 1 stays bare: the previous link resets the roster like Hono.
    expect(view.roster.prevUrl).not.toContain("roster_page");
    expect(view.roster.prevUrl).toContain("#rsvp-roster");
  });

  it("one row past an exact multiple opens the next page and preserves search/sort", async () => {
    const view = await okView(
      { roster_page: "2", roster_q: "ann", roster_sort: "status", roster_order: "asc" },
      { list: async () => ({ rows: rows(ROSTER_PAGE_SIZE), total: 2 * ROSTER_PAGE_SIZE + 1 }) },
    );
    expect(view.roster.hasNext).toBe(true);
    expect(view.roster.nextUrl).toContain("roster_page=3");
    expect(view.roster.nextUrl).toContain("roster_q=ann");
    expect(view.roster.nextUrl).toContain("roster_sort=status");
    expect(view.roster.nextUrl).toContain("roster_order=asc");
    expect(view.roster.nextUrl).toContain("#rsvp-roster");
    expect(view.roster.prevUrl).not.toContain("roster_page");
    expect(view.roster.prevUrl).toContain("roster_q=ann");
    expect(view.roster.prevUrl).toContain("roster_sort=status");
    expect(view.roster.prevUrl).toContain("roster_order=asc");
  });

  it("a past-end page renders empty with a zero range and working previous navigation", async () => {
    const view = await okView({ roster_page: "5" }, { list: async () => ({ rows: [], total: 2 }) });
    expect(view.roster.entries).toEqual([]);
    expect(view.roster.rangeStart).toBe(0);
    expect(view.roster.rangeEnd).toBe(0);
    expect(view.roster.emptyText).toBe("No RSVPs on this page.");
    expect(view.roster.hasPrev).toBe(true);
    expect(view.roster.prevUrl).toContain("roster_page=4");
    expect(view.roster.hasNext).toBe(false);
    expect(view.roster.nextUrl).toBeNull();
  });

  it("a single exactly-full first page reports range 1..pageSize and no next page", async () => {
    const view = await okView(
      {},
      { list: async () => ({ rows: rows(ROSTER_PAGE_SIZE), total: ROSTER_PAGE_SIZE }) },
    );
    expect(view.roster.rangeStart).toBe(1);
    expect(view.roster.rangeEnd).toBe(ROSTER_PAGE_SIZE);
    expect(view.roster.hasNext).toBe(false);
    expect(view.roster.hasPrev).toBe(false);
    expect(view.roster.prevUrl).toBeNull();
  });
});

describe("acceptance: DST fold and gap wall fill", () => {
  it("fold (Europe/London): the two instants an hour apart fill the same wall text, storage intact", async () => {
    // 2026-10-25 clocks fall back 02:00 BST -> 01:00 GMT, so 01:30 occurs twice.
    const first = await okView(
      {},
      {
        get: async () => ({
          ...baseRow,
          startsAt: new Date("2026-10-25T00:30:00.000Z"),
          endsAt: new Date("2026-10-25T01:30:00.000Z"),
        }),
      },
    );
    expect(first.values.starts_at).toBe("2026-10-25 01:30");
    expect(first.values.ends_at).toBe("2026-10-25 01:30");
    // The identical wall strings must not collapse the stored instant.
    expect(first.endsAt).toBe("2026-10-25T01:30:00.000Z");
  });

  it("gap (Europe/London): instants straddling spring-forward skip the missing hour", async () => {
    // 2026-03-29 clocks jump 01:00 GMT -> 02:00 BST; 01:xx never occurs.
    const view = await okView(
      {},
      {
        get: async () => ({
          ...baseRow,
          startsAt: new Date("2026-03-29T00:59:00.000Z"),
          endsAt: new Date("2026-03-29T01:00:00.000Z"),
        }),
      },
    );
    expect(view.values.starts_at).toBe("2026-03-29 00:59");
    expect(view.values.ends_at).toBe("2026-03-29 02:00");
  });

  it("gap (America/New_York): instants straddling spring-forward skip the missing hour", async () => {
    // 2026-03-08 clocks jump 02:00 EST -> 03:00 EDT; 02:xx never occurs.
    const view = await okView(
      {},
      {
        get: async () => ({
          ...baseRow,
          timezone: "America/New_York",
          startsAt: new Date("2026-03-08T06:59:00.000Z"),
          endsAt: new Date("2026-03-08T07:00:00.000Z"),
        }),
      },
    );
    expect(view.values.starts_at).toBe("2026-03-08 01:59");
    expect(view.values.ends_at).toBe("2026-03-08 03:00");
    expect(view.values.timezone).toBe("America/New_York");
  });

  it("fold (America/New_York): both occurrences of the repeated hour fill identically", async () => {
    // 2026-11-01 clocks fall back 02:00 EDT -> 01:00 EST.
    const earlier = await okView(
      {},
      {
        get: async () => ({
          ...baseRow,
          timezone: "America/New_York",
          startsAt: new Date("2026-11-01T05:30:00.000Z"),
          endsAt: new Date("2026-11-01T06:30:00.000Z"),
        }),
      },
    );
    expect(earlier.values.starts_at).toBe("2026-11-01 01:30");
    expect(earlier.values.ends_at).toBe("2026-11-01 01:30");
    expect(earlier.endsAt).toBe("2026-11-01T06:30:00.000Z");
  });
});

describe("acceptance: full transition-admission matrix", () => {
  const live = new Date(now.getTime() + 3600_000);
  const ended = new Date(now.getTime() - 3600_000);
  const cases: Array<{
    status: string;
    rsvpOpen: boolean;
    endsAt: Date;
    publish: boolean;
    cancel: boolean;
    rsvp: KitEventEditView["rsvpAction"];
  }> = [
    { status: "draft", rsvpOpen: true, endsAt: live, publish: true, cancel: true, rsvp: null },
    { status: "draft", rsvpOpen: false, endsAt: live, publish: true, cancel: true, rsvp: null },
    { status: "draft", rsvpOpen: true, endsAt: ended, publish: true, cancel: true, rsvp: null },
    {
      status: "published",
      rsvpOpen: true,
      endsAt: live,
      publish: false,
      cancel: true,
      rsvp: "rsvp-pause",
    },
    {
      status: "published",
      rsvpOpen: false,
      endsAt: live,
      publish: false,
      cancel: true,
      rsvp: "rsvp-reopen",
    },
    {
      status: "published",
      rsvpOpen: true,
      endsAt: ended,
      publish: false,
      cancel: true,
      rsvp: null,
    },
    {
      status: "published",
      rsvpOpen: false,
      endsAt: ended,
      publish: false,
      cancel: true,
      rsvp: null,
    },
    // Boundary: an event ending exactly now is no longer live (endsAt > now).
    { status: "published", rsvpOpen: true, endsAt: now, publish: false, cancel: true, rsvp: null },
    {
      status: "cancelled",
      rsvpOpen: true,
      endsAt: live,
      publish: false,
      cancel: false,
      rsvp: null,
    },
    {
      status: "cancelled",
      rsvpOpen: false,
      endsAt: ended,
      publish: false,
      cancel: false,
      rsvp: null,
    },
    // An unrecognised status admits nothing: no transition may leak through.
    { status: "archived", rsvpOpen: true, endsAt: live, publish: false, cancel: false, rsvp: null },
  ];

  it.each(cases)(
    "$status rsvpOpen=$rsvpOpen endsAt=$endsAt -> publish=$publish cancel=$cancel rsvp=$rsvp",
    async (c) => {
      const view = await okView(
        {},
        {
          get: async () => ({
            ...baseRow,
            status: c.status,
            rsvpOpen: c.rsvpOpen,
            startsAt: new Date(c.endsAt.getTime() - 7200_000),
            endsAt: c.endsAt,
          }),
        },
      );
      expect(view.showPublish).toBe(c.publish);
      expect(view.showCancel).toBe(c.cancel);
      expect(view.rsvpAction).toBe(c.rsvp);
    },
  );
});

describe("acceptance: duplicate submits, rows and params", () => {
  it("repeating the identical read (a duplicate submit of the page) is idempotent and side-effect free", async () => {
    const stored = { ...baseRow };
    const startsBefore = stored.startsAt.getTime();
    const get = vi.fn(async () => stored);
    const list = vi.fn(async () => ({ rows: rows(2), total: 2 }));
    const rawQuery = Object.freeze({ roster_page: "1", roster_q: "ann" });
    const deps = depsFor({ get, list });
    const first = await resolveKitEventEdit(baseRow.eventKey, rawQuery, deps);
    const second = await resolveKitEventEdit(baseRow.eventKey, rawQuery, deps);
    expect(second).toEqual(first);
    expect(get).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    // The read model mutates neither the stored row nor the raw query.
    expect(stored.startsAt.getTime()).toBe(startsBefore);
    expect(rawQuery).toEqual({ roster_page: "1", roster_q: "ann" });
  });

  it("duplicate roster rows render 1:1 in order — the view never dedupes a roster", async () => {
    const dup: KitEventEditRosterRow = { username: "sam", status: "going", answeredAt };
    const view = await okView(
      {},
      { list: async () => ({ rows: [{ ...dup }, { ...dup }, { ...dup }], total: 3 }) },
    );
    expect(view.roster.total).toBe(3);
    expect(view.roster.entries).toEqual([
      { member: "sam", status: "going", answeredAt: answeredAt.toISOString() },
      { member: "sam", status: "going", answeredAt: answeredAt.toISOString() },
      { member: "sam", status: "going", answeredAt: answeredAt.toISOString() },
    ]);
    expect(view.roster.rangeStart).toBe(1);
    expect(view.roster.rangeEnd).toBe(3);
  });
});

describe("acceptance: audit/read failure refuses with no roster leak", () => {
  it("a roster-list failure rejects the whole read: no partial view is produced", async () => {
    const failure = new Error("audit sink refused the roster read");
    await expect(
      resolveKitEventEdit(
        baseRow.eventKey,
        {},
        depsFor({
          list: async () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);
  });

  it("an event-read failure never reaches the roster read", async () => {
    const failure = new Error("event read exploded");
    const list = vi.fn(async () => ({ rows: rows(1), total: 1 }));
    await expect(
      resolveKitEventEdit(
        baseRow.eventKey,
        {},
        depsFor({
          get: async () => {
            throw failure;
          },
          list,
        }),
      ),
    ).rejects.toBe(failure);
    expect(list).not.toHaveBeenCalled();
  });

  it("a classified outage on the roster read answers bare unavailable — no roster bytes, no error detail", async () => {
    const outage = Object.assign(
      new Error("connect ECONNREFUSED while listing member secret-roster-name"),
      { code: "ECONNREFUSED" },
    );
    const outcome = await resolveKitEventEdit(
      baseRow.eventKey,
      {},
      depsFor({
        list: async () => {
          throw outage;
        },
      }),
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("secret-roster-name");
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain(baseRow.title);
  });
});

const pageSource = readFileSync(
  fileURLToPath(new URL("../web/src/routes/admin/events/[key]/+page.svelte", import.meta.url).href),
  "utf8",
);
// The cancel control lives in the shared TerminalReview disclosure, rendered
// by the page; no-JS counts must see through that component boundary.
const terminalReviewSource = readFileSync(
  fileURLToPath(new URL("../web/src/lib/TerminalReview.svelte", import.meta.url).href),
  "utf8",
);
const loadSource = readFileSync(
  fileURLToPath(
    new URL("../web/src/routes/admin/events/[key]/+page.server.ts", import.meta.url).href,
  ),
  "utf8",
);

describe("acceptance: duplicate query params resolve first-wins in the load", () => {
  it("the load keeps the first value per key, never the last duplicate", () => {
    expect(loadSource).toContain("if (!(k in raw)) raw[k] = v;");
    // The load's comment names the last-wins alternative it avoids; pin that
    // it is never actually assigned from.
    expect(loadSource).not.toMatch(/=\s*Object\.fromEntries\(url\.searchParams\)/);
  });
});

describe("acceptance: no-JS behaviour", () => {
  it("ships server-rendered only: the load disables client-side rendering", () => {
    expect(loadSource).toContain("export const csr = false;");
  });

  it("every control works without scripts: real forms, submit buttons and anchor navigation", () => {
    // The page must actually render the shared cancel control; the counts
    // below would otherwise stay green if it were dropped.
    expect(pageSource).toContain("<TerminalReview");
    // Five forms: edit update, publish, cancel (inside TerminalReview),
    // RSVP toggle, roster search.
    const rendered = pageSource + terminalReviewSource;
    expect(rendered.match(/<form\b/g) ?? []).toHaveLength(5);
    expect(rendered.match(/method="post"/g) ?? []).toHaveLength(4);
    expect(rendered.match(/method="get"/g) ?? []).toHaveLength(1);
    // Every button submits its form; nothing depends on a click handler.
    expect(rendered.match(/<button\b/g) ?? []).toHaveLength(5);
    expect(rendered.match(/<button[^>]*type="submit"/g) ?? []).toHaveLength(5);
    expect(rendered).not.toMatch(/\son(click|submit|input|change|keydown)=/);
    expect(pageSource).not.toContain("on:");
    // The shared control's `action: string` prop contains a bare "on:", so
    // legacy Svelte directives there need a markup-precise check instead.
    expect(terminalReviewSource).not.toMatch(/\son:\w+/);
    // Sorting and paging are plain links a no-JS browser can follow.
    expect(pageSource).toContain("<a href={h.url}");
    expect(pageSource).toContain('<a rel="prev" href={roster.prevUrl}>');
    expect(pageSource).toContain('<a rel="next" href={roster.nextUrl}>');
  });

  it("the roster search is a GET form carrying its state in named fields", () => {
    expect(pageSource).toContain('name="roster_q"');
    expect(pageSource).toContain('type="search"');
    // Sort state rides along as hidden fields so a no-JS search keeps it.
    expect(pageSource).toContain('name="roster_sort"');
    expect(pageSource).toContain('name="roster_order"');
  });
});
