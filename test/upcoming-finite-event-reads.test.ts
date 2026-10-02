// Staging regression (TOG-11612): imported rows can carry PostgreSQL infinity
// boundaries. Rendering/serializing such a Date throws RangeError, which 500s
// /events, /events.rss and /events.ics, so both upcoming reads refuse them the
// same way neighbours/related/suggestions already do. Isolated test DB only.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Env } from "../src/env";
import { listFeed, listUpcoming } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;

const FINITE = "01J0000000000000000000AAA";
const INF_START = "01J0000000000000000000AAB";
const INF_END = "01J0000000000000000000AAC";

const routeEnv = (adminDb: EnvWithAdminDb["ADMIN_DB"]) =>
  ({
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "fixture",
    DISCORD_CLIENT_SECRET: "fixture",
    DISCORD_GUILD_ID: "fixture",
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    DISCORD_BOT_TOKEN: "fixture",
    SESSION_SECRET: "fixture",
    ADMIN_DB: adminDb,
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  }) as unknown as Env;

const app = () => {
  const application = new Hono<{ Bindings: Env }>();
  registerEventRoutes(
    application,
    async () => null,
    async () => null,
  );
  return application;
};

describe.skipIf(!url)("upcoming reads refuse non-finite boundaries (isolated test DB)", () => {
  it("excludes infinity starts/ends from listFeed and listUpcoming", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await client`insert into events (event_key, title, starts_at, ends_at, status)
        values
          (${FINITE}, 'Finite upcoming', '2070-01-01T18:00:00Z', '2070-01-01T20:00:00Z', 'published'),
          (${INF_START}, 'Infinity start', 'infinity'::timestamptz, '2070-02-01T20:00:00Z', 'published'),
          (${INF_END}, 'Infinity end', '2070-03-01T18:00:00Z', 'infinity'::timestamptz, 'published')`;

      const feed = await listFeed(db, ["published", "cancelled"]);
      expect(feed.map((row) => row.eventKey)).toEqual([FINITE]);
      const upcoming = await listUpcoming(db);
      expect(upcoming.map((row) => row.eventKey)).toEqual([FINITE]);
    } finally {
      await fixture.dispose();
    }
  });

  it("serves the calendar page and both feeds when only non-finite rows exist", async () => {
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    const { client, db } = fixture;
    try {
      await client`insert into events (event_key, title, starts_at, ends_at, status)
        values
          (${INF_START}, 'Infinity start', 'infinity'::timestamptz, '2070-02-01T20:00:00Z', 'published'),
          (${INF_END}, 'Infinity end', '2070-03-01T18:00:00Z', 'infinity'::timestamptz, 'published')`;

      const application = app();
      for (const path of ["/events", "/events.rss", "/events.ics"]) {
        const response = await application.request(path, {}, routeEnv(db));
        const body = await response.text();
        expect([path, response.status]).toEqual([path, 200]);
        expect(body).not.toContain("Infinity start");
        expect(body).not.toContain("Infinity end");
      }
    } finally {
      await fixture.dispose();
    }
  });
});
