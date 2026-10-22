// Regression: validate stored source fields before truncating the copy title,
// and refuse unrepresentable dates/zones without crashing the HTML editor.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { newEventKey } from "../src/admin/validation";
import { activityLog, events } from "../src/db/admin-schema";
import type { Env, Session } from "../src/env";
import { registerEventRoutes } from "../src/events/routes";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const secret = "test-session-secret-at-least-32-bytes-long";
const moderator: Session = {
  id: "100000000000000111",
  username: "mod",
  avatar: null,
  member: true,
  moderator: true,
};
const env: Env = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: secret,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
};
const store = createMemorySessionStore();
const jsonApp = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  jsonApp,
  async () => moderator,
  async () => moderator,
);

const invalidSources = [
  { label: "blank title", field: "title", title: "   " },
  { label: "control beyond the copy cutoff", field: "title", title: `${"T".repeat(95)}\u0001` },
  { label: "overlong original title", field: "title", title: "T".repeat(101) },
  { label: "invalid zone", field: "timezone", timezone: "Not/AZone" },
  { label: "infinite start", field: "starts_at", dateColumn: "starts_at", instant: "infinity" },
  { label: "infinite end", field: "ends_at", dateColumn: "ends_at", instant: "infinity" },
  {
    label: "negative infinite start",
    field: "starts_at",
    dateColumn: "starts_at",
    instant: "-infinity",
  },
  { label: "negative infinite end", field: "ends_at", dateColumn: "ends_at", instant: "-infinity" },
] as const;

describe.skipIf(!process.env.DATABASE_URL)("duplicate invalid source regressions", () => {
  let fixture: MemberDataFixture;
  let cookie: string;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: moderator.id,
      username: moderator.username,
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    cookie = (
      await serializeSigned("__Host-two_session", token, secret, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  });
  afterAll(() => fixture?.dispose());
  beforeEach(() => fixture.reset());

  const seed = async (over: Partial<typeof events.$inferInsert> = {}) => {
    const [row] = await fixture.db
      .insert(events)
      .values({
        eventKey: newEventKey(),
        title: "Rolling plan night",
        startsAt: new Date("2099-06-04T19:00:00.000Z"),
        endsAt: new Date("2099-06-04T21:00:00.000Z"),
        timezone: "Europe/London",
        location: "Voice",
        status: "published",
        ...over,
      })
      .returning();
    return row!;
  };

  const request = (surface: "HTML" | "JSON", key: string) =>
    surface === "HTML"
      ? adminApp({ sessionStore: store, db: fixture.db }).request(
          `/events/${key}/duplicate`,
          { method: "POST", headers: { cookie } },
          { ...env, ADMIN_DB: fixture.db } as Env,
        )
      : jsonApp.request(
          `/events/${key}/duplicate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          { ...env, ADMIN_DB: fixture.db } as Env,
        );

  for (const surface of ["HTML", "JSON"] as const) {
    it.each(invalidSources)(
      `${surface} refuses $label with a field-specific 422 and no mutation`,
      async (bad) => {
        const source = await seed({
          ...("title" in bad ? { title: bad.title } : {}),
          ...("timezone" in bad ? { timezone: bad.timezone } : {}),
        });
        if ("dateColumn" in bad) {
          // Raw SQL represents PostgreSQL infinities, which JavaScript Date cannot.
          await fixture.client`update events set ${fixture.client(bad.dateColumn)} = ${bad.instant}::timestamptz where id = ${source.id}`;
        }
        const before = await fixture.client`select to_jsonb(events) as row from events order by id`;
        const res = await request(surface, source.eventKey);
        expect(res.status).toBe(422);
        if (surface === "JSON") {
          expect(await res.json()).toMatchObject({
            error: "invalid",
            fields: { [bad.field]: expect.any(String) },
          });
        } else {
          const html = await res.text();
          expect(html).toContain(`name="${bad.field}"`);
          expect(html).toContain(`href="#f-${bad.field.replaceAll("_", "-")}"`);
          expect(html).toContain('data-event-draft=""');
          if ("timezone" in bad) {
            expect(html).toContain('value="Not/AZone"');
            // Never reinterpret the saved instants in a default zone on refusal.
            expect(html).toMatch(/name="starts_at"[^>]*value=""/);
            expect(html).toMatch(/name="ends_at"[^>]*value=""/);
          }
        }
        expect(
          await fixture.client`select to_jsonb(events) as row from events order by id`,
        ).toEqual(before);
        expect(await fixture.db.select().from(activityLog)).toEqual([]);
        expect(await fixture.client`select * from queue_jobs`).toEqual([]);
      },
    );

    it(`${surface} still accepts and truncates a valid 100-code-point title`, async () => {
      const source = await seed({ title: "🎲".repeat(100) });
      const res = await request(surface, source.eventKey);
      expect(res.status).toBe(surface === "HTML" ? 303 : 201);
      const rows = await fixture.db.select().from(events);
      expect(rows).toHaveLength(2);
      const copy = rows.find((row) => row.id !== source.id)!;
      expect(copy.title).toBe(`Copy of ${"🎲".repeat(92)}`);
      expect(copy.status).toBe("draft");
      expect(copy.startsAt).toEqual(source.startsAt);
      expect(copy.endsAt).toEqual(source.endsAt);
      expect(rows.find((row) => row.id === source.id)).toEqual(source);
      expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
    });
  }
});
