// Invented capture data. No Discord calls, copied member data or session material.
import { createHash } from "node:crypto";
import { priorGrid } from "../../src/hotzones/aggregates";

export const CAPTURE_SEED = "ember-capture-v1";
export const CAPTURE_INSTANT = "2098-12-31T20:00:00.000Z";
const stamp = { created_at: "2098-12-30T18:00:00.000Z", updated_at: "2098-12-30T18:00:00.000Z" };
export const CAPTURE_IDENTITIES = {
  guest: {
    userId: "900000000000009801",
    username: "Capture Guest",
    member: false,
    moderator: false,
  },
  member: {
    userId: "900000000000009802",
    username: "Capture Rowan",
    member: true,
    moderator: false,
  },
  moderator: {
    userId: "900000000000009803",
    username: "Capture Quinn",
    member: true,
    moderator: true,
  },
  reserve: {
    userId: "900000000000009804",
    username: "Capture Avery",
    member: true,
    moderator: false,
  },
} as const;

export const CAPTURE_KEYS = {
  upcoming: "01J00000000000000000000001",
  past: "01J00000000000000000000002",
  may: "01J00000000000000000000003",
  june: "01J00000000000000000000004",
  paused: "01J00000000000000000000005",
  cancelled: "01J00000000000000000000006",
} as const;

type Cell = string | number | boolean | null | string[] | Record<string, unknown>;
export type CaptureRow = Record<string, Cell>;
export type CaptureTables = Record<string, CaptureRow[]>;

const event = (
  id: number,
  key: string,
  title: string,
  day: string,
  status = "published",
  open = true,
) => ({
  id,
  event_key: key,
  title,
  description: "Invented disposable capture gathering.",
  game: "Capture Chess",
  starts_at: `${day}T18:00:00.000Z`,
  ends_at: `${day}T20:00:00.000Z`,
  timezone: "Europe/London",
  status,
  capacity: 1,
  rsvp_open: open,
  created_by: CAPTURE_IDENTITIES.moderator.userId,
  ...stamp,
});
const rsvp = (id: number, eventId: number, userId: string, status: string) => ({
  id,
  event_id: eventId,
  user_id: userId,
  status,
  synced_to_discord_at: stamp.created_at,
  ...stamp,
});

