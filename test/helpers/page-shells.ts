// Local rows only: the mounted worker uses pg-proxy and memory sessions, never a DB or Discord.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import app from "../app";
import { events, featuredContents } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import { joinAttempts } from "../../src/db/schema";
import type { Env } from "../../src/env";
import { stuckIntent, type ReconciliationStore } from "../../src/jobs/reconciliation";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

export const MEMBER_ID = "100000000000000001";
export const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// Reconciliation rows are keyed by the carrier UUID, not an event key.
export const RECONCILIATION_KEY = "11111111-1111-4111-8111-111111111111";

export const HTML_READS = [
  "/",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
  "/join",
  "/join/callback",
  "/auth/recover",
  "/events",
  "/events/past",
  "/hotzones",
  "/hotzones/:signal",
  "/leaderboards/members",
  "/e/:key",
  "/profile",
  "/members/:user",
  "/admin",
  "/admin/activity-log",
  "/admin/echoes",
  "/admin/echoes/:id",
  "/admin/events",
  "/admin/events/new",
  "/admin/events/:key",
  "/admin/featured",
  "/admin/featured/new",
  "/admin/featured/:id",
  "/admin/join-attempts",
  "/admin/join-attempts/:id",
  "/admin/reconciliation",
  "/admin/reconciliation/:key",
];

// Bearer-only operational HTML needs a precise local upstream fixture, not the
// moderator-cookie fixture. Its success/empty/unavailable shells are exercised
// separately in page-shells.test.ts; this is not a non-HTML exemption.
export const OPERATIONAL_HTML_READS = ["/admin/ops-overrides"];

// Redirects, feeds and machine endpoints have no HTML success page. Their branded
// error responses are covered separately; new GET routes must be classified here.
export const NON_HTML_READS = [
  "/discord",
  "/join/discord",
  "/auth/discord",
  "/auth/discord/callback",
  "/auth/discord/redirect",
  "/login", // Vanity sign-in alias: 302 to /auth/discord, never an HTML page.
  "/community", // Vanity lobby alias: 302 to /, never an HTML page.
  "/admin/events/create",
  "/admin/events/:key/edit",
  "/admin/featured-contents",
  "/admin/featured-contents/create",
  "/admin/featured-contents/:id/edit",
  "/admin/queue/failed/:id/preview", // Operational advice is buffered JSON, never HTML.
  "/admin/queue/source-evidence/:id", // Evidence-only proof is JSON, never HTML.
  "/sitemap_index.xml",
  "/robots.txt",
  "/.well-known/security.txt", // Plain-text RFC 9116 disclosure file, never an HTML document.
  "/up",
  "/version", // Deploy commit JSON, never an HTML document.
  "/auth/status", // Bool-only JSON, never an HTML document.
  "/members", // Retired bare path: branded 404, never a member index.
  "/members/", // Trailing-slash form of the same retired path.
  "/events.json",
  "/events/:key",
  "/events.ics",
  "/events.rss",
  "/events/:file{.+\\.ics}",
  "/llms.txt", // Assistant index of the Markdown alternates, never an HTML document.
  "/about.md",
  "/faq.md",
  "/rules.md",
  "/privacy.md",
  "/join.md",
  "/events.md",
  "/e/:file{.+\\.md}", // Per-event Markdown alternate; cancelled 410, draft 403, never HTML.
  "/api/public/events", // Bounded session-free JSON, never an HTML page.
  "/api/public/events/:key",
  "/api/public/community",
  "/api/public/join",
  "/openapi.json", // Static OpenAPI document, never an HTML page.
];

export const concretePath = (pattern: string) =>
  pattern
    .replace("/admin/reconciliation/:key", `/admin/reconciliation/${RECONCILIATION_KEY}`)
    .replace(":key", EVENT_KEY)
    .replace(":user", MEMBER_ID)
    .replace(":id", "1")
    .replace(":signal", "joins");

