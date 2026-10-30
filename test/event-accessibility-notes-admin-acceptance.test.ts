import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { adminApp } from "../src/admin/routes";
import { activityLog, events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { savedForm } from "./helpers/event-save-document";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const ACCESSIBILITY_NOTES_MAX = 1000;

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

async function cookieFor(store: SessionStore) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000111",
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

const eventFields = (overrides: Record<string, string> = {}) => ({
  title: "Accessibility notes night",
  game: "Board games",
  description: "The existing event description remains available.",
  starts_at: "2026-11-04 20:00",
  ends_at: "2026-11-04 22:00",
  timezone: "UTC",
  location: "Community voice",
  capacity: "8",
  ...overrides,
});

function formValue(html: string, name: string): string | undefined {
  const textarea = html.match(
    new RegExp(`<textarea\\b(?=[^>]*\\bname="${name}"(?=[\\s>]))[^>]*>([\\s\\S]*?)<\\/textarea>`),
  );
  if (textarea) return textarea[1];
  const input = html.match(new RegExp(`<input\\b(?=[^>]*\\bname="${name}"(?=[\\s>]))[^>]*>`));
  return input?.[0].match(/\bvalue="([^"]*)"/)?.[1];
}

describe.skipIf(!process.env.DATABASE_URL)(
  "event accessibility notes acceptance (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    const store = createMemorySessionStore(() => Date.now());
    let cookie = "";

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });
    afterAll(() => fixture?.dispose());

    const app = () => adminApp({ sessionStore: store, db });
    const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
    const form = (fields: Record<string, string>) => ({
      method: "POST" as const,
      headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });

    beforeEach(async () => {
      await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
      await db.delete(events);
      cookie = await cookieFor(store);
    });

    afterEach(async () => {
      await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
      await db.delete(events);
    });

    async function createEvent(fields: Record<string, string>) {
      return app().request("/events", form(fields), liveEnv());
    }

    async function editEvent(key: string, fields: Record<string, string>) {
      // The save precondition rides with the moderator's own GET.
      const page = await app().request(`/events/${key}`, { headers: { cookie } }, liveEnv());
      expect(page.status).toBe(200);
      return app().request(
        `/events/${key}`,
        form({ ...fields, ...savedForm(await page.text()).hidden }),
        liveEnv(),
      );
    }

    async function editForm(key: string) {
      const response = await app().request(`/events/${key}`, { headers: { cookie } }, liveEnv());
      expect(response.status).toBe(200);
      return response.text();
    }

    function eventKeyFrom(response: Response) {
      return new URL(response.headers.get("location")!, APP_URL).pathname.split("/").at(-1)!;
    }

    it("persists optional accessibility notes across moderator create and edit", async () => {
      const firstNotes = "Step-free entrance; a quiet room is available.";
      const create = await createEvent(eventFields({ accessibility_notes: firstNotes }));
      expect(create.status).toBe(303);
      const key = eventKeyFrom(create);

      const createdForm = await editForm(key);
      expect(formValue(createdForm, "accessibility_notes")).toBe(firstNotes);
      expect(formValue(createdForm, "description")).toBe(
        "The existing event description remains available.",
      );

      const editedNotes = "Step-free entrance; a quiet room is available. Please ask the host.";
      const edit = await editEvent(key, eventFields({ accessibility_notes: editedNotes }));
      expect(edit.status).toBe(303);
      expect(formValue(await editForm(key), "accessibility_notes")).toBe(editedNotes);
    });

    it("keeps the notes control empty for an existing event with no note", async () => {
      const create = await createEvent(eventFields());
      expect(create.status).toBe(303);
      const key = eventKeyFrom(create);

      const html = await editForm(key);
      expect(formValue(html, "accessibility_notes")).toBe("");
      expect(formValue(html, "description")).toBe(
        "The existing event description remains available.",
      );
    });

    it("accepts the 1000-character create boundary and rejects longer notes without writes", async () => {
      const boundary = "a".repeat(ACCESSIBILITY_NOTES_MAX);
      const accepted = await createEvent(eventFields({ accessibility_notes: boundary }));
      expect(accepted.status).toBe(303);
      const key = eventKeyFrom(accepted);
      const eventsBefore = await db.select().from(events);
      const auditsBefore = await db.select().from(activityLog);
      const rejected = await createEvent(
        eventFields({ accessibility_notes: "a".repeat(ACCESSIBILITY_NOTES_MAX + 1) }),
      );
      expect(rejected.status).toBe(422);
      expect(await db.select().from(events)).toHaveLength(eventsBefore.length);
      expect(await db.select().from(activityLog)).toHaveLength(auditsBefore.length);
      expect(formValue(await editForm(key), "accessibility_notes")).toBe(boundary);
    });

    it("refuses overlong edit notes without changing the event or writing an audit", async () => {
      const initialNotes = "A quiet room is available.";
      const create = await createEvent(eventFields({ accessibility_notes: initialNotes }));
      expect(create.status).toBe(303);
      const key = eventKeyFrom(create);
      const eventsBefore = await db.select().from(events);
      const auditsBefore = await db.select().from(activityLog);

      const rejected = await editEvent(
        key,
        eventFields({
          title: "Must not be written",
          description: "This description must remain unchanged.",
          accessibility_notes: "a".repeat(ACCESSIBILITY_NOTES_MAX + 1),
        }),
      );
      expect(rejected.status).toBe(422);
      expect(await db.select().from(events)).toHaveLength(eventsBefore.length);
      expect(await db.select().from(activityLog)).toHaveLength(auditsBefore.length);
      const html = await editForm(key);
      expect(formValue(html, "title")).toBe("Accessibility notes night");
      expect(formValue(html, "description")).toBe(
        "The existing event description remains available.",
      );
      expect(formValue(html, "accessibility_notes")).toBe(initialNotes);
    });
  },
);
