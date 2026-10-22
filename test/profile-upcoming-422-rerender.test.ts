// The failed-save re-renders and the upcoming section: a 422 keeps the
// section next to the rejected draft (owner-only, same read as the GET
// self-view); the 503 re-render issues no further reads against the failed
// database, so the section stays hidden there. Hermetic, no database.
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import type { UpcomingGameNight } from "../src/profiles/upcoming";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const SECRET = "test-only-not-a-real-secret-value";
const OWNER = "100000000000000001";
const ORIGIN = "https://next.example.test";

const NIGHT: UpcomingGameNight = {
  eventKey: "01J0000000000000000000A01",
  title: "Alpha Night",
  startsAt: new Date("2070-06-01T18:00:00Z"),
  timezone: "Europe/London",
  location: "Alpha Hall",
  status: "going",
  waitlistPosition: null,
};

async function harness(options: { saveThrows?: unknown } = {}) {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: OWNER,
    username: "alice",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  const store = createMemoryProfileStore([
    {
      id: OWNER,
      username: "alice",
      avatar: null,
      bio: "Saved bio.",
      games: ["Chess"],
      timezone: "Europe/London",
      leaderboardOptOut: false,
    },
  ]);
  if (options.saveThrows !== undefined) {
    const thrown = options.saveThrows;
    vi.spyOn(store, "save").mockRejectedValue(thrown);
  }
  const upcomingCalls: string[] = [];
  const app = profilesApp({
    sessionStore: sessions,
    store,
    upcoming: async (memberId) => {
      upcomingCalls.push(memberId);
      return [NIGHT];
    },
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  const env = { APP_URL: ORIGIN, SESSION_SECRET: SECRET } as Env;
  const save = (body: URLSearchParams) =>
    app.request(
      `/members/${OWNER}`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body,
      },
      env,
    );
  return { save, upcomingCalls };
}

describe("upcoming section on failed saves", () => {
  it("keeps the section next to the rejected draft on a 422", async () => {
    const { save, upcomingCalls } = await harness();
    const res = await save(
      new URLSearchParams({
        _method: "PATCH",
        bio: "Rejected draft bio.",
        games_text: "Chess",
        timezone: "Invalid/Zone",
      }),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Rejected draft bio.");
    expect(html).toContain('data-testid="profile-upcoming"');
    expect(html).toContain("Alpha Night");
    expect(upcomingCalls).toEqual([OWNER]);
  });

  it("issues no upcoming read on the 503 save-failure re-render", async () => {
    const outage = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { save, upcomingCalls } = await harness({ saveThrows: outage });
      const res = await save(
        new URLSearchParams({
          _method: "PATCH",
          bio: "Draft kept through the outage.",
          games_text: "Chess",
          timezone: "Europe/London",
        }),
      );
      expect(res.status).toBe(503);
      const html = await res.text();
      expect(html).toContain("Draft kept through the outage.");
      expect(html).not.toContain("profile-upcoming");
      expect(upcomingCalls).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
