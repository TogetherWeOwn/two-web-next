import postgres from "postgres";
import { auditDatabaseUrl } from "./a11y-policy.mjs";
import { createMemberDataFixture } from "../test/helpers/member-data-db";
import { cookieFor, env, MODERATOR, seed, SUBJECT } from "../test/helpers/member-data";
import { events, featuredContents } from "../src/db/admin-schema";
import { createPostgresSessionStore, migrate, type Sql } from "../src/sessions";

export async function fixtures(raw: string) {
  // The existing validator refuses staging/production BEFORE connecting; all
  // migrations, seeds, sessions and access logs stay inside a fresh owned schema.
  const url = auditDatabaseUrl(raw, process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true");
  const fixture = await createMemberDataFixture(raw);
  // Drizzle replaces timestamp serializers on its client. Raw session SQL
  // keeps a separate client so Date parameters still serialize normally.
  const sessionClient = postgres(url.href, { max: 1, password: () => url.password, connect_timeout: 5, connection: { search_path: fixture.schemaName } });
  const dispose = async () => { await sessionClient.end(); await fixture.dispose(); };
  try {
    await seed(fixture.db);
    await fixture.db.insert(events).values([
      { eventKey: "01J00000000000000000000016", title: "Cancelled games", status: "cancelled", startsAt: new Date("2099-11-05T20:00:00Z"), endsAt: new Date("2099-11-05T22:00:00Z") },
      { eventKey: "01J00000000000000000000017", title: "Draft games", status: "draft", startsAt: new Date("2099-11-06T20:00:00Z"), endsAt: new Date("2099-11-06T22:00:00Z") },
      { eventKey: "01J00000000000000000000018", title: "Past games", status: "published", startsAt: new Date("2020-11-06T20:00:00Z"), endsAt: new Date("2020-11-06T22:00:00Z") },
    ]);
    await fixture.db.insert(featuredContents).values({ title: "Community games", body: "Everyone is welcome — مرحباً", isPublished: true, url: "/events" });
    await migrate(sessionClient as unknown as Sql);
    const sessions = createPostgresSessionStore(sessionClient as unknown as Sql);
    return {
      schemaName: fixture.schemaName,
      sessionSecret: env.SESSION_SECRET,
      cookie: (identity: string) => {
        if (identity !== "member" && identity !== "moderator") throw new Error(`Unknown fixture identity: ${identity}`);
        return cookieFor(sessions, identity === "moderator" ? MODERATOR : SUBJECT);
      },
      dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
