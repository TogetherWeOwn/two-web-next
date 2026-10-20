// CI-only data, production HTTP app and assets. Never spread runtime bindings:
// even an inherited DATABASE_URL/Hyperdrive or Discord token must be ignored.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import app from "../src/index";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { EVENTS_MONTH_GRID_LIMIT, EVENTS_UPCOMING_PAGE_SIZE } from "../src/islands/contracts";
import { createMemorySessionStore } from "../src/sessions";

import { auditPaths, fixtureKey } from "./lighthouse-paths";

const eventColumns = getTableColumns(events);
const columns = Object.keys(eventColumns) as (keyof typeof events.$inferSelect)[];
const eventSelect = `select ${columns.map((key) => `"${eventColumns[key].name}"`).join(", ")} from "events"`;
const linkSelect =
  'select "id", "event_key", "title", "starts_at", "timezone", "location" from "events"';
const timeoutsSql =
  "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)";
const featuredSql =
  'select "id", "title", "body", "url", "image_url", "image_alt" from "featured_contents" where ("featured_contents"."is_published" = $1 and ("featured_contents"."starts_at" is null or "featured_contents"."starts_at" <= $2) and ("featured_contents"."ends_at" is null or "featured_contents"."ends_at" > $3)) order by "featured_contents"."position" asc, "featured_contents"."id" asc';
// Homepage guest cache base: every published row with its window bounds; the
// worker applies the live window per request, so the open window here (null
// bounds) stays visible at every instant.
const publishedFeaturedSql =
  'select "id", "title", "body", "url", "image_url", "image_alt", "starts_at", "ends_at" from "featured_contents" where "featured_contents"."is_published" = $1 order by "featured_contents"."position" asc, "featured_contents"."id" asc';
// Attributable going count: joins users and counts only named rows, so the
// badge agrees with the roster (the fixture's three going members are named).
// Seat occupancy counts every going row (same shape as waitlist.goingCount);
// the fixture has no nameless rows, so both aggregates are 3.
const goingSql =
  'select "rsvps"."event_id", count(*) from "rsvps" inner join "users" on "rsvps"."user_id" = "users"."id" where ("rsvps"."event_id" in ($1) and "rsvps"."status" = $2 and "users"."username" <> $3) group by "rsvps"."event_id"';
const occupancySql =
  'select "event_id", count(*) from "rsvps" where ("rsvps"."event_id" in ($1) and "rsvps"."status" = $2) group by "rsvps"."event_id"';
const localOrigin = "http://127.0.0.1:8787";

