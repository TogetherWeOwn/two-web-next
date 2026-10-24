// route-inventory: POST /events
// route-inventory: PATCH /events/:key
//
// Acceptance suite: a supplied non-null, non-string value for an optional
// event text field (game, description, location) is a client error, never a
// silent clear. From the spec:
// - object, array, boolean and number values for game, description or
//   location are refused with the existing field-specific 422 shape
//   ({ error: "invalid", fields: { <field>: <message> } }) on the event
//   parser and on the authenticated POST/PATCH JSON writes alike — the
//   field-error key is the pin; the message wording is free. A refusal
//   names exactly the offending field, so the failure cannot be blamed on
//   another broken field.
// - a refused write changes nothing: the populated saved text survives, and
//   no event row, activity-audit row, sync job/lock, queued write-back or
//   anonymous-cache retirement happens.
// - controls that already pass stay pinned: valid strings are stored
//   (trimmed), explicit null and blank strings still clear where they
//   already could, omitted PATCH fields keep their saved value, form
//   (urlencoded) edits keep working, overlong strings still fail on length,
//   and a published event still refuses to lose its location.
//
// The wrong-type PATCH cases run against a draft as well as a published
// event on purpose: the published-row blank-location guard would already
// refuse a cleared location for a different reason, so only the draft row
// proves the type contract itself for location.
//
// Hermetic parser pins plus the real mounted routes against an owned schema
// on the guarded disposable test database only (route suites skipped
// without DATABASE_URL). Synthetic rows only; never production or staging.
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { parseEventForm, ValidationError } from "../src/admin/validation";
import { activityLog, events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { anonCacheGeneration } from "../src/events/anon-cache";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const OPTIONAL_TEXT_FIELDS = [
  "game",
  "description",
  "location",
  "organizer_name",
  "join_url",
  "join_instructions",
] as const;
type OptionalTextField = (typeof OPTIONAL_TEXT_FIELDS)[number];

const WRONG_TYPES: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: "object", value: { text: "new" } },
  { label: "array", value: ["new"] },
  { label: "boolean", value: true },
  { label: "number", value: 42 },
];

const PARSER_BASE: Record<string, unknown> = {
  title: "Game night",
  game: "Chess",
  description: "Bring a board",
  location: "Voice",
  timezone: "Europe/London",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
};

