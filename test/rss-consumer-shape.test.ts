// route-inventory: GET /events.rss
// RSS consumer shape: the channel lastBuildDate must parse as the UTC instant
// on both DST sides, and the moderator/member/guest bytes must be identical
// with drafts never exposed (the route reads no session; lastBuild covers
// published rows only). Byte-stability of empty feeds belongs to the
// empty-RSS validator card, so every fixture here is nonempty.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { eventsRss } from "../src/events/feeds";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import app from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const COOKIE = "__Host-two_session";

const row = (o: Partial<typeof events.$inferSelect> = {}) =>
  ({
    id: 1,
    icsSequence: 0n,
    eventKey: "01J0000000000000000000ABCD",
    title: "Friday night Helldivers",
    game: null,
    description: "Bring stims.",
    startsAt: new Date("2026-07-15T18:00:00Z"),
    endsAt: new Date("2026-07-15T20:00:00Z"),
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    updatedAt: new Date("2026-07-01T12:00:00Z"),
    ...o,
  }) as typeof events.$inferSelect;

/** Independent channel parse: a plain regex, not the production encoder. */
function channelLastBuildDate(document: string): string {
  const match = document.match(/<lastBuildDate>([^<]*)<\/lastBuildDate>/);
  expect(match?.[1]).toBeTruthy();
  return match![1]!;
}

/** RFC 2822 `+0000` shape plus a Date.parse round-trip to the exact instant. */
function expectUtcInstant(raw: string, expected: Date): void {
  expect(raw).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  const ms = Date.parse(raw);
  expect(Number.isNaN(ms)).toBe(false);
  expect(new Date(ms).toISOString()).toBe(expected.toISOString());
}

describe("rss consumer shape (channel lastBuildDate, no DB)", () => {
  it("parses the summer lastBuildDate as the UTC instant", () => {
    const built = new Date("2026-07-01T12:00:00Z");
    const out = eventsRss([row()], APP_URL, built);
    expect(channelLastBuildDate(out)).toBe("Wed, 01 Jul 2026 12:00:00 +0000");
    expectUtcInstant(channelLastBuildDate(out), built);
  });

  it("parses the winter lastBuildDate as the UTC instant", () => {
    const built = new Date("2026-01-15T20:00:00Z");
    const out = eventsRss(
      [
        row({
          startsAt: new Date("2026-01-15T20:00:00Z"),
          endsAt: new Date("2026-01-15T22:00:00Z"),
          updatedAt: built,
        }),
      ],
      APP_URL,
      built,
    );
    expect(channelLastBuildDate(out)).toBe("Thu, 15 Jan 2026 20:00:00 +0000");
    expectUtcInstant(channelLastBuildDate(out), built);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("rss moderator parity (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  const store = createMemorySessionStore();
  const bindings = () =>
    ({
      APP_URL,
      SESSION_SECRET: SECRET,
      SESSION_STORE: store,
      ADMIN_DB: fixture.db,
    }) as unknown as Env;
  const req = (path: string, init: RequestInit = {}) => app.request(path, init, bindings());

  async function cookieFor(store: SessionStore, moderator: boolean): Promise<string> {
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: moderator ? "rss-mod" : "rss-member",
      username: "rss",
      avatar: null,
      member: true,
      moderator,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned(COOKIE, token, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  }

  const PUB = "01J0000000000000000000RS1P";
  const DRAFT = "01J000000000000000000DRF1";
  const CANCELLED = "01J00000000000000000CAN1";

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
  });

  it("serves byte-identical RSS to guest, member and moderator; drafts never exposed and never move lastBuildDate", async () => {
    await fixture.db.insert(events).values([
      {
        eventKey: PUB,
        title: "Summer raid",
        startsAt: new Date("2099-07-15T18:00:00Z"),
        endsAt: new Date("2099-07-15T20:00:00Z"),
        timezone: "Europe/London",
        status: "published",
        updatedAt: new Date("2026-07-01T12:00:00Z"),
      },
      {
        // Newer than the published row: must still not leak into the channel.
        eventKey: DRAFT,
        title: "Secret draft plan",
        startsAt: new Date("2099-07-16T18:00:00Z"),
        endsAt: new Date("2099-07-16T20:00:00Z"),
        timezone: "Europe/London",
        status: "draft",
        updatedAt: new Date("2026-07-02T12:00:00Z"),
      },
      {
        eventKey: CANCELLED,
        title: "Cancelled night",
        startsAt: new Date("2099-07-17T18:00:00Z"),
        endsAt: new Date("2099-07-17T20:00:00Z"),
        timezone: "Europe/London",
        status: "cancelled",
        updatedAt: new Date("2026-07-01T12:00:00Z"),
      },
    ]);
    const guest = await req("/events.rss");
    const member = await req("/events.rss", { headers: { cookie: await cookieFor(store, false) } });
    const moderator = await req("/events.rss", {
      headers: { cookie: await cookieFor(store, true) },
    });
    for (const response of [guest, member, moderator]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("max-age=300, public");
      // The feed route never reads or issues a session, even for a signed cookie.
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const [guestBody, memberBody, moderatorBody] = await Promise.all([
      guest.text(),
      member.text(),
      moderator.text(),
    ]);
    expect(memberBody).toBe(guestBody);
    expect(moderatorBody).toBe(guestBody);
    expect(guestBody).toContain(PUB);
    for (const key of [DRAFT, CANCELLED]) expect(guestBody).not.toContain(key);
    // lastBuildDate is the published max, not the draft's newer stamp.
    expect(channelLastBuildDate(guestBody)).toBe("Wed, 01 Jul 2026 12:00:00 +0000");
    expectUtcInstant(channelLastBuildDate(guestBody), new Date("2026-07-01T12:00:00Z"));
  });

  it("parses the winter lastBuildDate as the UTC instant at the route level", async () => {
    await fixture.db.insert(events).values({
      eventKey: PUB,
      title: "Winter raid",
      startsAt: new Date("2099-01-15T20:00:00Z"),
      endsAt: new Date("2099-01-15T22:00:00Z"),
      timezone: "Europe/London",
      status: "published",
      updatedAt: new Date("2026-01-15T20:00:00Z"),
    });
    const response = await req("/events.rss");
    expect(response.status).toBe(200);
    const lastBuild = channelLastBuildDate(await response.text());
    expect(lastBuild).toBe("Thu, 15 Jan 2026 20:00:00 +0000");
    expectUtcInstant(lastBuild, new Date("2026-01-15T20:00:00Z"));
  });
});
