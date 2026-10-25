// Kit activity-log viewer port (card 38/43): the Kit route renders the Hono
// viewer contract — bounded subject/causer filters, newest-first paging with a
// one-row lookahead, stable UTC instants, legacy-ID labeling, no raw
// properties — from the same shared reads, audited by the hook's member-read
// boundary. Hono keeps ownership until the enablement review.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_LOG_PAGE_SIZE } from "../src/admin/table-list";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import {
  activityLogUnavailable,
  formatActivityCauser,
  loadActivityLogPage,
} from "../src/admin/kit-activity-log";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const env = { APP_URL: "https://example.test" } as unknown as Env;
const db = {} as unknown as Db;

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  description: "updated event Friday games",
  subjectType: "Event",
  subjectId: "01J00000000000000000000015",
  causerId: "100000000000000111",
  event: "updated",
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
  ...overrides,
});

const headersSpy = () => {
  const fn = vi.fn();
  return fn as unknown as (headers: Record<string, string>) => void;
};

describe("formatActivityCauser: snowflakes audited, legacy labeled, null silent", () => {
  it("renders a Discord snowflake verbatim so the audit names a member", () => {
    expect(formatActivityCauser("100000000000000111")).toBe("100000000000000111");
  });

  it("labels an imported legacy ID so it never reads as a Discord identity", () => {
    expect(formatActivityCauser("42")).toBe("42 (legacy ID)");
  });

  it("renders a null (cron/system) causer as an em dash with no subject", () => {
    expect(formatActivityCauser(null)).toBe("—");
  });
});

