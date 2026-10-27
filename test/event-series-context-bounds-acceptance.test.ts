// route-inventory: GET /e/:key
// Acceptance corrections: execute the real SELECT on disposable PostgreSQL.
// No fake prefilters statuses/roots, clips rows, or truncates projected text.
// The pg-proxy bridge preserves raw timestamp strings for Drizzle to decode,
// and records PostgreSQL's actual projected rows/bytes before application code.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { kitEventDetailStore, resolveKitEventDetail } from "../src/events/kit-detail";
import { getEventSeriesContext, type SeriesEventRef } from "../src/events/reads";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { renderSeriesDetail } from "./helpers/event-series-context-render";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const key = (id: number) => String(id).padStart(26, "0");
const ROOT: SeriesEventRef = {
  id: 10,
  parentEventId: null,
  recurrenceFrequency: "weekly",
  recurrenceIndex: 1,
  organizer_name: "Root host",
};
const CURRENT: SeriesEventRef = {
  id: 12,
  parentEventId: 10,
  recurrenceFrequency: null,
  recurrenceIndex: 3,
  organizer_name: "Current host",
};

type Trace = {
  sql: string;
  params: unknown[];
  rows: unknown[][];
  raw: (string | null)[][];
  columns: string[];
  bytes: number;
};
let fixture: MemberDataFixture;
let db: Db;
const traces: Trace[] = [];
const seriesReads = () =>
  traces.filter((q) => /\bwhere\b[\s\S]*"parent_event_id"\s*(?:=|in\b)/i.test(q.sql));
const env = () =>
  ({
    APP_URL,
    SESSION_SECRET,
    ADMIN_DB: db,
    SESSION_STORE: createMemorySessionStore(),
  }) as unknown as Env;

async function insert(
  id: number,
  over: {
    parent?: number | null;
    index?: number;
    status?: string;
    host?: string | null;
    start?: string;
    description?: string | null;
    title?: string;
    timezone?: string;
    location?: string | null;
  } = {},
) {
  const start =
    over.start ?? `2035-01-${String(id === 10 ? 1 : id - 8).padStart(2, "0")}T20:00:00Z`;
  await fixture.client`
    insert into events (id, event_key, title, starts_at, ends_at, timezone, location,
      organizer_name, status, parent_event_id, recurrence_index, recurrence_frequency,
      description, join_url, join_instructions)
    values (${id}, ${key(id)}, ${over.title ?? `Occurrence ${id}`}, ${start}::timestamptz,
      ${start}::timestamptz + interval '2 hours', ${over.timezone ?? "UTC"},
      ${over.location === undefined ? "Voice" : over.location},
      ${over.host === undefined ? `Host ${id}` : over.host}, ${over.status ?? "published"},
      ${over.parent === undefined ? (id === 10 ? null : 10) : over.parent},
      ${over.index ?? id - 9}, ${id === 10 ? "weekly" : null}, ${over.description ?? null},
      'https://example.test/private-join', 'unused join instructions')
  `;
}

async function smallRun() {
  await insert(10, { host: "Root host" });
  await insert(11, { host: "Previous host" });
  await insert(12, { host: "Current host" });
  await insert(13, { host: "Next host" });
}