export function pageShellFixture(status = "published") {
  const now = new Date("2030-01-01T20:00:00Z");
  const event: typeof events.$inferSelect = {
    id: 1,
    icsSequence: 1n,
    eventKey: EVENT_KEY,
    title: "Fixture game night",
    game: "Chess",
    description: "Play together.",
    startsAt: now,
    endsAt: new Date("2030-01-01T22:00:00Z"),
    timezone: "UTC",
    location: "Lobby",
    capacity: null,
    status,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: MEMBER_ID,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: now,
    updatedAt: now,
  };
  const featured: typeof featuredContents.$inferSelect = {
    id: 1,
    legacyId: null,
    title: "Fixture featured slot",
    body: null,
    url: null,
    imageUrl: null,
    imageAlt: null,
    isPublished: false,
    position: 0,
    startsAt: null,
    endsAt: null,
    createdBy: MEMBER_ID,
    createdAt: now,
    updatedAt: now,
  };
  const attempt: typeof joinAttempts.$inferSelect = {
    id: 1,
    legacyId: null,
    outcome: "added",
    source: "join",
    requestId: "page-shell-join-request",
    discordId: MEMBER_ID,
    createdAt: now,
  };
  const encode = <T extends Record<string, unknown>>(columns: Record<string, unknown>, row: T) =>
    Object.keys(columns).map((key) =>
      row[key] instanceof Date ? row[key].toISOString() : row[key],
    );
  const db = drizzle(async (sql, params) => {
    if (
      sql ===
        "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)" &&
      params[0] === "2000ms" &&
      params[1] === "2000ms"
    )
      return { rows: [] };
    if (sql.includes('from "users"')) {
      return {
        rows: params.includes(MEMBER_ID)
          ? [
              [
                MEMBER_ID,
                MEMBER_ID,
                "Fixture member",
                null,
                "A local bio.",
                ["Chess"],
                "UTC",
                now.toISOString(),
              ],
            ]
          : [],
      };
    }
    if (sql.includes('from "events"')) {
      if (sql.includes('"events"."id" <>')) return { rows: [] }; // No neighboring/related fixture rows.
      if (sql.includes("count(*)")) return { rows: [[1]] };
      if (sql.includes('"event_key" =') && !params.includes(EVENT_KEY)) return { rows: [] };
      return { rows: [encode(getTableColumns(events), event)] };
    }
    if (sql.includes('from "featured_contents"')) {
      if (sql.includes('"id" =') && !params.includes(1)) return { rows: [] };
      // listVisibleFeatured selects an explicit 6-column projection without
      // legacy_id so it stays readable on pre-1012 shapes; SELECT * includes it.
      if (!sql.includes("legacy_id")) {
        return {
          rows: [
            [
              featured.id,
              featured.title,
              featured.body,
              featured.url,
              featured.imageUrl,
              featured.imageAlt,
            ],
          ],
        };
      }
      return { rows: [encode(getTableColumns(featuredContents), featured)] };
    }
    if (sql.includes('from "join_attempts"')) {
      if (sql.includes("count(*)")) return { rows: [[attempt.outcome, 1]] };
      if (sql.includes('"join_attempts"."id" =') && params[0] !== attempt.id) return { rows: [] };
      // List and detail select the same explicit 6 columns (no legacy_id) so
      // both stay readable on migrateJoin() bootstraps (drizzle/1000 shape).
      if (!sql.includes("legacy_id")) {
        const row = [
          attempt.id,
          attempt.outcome,
          attempt.source,
          attempt.requestId,
          attempt.discordId,
          attempt.createdAt.toISOString(),
        ];
        return { rows: [sql.includes('left join "users"') ? [...row, MEMBER_ID] : row] };
      }
      const row = encode(getTableColumns(joinAttempts), attempt);
      return { rows: [sql.includes('left join "users"') ? [...row, MEMBER_ID] : row] };
    }
    if (
      sql.includes(
        "row_number() over (partition by event_id order by created_at, coalesce(legacy_id, id), id)",
      ) &&
      sql.includes("from rsvps")
    )
      return { rows: [] };
    // The activity-log viewer selects an explicit 7-column projection that
    // never includes `properties`; one null-causer system row keeps the page
    // shell covered without inventing an access-log subject.
    if (sql.includes('from "activity_log"'))
      return {
        rows: [[1, "Fixture activity", "event", "1", null, "created", now.toISOString()]],
      };
    // Frozen Echo fixture (id 1) for the admin detail shell only: the detail
    // select pins the `"event_echoes"."id" = $` where-clause (the join's
    // `"events"."id" = "event_echoes"."event_id"` never matches it). Every
    // other Echo read answers empty so the home/detail/archive shells keep
    // their scope and the ledger list shell renders its empty state. Member
    // rows stay empty: no fixture subject is invented.
    if (sql.includes('from "event_echo_members"')) return { rows: [] };
    if (sql.includes('from "event_echoes"')) {
      if (!sql.includes('"event_echoes"."id" = $') || !params.includes(1)) return { rows: [] };
      return {
        rows: [
          [
            1,
            1,
            EVENT_KEY,
            now.toISOString(),
            new Date("2030-01-01T22:15:00Z").toISOString(),
            10,
            5,
            4,
            [{ channel_id: "1", name_at_close: "Arena" }],
            "Fixture headline",
            null,
            now.toISOString(),
            now.toISOString(),
            "Fixture game night",
          ],
        ],
      };
    }
    if (
      sql.includes('from "rsvps"') ||
      sql.includes("from rsvps") ||
      sql.includes('from "event_search_log"') ||
      sql.startsWith('insert into "member_data_access_logs"') ||
      sql.startsWith("SET LOCAL")
    )
      return { rows: [] };
    throw new Error(`Unexpected page-shell fixture query: ${sql}`);
  });
  // pg-proxy has no transactions. Shim its session, not only db.transaction,
  // so the member-read observer's cloned adapter keeps inventory reads local.
  const session = (
    db as unknown as {
      session: { transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> };
    }
  ).session;
  session.transaction = async (fn) => fn(db as unknown as Db);
  const sessions = createMemorySessionStore();
  // One open stuck intent for the reconciliation shells; no SQL, no Discord.
  const stuck = {
    ...stuckIntent({
      idempotencyKey: RECONCILIATION_KEY,
      verb: "announcement.post",
      subject: "channel-synthetic",
      lastCode: "needs_reconciliation",
      lastStatus: 409,
      lastRequestId: "page-shell-request",
      attempts: 3,
    }),
    firstSeenAt: now,
    lastAttemptAt: now,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
  const reconciliationStore: ReconciliationStore = {
    recordStuck: async () => stuck,
    listOpen: async () => [stuck],
    listResolved: async () => [],
    getStuck: async (key) => (key === RECONCILIATION_KEY ? stuck : null),
    resolveStuck: async () => null,
  };
  const env = {
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "fixture-client",
    DISCORD_GUILD_ID: "fixture-guild",
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    DISCORD_CLIENT_SECRET: "fixture-secret",
    DISCORD_BOT_TOKEN: "",
    SESSION_SECRET: "fixture-session-secret-at-least-32-bytes-long",
    SESSION_STORE: sessions,
    ADMIN_DB: db as unknown as Db,
    RECONCILIATION_DEPS: { store: reconciliationStore },
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as Env;
  const cookie = async () => {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: MEMBER_ID,
      username: "Fixture member",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  };
  return {
    env,
    request: async (path: string) =>
      app.request(
        path,
        {
          headers: { cookie: await cookie(), accept: "text/html" },
        },
        env,
      ),
  };
}
