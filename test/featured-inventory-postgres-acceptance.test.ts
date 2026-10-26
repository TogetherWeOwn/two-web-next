// FI-SQL: filtering after LIMIT, Date-rounded comparisons, lost rows, N+1 reads and writes break these cases.
// Requires DATABASE_URL accepted by the existing disposable-test guard; never silently skips.
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { listFeatured } from "../src/admin/store-featured";
import { adminSchema, schema, type Db } from "../src/db";
import { featuredContents } from "../src/db/admin-schema";
import { listVisibleFeatured } from "../src/featured";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  INVENTORY_NOW,
  INVENTORY_STATES,
  INVENTORY_TWINS,
  inventoryIds,
  loadKitInventory,
  type InventoryState,
  type InventoryTwin,
} from "./helpers/featured-inventory-acceptance";

const AT = "2032-04-05 12:00:00.123000+00";
const AFTER = "2032-04-05 12:00:00.123001+00";
const BEFORE = "2032-04-05 12:00:00.122999+00";
// Literal independent verdicts, including SQL microseconds that JavaScript Dates cannot carry.
const WINDOWS: {
  name: string;
  start: string | null;
  end: string | null;
  published: boolean;
  state: InventoryState;
}[] = [
  { name: "Open", start: null, end: null, published: true, state: "live" },
  { name: "Exact start", start: AT, end: null, published: true, state: "live" },
  { name: "Exact end", start: null, end: AT, published: true, state: "expired" },
  { name: "Start plus microsecond", start: AFTER, end: null, published: true, state: "scheduled" },
  { name: "End plus microsecond", start: null, end: AFTER, published: true, state: "live" },
  { name: "Start minus microsecond", start: BEFORE, end: null, published: true, state: "live" },
  { name: "End minus microsecond", start: null, end: BEFORE, published: true, state: "expired" },
  {
    name: "Future",
    start: "2032-04-06 12:00:00+00",
    end: null,
    published: true,
    state: "scheduled",
  },
  { name: "Past", start: null, end: "2032-04-04 12:00:00+00", published: true, state: "expired" },
  { name: "Draft future", start: AFTER, end: null, published: false, state: "unpublished" },
  { name: "Infinite start", start: "infinity", end: null, published: true, state: "unavailable" },
  { name: "Infinite end", start: null, end: "-infinity", published: true, state: "unavailable" },
  {
    name: "Draft undecodable",
    start: "infinity",
    end: "-infinity",
    published: false,
    state: "unpublished",
  },
  {
    name: "Outside Date range",
    start: "294276-01-01 00:00:00+00",
    end: null,
    published: true,
    state: "unavailable",
  },
];

