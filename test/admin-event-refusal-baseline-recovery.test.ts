import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { adminApp } from "../src/admin/routes";
import { newEventKey } from "../src/admin/validation";
import { activityLog, events } from "../src/db/admin-schema";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { savedForm } from "./helpers/event-save-document";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const env: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
};
const moderatorId = "100000000000000111";
const cases: {
  name: string;
  changes: Partial<typeof events.$inferInsert>;
  column?: "starts_at" | "ends_at";
  correction: Record<string, string>;
  audit: Record<string, { before: string | null; after: string }>;
}[] = [
  {
    name: "blank title",
    changes: { title: "   " },
    correction: { title: "Repaired game night" },
    audit: { title: { before: "   ", after: "Repaired game night" } },
  },
  {
    name: "invalid timezone",
    changes: { timezone: "Not/AZone" },
    correction: { timezone: "UTC", starts_at: "2099-07-01 19:00", ends_at: "2099-07-01 21:00" },
    audit: { timezone: { before: "Not/AZone", after: "UTC" } },
  },
  {
    name: "nonfinite start",
    changes: {},
    column: "starts_at",
    correction: { starts_at: "2099-07-01 19:00" },
    audit: { startsAt: { before: null, after: "2099-07-01T19:00:00.000Z" } },
  },
  {
    name: "nonfinite end",
    changes: {},
    column: "ends_at",
    correction: { ends_at: "2099-07-01 21:00" },
    audit: { endsAt: { before: null, after: "2099-07-01T21:00:00.000Z" } },
  },
];

// Removing only the baseline mint from either refusal renderer must make the
// direct correction fail: no intervening GET is allowed to repair the form.
// Requires the disposable DATABASE_URL; the fixture validates it before use.
describe("admin action refusals: save directly from the returned document", () => {
  let fixture: MemberDataFixture;
  let app: Hono<{ Bindings: EnvWithAdminDb }>;
  let cookie: string;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    const store = createMemorySessionStore();
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token),
      userId: moderatorId,
      username: "moderator",
      avatar: null,
      member: true,
      moderator: true,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    cookie = (
      await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
    app = new Hono<{ Bindings: EnvWithAdminDb }>();
    app.use("*", sameOrigin);
    app.route("/admin", adminApp({ sessionStore: store, db: fixture.db }));
  });
  afterAll(async () => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from queue_jobs`;
  });

  const seed = async (changes: Partial<typeof events.$inferInsert> = {}) => {
    const [source] = await fixture.db
      .insert(events)
      .values({
        eventKey: newEventKey(),
        title: "Repaired game night",
        game: "Chess",
        description: "A moderator can repair this saved source.",
        startsAt: new Date("2099-07-01T19:00:00.000Z"),
        endsAt: new Date("2099-07-01T21:00:00.000Z"),
        timezone: "UTC",
        location: "Hall",
        status: "draft",
        ...changes,
      })
      .returning();
    return source!;
  };
  const post = (path: string, fields: Record<string, string> = {}) =>
    app.request(
      path,
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields),
      },
      { ...env, ADMIN_DB: fixture.db },
    );

  it.each(cases)("repairs $name from the duplicate 422 without a fresh GET", async (entry) => {
    const source = await seed(entry.changes);
    if (entry.column) {
      await fixture.client`update events set ${fixture.client(entry.column)} = 'infinity'::timestamptz where id = ${source.id}`;
    }
    const before = await fixture.client`select to_jsonb(events) as row from events order by id`;
    const refusal = await post(`/admin/events/${source.eventKey}/duplicate`);
    expect(refusal.status).toBe(422);
    expect(refusal.headers.get("content-type")).toContain("text/html");
    const document = savedForm(await refusal.text());
    expect(document.attrs.action).toBe(`/admin/events/${source.eventKey}`);
    expect(await fixture.client`select to_jsonb(events) as row from events order by id`).toEqual(
      before,
    );
    expect(await fixture.db.select().from(activityLog)).toEqual([]);
    expect(await fixture.client`select * from queue_jobs`).toEqual([]);

    const repaired = await post(document.attrs.action!, {
      ...document.fields,
      ...entry.correction,
    });
    expect(repaired.status, "the refusal document itself authorizes a current-row correction").toBe(
      303,
    );
    expect(repaired.headers.get("location")).toBe(`/admin/events/${source.eventKey}`);
    expect(document.hidden.saved_baseline).toMatch(/^[a-f0-9]{64}$/);
    const rows = await fixture.db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: source.id,
      eventKey: source.eventKey,
      title: "Repaired game night",
      timezone: "UTC",
      startsAt: new Date("2099-07-01T19:00:00.000Z"),
      endsAt: new Date("2099-07-01T21:00:00.000Z"),
      location: "Hall",
      status: "draft",
    });
    const audits = await fixture.db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      subjectId: source.eventKey,
      causerId: moderatorId,
      description: "updated event Repaired game night",
    });
    expect(audits[0]!.properties).toMatchObject(entry.audit);
    expect(await fixture.client`select * from queue_jobs`).toEqual([]);
  });

  it("adds a location using the publish 422 document without a fresh GET", async () => {
    const source = await seed({ location: null });
    const before = await fixture.client`select to_jsonb(events) as row from events order by id`;
    const refusal = await post(`/admin/events/${source.eventKey}/publish`);
    expect(refusal.status).toBe(422);
    expect(refusal.headers.get("content-type")).toContain("text/html");
    const html = await refusal.text();
    expect(html).toContain('href="#f-location"');
    const document = savedForm(html);
    expect(document.attrs.action).toBe(`/admin/events/${source.eventKey}`);
    expect(await fixture.client`select to_jsonb(events) as row from events order by id`).toEqual(
      before,
    );
    expect(await fixture.db.select().from(activityLog)).toEqual([]);
    expect(await fixture.client`select * from queue_jobs`).toEqual([]);

    const corrected = await post(document.attrs.action!, { ...document.fields, location: "Hall" });
    expect(corrected.status).toBe(303);
    expect(corrected.headers.get("location")).toBe(`/admin/events/${source.eventKey}`);
    expect(document.hidden.saved_baseline).toMatch(/^[a-f0-9]{64}$/);
    const rows = await fixture.db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: source.id,
      eventKey: source.eventKey,
      location: "Hall",
      status: "draft",
    });
    const audits = await fixture.db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ subjectId: source.eventKey, causerId: moderatorId });
    expect(audits[0]!.properties).toMatchObject({ location: { before: null, after: "Hall" } });
    expect(await fixture.client`select * from queue_jobs`).toEqual([]);
  });

  it("does not rebase a duplicate-refusal draft after another moderator changes the source", async () => {
    const source = await seed({ title: "   " });
    const refusal = await post(`/admin/events/${source.eventKey}/duplicate`);
    expect(refusal.status).toBe(422);
    const document = savedForm(await refusal.text());
    await fixture.db
      .update(events)
      .set({ title: "Another moderator's saved title" })
      .where(eq(events.id, source.id));
    const fields = { ...document.fields, title: "My repaired draft" };
    const conflict = await post(document.attrs.action!, fields);
    expect(conflict.status).toBe(409);
    const conflictForm = savedForm(await conflict.text());
    expect(conflictForm.fields.title).toBe("My repaired draft");
    expect(conflictForm.hidden.saved_baseline).toBe(document.hidden.saved_baseline);
    const rows = await fixture.db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: source.id,
      title: "Another moderator's saved title",
      status: "draft",
    });
    expect(await fixture.db.select().from(activityLog)).toEqual([]);
    expect(await fixture.client`select * from queue_jobs`).toEqual([]);
  });
});
