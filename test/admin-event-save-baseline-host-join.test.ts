// Companion pins for fields committed by event Save but previously omitted
// from its baseline and Kit form. Keep the frozen stale-save acceptance and
// the notes companion unchanged. All rows and moderator sessions are synthetic.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { EVENT_BASELINE_FIELD, eventContentBaseline } from "../src/admin/event-baseline";
import { resolveKitEventEdit } from "../src/admin/kit-event-edit";
import { listRoster } from "../src/admin/reads";
import { adminApp } from "../src/admin/routes";
import { getEvent } from "../src/admin/store-event-reads";
import { activityLog, events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { compileKitForms } from "./helpers/admin-validation-correction";
import { attributes, reviewCurrentHref, savedForm } from "./helpers/event-save-document";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const hostJoinFields = ["organizer_name", "join_url", "join_instructions"] as const;
const savedHostJoin = {
  organizer_name: 'Riley & "friends"',
  join_url: "https://meet.example.test/room-9?game=chess&table=2",
  join_instructions: "Use the public lobby.\nAsk for <table 2> & wait.",
};
const concurrentHostJoin = {
  organizer_name: "Sam, the new host",
  join_url: "https://meet.example.test/room-10",
  join_instructions: "The new lobby opens ten minutes early.",
};
// Fixture ULID, not a credential.
const KEY = "01ARZ3ND" + "EKTSV4RR" + "FFQ69G5FBV";
const content = {
  title: "Original title",
  game: "Chess",
  description: "Bring a board.",
  accessibilityNotes: "Step-free access confirmed.",
  startsAt: new Date("2099-11-04T20:00:00.000Z"),
  endsAt: new Date("2099-11-04T22:00:00.000Z"),
  timezone: "UTC",
  location: "Community voice",
  capacity: 8,
  ...savedHostJoin,
};

// Dropping any single host/join column from the mint must fail, even when
// every other editable value (and both instants) is unchanged.
describe("event content baseline includes public host and joining details", () => {
  it.each(hostJoinFields)("a %s-only change invalidates the old baseline", async (field) => {
    const original = await eventContentBaseline(content);
    expect(await eventContentBaseline({ ...content, [field]: concurrentHostJoin[field] })).not.toBe(
      original,
    );
  });

  it.each(hostJoinFields)("normalizes undefined %s to the stored null default", async (field) => {
    expect(await eventContentBaseline({ ...content, [field]: undefined })).toBe(
      await eventContentBaseline({ ...content, [field]: null }),
    );
  });
});

let kit: Awaited<ReturnType<typeof compileKitForms>>;
beforeAll(async () => {
  kit = await compileKitForms();
});
afterAll(() => kit?.dispose());

describe("real Kit event-edit controls", () => {
  // Supply the desired values independently of the resolver: adding values to
  // its view alone must not make these tests pass while controls stay absent.
  it.each(hostJoinFields)("serializes %s from an enabled, visible edit control", async (field) => {
    const outcome = await resolveKitEventEdit(
      KEY,
      {},
      {
        db: {} as Db,
        get: async () => ({
          ...content,
          eventKey: KEY,
          status: "draft",
          rsvpOpen: true,
          recurrenceFrequency: null,
        }),
        list: async () => ({ rows: [], total: 0 }),
      },
    );
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    const html = kit.renderForm(1, {
      view: { ...outcome.view, values: { ...outcome.view.values, ...savedHostJoin } },
    });
    const document = savedForm(html);
    expect(document.attrs.method?.toLowerCase()).toBe("post");
    expect(document.attrs.action).toBe(`/admin/events/${KEY}`);
    expect(document.fields[field]).toBe(savedHostJoin[field]);
    const control = Array.from(html.matchAll(/<(?:input|textarea)\b([^>]*)>/g), (match) =>
      attributes(match[1]!),
    ).find((attrs) => attrs.name === field);
    expect(control).toBeDefined();
    expect(control!.type).not.toBe("hidden");
    expect(control).not.toHaveProperty("disabled");
  });
});

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// The fixture rejects non-test URLs before connecting and owns its schema.
describe.skipIf(!process.env.DATABASE_URL)(
  "host/join stale Save and Kit preservation (disposable Postgres)",
  () => {
    let fixture: MemberDataFixture;
    let admin: ReturnType<typeof adminApp>;
    let cookie: string;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.insert(events).values({
        ...content,
        eventKey: KEY,
        status: "draft",
        createdBy: "seed-mod",
      });
      const store = createMemorySessionStore();
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "333333333333333333",
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
      admin = adminApp({ sessionStore: store, db: fixture.db });
    });

    const bindings = (): EnvWithAdminDb => ({ ...env, ADMIN_DB: fixture.db });
    const read = async () => {
      const response = await admin.request(`/events/${KEY}`, { headers: { cookie } }, bindings());
      expect(response.status).toBe(200);
      return savedForm(await response.text());
    };
    const save = (fields: Record<string, string>) =>
      admin.request(
        `/events/${KEY}`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields),
        },
        bindings(),
      );
    const state = async () => ({
      rows: await fixture.db.select().from(events).orderBy(events.id),
      audits: await fixture.db.select().from(activityLog).orderBy(activityLog.id),
    });
    const kitView = async () => {
      const outcome = await resolveKitEventEdit(
        KEY,
        {},
        { db: fixture.db, get: getEvent, list: listRoster },
      );
      if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
      return outcome.view;
    };

    it.each(hostJoinFields)(
      "refuses the second Save after a %s-only concurrent save, keeps draft/row/audit, then accepts a fresh review",
      async (field) => {
        const a = await read();
        const b = await read();
        expect(a.fields).toMatchObject(savedHostJoin);
        expect(b.fields).toEqual(a.fields);
        expect(a.hidden[EVENT_BASELINE_FIELD]).toMatch(/^[0-9a-f]{64}$/);
        expect((await save({ ...a.fields, [field]: concurrentHostJoin[field] })).status).toBe(303);
        const afterFirst = await state();
        expect(afterFirst.rows[0]![field]).toBe(concurrentHostJoin[field]);
        expect(afterFirst.audits).toHaveLength(1);
        // The only saved editable change is the table-selected host/join field.
        for (const other of hostJoinFields.filter((name) => name !== field)) {
          expect(afterFirst.rows[0]![other]).toBe(savedHostJoin[other]);
        }
        const draft = {
          ...b.fields,
          title: 'B draft <night> & "friends"',
          game: "Go",
          description: "B unsent description\nKeep <literal> & text.",
          accessibility_notes: "B unsent accessibility notes",
          starts_at: "2099-11-05 20:30",
          ends_at: "2099-11-05 22:30",
          timezone: "UTC",
          location: "B draft room",
          capacity: "12",
          organizer_name: 'B draft host & "friends"',
          join_url: "https://meet.example.test/draft?room=b&table=3",
          join_instructions: "B unsent joining details\nKeep <lobby> & wait.",
        };
        const rejected = await save(draft);
        expect.soft(rejected.status, "a host/join-only edit must invalidate B's form").toBe(409);
        expect
          .soft(await state(), "refusal cannot change any row column or audit entry")
          .toEqual(afterFirst);
        // Continue all recovery assertions when a conflict document exists;
        // the status assertion above still fails if the buggy path redirected.
        if (rejected.status === 409) {
          const html = await rejected.text();
          const retained = savedForm(html);
          for (const [name, value] of Object.entries(draft)) {
            expect.soft(retained.fields[name], `retains typed ${name}`).toBe(value);
          }
          expect(retained.hidden).toEqual(b.hidden);
          reviewCurrentHref(html, KEY);
          expect((await save(retained.fields)).status).toBe(409);
          expect(await state()).toEqual(afterFirst);
        }
        const fresh = await read();
        expect.soft(fresh.fields[field]).toBe(concurrentHostJoin[field]);
        expect(fresh.hidden[EVENT_BASELINE_FIELD]).not.toBe(b.hidden[EVENT_BASELINE_FIELD]);
        expect((await save({ ...fresh.fields, title: "Freshly reviewed title" })).status).toBe(303);
        const final = await state();
        expect(final.rows[0]!.title).toBe("Freshly reviewed title");
        expect.soft(final.rows[0]![field]).toBe(concurrentHostJoin[field]);
        expect(final.audits).toHaveLength(2);
      },
    );

    it("the real-row Kit view carries every host/join value and the Hono GET baseline", async () => {
      const view = await kitView();
      expect.soft(view.values).toMatchObject(savedHostJoin);
      expect(view.baseline).toBe((await read()).hidden[EVENT_BASELINE_FIELD]);
    });

    it("posting Kit values to Hono edits the title without clearing seeded host/join details", async () => {
      const view = await kitView();
      const response = await save({
        ...view.values,
        [EVENT_BASELINE_FIELD]: view.baseline,
        title: "Kit title edit",
      });
      expect(response.status).toBe(303);
      const [row] = await fixture.db.select().from(events).where(eq(events.eventKey, KEY));
      expect(row).toMatchObject({ ...content, title: "Kit title edit" });
    });

    it("serializing the real-row Svelte Save form preserves seeded host/join details through Hono", async () => {
      const view = await kitView();
      const document = savedForm(kit.renderForm(1, { view }));
      expect(document.attrs.method?.toLowerCase()).toBe("post");
      expect(document.attrs.action).toBe(`/admin/events/${KEY}`);
      expect.soft(document.fields).toMatchObject(savedHostJoin);
      expect(document.hidden[EVENT_BASELINE_FIELD]).toBe(
        (await read()).hidden[EVENT_BASELINE_FIELD],
      );
      const response = await save({ ...document.fields, title: "Rendered Kit title edit" });
      expect(response.status).toBe(303);
      const [row] = await fixture.db.select().from(events).where(eq(events.eventKey, KEY));
      expect(row).toMatchObject({ ...content, title: "Rendered Kit title edit" });
    });
  },
);
