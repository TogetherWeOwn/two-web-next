// CI-only data, production HTTP app and assets. Never spread runtime bindings:
// even an inherited DATABASE_URL/Hyperdrive or Discord token must be ignored.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import app from "../src/index";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";

import { auditPaths, fixtureKey } from "./lighthouse-paths";

const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];

// The fixture date is built inside the request handler, not at module scope:
// workerd evaluates global-scope Date.now() as the Unix epoch, so a
// module-level "seven days from now" renders January 1970. One timestamp per
// request keeps the row, the encoded proxy payload and the upcoming/past
// classification internally consistent.
function fixtureEnvForRequest(nowMs: number): Env & Record<string, unknown> {
  const startsAt = new Date(nowMs + 7 * 86400_000);
  const fixture: typeof events.$inferSelect = {
    id: 1, eventKey: fixtureKey, title: "Lighthouse fixture game night", game: "Community games",
    description: "A local-only community game night used to measure the real event page.",
    startsAt, endsAt: new Date(startsAt.getTime() + 7200_000), timezone: "Europe/London",
    location: "Community voice channel", capacity: 20, status: "published", discordEventId: null,
    discordSyncFailedAt: null, discordSyncFailureCode: null,
    createdBy: null, rsvpOpen: true, recurrenceFrequency: null, recurrenceCount: null,
    recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
    createdAt: startsAt, updatedAt: startsAt, icsSequence: 0n,
  };
  const encoded = columns.map((key) => {
    const value = fixture[key];
    return value instanceof Date ? value.toISOString() : value;
  });
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) return { rows: [[1, 3]] };
    if (sql.includes('from "events"')) {
      if (sql.includes('"events"."id" <>')) return { rows: [] }; // The fixture has no neighboring or related events.
      if (sql.includes('"event_key" =')) return { rows: params.includes(fixtureKey) ? [encoded] : [] };
      if (sql.includes('"ends_at" <')) return { rows: [] };
      if (sql.includes('"ends_at" >=')) return { rows: [encoded] };
    }
    throw new Error(`Unhandled Lighthouse fixture query: ${sql}`);
  });

  return {
    APP_URL: "http://127.0.0.1:8787",
    DISCORD_CLIENT_ID: "ci-client", DISCORD_GUILD_ID: "ci-guild",
    DISCORD_INVITE_URL: "http://127.0.0.1:8787/join",
    DISCORD_CLIENT_SECRET: "fixture-only", DISCORD_BOT_TOKEN: "fixture-only",
    SESSION_SECRET: "lighthouse-local-fixture-only",
    SESSION_STORE: createMemorySessionStore(),
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  };
}

export default {
  fetch(request: Request, _env: unknown, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    // Fail closed: no OAuth, writes, search analytics or external fetch routes.
    if (request.method !== "GET" || url.search || !auditPaths.includes(url.pathname)) {
      return new Response("Not in the Lighthouse fixture", { status: 404 });
    }
    return app.fetch(request, fixtureEnvForRequest(Date.now()), ctx);
  },
};
