import { eq } from "drizzle-orm";
import postgres from "postgres";
import { A11Y_RECONCILIATION_OPEN_KEY, A11Y_RECONCILIATION_RESOLVED_KEY } from "./a11y-cases.mjs";
import { pgReconciliationStore, stuckIntent } from "../src/jobs/reconciliation";
import { auditDatabaseOptions, auditDatabaseUrl } from "./a11y-policy.mjs";
import { createMemberDataFixture } from "../test/helpers/member-data-db";
import { cookieFor, env, MODERATOR, seed, SUBJECT } from "../test/helpers/member-data";
import { eventEchoes, events, featuredContents, rsvps } from "../src/db/admin-schema";
import { createPostgresSessionStore, migrate, type Sql } from "../src/sessions";

export async function fixtures(raw: string) {
  // The existing validator refuses staging/production BEFORE connecting; all
  // migrations, seeds, sessions and access logs stay inside a fresh owned schema.
  const url = auditDatabaseUrl(
    raw,
    process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true",
  );
  const fixture = await createMemberDataFixture(raw);
  // Drizzle replaces timestamp serializers on its client. Raw session SQL
  // keeps a separate client so Date parameters still serialize normally.
  const sessionClient = postgres(url.href, auditDatabaseOptions(url, fixture.schemaName));
  const dispose = async () => {
    try {
      await sessionClient.end();
    } finally {
      await fixture.dispose();
    }
  };
  try {
    await seed(fixture.db);
    await fixture.db.insert(events).values([
      {
        eventKey: "01J00000000000000000000016",
        title: "Cancelled games",
        status: "cancelled",
        startsAt: new Date("2099-11-05T20:00:00Z"),
        endsAt: new Date("2099-11-05T22:00:00Z"),
      },
      {
        eventKey: "01J00000000000000000000017",
        title: "Draft games",
        status: "draft",
        startsAt: new Date("2099-11-06T20:00:00Z"),
        endsAt: new Date("2099-11-06T22:00:00Z"),
      },
      {
        eventKey: "01J00000000000000000000018",
        title: "Past games",
        status: "published",
        startsAt: new Date("2020-11-06T20:00:00Z"),
        endsAt: new Date("2020-11-06T22:00:00Z"),
      },
      {
        eventKey: "01J00000000000000000000020",
        title: "Paused games",
        status: "published",
        rsvpOpen: false,
        startsAt: new Date("2099-11-08T20:00:00Z"),
        endsAt: new Date("2099-11-08T22:00:00Z"),
      },
    ]);
    const [waitlisted] = await fixture.db
      .insert(events)
      .values({
        eventKey: "01J00000000000000000000019",
        title: "Full co-op night",
        game: "Co-op",
        description: "Bring your favourite loadout.",
        location: "Voice lobby",
        capacity: 1,
        status: "published",
        startsAt: new Date("2099-11-07T20:00:00Z"),
        endsAt: new Date("2099-11-07T22:00:00Z"),
      })
      .returning();
    await fixture.db.insert(rsvps).values([
      { eventId: waitlisted!.id, userId: MODERATOR.userId, status: "going" },
      { eventId: waitlisted!.id, userId: SUBJECT.userId, status: "waitlisted" },
    ]);
    // One frozen Echo on the past event so the admin detail audit case
    // renders 200 and the homepage audit covers the cream band.
    const [pastEvent] = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventKey, "01J00000000000000000000018"));
    await fixture.db.insert(eventEchoes).values({
      eventId: pastEvent!.id,
      eventKey: pastEvent!.eventKey,
      windowStartsAt: new Date("2020-11-06T20:00:00Z"),
      windowEndsAt: new Date("2020-11-06T22:15:00Z"),
      thresholdMinutes: 10,
      peakConcurrent: 5,
      attendedCount: 4,
      rooms: [{ channel_id: "111", name_at_close: "Arena" }],
      headline: "Five regulars, four first-timers",
    });
    await fixture.db.insert(featuredContents).values({
      title: "Community games",
      body: "Everyone is welcome — مرحباً",
      isPublished: true,
      url: "/events",
    });
    await migrate(sessionClient as unknown as Sql);
    const sessions = createPostgresSessionStore(sessionClient as unknown as Sql);
    // Real stuck-intent rows through the production store on the raw client
    // (its Date serializers are untouched, unlike the Drizzle client).
    const reconciliation = pgReconciliationStore(sessionClient as unknown as postgres.Sql);
    await reconciliation.recordStuck(
      stuckIntent({
        idempotencyKey: A11Y_RECONCILIATION_OPEN_KEY,
        verb: "event.upsert",
        subject: "01J00000000000000000000015",
        lastCode: "needs_reconciliation",
        lastStatus: 409,
        lastRequestId: "a11y-req-open",
        attempts: 3,
      }),
      new Date("2026-10-01T12:00:00Z"),
    );
    await reconciliation.recordStuck(
      stuckIntent({
        idempotencyKey: A11Y_RECONCILIATION_RESOLVED_KEY,
        verb: "announcement.post",
        subject: "a11y-channel-announcements",
        lastCode: null,
        lastStatus: null,
        lastRequestId: null,
        attempts: 5,
      }),
      new Date("2026-10-02T09:00:00Z"),
    );
    await reconciliation.resolveStuck(
      A11Y_RECONCILIATION_RESOLVED_KEY,
      { by: MODERATOR.userId, note: "Checked Discord; the announcement was posted." },
      new Date("2026-10-02T10:30:00Z"),
    );
    return {
      schemaName: fixture.schemaName,
      sessionSecret: env.SESSION_SECRET,
      cookie: (identity: string) => {
        if (identity !== "member" && identity !== "moderator")
          throw new Error(`Unknown fixture identity: ${identity}`);
        return cookieFor(sessions, identity === "moderator" ? MODERATOR : SUBJECT);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
