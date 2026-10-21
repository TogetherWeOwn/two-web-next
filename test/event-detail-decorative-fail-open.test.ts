// Acceptance (fail-first): event-detail decorative reads fail open, Hono twin.
//
// GET /e/:key must stay 200 when the neighbors or related read throws,
// omitting only that section while every viewer section stays intact. Viewer
// reads (attendees, waitlist position, answer) keep failing closed with the
// existing 503 contract refusal. Hermetic fakes behind vi.mock: no database,
// no network.
//
// Owned by the acceptance card; the Builder implements on this branch and
// never edits this file. Degraded shape (Builder contract): a throwing
// neighbors read renders as { previous: null, next: null } (no
// event-pagination nav, exactly like a lone event); a throwing related read
// renders as [] (no event-related section). Viewer reads are untouched.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import app from "./app";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  getEventNeighbors,
  getPublicEvent,
  getViewerRsvp,
  listGoingAttendees,
  listRelatedEvents,
  type EventLink,
  type EventNeighbors,
  type PublicEvent,
} from "../src/events/reads";
import { waitlistPosition } from "../src/events/waitlist";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
  getEventNeighbors: vi.fn(),
  listRelatedEvents: vi.fn(),
  listGoingAttendees: vi.fn(),
  getViewerRsvp: vi.fn(),
}));
vi.mock("../src/events/waitlist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/waitlist")>()),
  waitlistPosition: vi.fn(),
}));

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PREV_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAD";
const NEXT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const MEMBER_ID = "100000000000000001";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const CONTRACT_REFUSAL = "Member data is temporarily unavailable.";

function link(over: Partial<EventLink> & { eventKey: string }): EventLink {
  return {
    id: 9,
    title: "Chess finals",
    startsAt: new Date("2030-02-01T19:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    ...over,
  };
}

const EVENT: PublicEvent = {
  id: 7,
  icsSequence: 4n,
  eventKey: KEY,
  title: "Chess night",
  description: "Bring a friend & a board.",
  game: "Chess",
  startsAt: new Date("2030-01-10T20:00:00Z"),
  endsAt: new Date("2030-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "The lobby",
  capacity: 10,
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
  createdAt: new Date("2030-01-01T00:00:00Z"),
  updatedAt: new Date("2030-01-01T00:00:00Z"),
  goingCount: 3,
  goingOccupancy: 3,
};

// Two-sided neighbors so the related-throw test can pin the full neighbor rail
// intact while the neighbors-throw test pins the whole rail absent.
const NEIGHBORS: EventNeighbors = {
  previous: link({ eventKey: PREV_KEY, title: "Chess warm-up", id: 6 }),
  next: link({ eventKey: NEXT_KEY, title: "Chess finals", id: 9 }),
};
const RELATED: EventLink[] = [link({ eventKey: NEXT_KEY, title: "Chess finals", id: 9 })];
const ATTENDEES = [{ id: "100000000000000003", name: "ann" }];
const ANSWER = { status: "going", syncedToDiscordAt: null };

async function memberCookie(store: ReturnType<typeof createMemorySessionStore>): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: MEMBER_ID,
    username: "member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

async function memberPage(): Promise<Response> {
  const store = createMemorySessionStore();
  const cookie = await memberCookie(store);
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: {},
  } as unknown as Env;
  return app.request(`/e/${KEY}`, { headers: { cookie } }, env);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPublicEvent).mockResolvedValue(EVENT);
  vi.mocked(getEventNeighbors).mockResolvedValue(NEIGHBORS);
  vi.mocked(listRelatedEvents).mockResolvedValue(RELATED);
  vi.mocked(listGoingAttendees).mockResolvedValue(ATTENDEES);
  vi.mocked(getViewerRsvp).mockResolvedValue(ANSWER);
  vi.mocked(waitlistPosition).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetAlertRateLimitForTests();
});

