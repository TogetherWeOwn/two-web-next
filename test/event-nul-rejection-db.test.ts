// Real-persistence half of the event NUL acceptance suite (see
// test/event-nul-rejection.test.ts for the hermetic parser/route half and the
// pre-fix probe summary). No store mocks here: writes go to the guarded
// disposable test DB via the real admin form handlers.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { activityLog, events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const FIELDS = ["title", "game", "description", "location"] as const;

// Real persistence against the guarded disposable test DB: pre-fix the game
// cases surface the database NUL failure (500); post-fix they are the same
// field-named 422 the other fields already return, with no row and no audit.
describe.skipIf(!process.env.DATABASE_URL)(
  "admin event form NUL rejection (isolated test DB)",
  () => {
    const APP_URL = "https://next.example.test";
    const SESSION_SECRET = "event-nul-test-secret-at-least-32-bytes!";
    const FORM_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
    const FORM = {
      title: "Game night",
      game: "Chess",
      description: "Boards out",
      location: "Voice",
      capacity: "8",
      starts_at: "2026-11-04 20:00",
      ends_at: "2026-11-04 22:00",
      timezone: "Europe/London",
    };
    let fixture: MemberDataFixture;
    let cookie: string;
    let env: Env;
    let app: Hono<{ Bindings: Env }>;
    const store = createMemorySessionStore();

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "nul-rejection-mod",
        username: "mod",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      cookie = (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      env = {
        APP_URL,
        SESSION_SECRET,
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_GUILD_ID: "guild",
        DISCORD_INVITE_URL: "https://discord.gg/invite",
        DISCORD_BOT_TOKEN: "bot-token",
        ADMIN_DB: fixture.db,
      } as Env;
      app = new Hono<{ Bindings: Env }>()
        .use("*", sameOrigin)
        .route("/admin", adminApp({ sessionStore: store, db: fixture.db }));
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.insert(events).values({
        eventKey: FORM_KEY,
        title: "Stored title",
        game: "Stored game",
        timezone: FORM.timezone,
        status: "draft",
        startsAt: new Date("2026-11-04T20:00:00Z"),
        endsAt: new Date("2026-11-04T22:00:00Z"),
      });
    });

    const post = (path: string, values: Record<string, string>) =>
      app.request(
        APP_URL + path,
        { method: "POST", headers: { cookie, origin: APP_URL }, body: new URLSearchParams(values) },
        env,
      );

    for (const field of FIELDS) {
      it(`create: NUL in ${field} is a field-named 422 with no row and no audit`, async () => {
        const before = await fixture.db.select().from(events);
        const res = await post("/admin/events", { ...FORM, [field]: "a\u0000b" });
        expect(res.status).toBe(422);
        expect(await res.text()).toContain(`data-testid="error-${field}"`);
        expect(await fixture.db.select().from(events)).toEqual(before);
        expect(await fixture.db.select().from(activityLog)).toEqual([]);
      });

      it(`edit: NUL in ${field} is a field-named 422 and the stored row is unchanged`, async () => {
        const before = await fixture.db.select().from(events);
        const res = await post(`/admin/events/${FORM_KEY}`, { ...FORM, [field]: "a\u0000b" });
        expect(res.status).toBe(422);
        expect(await res.text()).toContain(`data-testid="error-${field}"`);
        expect(await fixture.db.select().from(events)).toEqual(before);
        expect(await fixture.db.select().from(activityLog)).toEqual([]);
      });
    }

    it("create: valid multibyte free text persists verbatim", async () => {
      const values = {
        ...FORM,
        title: "👩‍💻 Game night",
        game: "将棋",
        description: "Café — é",
        location: "東京 / Voice",
      };
      const res = await post("/admin/events", values);
      expect(res.status).toBe(303);
      const key = res.headers.get("location")!.split("/").pop()!;
      const [savedRow] = await fixture.db.select().from(events).where(eq(events.eventKey, key));
      expect(savedRow).toMatchObject({
        title: values.title,
        game: values.game,
        description: values.description,
        location: values.location,
      });
    });
  },
);