describe("featured effective-state inventory (owned disposable schema)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  let cookie: string;
  const sessions = createMemorySessionStore();
  const statements: { sql: string; params: unknown[] }[] = [];
  let advanceOnInventory = false;
  let inserted: { id: number; name: string; state: InventoryState }[];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error(
        "FI-ENV-DB: set the README-approved disposable DATABASE_URL; no tests executed against another target",
      );
    fixture = await createMemberDataFixture(process.env.DATABASE_URL);
    db = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: {
        logQuery: (sql, params) => {
          statements.push({ sql, params });
          // Advance only once SQL has been built: the row must retain that read's verdict.
          if (advanceOnInventory && /from "featured_contents"/.test(sql)) {
            vi.setSystemTime(new Date(INVENTORY_NOW.getTime() + 2000));
          }
        },
      },
    });
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(INVENTORY_NOW);
    await fixture.db.delete(featuredContents);
    cookie = await cookieFor(sessions, MODERATOR);
    inserted = [];
    advanceOnInventory = false;
    statements.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  async function seedWindows() {
    for (const [position, item] of WINDOWS.entries()) {
      const [saved] = await fixture.client`
        insert into featured_contents (title, position, is_published, starts_at, ends_at)
        values (${item.name}, ${position}, ${item.published}, ${item.start}::timestamptz, ${item.end}::timestamptz)
        returning id`;
      inserted.push({ id: saved!.id, name: item.name, state: item.state });
    }
  }

  async function render(twin: InventoryTwin, search = "") {
    if (twin === "Kit") {
      const result = await loadKitInventory(search, db);
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.dbReads).toBe(1);
      return result.html;
    }
    const response = await adminApp({ sessionStore: sessions, db }).request(
      `/featured${search}`,
      { headers: { cookie } },
      { ...env, ADMIN_DB: db },
    );
    expect(
      response.status,
      "FI-ROW-LOSS: a malformed window must not turn healthy inventory into an outage",
    ).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    return response.text();
  }

  it.each(INVENTORY_STATES)(
    "FI-SQL01-%s: classify at saved precision before SQL lookahead",
    async (state) => {
      await seedWindows();
      const opts = { state, q: "" };
      const rows = await listFeatured(db, opts);
      expect(rows.map((row) => row.id)).toEqual(
        inserted.filter((row) => row.state === state).map((row) => row.id),
      );
    },
  );

  for (const twin of INVENTORY_TWINS) {
    it(`${twin} FI-SQL02: All keeps healthy, infinite and out-of-range rows inspectable`, async () => {
      await seedWindows();
      const html = await render(twin);
      expect(inventoryIds(html)).toEqual(inserted.map((row) => row.id));
      for (const row of inserted) {
        const statusCell = html.match(
          new RegExp(`data-testid="featured-status-${row.id}"[^>]*>([\\s\\S]*?)</td>`),
        )?.[1];
        expect(statusCell, row.name).toContain(`data-status="${row.state}"`);
        expect(html).toContain(`/admin/featured/${row.id}`);
      }
      for (const match of html.matchAll(/datetime="([^"]+)"/g))
        expect(Number.isFinite(Date.parse(match[1]!)), match[1]).toBe(true);
      expect(html).toContain("infinity");
      expect(html).toContain("-infinity");
    });

    it(`${twin} FI-SQL03: facet intersections and 25+1 apply before paging, not to the first raw page`, async () => {
      const values = [
        ...Array.from({ length: 31 }, (_, position) => ({
          title: `Night scheduled ${position}`,
          isPublished: true,
          position,
          startsAt: new Date("2032-04-06T00:00:00Z"),
        })),
        ...Array.from({ length: 52 }, (_, position) => ({
          title: `Night live ${position}`,
          isPublished: true,
          position: 100,
          startsAt: null,
        })),
        { title: "Day unrelated", isPublished: true, position: 100, startsAt: null },
        { title: "Night draft", isPublished: false, position: 100, startsAt: null },
      ];
      const rows = await fixture.db
        .insert(featuredContents)
        .values(values)
        .returning({ id: featuredContents.id, title: featuredContents.title });
      const liveIds = rows
        .filter((row) => row.title.startsWith("Night live"))
        .map((row) => row.id)
        .sort((a, b) => a - b);
      const opts = { state: "live", published: true, q: "Night", page: 1 };
      expect((await listFeatured(db, opts)).map((row) => row.id)).toEqual(liveIds.slice(0, 26));
      const second = await render(twin, "?state=live&published=1&q=Night&page=2");
      expect(inventoryIds(second)).toEqual(liveIds.slice(25, 50));
      expect(second).toMatch(/rel="next"/);
      const third = await render(twin, "?state=live&published=1&q=Night&page=3");
      expect(inventoryIds(third)).toEqual(liveIds.slice(50));
      expect(third).not.toMatch(/rel="next"/);
      expect(third).toMatch(/rel="prev"/);
      const contradictory = await render(twin, "?state=live&published=0&q=Night");
      expect(inventoryIds(contradictory)).toEqual([]);
      expect(contradictory).toMatch(/matches these filters/i);
    });

    it(`${twin} FI-SQL07: one evaluation instant survives clock movement while the inventory is awaited`, async () => {
      const [saved] = await fixture.db
        .insert(featuredContents)
        .values({
          title: "Boundary crossed during read",
          isPublished: true,
          startsAt: new Date(INVENTORY_NOW.getTime() + 1000),
        })
        .returning({ id: featuredContents.id });
      advanceOnInventory = true;
      const html = await render(twin, "?state=scheduled");
      expect(inventoryIds(html)).toEqual([saved!.id]);
      expect(
        html.match(
          new RegExp(`data-testid="featured-status-${saved!.id}"[^>]*>([\\s\\S]*?)</td>`),
        )?.[1],
      ).toContain('data-status="scheduled"');
    });

    it(`${twin} FI-SQL04-CONTROL: one bounded classified inventory read, no row reads or audit/write effects`, async () => {
      await fixture.db.insert(featuredContents).values(
        Array.from({ length: 26 }, (_, i) => ({
          title: `Safe ${i}`,
          isPublished: true,
          position: 2,
        })),
      );
      statements.length = 0;
      const html = await render(twin, "?state=live");
      expect(inventoryIds(html)).toHaveLength(25);
      const reads = statements.filter((statement) =>
        /from "featured_contents"/.test(statement.sql),
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]!.params).toContain(26);
      expect(
        statements.filter((statement) => /set_config|SET LOCAL/.test(statement.sql)),
      ).toHaveLength(1);
      expect(
        statements.some((statement) => /(?:insert into|update |delete from)/i.test(statement.sql)),
      ).toBe(false);
      const [activityCount] =
        await fixture.client`select count(*)::int as activities from activity_log`;
      const [accessCount] =
        await fixture.client`select count(*)::int as accesses from member_data_access_logs`;
      expect({ activities: activityCount!.activities, accesses: accessCount!.accesses }).toEqual({
        activities: 0,
        accesses: 0,
      });
    });
  }

  it("FI-SQL05: malformed saved text remains exact and the inventory read never rewrites windows", async () => {
    await seedWindows();
    const snapshot = () =>
      fixture.client`select id, starts_at::text as start, ends_at::text as end from featured_contents order by id`;
    const before = await snapshot();
    const rows = await listFeatured(db, {});
    for (const [name, field, exact] of [
      ["Infinite start", "startsAtText", "infinity"],
      ["Infinite end", "endsAtText", "-infinity"],
    ] as const) {
      const id = inserted.find((row) => row.name === name)!.id;
      expect(rows.find((row) => row.id === id)).toHaveProperty(field, exact);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("FI-SQL06-CONTROL: legacy public selection remains independent of admin facet browsing", async () => {
    await fixture.db.insert(featuredContents).values([
      { title: "Guest live", isPublished: true, startsAt: INVENTORY_NOW },
      { title: "Guest draft", isPublished: false },
      { title: "Guest scheduled", isPublished: true, startsAt: new Date("2032-04-06T00:00:00Z") },
      { title: "Guest ended", isPublished: true, endsAt: INVENTORY_NOW },
    ]);
    expect((await listVisibleFeatured(db, INVENTORY_NOW)).map((row) => row.title)).toEqual([
      "Guest live",
    ]);
    await listFeatured(db, { state: "unpublished" } as Parameters<typeof listFeatured>[1]);
    expect((await listVisibleFeatured(db, INVENTORY_NOW)).map((row) => row.title)).toEqual([
      "Guest live",
    ]);
  });
});