describe("event-detail decorative fail-open (Hono twin)", () => {
  it("neighbors throw: stays 200 with viewer sections intact and only the neighbor rail absent", async () => {
    vi.mocked(getEventNeighbors).mockRejectedValue(new Error("neighbors down"));
    const response = await memberPage();
    expect(response.status).toBe(200);
    const html = await response.text();
    // Absent state: the whole neighbor rail is gone, exactly like a lone event.
    expect(html).not.toContain('data-testid="event-pagination"');
    expect(html).not.toContain('data-testid="event-previous"');
    expect(html).not.toContain('data-testid="event-next"');
    // Intact state: viewer sections and the independent related rail survive.
    expect(html).toContain('data-testid="event-attendees"');
    expect(html).toContain(">ann<");
    expect(html).toContain('data-testid="rsvp-confirmed"');
    expect(html).toContain('data-testid="rsvp-withdraw"');
    expect(html).toContain('data-testid="event-venue">The lobby');
    expect(html).toContain('data-testid="event-related"');
    expect(html).toContain('data-testid="event-related-link"');
    expect(html).toContain("Chess finals");
    // The fake actually threw: a vacuous mock would hide a dead seam.
    expect(getEventNeighbors).toHaveBeenCalledTimes(1);
    expect(listRelatedEvents).toHaveBeenCalledTimes(1);
    expect(listGoingAttendees).toHaveBeenCalled();
    expect(getViewerRsvp).toHaveBeenCalled();
    expect(waitlistPosition).toHaveBeenCalled();
  });

  it("related throw: stays 200 with viewer sections and the neighbor rail intact", async () => {
    vi.mocked(listRelatedEvents).mockRejectedValue(new Error("related down"));
    const response = await memberPage();
    expect(response.status).toBe(200);
    const html = await response.text();
    // Absent state: only the related block is gone.
    expect(html).not.toContain('data-testid="event-related"');
    expect(html).not.toContain('data-testid="event-related-link"');
    // Intact state: viewer sections and the full two-sided neighbor rail survive.
    expect(html).toContain('data-testid="event-attendees"');
    expect(html).toContain(">ann<");
    expect(html).toContain('data-testid="rsvp-confirmed"');
    expect(html).toContain('data-testid="event-venue">The lobby');
    expect(html).toContain('data-testid="event-pagination"');
    expect(html).toContain(`href="/e/${PREV_KEY}" rel="prev" data-testid="event-previous"`);
    expect(html).toContain(`href="/e/${NEXT_KEY}" rel="next" data-testid="event-next"`);
    expect(getEventNeighbors).toHaveBeenCalledTimes(1);
    expect(listRelatedEvents).toHaveBeenCalledTimes(1);
    expect(listGoingAttendees).toHaveBeenCalled();
    expect(getViewerRsvp).toHaveBeenCalled();
    expect(waitlistPosition).toHaveBeenCalled();
  });
});

describe("event-detail viewer reads stay closed (Hono twin)", () => {
  it("attendees throw: keeps the 503 contract refusal with no member data", async () => {
    vi.mocked(listGoingAttendees).mockRejectedValue(new Error("attendees down"));
    const response = await memberPage();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).toContain(CONTRACT_REFUSAL);
    expect(body).not.toContain("ann");
    expect(listGoingAttendees).toHaveBeenCalledTimes(1);
  });

  it("waitlist-position throw: keeps the 503 contract refusal", async () => {
    vi.mocked(waitlistPosition).mockRejectedValue(new Error("waitlist down"));
    const response = await memberPage();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain(CONTRACT_REFUSAL);
    expect(body).not.toContain("ann");
    expect(waitlistPosition).toHaveBeenCalledTimes(1);
  });

  it("viewer-answer throw: keeps the 503 contract refusal", async () => {
    vi.mocked(getViewerRsvp).mockRejectedValue(new Error("answer down"));
    const response = await memberPage();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain(CONTRACT_REFUSAL);
    expect(body).not.toContain("ann");
    expect(getViewerRsvp).toHaveBeenCalledTimes(1);
  });
});

describe("event-detail decorative read classification", () => {
  const reads = readFileSync(new URL("../src/events/reads.ts", import.meta.url), "utf8");
  const waitlist = readFileSync(new URL("../src/events/waitlist.ts", import.meta.url), "utf8");

  function bodyOf(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(end, `missing ${endMarker}`).toBeGreaterThanOrEqual(0);
    return source.slice(start, end);
  }

  it("neighbors and related stay nonSensitive published-only reads", () => {
    const neighbors = bodyOf(
      reads,
      "export async function getEventNeighbors(",
      "export async function listRelatedEvents(",
    );
    const related = bodyOf(
      reads,
      "export async function listRelatedEvents(",
      "export type ViewerRsvp",
    );
    for (const [name, body] of [
      ["getEventNeighbors", neighbors],
      ["listRelatedEvents", related],
    ] as const) {
      expect(body, `${name} classification`).toContain('nonSensitiveRead("events"');
      expect(body, `${name} published scope`).toContain('eq(events.status, "published")');
      expect(body, `${name} must not key member data`).not.toContain("keyedMemberRead");
    }
  });

  it("viewer reads stay keyed member reads", () => {
    const answer = bodyOf(
      reads,
      "export async function getViewerRsvp(",
      "export type EventAttendee",
    );
    const attendees = bodyOf(
      reads,
      "export async function listGoingAttendees(",
      "export async function listJson(",
    );
    const positions = bodyOf(
      waitlist,
      "export async function waitlistPositions(",
      "export async function waitlistPosition(",
    );
    for (const [name, body] of [
      ["getViewerRsvp", answer],
      ["listGoingAttendees", attendees],
      ["waitlistPositions", positions],
    ] as const) {
      expect(body, `${name} keying`).toContain("keyedMemberRead");
      expect(body, `${name} must not declassify`).not.toContain("nonSensitiveRead");
    }
  });
});