describe("loadActivityLogPage: shared filters, paging, instants, headers", () => {
  it("parses and bounds the query through the shared parser", async () => {
    const seen: unknown[] = [];
    const listFn = vi.fn(async (_db: Db, opts: unknown) => {
      seen.push(opts);
      return [];
    });
    const setHeaders = headersSpy();
    const out = await loadActivityLogPage({
      env,
      subjectParam: "  Alpha  ",
      causerParam: "  100000000000000111  ",
      pageParam: "2",
      setHeaders,
      dbForFn: async () => db,
      listFn,
    });
    expect(seen).toEqual([{ subject: "Alpha", causer: "100000000000000111", page: 2 }]);
    expect(out.query).toEqual({ subject: "Alpha", causer: "100000000000000111", page: 2 });
    expect(out.rows).toEqual([]);
    expect(out.hasNext).toBe(false);
  });

  it("prepares serializable recovery links on the server from the normalized query", async () => {
    const listFn = vi.fn(async () => []);
    const out = await loadActivityLogPage({
      env,
      subjectParam: "  Event Alpha  ",
      causerParam: "  42  ",
      pageParam: "2",
      setHeaders: headersSpy(),
      dbForFn: async () => db,
      listFn,
    });
    expect(out).toMatchObject({
      recovery: {
        clearUrl: "/admin/activity-log?page=1",
        firstUrl: "/admin/activity-log?page=1&subject=Event+Alpha&causer=42",
      },
    });
    expect(listFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("omits server recovery actions while populated rows render", async () => {
    const out = await loadActivityLogPage({
      env,
      subjectParam: "Event",
      causerParam: null,
      pageParam: "2",
      setHeaders: headersSpy(),
      dbForFn: async () => db,
      listFn: async () => [row()],
    });
    expect(out).toMatchObject({ recovery: null });
  });

  it("falls back to page 1 for unsafe page values", async () => {
    for (const pageParam of ["0", "-1", "1.5", "abc", "9007199254740993"]) {
      const listFn = vi.fn(async (_db: Db, _opts: unknown) => []);
      await loadActivityLogPage({
        env,
        subjectParam: null,
        causerParam: null,
        pageParam,
        setHeaders: headersSpy(),
        dbForFn: async () => db,
        listFn,
      });
      expect(listFn.mock.calls[0]?.[1], pageParam).toMatchObject({ page: 1 });
    }
  });

  it("slices to the page size with a one-row lookahead and renders ISO instants", async () => {
    const fetched = Array.from({ length: ACTIVITY_LOG_PAGE_SIZE + 1 }, (_, i) =>
      row({ id: i + 1, description: `row ${i}` }),
    );
    const setHeaders = headersSpy();
    const out = await loadActivityLogPage({
      env,
      subjectParam: null,
      causerParam: null,
      pageParam: null,
      setHeaders,
      dbForFn: async () => db,
      listFn: async () => fetched,
    });
    expect(out.rows).toHaveLength(ACTIVITY_LOG_PAGE_SIZE);
    expect(out.hasNext).toBe(true);
    expect(out.rows[0]?.createdAt).toBe("2026-10-01T12:00:00.000Z");
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("reports no next page at the exact page-size boundary", async () => {
    const out = await loadActivityLogPage({
      env,
      subjectParam: null,
      causerParam: null,
      pageParam: null,
      setHeaders: headersSpy(),
      dbForFn: async () => db,
      listFn: async () => Array.from({ length: ACTIVITY_LOG_PAGE_SIZE }, (_, i) => row({ id: i })),
    });
    expect(out.hasNext).toBe(false);
  });

  it("fails closed to 503 with private, no-store when there is no database", async () => {
    const setHeaders = headersSpy();
    await expect(
      loadActivityLogPage({
        env,
        subjectParam: null,
        causerParam: null,
        pageParam: null,
        setHeaders,
        dbForFn: async () => null,
        listFn: async () => [],
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("fails closed to 503 with private, no-store when the read throws", async () => {
    const setHeaders = headersSpy();
    await expect(
      loadActivityLogPage({
        env,
        subjectParam: null,
        causerParam: null,
        pageParam: null,
        setHeaders,
        dbForFn: async () => db,
        listFn: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(setHeaders).toHaveBeenCalledTimes(1);
  });

  it("fails closed to 503 with private, no-store when the db seam throws", async () => {
    const setHeaders = headersSpy();
    await expect(
      loadActivityLogPage({
        env,
        subjectParam: null,
        causerParam: null,
        pageParam: null,
        setHeaders,
        dbForFn: async () => {
          throw new Error("seam down");
        },
        listFn: async () => [],
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(setHeaders).toHaveBeenCalledTimes(1);
  });

  it("brands the outage like the Hono 503 envelope", () => {
    expect(activityLogUnavailable()).toMatchObject({ status: 503 });
  });
});

describe("loadActivityLogPage: load failures classify and alert (acceptance)", () => {
  // A code bug inside the load must never look like a downstream outage:
  // an unbranded failure emits exactly one leak-free `error.alert`
  // diagnostic (critical JSON on console.error) and still answers the
  // branded 503. A classified database-unavailable failure (transport
  // code or Postgres server-unavailable code) keeps the silent 503 — no
  // over-alerting. Each silent expectation is paired after an alerting
  // one in the same case, so a load that never alerts fails every case.
  const MARKER = "acceptance-probe-secret-marker";
  const codeBug = () => new TypeError(`${MARKER}: cannot read properties of undefined`);
  const transportDown = () =>
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const serverDown = () => {
    const err = new Error(`${MARKER}: the database system is starting up`);
    err.name = "PostgresError";
    return Object.assign(err, { code: "57P03" });
  };

  const alertLines = (): string[] =>
    vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.includes('"error.alert"'));

  const expectExactlyOneAlert = () => {
    const lines = alertLines();
    expect(lines, "expected exactly one error.alert diagnostic").toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as { event?: unknown; level?: unknown };
    expect(parsed.event).toBe("error.alert");
    expect(parsed.level).toBe("critical");
    expect(lines[0]).not.toContain(MARKER);
  };

  const loadWith = (overrides: Record<string, unknown> = {}) => {
    const setHeaders = headersSpy();
    const promise = loadActivityLogPage({
      env,
      subjectParam: null,
      causerParam: null,
      pageParam: null,
      setHeaders,
      dbForFn: async () => db,
      listFn: async () => [],
      ...overrides,
    } as Parameters<typeof loadActivityLogPage>[0]);
    return { promise, setHeaders };
  };

  const expectBranded503 = async (
    promise: ReturnType<typeof loadActivityLogPage>,
    setHeaders: ReturnType<typeof headersSpy>,
  ) => {
    await expect(promise).rejects.toMatchObject({ status: 503 });
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  };

  beforeEach(() => {
    __resetAlertRateLimitForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("listFn throwing a TypeError emits one error.alert and still answers branded 503", async () => {
    const { promise, setHeaders } = loadWith({
      listFn: async () => {
        throw codeBug();
      },
    });
    await expectBranded503(promise, setHeaders);
    expectExactlyOneAlert();
  });

  it("dbForFn throwing a TypeError emits one error.alert and still answers branded 503", async () => {
    const { promise, setHeaders } = loadWith({
      dbForFn: async () => {
        throw codeBug();
      },
    });
    await expectBranded503(promise, setHeaders);
    expectExactlyOneAlert();
  });

  it("listFn classifies: TypeError alerts, unavailable failures add no alert", async () => {
    const bug = loadWith({
      listFn: async () => {
        throw codeBug();
      },
    });
    await expectBranded503(bug.promise, bug.setHeaders);
    expectExactlyOneAlert();

    for (const unavailable of [transportDown, serverDown]) {
      const down = loadWith({
        listFn: async () => {
          throw unavailable();
        },
      });
      await expectBranded503(down.promise, down.setHeaders);
      expect(alertLines(), "unavailable failure must not over-alert").toHaveLength(1);
    }
  });

  it("dbForFn classifies: TypeError alerts, unavailable failures add no alert", async () => {
    const bug = loadWith({
      dbForFn: async () => {
        throw codeBug();
      },
    });
    await expectBranded503(bug.promise, bug.setHeaders);
    expectExactlyOneAlert();

    for (const unavailable of [transportDown, serverDown]) {
      const down = loadWith({
        dbForFn: async () => {
          throw unavailable();
        },
      });
      await expectBranded503(down.promise, down.setHeaders);
      expect(alertLines(), "unavailable failure must not over-alert").toHaveLength(1);
    }
  });
});

describe("Kit activity-log manifest: Hono-owned until the enablement review", () => {
  it("registers GET /admin/activity-log as an audited member read, still Hono-served", () => {
    const manifest = read("src/route-ownership.ts");
    expect(manifest).toMatch(/path:\s*"\/admin\/activity-log"/);
    expect(manifest).toMatch(/\/admin\/activity-log"[^}]*resource:\s*"activity_log"/);
    expect(manifest).toMatch(/\/admin\/activity-log"[^}]*action:\s*"list"/);
    expect(manifest).toMatch(/\/admin\/activity-log"[^}]*route:\s*"admin\.activity-log\.index"/);
    // Off by default: flipping enabled flips ownership, and the parity
    // ledger fails any enabled route with no executed journey covering it.
    expect(manifest).toMatch(/\/admin\/activity-log"[^}]*enabled:\s*false/);
  });
});

describe("Kit activity-log binding: thin, shared reads, outage mapped", () => {
  it("load delegates to the tested helper and maps every throw to 503", () => {
    const load = read("web/src/routes/admin/activity-log/+page.server.ts");
    expect(load).toContain("loadActivityLogPage");
    expect(load).toContain("error(503");
    expect(load).toContain("csr = false");
    expect(load).not.toMatch(/select\(|from\(|sql`/);
  });

  it("load settles the layout guard before the member-subject read", () => {
    // SvelteKit starts layout and page loads together: without awaiting
    // parent(), a guest/non-moderator request reads activity-log subjects
    // before the 302/403. The runtime order (no read while the guard is
    // pending, no read on 302/403) is pinned in kit-activity-log-load.test.mjs;
    // this pins the source contract next to the other binding pins.
    const load = read("web/src/routes/admin/activity-log/+page.server.ts");
    expect(load).toContain("await parent()");
    expect(load.indexOf("await parent()")).toBeLessThan(
      load.indexOf("return await loadActivityLogPage"),
    );
  });

  it("the helper defaults to the shared projection that never selects properties", () => {
    const helper = read("src/admin/kit-activity-log.ts");
    expect(helper).toContain("listActivityLog");
    expect(helper).toContain("parseActivityLogQuery");
    expect(helper).toContain("ACTIVITY_LOG_PAGE_SIZE");
    expect(helper).toContain("dbFor");
    expect(helper).not.toMatch(/select\(|from\(|sql`/);
    // The header comment names the never-selected column; the pin is that no
    // code path reads it off a row.
    expect(helper).not.toMatch(/\.properties/);
  });

  it("the Hono page shares the Kit legacy-ID formatter: one copy, zero drift", () => {
    expect(read("src/admin/pages/activity-log.tsx")).toContain("formatActivityCauser");
    expect(read("src/admin/pages/activity-log.tsx")).not.toContain("SNOWFLAKE_ID");
  });
});

describe("Kit activity-log page: Hono markup contract, no island, no payload", () => {
  const page = () => read("web/src/routes/admin/activity-log/+page.svelte");

  it("keeps the heading, hint, filter form and table contract", () => {
    for (const needle of [
      "<h1>Activity log</h1>",
      "Views that name a member are access-logged",
      'method="get"',
      'action="/admin/activity-log"',
      'for="subject">Subject',
      'for="causer">Causer',
      ">Filter</button>",
      'data-testid="activity-log-table"',
      'data-testid="activity-log-empty"',
      'data-testid="activity-log-table-scroll"',
      'aria-label="Activity log list"',
      'aria-describedby="activity-log-scroll-hint"',
      'aria-label="Activity pages"',
      "<time",
      "datetime=",
      "Page {",
      'rel="prev"',
      'rel="next"',
    ]) {
      expect(page()).toContain(needle);
    }
  });

  it("derives empty copy, paging links and legacy labels from the shared helpers", () => {
    for (const needle of ["activityLogEmptyText", "activityLogUrl", "formatActivityCauser"]) {
      expect(page()).toContain(needle);
    }
  });

  it("renders inside the admin chrome with its own title and never indexes", () => {
    expect(page()).toContain('<AdminShell title="Activity log">');
    expect(read("web/src/lib/AdminShell.svelte")).toContain("noindex");
  });

  it("ships no island and never expands the raw properties payload", () => {
    expect(page()).not.toContain("/islands/");
    expect(page()).not.toContain("properties");
    expect(page()).not.toContain("before");
  });

  it("justifies its one a11y-ignore: the scroll region stays keyboard-focusable", () => {
    // Hono parity: the region keeps tabindex="0" so keyboard users can scroll
    // it (axe scrollable-region-focusable requires it); the ignore carries its
    // reason inline so it can never become a bare suppression.
    expect(page()).toContain("svelte-ignore a11y_no_noninteractive_tabindex");
    expect(page()).toContain("keyboard-focusable");
    expect(page()).toContain('tabindex="0"');
  });

  it("the group outlet carries no chrome of its own: children own their titles", () => {
    expect(read("web/src/routes/admin/+layout.svelte")).not.toContain('title="Dashboard"');
    expect(read("web/src/routes/admin/+page.svelte")).toContain('<AdminShell title="Dashboard">');
  });
});

describe("Kit parity gates record the activity-log slice as Hono-owned", () => {
  it("inventories the route with its reads class and enablement state", () => {
    const gates = read("docs/kit-parity-gates.md");
    expect(gates).toContain("GET /admin/activity-log");
    expect(gates).toContain("admin.activity-log.index");
    expect(gates).toContain("`enabled: false`");
  });
});
