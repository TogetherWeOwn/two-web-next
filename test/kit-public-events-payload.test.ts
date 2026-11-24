// Execute the real endpoint: a source-substring pin cannot detect bytes that
// the binding appends after rendering. The acceptance-owned suite stays intact.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { KEY } from "./helpers/ics-wire-fixture";
import {
  ARCHIVE_ORIGIN,
  archiveEnv,
  archiveRow,
  compileArchiveKit,
} from "./helpers/past-archive-search-acceptance";
import { encodeEventRow } from "./helpers/pg-proxy-event-projection";

const MEMBER_ID = "987654321098765432";
const USERS = [
  { id: MEMBER_ID, username: "leak-probe-\u202erebmem-zz9\u202c\u200f" },
  { id: "876543210987654321", username: "leak-probe-member-zz9@example.test" },
  { id: "765432109876543210", username: "leak-probe-\u0301\ud83d\udc80\u6f22\u5b57-qq4" },
];
const SESSION_BEARER = `two_${"z".repeat(43)}`;

function assertNoMemberBytes(bytes: string) {
  for (const user of USERS) {
    expect(bytes, "Kit public endpoint leaked a member id").not.toContain(user.id);
    expect(bytes, "Kit public endpoint leaked a username/email").not.toContain(user.username);
  }
  expect(bytes, "Kit public endpoint leaked a session bearer").not.toMatch(/two_[A-Za-z0-9_-]{43}/);
}

let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
beforeAll(async () => {
  kit = await compileArchiveKit();
});
afterAll(() => {
  kit?.dispose();
});

describe("Kit GET /events binding anonymous payload", () => {
  for (const island of [false, true]) {
    it(`serves hostile rows without member bytes in the ${island ? "island" : "full page"} response`, async () => {
      const statements: string[] = [];
      const row = archiveRow(7, {
        status: "published",
        eventKey: "public-binding-fixture",
        title: "Hostile endpoint fixture title",
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 7200_000),
        createdBy: MEMBER_ID,
      });
      const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
      const db = drizzle(async (sql, params) => {
        statements.push(sql);
        if (sql.includes('from "rsvps"')) {
          // Only counts cross the public boundary, not the stored identities.
          return { rows: [[row.id, USERS.length]] };
        }
        if (!sql.includes('from "events"')) return { rows: [] };
        const past = params.includes("past") || sql.includes('"events"."ends_at" < ');
        if (sql.startsWith("select count(*)")) return { rows: [[past ? 0 : 1]] };
        return {
          rows: past
            ? []
            : [
                columns.map((key) => {
                  const value = row[key];
                  return value instanceof Date ? value.toISOString() : value;
                }),
              ],
        };
      }) as unknown as Db;
      const env = { ...archiveEnv(db), SESSION_SECRET: SESSION_BEARER };
      const response = await kit.request(
        new Request(`${ARCHIVE_ORIGIN}/events?view=list`, {
          headers: island ? { "x-two-island": "events-calendar" } : {},
        }),
        env,
      );
      const bytes = await response.text();
      expect(response.status).toBe(200);
      expect(statements.some((sql) => sql.includes('from "events"'))).toBe(true);
      expect(row.createdBy).toBe(MEMBER_ID);
      expect(bytes).toContain(row.title);
      expect(bytes).toContain(row.eventKey);
      assertNoMemberBytes(bytes);
    });
  }
});

describe("Kit feed anonymous payloads", () => {
  it.each([
    ["/events.ics", "text/calendar"],
    ["/events.rss", "application/rss+xml"],
    [`/events/${KEY}.ics`, "text/calendar"],
  ])("GET %s excludes private fields from serialized feed items", async (path, mediaType) => {
    const row = archiveRow(7, {
      eventKey: KEY,
      status: "published",
      title: "Public feed fixture title",
      startsAt: new Date("2099-01-02T18:00:00Z"),
      endsAt: new Date("2099-01-02T19:00:00Z"),
      createdBy: MEMBER_ID,
      join_instructions: USERS[1]!.username,
    });
    const db = drizzle(async (sql, params) => {
      expect(sql).toContain('from "events"');
      return {
        rows: [
          encodeEventRow(sql, params, row, (value) =>
            value instanceof Date ? value.toISOString() : value,
          ),
        ],
      };
    }) as unknown as Db;
    const request = new Request(`${ARCHIVE_ORIGIN}${path}`, {
      headers: { cookie: `__Host-two_session=${SESSION_BEARER}` },
    });
    const response = await kit.request(request, archiveEnv(db));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(mediaType);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(body).toContain(row.title);
    expect(body).toContain(row.eventKey);
    assertNoMemberBytes(body.replaceAll(/\r\n[ \t]/g, ""));
  });
});

describe("Kit search indexing anonymous payloads", () => {
  it.each([
    ["/robots.txt", `Sitemap: ${ARCHIVE_ORIGIN}/sitemap_index.xml`, 0],
    ["/sitemap_index.xml", `<loc>${ARCHIVE_ORIGIN}/e/${KEY}</loc>`, 1],
  ])("GET %s excludes private fields and session artifacts", async (path, expected, queryCount) => {
    const row = archiveRow(7, {
      eventKey: KEY,
      status: "published",
      createdBy: MEMBER_ID,
      organizer_name: USERS[0]!.username,
      join_instructions: USERS[1]!.username,
      description: USERS[2]!.username,
    });
    const query = vi.fn(async (sql: string, params: unknown[]) => ({
      rows: [
        encodeEventRow(sql, params, row, (value) =>
          value instanceof Date ? value.toISOString() : value,
        ),
      ],
    }));
    const request = new Request(`${ARCHIVE_ORIGIN}${path}`, {
      headers: { cookie: `__Host-two_session=${SESSION_BEARER}` },
    });
    const response = await kit.request(request, archiveEnv(drizzle(query) as unknown as Db));
    const bytes = await response.text();

    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(queryCount);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(bytes).toContain(expected);
    assertNoMemberBytes(bytes);
  });
});