export function captureTables(): CaptureTables {
  return {
    users: Object.values(CAPTURE_IDENTITIES).map((actor) => ({
      id: actor.userId,
      username: actor.username,
      avatar: null,
      member: actor.member,
      ...stamp,
    })),
    profiles: [
      CAPTURE_IDENTITIES.member,
      CAPTURE_IDENTITIES.moderator,
      CAPTURE_IDENTITIES.reserve,
    ].map((actor) => ({
      user_id: actor.userId,
      bio: "Invented member for local capture only.",
      games: ["Capture Chess"],
      timezone: "Europe/London",
      leaderboard_opt_out: false,
      ...stamp,
    })),
    events: [
      event(1, CAPTURE_KEYS.upcoming, "Capture Community Night", "2099-01-01"),
      { ...event(2, CAPTURE_KEYS.past, "Capture Past Night", "2098-12-28"), capacity: 2 },
      event(3, CAPTURE_KEYS.may, "Capture May Night", "2099-05-15"),
      event(4, CAPTURE_KEYS.june, "Capture June Night", "2099-06-15"),
      event(5, CAPTURE_KEYS.paused, "Capture Paused Night", "2099-01-02", "published", false),
      event(6, CAPTURE_KEYS.cancelled, "Capture Cancelled Night", "2099-01-03", "cancelled", false),
    ],
    rsvps: [
      rsvp(1, 1, CAPTURE_IDENTITIES.member.userId, "going"),
      rsvp(2, 1, CAPTURE_IDENTITIES.reserve.userId, "waitlisted"),
      rsvp(3, 2, CAPTURE_IDENTITIES.member.userId, "going"),
      rsvp(4, 2, CAPTURE_IDENTITIES.moderator.userId, "going"),
      rsvp(5, 5, CAPTURE_IDENTITIES.member.userId, "going"),
    ],
    featured_contents: [
      {
        id: 1,
        title: "Capture Community Night",
        body: "Invented featured gathering.",
        url: `/e/${CAPTURE_KEYS.upcoming}`,
        image_url: null,
        image_alt: null,
        is_published: true,
        position: 0,
        starts_at: "2098-12-01T00:00:00.000Z",
        ends_at: "2099-02-01T00:00:00.000Z",
        created_by: CAPTURE_IDENTITIES.moderator.userId,
        ...stamp,
      },
    ],
    join_attempts: [
      {
        id: 1,
        outcome: "added",
        source: "capture",
        request_id: "ember-join-added",
        discord_id: CAPTURE_IDENTITIES.member.userId,
        created_at: "2098-12-30T19:00:00.000Z",
      },
      {
        id: 2,
        outcome: "already_member",
        source: "capture",
        request_id: "ember-join-existing",
        discord_id: CAPTURE_IDENTITIES.moderator.userId,
        created_at: "2098-12-31T18:00:00.000Z",
      },
      {
        id: 3,
        outcome: "error",
        source: "capture",
        request_id: "ember-join-error",
        discord_id: null,
        created_at: "2098-12-31T19:00:00.000Z",
      },
    ],
    activity_log: [
      {
        id: 1,
        log_name: "default",
        description: "created",
        subject_type: "App\\Models\\Event",
        subject_id: "1",
        causer_type: "App\\Models\\User",
        causer_id: CAPTURE_IDENTITIES.moderator.userId,
        event: "created",
        properties: { title: { before: null, after: "Capture Community Night" } },
        ...stamp,
      },
    ],
  };
}

export type CapturePersona = "guest" | "member" | "moderator";
export type RouteState = {
  id: string;
  route: string;
  persona: CapturePersona;
  expectedStatus: number;
  requires: string[];
};

export function captureRoutes(): RouteState[] {
  const rows: RouteState[] = [];
  const add = (
    id: string,
    route: string,
    persona: CapturePersona = "guest",
    requires: string[] = [],
    expectedStatus = 200,
  ) => rows.push({ id, route, persona, expectedStatus, requires });
  add("home-guest", "/", "guest", ["events", "featured_contents"]);
  add("home-member", "/", "member", ["events", "featured_contents"]);
  add("events-guest", "/events", "guest", ["events"]);
  add("past-guest", "/events/past", "guest", ["events:2"]);
  add("event-guest", `/e/${CAPTURE_KEYS.upcoming}`, "guest", ["events:1", "rsvps"]);
  add("event-member", `/e/${CAPTURE_KEYS.upcoming}`, "member", ["events:1", "rsvps:1", "rsvps:2"]);
  add("event-paused-member", `/e/${CAPTURE_KEYS.paused}`, "member", ["events:5", "rsvps:5"]);
  add("event-cancelled-guest", `/e/${CAPTURE_KEYS.cancelled}`, "guest", ["events:6"], 410);
  for (const route of ["/about", "/faq", "/rules", "/privacy", "/join", "/auth/recover"])
    add(`${route.slice(1).replaceAll("/", "-")}-guest`, route);
  add("profile-member", "/profile", "member", [
    "users:900000000000009802",
    "profiles:900000000000009802",
  ]);
  add("member-guest", "/members/900000000000009802", "guest", [
    "users:900000000000009802",
    "profiles:900000000000009802",
  ]);
  add("member-member", "/members/900000000000009802", "member", [
    "users:900000000000009802",
    "profiles:900000000000009802",
  ]);
  add("leaderboard-member", "/leaderboards/members", "member", ["leaderboard"]);
  add("hotzones-guest", "/hotzones", "guest", ["joins", "voice", "games"]);
  add("hotzones-joins-guest", "/hotzones/joins", "guest", ["joins"]);
  add("voice-guest", "/voice", "guest", ["voice"]);
  add("games-guest", "/games", "guest", ["games"]);
  add("admin-moderator", "/admin", "moderator", ["events", "join_attempts"]);
  add("admin-events-moderator", "/admin/events", "moderator", ["events"]);
  add("admin-events-new-moderator", "/admin/events/new", "moderator");
  add("admin-event-moderator", `/admin/events/${CAPTURE_KEYS.upcoming}`, "moderator", [
    "events:1",
    "rsvps",
  ]);
  add("admin-featured-moderator", "/admin/featured", "moderator", ["featured_contents"]);
  add("admin-featured-new-moderator", "/admin/featured/new", "moderator");
  add("admin-featured-detail-moderator", "/admin/featured/1", "moderator", ["featured_contents:1"]);
  add("admin-activity-moderator", "/admin/activity-log", "moderator", ["activity_log"]);
  add("admin-joins-moderator", "/admin/join-attempts", "moderator", ["join_attempts"]);
  add("admin-join-detail-moderator", "/admin/join-attempts/1", "moderator", ["join_attempts:1"]);
  add("unknown-guest", "/ember-capture-unknown", "guest", [], 404);
  return rows;
}

