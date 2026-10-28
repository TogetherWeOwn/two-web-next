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

  const formValue = (html: string, name: string): string | undefined => {
    const input = html.match(new RegExp(`<input\\b(?=[^>]*\\bname="${name}"(?=[\\s>]))[^>]*>`));
    return input?.[0].match(/\bvalue="([^"]*)"/)?.[1];
  };

  const save = async (key: string, values: Record<string, string> = {}) => {
    const form = await adminApp({ sessionStore: store, db: fixture.db }).request(
      `/events/${key}`,
      { headers: { cookie } },
      { ...env, ADMIN_DB: fixture.db } as Env,
    );
    expect(form.status).toBe(200);
    const baseline = formValue(await form.text(), "saved_baseline");
    expect(baseline, "edit form carries the server baseline").toBeDefined();
    return adminApp({ sessionStore: store, db: fixture.db }).request(
      `/events/${key}`,
      {
        method: "POST",
        headers: { cookie, origin: env.APP_URL },
        body: new URLSearchParams({
          title: "Rolling plan night",
          starts_at: "2099-06-04 19:00",
          ends_at: "2099-06-04 21:00",
          timezone: "Europe/London",
          location: "Voice",
          ...values,
          saved_baseline: baseline!,
        }),
      },
      { ...env, ADMIN_DB: fixture.db } as Env,
    );
  };

  const seedSeries = async () => {
    const parent = await seed({
      status: "draft",
      startsAt: new Date("2099-06-04T18:00:00.000Z"),
      endsAt: new Date("2099-06-04T20:00:00.000Z"),
      recurrenceFrequency: "weekly",
      recurrenceCount: 3,
      recurrenceIndex: 1,
    });
    const future = await seed({
      status: "draft",
      startsAt: new Date("2099-06-11T18:00:17.125Z"),
      endsAt: new Date("2099-06-11T20:00:43.875Z"),
      parentEventId: parent.id,
      recurrenceIndex: 2,
    });
    const past = await seed({
      status: "draft",
      startsAt: new Date("2000-06-11T18:00:00.000Z"),
      endsAt: new Date("2000-06-11T20:00:00.000Z"),
      parentEventId: parent.id,
      recurrenceIndex: 3,
    });
    return { parent, future, past };
  };

  for (const peerMoves of [false, true]) {
    it.each([
      { column: "starts_at", instant: "infinity" },
      { column: "ends_at", instant: "infinity" },
      { column: "starts_at", instant: "-infinity" },
      { column: "ends_at", instant: "-infinity" },
    ])(
      `repairs series $instant $column, preserving that child instant (peer moves: ${peerMoves})`,
      async ({ column, instant }) => {
        const { parent, future, past } = await seedSeries();
        await fixture.client`update events set ${fixture.client(column)} = ${instant}::timestamptz where id = ${parent.id}`;
        expect((await request("HTML", parent.eventKey)).status).toBe(422);
        const invalidField = column === "starts_at" ? "startsAt" : "endsAt";
        const peerField = column === "starts_at" ? "endsAt" : "startsAt";
        const res = await save(
          parent.eventKey,
          peerMoves
            ? column === "starts_at"
              ? { ends_at: "2099-06-04 22:00" }
              : { starts_at: "2099-06-04 20:00" }
            : {},
        );
        expect(res.status).toBe(303);
        const rows = await fixture.db.select().from(events);
        expect(rows).toHaveLength(3);
        const repaired = rows.find((row) => row.id === parent.id)!;
        expect(repaired).toMatchObject({
          ...parent,
          startsAt: new Date(
            column === "ends_at" && peerMoves
              ? "2099-06-04T19:00:00.000Z"
              : "2099-06-04T18:00:00.000Z",
          ),
          endsAt: new Date(
            column === "starts_at" && peerMoves
              ? "2099-06-04T21:00:00.000Z"
              : "2099-06-04T20:00:00.000Z",
          ),
          updatedAt: expect.any(Date),
          icsSequence: expect.any(BigInt),
          syncRevision: parent.syncRevision + 2,
        });
        expect(repaired.icsSequence).toBeGreaterThanOrEqual(parent.icsSequence + 2n);
        const moved = rows.find((row) => row.id === future.id)!;
        expect(moved).toEqual({
          ...future,
          [peerField]: new Date(future[peerField].getTime() + (peerMoves ? 3600_000 : 0)),
          updatedAt: peerMoves ? expect.any(Date) : future.updatedAt,
          icsSequence: peerMoves ? expect.any(BigInt) : future.icsSequence,
          syncRevision: future.syncRevision + (peerMoves ? 1 : 0),
        });
        if (peerMoves) expect(moved.icsSequence).toBeGreaterThan(future.icsSequence);
        expect(rows.find((row) => row.id === past.id)).toEqual(past);
        const audits = await fixture.db.select().from(activityLog);
        expect(audits).toHaveLength(peerMoves ? 2 : 1);
        expect(audits.find((row) => row.subjectId === parent.eventKey)).toMatchObject({
          causerId: moderator.id,
          properties: {
            [invalidField]: { before: null, after: repaired[invalidField].toISOString() },
          },
        });
        if (peerMoves) {
          const childAudit = audits.find((row) => row.subjectId === future.eventKey)!;
          expect(childAudit).toMatchObject({
            causerId: moderator.id,
            properties: {
              [peerField]: {
                before: future[peerField].toISOString(),
                after: moved[peerField].toISOString(),
              },
            },
          });
          expect(childAudit.properties).not.toHaveProperty(invalidField);
        }
        expect(await fixture.client`select * from queue_jobs`).toEqual([]);
      },
    );
  }

  it("repairs both nonfinite series parent timestamps without rewriting children", async () => {
    const { parent, future, past } = await seedSeries();
    await fixture.client`update events set starts_at = '-infinity'::timestamptz, ends_at = 'infinity'::timestamptz where id = ${parent.id}`;
    expect((await request("HTML", parent.eventKey)).status).toBe(422);
    expect((await save(parent.eventKey)).status).toBe(303);
    const rows = await fixture.db.select().from(events);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === parent.id)).toMatchObject({
      startsAt: new Date("2099-06-04T18:00:00.000Z"),
      endsAt: new Date("2099-06-04T20:00:00.000Z"),
    });
    expect(rows.find((row) => row.id === future.id)).toEqual(future);
    expect(rows.find((row) => row.id === past.id)).toEqual(past);
    const audits = await fixture.db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      subjectId: parent.eventKey,
      causerId: moderator.id,
      properties: {
        startsAt: { before: null, after: "2099-06-04T18:00:00.000Z" },
        endsAt: { before: null, after: "2099-06-04T20:00:00.000Z" },
      },
    });
    expect(await fixture.client`select * from queue_jobs`).toEqual([]);
  });

  it.each(["starts_at", "ends_at"])(
    "refuses series %s repair atomically when the finite peer would invert a child",
    async (column) => {
      const { parent, future } = await seedSeries();
      await fixture.client`update events set ${fixture.client(column)} = 'infinity'::timestamptz where id = ${parent.id}`;
      await fixture.client`update events set starts_at = '2099-06-11T18:00:00Z', ends_at = '2099-06-11T18:30:00Z' where id = ${future.id}`;
      expect((await request("HTML", parent.eventKey)).status).toBe(422);
      const before = await fixture.client`select to_jsonb(events) as row from events order by id`;
      const res = await save(
        parent.eventKey,
        column === "starts_at"
          ? { ends_at: "2099-06-04 19:30" }
          : { starts_at: "2099-06-04 20:00" },
      );
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("The end is after the start.");
      expect(await fixture.client`select to_jsonb(events) as row from events order by id`).toEqual(
        before,
      );
      expect(await fixture.db.select().from(activityLog)).toEqual([]);
      expect(await fixture.client`select * from queue_jobs`).toEqual([]);
    },
  );

  it.each([
    { column: "starts_at", instant: "infinity" },
    { column: "ends_at", instant: "infinity" },
    { column: "starts_at", instant: "-infinity" },
    { column: "ends_at", instant: "-infinity" },
  ])("repairs $instant $column after a duplicate refusal", async ({ column, instant }) => {
    const source = await seed({ status: "draft" });
    await fixture.client`update events set ${fixture.client(column)} = ${instant}::timestamptz where id = ${source.id}`;
    const refusal = await request("HTML", source.eventKey);
    expect(refusal.status).toBe(422);
    expect(await refusal.text()).toMatch(new RegExp(`name="${column}"[^>]*value=""`));

    const res = await save(source.eventKey);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/events/${source.eventKey}`);
    const rows = await fixture.db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: source.id,
      eventKey: source.eventKey,
      status: "draft",
      startsAt: new Date("2099-06-04T18:00:00.000Z"),
      endsAt: new Date("2099-06-04T20:00:00.000Z"),
    });
    const audits = await fixture.db.select().from(activityLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      description: "updated event Rolling plan night",
      subjectId: source.eventKey,
      causerId: moderator.id,
      properties: {
        [column === "starts_at" ? "startsAt" : "endsAt"]: {
          before: null,
          after: column === "starts_at" ? "2099-06-04T18:00:00.000Z" : "2099-06-04T20:00:00.000Z",
        },
      },
    });
    expect(await fixture.client`select * from queue_jobs`).toEqual([]);
  });

  it.each(["starts_at", "ends_at"])(
    "still refuses an invalid submitted %s while repairing a nonfinite source",
    async (column) => {
      const source = await seed({ status: "draft" });
      await fixture.client`update events set ${fixture.client(column)} = 'infinity'::timestamptz where id = ${source.id}`;
      expect((await request("HTML", source.eventKey)).status).toBe(422);
      const before = await fixture.client`select to_jsonb(events) as row from events`;
      const res = await save(source.eventKey, { [column]: "not-a-wall-time" });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain(`href="#f-${column.replaceAll("_", "-")}"`);
      expect(await fixture.client`select to_jsonb(events) as row from events`).toEqual(before);
      expect(await fixture.db.select().from(activityLog)).toEqual([]);
      expect(await fixture.client`select * from queue_jobs`).toEqual([]);
    },
  );

  it.each([
    {
      column: "ends_at",
      startsAt: "2099-10-25T00:30:27.125Z",
      endsAt: "2099-10-25T03:00:00.000Z",
      starts_at: "2099-10-25 01:30",
      ends_at: "2099-10-25 03:00",
      expectedStart: "2099-10-25T00:30:27.125Z",
      expectedEnd: "2099-10-25T03:00:00.000Z",
    },
    {
      column: "starts_at",
      startsAt: "2099-10-24T22:00:00.000Z",
      endsAt: "2099-10-25T00:30:44.875Z",
      starts_at: "2099-10-24 23:00",
      ends_at: "2099-10-25 01:30",
      expectedStart: "2099-10-24T22:00:00.000Z",
      expectedEnd: "2099-10-25T00:30:44.875Z",
    },
  ])("repairing $column preserves the finite peer's fold instant and precision", async (entry) => {
    const source = await seed({
      status: "draft",
      startsAt: new Date(entry.startsAt),
      endsAt: new Date(entry.endsAt),
    });
    await fixture.client`update events set ${fixture.client(entry.column)} = 'infinity'::timestamptz where id = ${source.id}`;
    expect((await request("HTML", source.eventKey)).status).toBe(422);
    const res = await save(source.eventKey, {
      starts_at: entry.starts_at,
      ends_at: entry.ends_at,
    });
    expect(res.status).toBe(303);
    const rows = await fixture.db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.startsAt.toISOString()).toBe(entry.expectedStart);
    expect(rows[0]!.endsAt.toISOString()).toBe(entry.expectedEnd);
  });

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
