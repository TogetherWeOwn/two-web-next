// Builder-owned pins for optional public host and joining details: hermetic
// parser/merge pins plus moderator form persistence against the disposable
// test database only (DB suites skip without DATABASE_URL). Synthetic rows
// only; never production or staging. This complements the Test Author-owned
// render/reject suite in test/event-verified-host-join-details-acceptance.test.ts,
// which this file must not duplicate: create/edit/PATCH/series persistence,
// the join-link length boundary, and credentialed-link refusal.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { mergePatchInput } from "../src/admin/store";
import { parseEventForm, ValidationError } from "../src/admin/validation";
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

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const JOIN_URL_MAX = 2048;

const URL_BASE: Record<string, unknown> = {
  title: "Game night",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
  timezone: "UTC",
};

function urlOfLength(length: number): string {
  const prefix = "https://example.com/";
  return prefix + "p".repeat(length - prefix.length);
}

function parserErrors(data: Record<string, unknown>): Record<string, string> {
  try {
    parseEventForm(data);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("Expected event validation to fail");
}

describe("join URL parser pins", () => {
  it("refuses a 2049-character join link with the length message", () => {
    expect(parserErrors({ ...URL_BASE, join_url: urlOfLength(JOIN_URL_MAX + 1) })).toEqual({
      join_url: "Keep the public joining link to 2048 characters.",
    });
  });

  it.each(["https://mod:secret@example.com/room", "https://mod@example.com/room"])(
    "refuses the credentialed join link %s",
    (join_url) => {
      expect(parserErrors({ ...URL_BASE, join_url })).toEqual({
        join_url: "Enter a valid public HTTP or HTTPS link without sign-in credentials.",
      });
    },
  );

  it("accepts the 2048-character join link boundary", () => {
    const boundary = urlOfLength(JOIN_URL_MAX);
    expect([...boundary]).toHaveLength(JOIN_URL_MAX);
    expect(parseEventForm({ ...URL_BASE, join_url: boundary }).join_url).toBe(boundary);
  });

  it("trims padded host and joining values", () => {
    const input = parseEventForm({
      ...URL_BASE,
      organizer_name: "  Riley  ",
      join_url: "  https://meet.example.test/room-9  ",
      join_instructions: "  Use the public lobby.  ",
    });
    expect(input.organizer_name).toBe("Riley");
    expect(input.join_url).toBe("https://meet.example.test/room-9");
    expect(input.join_instructions).toBe("Use the public lobby.");
  });
});

describe("PATCH merge retains stored join details", () => {
  it("keeps organizer and join values when a PATCH touches only the title", () => {
    const input = mergePatchInput(
      {
        title: "Game night",
        game: "Chess",
        description: "Bring a board",
        accessibilityNotes: null,
        timezone: "UTC",
        location: "Voice",
        organizer_name: "Riley",
        join_url: "https://meet.example.test/room-9",
        join_instructions: "Use the public lobby.",
        capacity: 8,
        startsAt: new Date("2030-01-01T18:00:00Z"),
        endsAt: new Date("2030-01-01T19:00:00Z"),
      },
      { title: "Renamed" },
    );
    expect(input.title).toBe("Renamed");
    expect(input.organizer_name).toBe("Riley");
    expect(input.join_url).toBe("https://meet.example.test/room-9");
    expect(input.join_instructions).toBe("Use the public lobby.");
  });
});

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
  title: "Host and join night",
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

describe.skipIf(!process.env.DATABASE_URL)("event host and join persistence (agent-testdb)", () => {
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
    return app().request(`/events/${key}`, form(fields), liveEnv());
  }

  async function editForm(key: string) {
    const response = await app().request(`/events/${key}`, { headers: { cookie } }, liveEnv());
    expect(response.status).toBe(200);
    return response.text();
  }

  function eventKeyFrom(response: Response) {
    return new URL(response.headers.get("location")!, APP_URL).pathname.split("/").at(-1)!;
  }

  async function storedRow(key: string) {
    return (await db.select().from(events)).find((r) => r.eventKey === key)!;
  }

  it("persists host and join fields across moderator create and edit", async () => {
    const create = await createEvent(
      eventFields({
        organizer_name: "Riley",
        join_url: "https://meet.example.test/room-9",
        join_instructions: "Use the public lobby.",
      }),
    );
    expect(create.status).toBe(303);
    const key = eventKeyFrom(create);

    const created = await storedRow(key);
    expect(created.organizer_name).toBe("Riley");
    expect(created.join_url).toBe("https://meet.example.test/room-9");
    expect(created.join_instructions).toBe("Use the public lobby.");
    const createdForm = await editForm(key);
    expect(formValue(createdForm, "organizer_name")).toBe("Riley");
    expect(formValue(createdForm, "join_url")).toBe("https://meet.example.test/room-9");
    expect(formValue(createdForm, "join_instructions")).toBe("Use the public lobby.");

    const edit = await editEvent(
      key,
      eventFields({
        organizer_name: "Sam",
        join_url: "https://meet.example.test/room-10",
        join_instructions: "Ask at the door.",
      }),
    );
    expect(edit.status).toBe(303);
    const edited = await storedRow(key);
    expect(edited.organizer_name).toBe("Sam");
    expect(edited.join_url).toBe("https://meet.example.test/room-10");
    expect(edited.join_instructions).toBe("Ask at the door.");
    const editedForm = await editForm(key);
    expect(formValue(editedForm, "organizer_name")).toBe("Sam");
    expect(formValue(editedForm, "join_url")).toBe("https://meet.example.test/room-10");
    expect(formValue(editedForm, "join_instructions")).toBe("Ask at the door.");
  });

  it("carries host and join fields onto each series child", async () => {
    const create = await createEvent(
      eventFields({
        organizer_name: "Riley",
        join_url: "https://meet.example.test/room-9",
        join_instructions: "Use the public lobby.",
        recurrence_frequency: "weekly",
        recurrence_count: "3",
      }),
    );
    expect(create.status).toBe(303);
    const parent = await storedRow(eventKeyFrom(create));
    const children = await db.select().from(events).where(eq(events.parentEventId, parent.id));
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.organizer_name).toBe("Riley");
      expect(child.join_url).toBe("https://meet.example.test/room-9");
      expect(child.join_instructions).toBe("Use the public lobby.");
    }
  });

  it("accepts the 2048-character join link and refuses longer links without writes", async () => {
    const boundary = urlOfLength(JOIN_URL_MAX);
    const accepted = await createEvent(eventFields({ join_url: boundary }));
    expect(accepted.status).toBe(303);
    expect((await storedRow(eventKeyFrom(accepted))).join_url).toBe(boundary);

    const eventsBefore = await db.select().from(events);
    const auditsBefore = await db.select().from(activityLog);
    const rejected = await createEvent(eventFields({ join_url: urlOfLength(JOIN_URL_MAX + 1) }));
    expect(rejected.status).toBe(422);
    expect(await db.select().from(events)).toHaveLength(eventsBefore.length);
    expect(await db.select().from(activityLog)).toHaveLength(auditsBefore.length);
    const html = await rejected.text();
    expect(html).toContain("Keep the public joining link to 2048 characters.");
    expect(html).toContain('href="#f-join-url"');
  });

  it("refuses credentialed join links without writes", async () => {
    const eventsBefore = await db.select().from(events);
    const auditsBefore = await db.select().from(activityLog);
    const rejected = await createEvent(
      eventFields({ join_url: "https://mod:secret@example.com/room" }),
    );
    expect(rejected.status).toBe(422);
    expect(await db.select().from(events)).toHaveLength(eventsBefore.length);
    expect(await db.select().from(activityLog)).toHaveLength(auditsBefore.length);
    expect(await rejected.text()).toContain(
      "Enter a valid public HTTP or HTTPS link without sign-in credentials.",
    );
  });
});