function neighborSql(comparison: "<" | ">", direction: "asc" | "desc"): string {
  return `${linkSelect} where ("events"."status" = $1 and "events"."id" <> $2 and isfinite("events"."starts_at") and "events"."ends_at" >= $3 and ("events"."starts_at" ${comparison} (select "starts_at" from "events" where "events"."id" = $4) or ("events"."starts_at" = (select "starts_at" from "events" where "events"."id" = $5) and "events"."id" ${comparison} $6))) order by "events"."starts_at" ${direction}, "events"."id" ${direction} limit $7`;
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function sameParams(actual: unknown[], expected: unknown[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

// The fixture date is built inside the request handler, not at module scope:
// workerd evaluates global-scope Date.now() as the Unix epoch, so a
// module-level "seven days from now" renders January 1970. One timestamp per
// request keeps the row, the encoded proxy payload and the upcoming/past
// classification internally consistent.
export function fixtureEnvForRequest(nowMs: number): Env & Record<string, unknown> {
  const startsAt = new Date(nowMs + 7 * 86400_000);
  const fixture: typeof events.$inferSelect = {
    id: 1,
    eventKey: fixtureKey,
    title: "Lighthouse fixture game night",
    game: "Community games",
    description: "A local-only community game night used to measure the real event page.",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Community voice channel",
    capacity: 20,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    icsSequence: 0n,
  };
  const encoded = columns.map((key) => {
    const value = fixture[key];
    return value instanceof Date ? value.toISOString() : value;
  });
  // A closed list of the anonymous production reads, not a general SQL emulator.
  // Match the complete statement AND its parameters: substring checks would also
  // accept writes, extra statements, private projections and unbounded settings.
  function localDb(transaction?: { active: boolean }): ReturnType<typeof drizzle> {
    const inTransaction = transaction !== undefined;
    const db = drizzle(async (sql, params, method) => {
      if (transaction && !transaction.active)
        throw new Error("Lighthouse fixture transaction has ended");
      if (
        method === "execute" &&
        inTransaction &&
        sql === timeoutsSql &&
        (sameParams(params, ["400ms", "400ms"]) || sameParams(params, ["250ms", "250ms"]))
      ) {
        return { rows: [] }; // Only these transaction-local read timeouts are simulated.
      }
      if (method === "all") {
        if (sql === goingSql && sameParams(params, [fixture.id, "going", ""]))
          return { rows: [[fixture.id, 3]] };
        if (sql === occupancySql && sameParams(params, [fixture.id, "going"]))
          return { rows: [[fixture.id, 3]] };
        if (
          sql === `${eventSelect} where "events"."event_key" = $1` &&
          sameParams(params, [fixtureKey])
        ) {
          return { rows: [encoded] };
        }
        if (
          sql ===
            `select count(*) from "events" where ("events"."status" != 'draft' and (isfinite("events"."starts_at") and isfinite("events"."ends_at")) and "events"."status" <> $1 and "events"."ends_at" >= $2)` &&
          params.length === 2 &&
          params[0] === "past" &&
          isInstant(params[1])
        ) {
          return { rows: [[fixture.endsAt >= new Date(params[1]) ? "1" : "0"]] };
        }
        // The upcoming list is paged: the audited set only turns page one
        // (Drizzle omits a zero offset), so the pinned limit below proves the
        // bound, not just the shape. Later pages emit an offset clause the
        // closed list deliberately does not know.
        if (
          sql ===
            `${eventSelect} where ("events"."status" != 'draft' and (isfinite("events"."starts_at") and isfinite("events"."ends_at")) and "events"."status" <> $1 and "events"."ends_at" >= $2) order by "events"."starts_at" asc, "events"."id" asc limit $3` &&
          params.length === 3 &&
          params[0] === "past" &&
          isInstant(params[1]) &&
          params[2] === EVENTS_UPCOMING_PAGE_SIZE + 1
        ) {
          return { rows: fixture.endsAt >= new Date(params[1]) ? [encoded] : [] };
        }
        // No calendar-view traffic in the audited set; emulate the month read
        // faithfully against the single fixture row so one never 500s silently.
        if (
          sql ===
            `${eventSelect} where ("events"."status" != 'draft' and (isfinite("events"."starts_at") and isfinite("events"."ends_at")) and "events"."status" <> $1 and "events"."status" <> $2 and "events"."ends_at" >= $3 and "events"."starts_at" < $4 and "events"."ends_at" > $5) order by "events"."starts_at" asc, "events"."id" asc limit $6` &&
          params.length === 6 &&
          params[0] === "past" &&
          params[1] === "cancelled" &&
          isInstant(params[2]) &&
          isInstant(params[3]) &&
          isInstant(params[4]) &&
          params[5] === EVENTS_MONTH_GRID_LIMIT
        ) {
          const overlaps =
            fixture.startsAt.getTime() < new Date(params[3]).getTime() &&
            fixture.endsAt.getTime() > new Date(params[4]).getTime();
          return {
            rows: fixture.endsAt >= new Date(params[2]) && overlaps ? [encoded] : [],
          };
        }
        // Grid day-jumps resolve the card's list page: the anchor row, then the
        // count of visible rows before it. Single-fixture emulation: the row
        // counts exactly when the anchor is the fixture itself.
        if (
          sql ===
            `${eventSelect} where ("events"."event_key" = $1 and "events"."status" != 'draft' and (isfinite("events"."starts_at") and isfinite("events"."ends_at")) and "events"."status" <> $2 and "events"."ends_at" >= $3)` &&
          params.length === 3 &&
          params[0] === fixtureKey &&
          params[1] === "past" &&
          isInstant(params[2])
        ) {
          return { rows: fixture.endsAt >= new Date(params[2]) ? [encoded] : [] };
        }
        // The rank anchor compares at the stored timestamp precision: the
        // count carries the anchor id twice (once per subquery) instead of a
        // bound JS instant. Single-fixture emulation: the count only runs
        // when the anchor is the fixture itself, so no visible row sorts
        // before it.
        if (
          sql ===
            `select count(*) from "events" where ("events"."status" != 'draft' and (isfinite("events"."starts_at") and isfinite("events"."ends_at")) and "events"."status" <> $1 and "events"."ends_at" >= $2 and ("events"."starts_at" < (select "starts_at" from "events" where "events"."id" = $3) or ("events"."starts_at" = (select "starts_at" from "events" where "events"."id" = $4) and "events"."id" < $5)))` &&
          params.length === 5 &&
          params[0] === "past" &&
          isInstant(params[1]) &&
          params[2] === fixture.id &&
          params[3] === fixture.id &&
          params[4] === fixture.id
        ) {
          return { rows: [["0"]] };
        }
        if (
          inTransaction &&
          sql ===
            `${eventSelect} where ("events"."status" = $1 and "events"."ends_at" >= $2 and isfinite("events"."starts_at")) order by "events"."starts_at" asc, "events"."id" asc limit $3` &&
          params.length === 3 &&
          params[0] === "published" &&
          isInstant(params[1]) &&
          params[2] === 3
        ) {
          return { rows: fixture.endsAt >= new Date(params[1]) ? [encoded] : [] };
        }
        if (
          sql ===
            `${eventSelect} where ("events"."status" != 'draft' and "events"."ends_at" < $1) order by "events"."starts_at" desc, "events"."id" desc limit $2` &&
          params.length === 2 &&
          isInstant(params[0]) &&
          params[1] === 20
        ) {
          return { rows: fixture.endsAt < new Date(params[0]) ? [encoded] : [] };
        }
        if (
          inTransaction &&
          sql === featuredSql &&
          params.length === 3 &&
          params[0] === true &&
          isInstant(params[1]) &&
          params[1] === params[2]
        ) {
          return {
            rows: [
              [
                1,
                "Lighthouse fixture community news",
                "Local community games and upcoming game nights.",
                "/events",
                null,
                null,
              ],
            ],
          };
        }
        if (
          inTransaction &&
          sql === publishedFeaturedSql &&
          params.length === 1 &&
          params[0] === true
        ) {
          return {
            rows: [
              [
                1,
                "Lighthouse fixture community news",
                "Local community games and upcoming game nights.",
                "/events",
                null,
                null,
                null,
                null,
              ],
            ],
          };
        }
        // The one fixture has no neighboring or related events.
        if (
          (sql === neighborSql("<", "desc") || sql === neighborSql(">", "asc")) &&
          params.length === 7 &&
          params[0] === "published" &&
          params[1] === fixture.id &&
          isInstant(params[2]) &&
          params[3] === fixture.id &&
          params[4] === fixture.id &&
          params[5] === fixture.id &&
          params[6] === 1
        )
          return { rows: [] };
        if (
          sql ===
            `${linkSelect} where ("events"."status" = $1 and "events"."id" <> $2 and isfinite("events"."starts_at") and "events"."ends_at" >= $3) order by case when "events"."game" = $4 then 0 else 1 end, "events"."starts_at" asc, "events"."id" asc limit $5` &&
          params.length === 5 &&
          params[0] === "published" &&
          params[1] === fixture.id &&
          isInstant(params[2]) &&
          params[3] === fixture.game &&
          params[4] === 3
        )
          return { rows: [] };
      }
      throw new Error("Unhandled Lighthouse fixture query");
    });
    // pg-proxy rejects transactions. A fresh, read-only local proxy is safe for
    // these callbacks: there is no socket, mutable DB, BEGIN/COMMIT or session
    // setting. Errors propagate; nested/configured transactions remain forbidden.
    Object.assign(db, {
      transaction: async <T>(
        read: (tx: ReturnType<typeof drizzle>) => Promise<T>,
        config?: unknown,
      ): Promise<T> => {
        if (inTransaction || config !== undefined)
          throw new Error("Unsupported Lighthouse fixture transaction");
        const scope = { active: true };
        try {
          return await read(localDb(scope));
        } finally {
          scope.active = false;
        }
      },
    });
    return db;
  }
  const db = localDb();

  return {
    APP_URL: localOrigin,
    DISCORD_CLIENT_ID: "ci-client",
    DISCORD_GUILD_ID: "ci-guild",
    DISCORD_INVITE_URL: "http://127.0.0.1:8787/join",
    DISCORD_CLIENT_SECRET: "fixture-only",
    DISCORD_BOT_TOKEN: "fixture-only",
    SESSION_SECRET: "lighthouse-local-fixture-secret-at-least-32",
    SESSION_STORE: createMemorySessionStore(),
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  };
}

export default {
  fetch(request: Request, _env: unknown, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    // Fail closed: no OAuth, writes, search analytics or external fetch routes.
    if (
      request.method !== "GET" ||
      url.origin !== localOrigin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      request.headers.has("cookie") ||
      request.headers.has("authorization") ||
      !auditPaths.includes(url.pathname)
    ) {
      return new Response("Not in the Lighthouse fixture", { status: 404 });
    }
    return app.fetch(request, fixtureEnvForRequest(Date.now()), ctx);
  },
};
