import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { createEvent, getEvent, updateEvent } from "../src/admin/store";
import { parseEventForm, ValidationError, type EventFormInput } from "../src/admin/validation";
import { validateFields } from "../src/agent-events/service";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { getPublicEvent } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  updateEvent: vi.fn(),
}));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
}));
vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const base = {
  title: "Game night",
  game: "Chess",
  description: "Friendly game night",
  location: "Discord",
  timezone: "UTC",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
};

const KEY = "01J0000000000000000000ABCD";
const row = {
  id: 1,
  eventKey: KEY,
  title: base.title,
  game: base.game,
  description: base.description,
  location: base.location,
  timezone: base.timezone,
  capacity: null,
  startsAt: new Date("2030-01-01T18:00:00Z"),
  endsAt: new Date("2030-01-01T19:00:00Z"),
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  status: "draft",
  rsvpOpen: true,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies typeof events.$inferSelect;
const env: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture",
  ADMIN_DB: new Proxy({} as Db, {
    get: (_, key) => {
      if (key === "then") return undefined;
      throw new Error("fixture must not query a DB");
    },
  }),
};
const moderator: Session = {
  id: "fixture",
  username: "mod",
  avatar: null,
  member: true,
  moderator: true,
};
const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => moderator,
  async () => moderator,
);
function saved(input: EventFormInput): typeof events.$inferSelect {
  const { startsAtUtc, endsAtUtc, ...fields } = input;
  return { ...row, ...fields, startsAt: startsAtUtc, endsAt: endsAtUtc };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(row);
  vi.mocked(createEvent).mockImplementation(async (_db, _actor, input) => ({
    row: saved(input),
    writeBack: null,
  }));
  vi.mocked(updateEvent).mockImplementation(async (_db, _actor, _key, input) => {
    const updated = saved(input);
    vi.mocked(getPublicEvent).mockResolvedValue({ ...updated, goingCount: 0 });
    return { row: updated, writeBack: null, childWriteBacks: [] };
  });
});

const limits = [
  { field: "title", max: 100 },
  { field: "game", max: 100 },
  { field: "description", max: 1000 },
  { field: "location", max: 255 },
] as const;
const characters = [
  { label: "ASCII", pattern: ["x"] },
  { label: "BMP", pattern: ["界"] },
  { label: "astral", pattern: ["😀"] },
  { label: "mixed astral/BMP", pattern: ["😀", "界", "x"] },
];
function text(pattern: string[], count: number): string {
  return Array.from({ length: count }, (_, i) => pattern[i % pattern.length]).join("");
}
function errors(data: Record<string, unknown>): Record<string, string> {
  try {
    parseEventForm(data);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("Expected event validation to fail");
}

// Backend character limits count code points, not UTF-16 units or graphemes.
// Native HTML maxlength and browser editor parity are outside these fixtures.
describe("moderator event Unicode boundaries", () => {
  for (const { field, max } of limits) {
    describe(field, () => {
      it.each(characters)("accepts exactly N $label code points", ({ pattern }) => {
        const value = text(pattern, max);
        expect(parseEventForm({ ...base, [field]: value })[field]).toBe(value);
        expect(validateFields({ ...base, [field]: value })).toMatchObject({
          ok: true,
          fields: { [field]: value },
        });
      });
      it.each(characters)(
        "rejects N+1 $label code points with the existing error",
        ({ pattern }) => {
          const data = { ...base, [field]: text(pattern, max + 1) };
          expect(errors(data)).toEqual({ [field]: `Keep the ${field} to ${max} characters.` });
          expect(validateFields(data)).toMatchObject({
            ok: false,
            errors: { [field]: [`The ${field} field must not be greater than ${max} characters.`] },
          });
        },
      );
      it("trims whitespace before measuring the limit", () => {
        const value = "😀".repeat(max);
        expect(parseEventForm({ ...base, [field]: ` \t${value}\r\n ` })[field]).toBe(value);
      });
    });
  }

  it("accepts the reported 51-emoji title", () => {
    const title = "😀".repeat(51);
    expect(parseEventForm({ ...base, title }).title).toBe(title);
  });
  it("counts combining marks and emoji joiners as code points, not graphemes", () => {
    for (const title of ["é".repeat(50), "👩‍💻".repeat(33) + "x"]) {
      expect([...title]).toHaveLength(100);
      expect(parseEventForm({ ...base, title }).title).toBe(title);
      expect(errors({ ...base, title: title + "x" })).toEqual({
        title: "Keep the title to 100 characters.",
      });
    }
  });
  it("keeps title required and empty optional text null", () => {
    expect(errors({ ...base, title: " \t " })).toEqual({ title: "Give the event a title." });
    expect(parseEventForm({ ...base, game: " ", description: "\n", location: "\t" })).toMatchObject(
      {
        game: null,
        description: null,
        location: null,
      },
    );
  });
  for (const field of ["title", "description", "location"] as const) {
    it.each([0, 0x200b, 0x202e, 0xfeff].map((codePoint) => String.fromCodePoint(codePoint)))(
      `keeps forbidden controls rejected in ${field}: %j`,
      (control) => {
        expect(errors({ ...base, [field]: control + "😀" })).toEqual({
          [field]: "Remove control or invisible characters.",
        });
      },
    );
  }
});

// Real moderator JSON handlers, synthetic identity/reads/writes; no SQL or network.
for (const method of ["POST", "PATCH"] as const) {
  describe(`${method} moderator event text boundaries`, () => {
    const path = method === "POST" ? "/events" : `/events/${KEY}`;
    async function request(field: string, value: string): Promise<Response> {
      // A one-field PATCH must retain all the stored defaults and UTC carriers.
      const data = method === "POST" ? { ...base, [field]: value } : { [field]: value };
      return app.request(
        path,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        },
        env,
      );
    }
    for (const { field, max } of limits) {
      describe(field, () => {
        it.each(characters)("persists exactly N $label code points", async ({ pattern }) => {
          const value = text(pattern, max);
          const response = await request(field, value);
          expect(response.status).toBe(method === "POST" ? 201 : 200);
          expect(await response.json()).toMatchObject({ data: { [field]: value } });
          const write = method === "POST" ? createEvent : updateEvent;
          expect(write).toHaveBeenCalledTimes(1);
          expect(vi.mocked(write).mock.calls[0]!.at(-1)).toMatchObject({
            ...parseEventForm(base),
            [field]: value,
          });
          expect(method === "POST" ? updateEvent : createEvent).not.toHaveBeenCalled();
        });
        it.each(characters)(
          "returns the existing 422 for N+1 $label code points without writing",
          async ({ pattern }) => {
            const response = await request(field, text(pattern, max + 1));
            expect(response.status).toBe(422);
            expect(await response.json()).toEqual({
              error: "invalid",
              fields: { [field]: `Keep the ${field} to ${max} characters.` },
            });
            expect(createEvent).not.toHaveBeenCalled();
            expect(updateEvent).not.toHaveBeenCalled();
          },
        );
      });
    }
  });
}