async function kit(id = 12) {
  const configured = env();
  const outcome = await resolveKitEventDetail({
    key: key(id),
    search: "",
    path: `/e/${key(id)}`,
    env: configured,
    session: { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store: kitEventDetailStore(configured),
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error(`Expected ok, got ${outcome.kind}`);
  return outcome.model;
}

async function hono(id = 12) {
  const response = await app.request(`/e/${key(id)}`, {}, env());
  expect(response.status).toBe(200);
  return response.text();
}

function hosts(html: string) {
  return html.match(/data-testid="event-series-hosts"[^>]*>([^<]*)<\/p>/)?.[1] ?? null;
}
function nav(html: string) {
  return html.match(/<nav[^>]*data-testid="event-series-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
}

beforeAll(async () => {
  // Always execute these proofs. CI supplies its approved disposable URL;
  // local runs default to the passwordless test host, never a remote database.
  fixture = await createMemberDataFixture(
    process.env.DATABASE_URL ?? "postgres://agent_test@agent-testdb:5432/postgres",
  );
  db = drizzle(async (sql, params) => {
    const raw = await fixture.client.unsafe(sql, params as never[]).raw();
    const rows = raw.map((values) =>
      values.map((value, index) => {
        if (value === null) return null;
        const column = raw.columns[index]!;
        const text = value.toString();
        // Driver Date conversion would discard the raw out-of-range timestamp.
        // pg-proxy's Drizzle timestamp decoder must see PostgreSQL's real text.
        return [1114, 1184].includes(column.type)
          ? text
          : column.parser
            ? column.parser(text)
            : text;
      }),
    );
    traces.push({
      sql,
      params,
      rows,
      raw: raw.map((r) => r.map((v) => (v === null ? null : v.toString()))),
      columns: raw.columns.map((c) => c.name),
      bytes: raw.reduce((sum, r) => sum + r.reduce((n, v) => n + (v?.byteLength ?? 0), 0), 0),
    });
    return { rows };
  }) as unknown as Db;
});
afterAll(async () => {
  await fixture?.dispose();
});
beforeEach(async () => {
  await fixture.reset();
  traces.length = 0;
});

describe("series timestamp and historical visibility through production reads", () => {
  it.each(["shared read", "production Kit resolver", "Hono route"])(
    "drops a raw year-280000 sibling before hosts and adjacency: %s",
    async (path) => {
      await smallRun();
      await fixture.client`update events set recurrence_index = 5 where id = 13`;
      await insert(14, { index: 4, start: "280000-01-01 20:00:00+00", host: "Invalid-date host" });
      // Establish the fixture is finite in PostgreSQL but outside JS Date range.
      const [raw] =
        await fixture.client`select starts_at::text as stamp, isfinite(starts_at) as finite from events where id = 14`;
      expect(raw!.stamp).toBe("280000-01-01 20:00:00+00");
      expect(raw!.finite).toBe(true);
      expect(Number.isFinite(new Date(raw!.stamp).getTime())).toBe(false);
      if (path === "shared read") {
        const context = await getEventSeriesContext(db, CURRENT);
        expect(context?.hosts).toEqual(["Current host", "Root host", "Previous host", "Next host"]);
        expect(context?.previous?.eventKey).toBe(key(11));
        expect(context?.next?.eventKey).toBe(key(13));
      } else if (path === "production Kit resolver") {
        const model = await kit();
        expect(model.series?.hosts).toEqual([
          "Current host",
          "Root host",
          "Previous host",
          "Next host",
        ]);
        expect(model.series?.previous?.key).toBe(key(11));
        expect(model.series?.next?.key).toBe(key(13));
      } else {
        const html = await hono();
        expect(hosts(html)).toBe("Current host, Root host, Previous host, Next host");
        expect(nav(html)).toContain(`/e/${key(11)}`);
        expect(nav(html)).toContain(`/e/${key(13)}`);
        expect(nav(html)).not.toContain(key(14));
      }
    },
  );

  it.each([
    { kind: "mixed", path: "Kit" },
    { kind: "mixed", path: "Hono" },
    { kind: "entirely past", path: "Kit" },
    { kind: "entirely past", path: "Hono" },
  ])("includes historic hosts and both neighbors: $kind / $path", async ({ kind, path }) => {
    await smallRun();
    await fixture.client`update events set status = 'past' where id in (10, 11)`;
    if (kind === "entirely past") await fixture.client`update events set status = 'past'`;
    await insert(14, { status: "draft", index: 2, host: "Hidden draft" });
    await insert(15, { status: "cancelled", index: 4, host: "Hidden cancelled" });
    await insert(40, {
      parent: null,
      index: 1,
      host: "Foreign root",
      start: "2035-02-01T20:00:00Z",
    });
    await insert(41, {
      parent: 40,
      index: 2,
      host: "Foreign child",
      start: "2035-02-02T20:00:00Z",
    });
    if (path === "Kit") {
      const model = await kit();
      expect(model.series?.hosts).toEqual([
        "Current host",
        "Root host",
        "Previous host",
        "Next host",
      ]);
      expect(model.series?.previous?.key).toBe(key(11));
      expect(model.series?.next?.key).toBe(key(13));
    } else {
      const html = await hono();
      expect(hosts(html)).toBe("Current host, Root host, Previous host, Next host");
      expect(nav(html)).toContain(`/e/${key(11)}`);
      expect(nav(html)).toContain(`/e/${key(13)}`);
      expect(nav(html)).not.toContain(key(14));
      expect(nav(html)).not.toContain(key(15));
      expect(nav(html)).not.toContain(key(40));
      expect(nav(html)).not.toContain(key(41));
    }
  });
});

describe("bounded series projection from actual SQL results", () => {
  it("fetches at most 53 projected rows and omits the whole oversized imported run", async () => {
    await insert(10, { host: "Root host", description: "unused description ".repeat(100_000) });
    await fixture.client`
      insert into events (id, event_key, title, starts_at, ends_at, timezone, status,
        parent_event_id, recurrence_index, organizer_name, description, join_instructions)
      select n, lpad(n::text, 26, '0'), 'Imported ' || n,
        '2035-01-01'::timestamptz + n * interval '1 day',
        '2035-01-01'::timestamptz + n * interval '1 day' + interval '2 hours',
        'UTC', 'published', 10, n - 9, 'Imported host ' || n,
        repeat('huge unused description ', 10000), repeat('unused join ', 10000)
      from generate_series(11, 90) as n
    `;
    const context = await getEventSeriesContext(db, ROOT);
    expect.soft(context).toBeNull();
    expect(seriesReads()).toHaveLength(1);
    const query = seriesReads()[0]!;
    expect.soft(query.rows.length).toBeLessThanOrEqual(53);
    expect.soft(query.rows).toHaveLength(53);
    expect.soft(query.sql).toMatch(/\blimit\s+(?:\$\d+|53)\b/i);
    const selected = query.sql.split(/\bfrom\b/i)[0]!;
    expect
      .soft(selected)
      .not.toMatch(
        /description|accessibility_notes|join_url|join_instructions|created_by|agent_grant_id/,
      );
    expect.soft(query.columns.length).toBe(12);
    expect.soft(query.bytes).toBeLessThanOrEqual(53 * (4096 + 128));
    traces.length = 0;
    const model = await kit(10);
    expect(model.series).toBeNull();
    const html = await hono(10);
    expect(html).not.toContain("event-series-hosts");
    expect(html).not.toContain("event-series-nav");
  });

  it("large unused descriptions do not suppress an otherwise small valid series", async () => {
    await smallRun();
    await fixture.client`update events set description = repeat('unused description ', 100000), join_instructions = repeat('unused join ', 100000)`;
    const context = await getEventSeriesContext(db, CURRENT);
    expect(context?.hosts).toEqual(["Current host", "Root host", "Previous host", "Next host"]);
    expect(context?.next?.eventKey).toBe(key(13));
    expect(seriesReads()).toHaveLength(1);
    const query = seriesReads()[0]!;
    expect(query.rows).toHaveLength(4);
    expect(query.sql.split(/\bfrom\b/i)[0]).not.toMatch(/description|join_instructions/);
    expect(query.bytes).toBeLessThanOrEqual(4 * (4096 + 128));
  });

  it("does not truncate a supported 52-occurrence run or count hidden rows as overflow", async () => {
    await insert(10, { host: "Root host" });
    await fixture.client`
      insert into events (id, event_key, title, starts_at, ends_at, status, parent_event_id, recurrence_index, organizer_name)
      select n, lpad(n::text, 26, '0'), 'Occurrence ' || n, '2035-01-01'::timestamptz + n * interval '1 day',
        '2035-01-01'::timestamptz + n * interval '1 day' + interval '2 hours',
        case when n > 61 then 'draft' when n % 2 = 0 then 'past' else 'published' end,
        10, n - 9, 'Host ' || n from generate_series(11, 65) as n
    `;
    const context = await getEventSeriesContext(db, ROOT);
    expect(context?.hosts).toHaveLength(52);
    expect(context?.hosts.at(-1)).toBe("Host 61");
    expect(context?.next?.eventKey).toBe(key(11));
    expect(seriesReads()).toHaveLength(1);
    expect(seriesReads()[0]!.rows).toHaveLength(52);
  });

  it.each(["event_key", "title", "timezone", "location", "game", "organizer_name"] as const)(
    "SQL nulls over-budget %s text before transport and suppresses context",
    async (field) => {
      await smallRun();
      const huge = "🦊".repeat(1100); // 4400 UTF-8 bytes, only 2200 JS code units.
      expect(Buffer.byteLength(huge, "utf8")).toBe(4400);
      await fixture.client.unsafe(`update events set "${field}" = $1 where id = 13`, [huge]);
      const context = await getEventSeriesContext(db, CURRENT);
      expect.soft(context).toBeNull();
      expect(seriesReads()).toHaveLength(1);
      const query = seriesReads()[0]!;
      expect.soft(query.sql).toMatch(/\bcase\b/i);
      expect.soft(query.sql).toMatch(/octet_length/i);
      expect.soft(query.rows.flat()).toContain(false);
      expect.soft(query.bytes).toBeLessThanOrEqual(4 * (4096 + 128));
      expect.soft(query.raw.flat()).not.toContain(huge);
      const idPosition = query.columns.indexOf("id");
      const oversized = query.rows.find((r) => r[idPosition] === 13)!;
      // The six projected strings all go NULL together. Id/index/times and the
      // false marker remain, so neither hosts nor unsafe links can leak through.
      expect.soft(oversized.filter((value) => value === null)).toHaveLength(6);
    },
  );

  it("applies the UTF-8 cap to the sum, admitting exactly 4096 and refusing 4097 bytes", async () => {
    await smallRun();
    // eventKey=26 + title=3000 + UTC=3 + Voice=5 + organizer=1062 = 4096.
    await fixture.client`update events set title = ${"T".repeat(3000)}, organizer_name = ${"H".repeat(1062)} where id = 13`;
    const admitted = await getEventSeriesContext(db, CURRENT);
    expect(admitted?.next?.eventKey).toBe(key(13));
    expect(admitted?.hosts).toContain("H".repeat(1062));
    traces.length = 0;
    await fixture.client`update events set organizer_name = ${"H".repeat(1063)} where id = 13`;
    const refused = await getEventSeriesContext(db, CURRENT);
    expect(refused).toBeNull();
    expect(seriesReads()).toHaveLength(1);
    expect(seriesReads()[0]!.rows.flat()).toContain(false);
  });

  it("metadata-free detail performs zero series queries", async () => {
    const ordinary = { ...ROOT, recurrenceFrequency: null, recurrenceIndex: null };
    await expect(getEventSeriesContext(db, ordinary)).resolves.toBeNull();
    expect(traces).toHaveLength(0);
  });

  it("a recurring singleton plus hidden siblings omits read, Hono and Kit series context", async () => {
    await insert(10, { host: "Root host" });
    await insert(11, { status: "draft", host: "Hidden draft" });
    await insert(12, { status: "cancelled", host: "Hidden cancelled" });
    await expect(getEventSeriesContext(db, ROOT)).resolves.toBeNull();
    expect(seriesReads()).toHaveLength(1);
    const html = await hono(10);
    expect(html).toContain('data-testid="event-organizer">Root host');
    expect(html).not.toContain("event-series-hosts");
    expect(html).not.toContain("event-series-nav");
    const model = await kit(10);
    expect(model.series).toBeNull();
    const kitHtml = await renderSeriesDetail(model as unknown as Record<string, unknown>);
    expect(kitHtml).not.toContain("event-series-hosts");
    expect(kitHtml).not.toContain("event-series-nav");
  });
});