export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, entry]) => [k, normalize(entry)]),
      );
    return v;
  };
  return JSON.stringify(normalize(value));
}
export const captureHash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export function captureManifest() {
  const tables = captureTables();
  const routeStates = captureRoutes();
  const data = { tables, voice: priorGrid("voice"), games: priorGrid("games") };
  return {
    version: 1,
    seedId: CAPTURE_SEED,
    renderInstant: CAPTURE_INSTANT,
    dataHash: captureHash(data),
    bindingsHash: captureHash(routeStates),
    hashProvenance:
      "SHA-256 of canonical UTF-8 JSON: sorted object keys, declared array order, ISO UTC timestamps; seed-owned table columns plus shipped voice/game priors. Excludes session material, schema names and runtime audit writes.",
    ids: {
      events: CAPTURE_KEYS,
      member: CAPTURE_IDENTITIES.member.userId,
      moderator: CAPTURE_IDENTITIES.moderator.userId,
      featured: 1,
      joinAttempt: 1,
      activity: 1,
    },
    sessions: {
      guest: { kind: "anonymous", member: false, moderator: false },
      member: {
        kind: "ephemeral-local",
        member: true,
        moderator: false,
        ttlSeconds: 7200,
        absoluteMaxAgeSeconds: 86400,
      },
      moderator: {
        kind: "ephemeral-local",
        member: true,
        moderator: true,
        ttlSeconds: 7200,
        absoluteMaxAgeSeconds: 86400,
      },
    },
    aggregates: {
      joins: {
        source: "join_attempts + profiles + events",
        successfulAttempts: 2,
        allTimeEventCount: 5,
      },
      voice: {
        source: "shipped priorGrid(voice), estimate, not live Discord",
        hash: captureHash(data.voice),
      },
      games: {
        source: "shipped priorGrid(games), estimate, not live Discord",
        hash: captureHash(data.games),
      },
      leaderboard: {
        source: "users + profiles + rsvps + events",
        allTime: [
          { userId: "900000000000009802", count: 3 },
          { userId: "900000000000009803", count: 1 },
        ],
      },
    },
    routeStates,
    readiness: {
      pilot: "not_ready",
      note: "Data prerequisite only. Adapter, server render clock, Ember shell/fonts/tokens and migration qualification remain separate. Guest member-page access currently redirects; never omit or relabel that declared 200 row.",
    },
  };
}

export function assertCaptureData(actual: CaptureTables) {
  // Exact table/column/row equality: missing data must never become a smaller successful matrix.
  if (canonicalJson(actual) !== canonicalJson(captureTables()))
    throw new Error("capture_invalid: fixture data differs from ember-capture-v1");
}