function parserErrors(data: Record<string, unknown>): Record<string, string> | null {
  try {
    parseEventForm(data);
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
}

describe("event form parser: wrong-type optional text", () => {
  for (const field of OPTIONAL_TEXT_FIELDS) {
    for (const { label, value } of WRONG_TYPES) {
      it(`refuses ${label}-typed ${field} with a field-specific error`, () => {
        const fields = parserErrors({ ...PARSER_BASE, [field]: value });
        expect(fields).not.toBeNull();
        expect(Object.keys(fields!)).toEqual([field]);
        expect(typeof fields![field]).toBe("string");
        expect(fields![field]!.length).toBeGreaterThan(0);
      });
    }
  }

  it("refuses when several optional text fields arrive with wrong types", () => {
    const fields = parserErrors({
      ...PARSER_BASE,
      game: 42,
      description: { text: "new" },
      location: true,
    });
    expect(fields).not.toBeNull();
    expect(Object.keys(fields!).sort()).toEqual(["description", "game", "location"]);
  });

  // Positive controls: the values a form or JSON client may legitimately
  // send today must keep their current meaning.
  it("accepts valid strings and trims them", () => {
    const input = parseEventForm({
      ...PARSER_BASE,
      game: "  Go  ",
      description: "  Quiet round  ",
      location: "  Hall  ",
    });
    expect(input.game).toBe("Go");
    expect(input.description).toBe("Quiet round");
    expect(input.location).toBe("Hall");
  });

  for (const field of OPTIONAL_TEXT_FIELDS) {
    it(`still treats explicit null ${field} as cleared`, () => {
      const input = parseEventForm({ ...PARSER_BASE, [field]: null });
      expect(input[field]).toBeNull();
    });

    it(`still treats a blank-string ${field} as cleared`, () => {
      for (const blank of ["", "   "]) {
        const input = parseEventForm({ ...PARSER_BASE, [field]: blank });
        expect(input[field]).toBeNull();
      }
    });

    it(`still treats an omitted ${field} as empty`, () => {
      const data = { ...PARSER_BASE };
      delete data[field];
      const input = parseEventForm(data);
      expect(input[field]).toBeNull();
    });
  }

  it("still refuses an overlong string game on length, not type", () => {
    const fields = parserErrors({ ...PARSER_BASE, game: "G".repeat(101) });
    expect(fields).not.toBeNull();
    expect(Object.keys(fields!)).toEqual(["game"]);
  });
});

// Keep the routes, tracking ledger and unique locks real, in the owned schema.
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

type SyncEventMessage = Extract<QueueMessage, { kind: "sync-event" }>;

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const DRAFT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PUBLISHED_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const POPULATED = {
  game: "Chess",
  description: "Bring a board",
  location: "Voice",
  organizer_name: "Riley",
  join_url: "https://meet.example.test/room-9",
  join_instructions: "Use the public lobby.",
} as const;

describe.skipIf(!process.env.DATABASE_URL)(
  "event JSON writes: wrong-type optional text (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let realPostgres: typeof postgres;
    const store = createMemorySessionStore();
    const sent: SyncEventMessage[] = [];
    let env: Env;

    beforeAll(async () => {
      realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      fixture = await createMemberDataFixture(url.href);
      vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}>) => {
        testDatabaseUrl(raw);
        return realPostgres(raw, {
          ...opts,
          port: 5432,
          password: () => url.password,
          connection: { search_path: fixture.schemaName },
          onnotice: () => {},
        });
      }) as typeof postgres);
      env = {
        ...baseEnv,
        DB: { connectionString: url.href },
        ADMIN_DB: fixture.db,
        SESSION_STORE: store,
        SYNC_EVENT_QUEUE: {
          send: async (message) => {
            sent.push(message as SyncEventMessage);
            return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
          },
        },
      } as Env;
    });
    afterAll(async () => {
      if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
      await fixture?.dispose();
    });

    beforeEach(async () => {
      await fixture.client`delete from queue_jobs`;
      await fixture.client`delete from job_unique_locks`;
      await fixture.client`delete from web_throttle_hits`;
      await fixture.reset();
      sent.length = 0;
      const row = {
        title: "Game night",
        ...POPULATED,
        startsAt: new Date("2030-01-01T18:00:00Z"),
        endsAt: new Date("2030-01-01T19:00:00Z"),
        timezone: "Europe/London",
        capacity: 8,
        createdBy: "event-moderator",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };
      await fixture.db.insert(events).values({
        ...row,
        eventKey: DRAFT_KEY,
        status: "draft",
        discordEventId: null,
        rsvpOpen: false,
      });
      await fixture.db.insert(events).values({
        ...row,
        eventKey: PUBLISHED_KEY,
        status: "published",
        discordEventId: "123456789012345678",
        rsvpOpen: true,
      });
      await fixture.db.insert(activityLog).values({
        description: "created event Game night",
        subjectType: "Event",
        subjectId: DRAFT_KEY,
        causerId: "event-moderator",
      });
    });

    async function cookieFor() {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "event-moderator",
        username: "Moderator",
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

    async function write(
      method: "POST" | "PATCH",
      key: string,
      body: string,
      contentType = "application/json",
    ) {
      return app.request(
        method === "POST" ? "/events" : `/events/${key}`,
        {
          method,
          headers: { cookie: await cookieFor(), origin: APP_URL, "content-type": contentType },
          body,
        },
        env,
      );
    }
    const patch = (key: string, body: unknown) => write("PATCH", key, JSON.stringify(body));
    const post = (body: unknown) => write("POST", DRAFT_KEY, JSON.stringify(body));

    const snapshot = async () => ({
      events: await fixture.db.select().from(events).orderBy(events.eventKey),
      audit: await fixture.db.select().from(activityLog).orderBy(activityLog.id),
      jobs: await fixture.client`select * from queue_jobs order by job_id`,
      locks: await fixture.client`select * from job_unique_locks order by key`,
      cacheGeneration: anonCacheGeneration(),
    });
    async function expectUnchanged(before: Awaited<ReturnType<typeof snapshot>>) {
      expect(await snapshot()).toEqual(before);
      expect(sent).toEqual([]);
    }

    async function expectFieldRefusal(res: Response, field: OptionalTextField) {
      expect(res.status).toBe(422);
      const payload = (await res.json()) as {
        error?: unknown;
        fields?: Record<string, unknown>;
        request_id?: unknown;
      };
      expect(payload.error).toBe("invalid");
      expect(Object.keys(payload).sort()).toEqual(["error", "fields", "request_id"]);
      expect(payload.request_id).toBe(res.headers.get("x-request-id"));
      expect(Object.keys(payload.fields!)).toEqual([field]);
      expect(typeof payload.fields![field]).toBe("string");
      expect((payload.fields![field] as string).length).toBeGreaterThan(0);
    }

    const savedRow = async (key: string) =>
      (await fixture.db.select().from(events)).find((r) => r.eventKey === key)!;

    // RED at the acceptance base: every case below currently succeeds and
    // clears the populated field instead of refusing.
    for (const field of OPTIONAL_TEXT_FIELDS) {
      for (const { label, value } of WRONG_TYPES) {
        it(`PATCH draft refuses ${label}-typed ${field} and keeps the saved text`, async () => {
          const before = await snapshot();
          const res = await patch(DRAFT_KEY, { [field]: value });
          await expectFieldRefusal(res, field);
          await expectUnchanged(before);
          expect((await savedRow(DRAFT_KEY))[field]).toBe(POPULATED[field]);
        });
      }
    }

    for (const field of ["game", "description"] as const) {
      for (const { label, value } of WRONG_TYPES) {
        it(`PATCH published refuses ${label}-typed ${field} and keeps the saved text`, async () => {
          const before = await snapshot();
          const res = await patch(PUBLISHED_KEY, { [field]: value });
          await expectFieldRefusal(res, field);
          await expectUnchanged(before);
          expect((await savedRow(PUBLISHED_KEY))[field]).toBe(POPULATED[field]);
        });
      }
    }

    for (const field of OPTIONAL_TEXT_FIELDS) {
      for (const { label, value } of WRONG_TYPES) {
        it(`POST refuses ${label}-typed ${field} and writes nothing`, async () => {
          const before = await snapshot();
          const res = await post({ ...PARSER_BASE, title: "New night", [field]: value });
          await expectFieldRefusal(res, field);
          await expectUnchanged(before);
        });
      }
    }

    // Controls: behavior that is already correct and must not move.
    it("a valid string PATCH still updates the saved text and syncs", async () => {
      const res = await patch(PUBLISHED_KEY, { description: "Updated notes" });
      expect(res.status).toBe(200);
      expect((await savedRow(PUBLISHED_KEY)).description).toBe("Updated notes");
      expect((await savedRow(PUBLISHED_KEY)).game).toBe(POPULATED.game);
      expect((await savedRow(PUBLISHED_KEY)).location).toBe(POPULATED.location);
      expect(sent).toHaveLength(1);
    });

    it("valid string game and location PATCHes still update a draft", async () => {
      const res = await patch(DRAFT_KEY, { game: "Go", location: "Hall" });
      expect(res.status).toBe(200);
      expect((await savedRow(DRAFT_KEY)).game).toBe("Go");
      expect((await savedRow(DRAFT_KEY)).location).toBe("Hall");
      expect((await savedRow(DRAFT_KEY)).description).toBe(POPULATED.description);
    });

    it("explicit null still clears description on a published event", async () => {
      const res = await patch(PUBLISHED_KEY, { description: null });
      expect(res.status).toBe(200);
      expect((await savedRow(PUBLISHED_KEY)).description).toBeNull();
    });

    it("explicit null still clears location on a draft event", async () => {
      const res = await patch(DRAFT_KEY, { location: null });
      expect(res.status).toBe(200);
      expect((await savedRow(DRAFT_KEY)).location).toBeNull();
    });

    it("a blank string still clears game on a draft event", async () => {
      const res = await patch(DRAFT_KEY, { game: "   " });
      expect(res.status).toBe(200);
      expect((await savedRow(DRAFT_KEY)).game).toBeNull();
    });

    it("omitted PATCH fields keep every saved text value", async () => {
      const res = await patch(DRAFT_KEY, { title: "Renamed" });
      expect(res.status).toBe(200);
      const row = await savedRow(DRAFT_KEY);
      expect(row.game).toBe(POPULATED.game);
      expect(row.description).toBe(POPULATED.description);
      expect(row.location).toBe(POPULATED.location);
      expect(row.organizer_name).toBe(POPULATED.organizer_name);
      expect(row.join_url).toBe(POPULATED.join_url);
      expect(row.join_instructions).toBe(POPULATED.join_instructions);
    });

    it("form edits keep working with string values", async () => {
      const res = await write(
        "PATCH",
        DRAFT_KEY,
        "description=Form+notes&game=Go",
        "application/x-www-form-urlencoded",
      );
      expect(res.status).toBe(200);
      expect((await savedRow(DRAFT_KEY)).description).toBe("Form notes");
      expect((await savedRow(DRAFT_KEY)).game).toBe("Go");
    });

    it("a published event still refuses to lose its location by explicit clear", async () => {
      const before = await snapshot();
      const res = await patch(PUBLISHED_KEY, { location: null });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "invalid",
        fields: { location: "Add a location before publishing." },
        request_id: res.headers.get("x-request-id"),
      });
      await expectUnchanged(before);
    });

    it("a published event refuses a wrong-type location without writes", async () => {
      // Already refused today by the published blank-location guard; pinned
      // so the type refusal keeps the same no-write outcome either way.
      const before = await snapshot();
      const res = await patch(PUBLISHED_KEY, { location: { text: "new" } });
      await expectFieldRefusal(res, "location");
      await expectUnchanged(before);
    });

    it("a fully valid POST still creates the event", async () => {
      const before = await snapshot();
      const res = await post({ ...PARSER_BASE, title: "New night" });
      expect(res.status).toBe(201);
      const after = await snapshot();
      expect(after.events).toHaveLength(before.events.length + 1);
      const created = after.events.find((r) => r.title === "New night")!;
      expect(created.game).toBe(PARSER_BASE.game);
      expect(created.description).toBe(PARSER_BASE.description);
      expect(created.location).toBe(PARSER_BASE.location);
    });
  },
);
