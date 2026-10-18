// Acceptance: NUL (U+0000) in any event free-text field is refused with a
// field-named validation error before persistence — never a database 500,
// never silently stripped. Postgres text columns reject NUL bytes, so any
// field that lets NUL through turns member input into a 500 at write time.
//
// Pre-fix probe (base 38a700f4e): title/description/location already reject
// NUL on every surface below; those rows are regression pins. `game` lets
// NUL reach the persistence call on every surface; those rows are RED until
// the paired build adds the guard. Only the field-error KEY is pinned —
// message wording is free. Broadened control scope: non-NUL controls (BEL,
// U+0007) in `game` are refused like the sibling fields, so the rows below
// pin that refusal; tab, LF, CR and genuine emoji ZWJ sequences stay accepted.
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
const FIELDS = ["title", "game", "description", "location"] as const;
const MAX = { title: 100, game: 100, description: 1000, location: 255 } as const;
const NUL_VARIANTS = [
  { label: "embedded", value: "a\u0000b" },
  { label: "leading", value: "\u0000a" },
  { label: "trailing", value: "a\u0000" },
  { label: "NUL only", value: "\u0000" },
  { label: "space-padded", value: " \u0000 " },
];

function parseErrors(data: Record<string, unknown>): Record<string, string> {
  try {
    parseEventForm(data);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("Expected event validation to fail");
}

describe("parseEventForm NUL rejection", () => {
  for (const field of FIELDS) {
    it.each(NUL_VARIANTS)(
      `rejects $label NUL in ${field} with only that field error`,
      ({ value }) => {
        const errors = parseErrors({ ...base, [field]: value });
        expect(Object.keys(errors)).toEqual([field]);
        expect(errors[field]).toEqual(expect.any(String));
        expect(errors[field]!.length).toBeGreaterThan(0);
      },
    );
  }

  it("names every NUL-bearing field when several are present", () => {
    const errors = parseErrors({
      ...base,
      title: "a\u0000",
      game: "b\u0000",
      location: "c\u0000",
    });
    expect(Object.keys(errors).sort()).toEqual(["game", "location", "title"]);
  });

  it("accepts valid multibyte text verbatim in every field (no stripping)", () => {
    const data = {
      ...base,
      title: "👩‍💻 Game night",
      game: "将棋",
      description: "Café — é",
      location: "東京 / Discord",
    };
    expect(parseEventForm(data)).toMatchObject({
      title: data.title,
      game: data.game,
      description: data.description,
      location: data.location,
    });
  });

  for (const field of FIELDS) {
    it(`accepts exactly ${MAX[field]} astral code points in ${field}`, () => {
      const value = "😀".repeat(MAX[field]);
      expect(parseEventForm({ ...base, [field]: value })[field]).toBe(value);
    });
  }

  it("still accepts multiline and tab text in description", () => {
    expect(parseEventForm({ ...base, description: "line1\nline2\tend" }).description).toBe(
      "line1\nline2\tend",
    );
  });

  it("refuses BEL (U+0007) in game naming only game (broadened control scope)", () => {
    const errors = parseErrors({ ...base, game: "a\u0007b" });
    expect(Object.keys(errors)).toEqual(["game"]);
    expect(errors.game).toEqual(expect.any(String));
    expect(errors.game!.length).toBeGreaterThan(0);
  });

  it("keeps empty optional text null", () => {
    expect(parseEventForm({ ...base, game: " ", description: "\n", location: "\t" })).toMatchObject(
      { game: null, description: null, location: null },
    );
  });
});

describe("agent validateFields NUL rejection", () => {
  for (const field of FIELDS) {
    it(`rejects NUL in ${field} with only that field error`, () => {
      const result = validateFields({ ...base, [field]: "a\u0000b" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(Object.keys(result.errors)).toEqual([field]);
      expect(result.errors[field as keyof typeof result.errors]?.length).toBeGreaterThan(0);
    });
  }

  it("refuses BEL in game even alongside valid multibyte text", () => {
    const result = validateFields({ ...base, game: "a\u0007b 将棋" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(Object.keys(result.errors)).toEqual(["game"]);
    expect(result.errors.game).toEqual([expect.any(String)]);
  });
});

// Real moderator JSON handlers, synthetic identity/reads/writes; no SQL.
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
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
const routeEnv: EnvWithAdminDb = {
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
const routeApp = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  routeApp,
  async () => moderator,
  async () => moderator,
);
function saved(input: EventFormInput): typeof events.$inferSelect {
  const { startsAtUtc, endsAtUtc, ...fields } = input;
  return { ...row, ...fields, startsAt: startsAtUtc, endsAt: endsAtUtc };
}

describe("moderator JSON event NUL rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEvent).mockResolvedValue(row);
    vi.mocked(createEvent).mockImplementation(async (_db, _actor, input) => ({
      row: saved(input),
      writeBack: null,
    }));
    vi.mocked(updateEvent).mockImplementation(async (_db, _actor, _key, input) => {
      const updated = saved(input);
      vi.mocked(getPublicEvent).mockResolvedValue({ ...updated, goingCount: 0, goingOccupancy: 0 });
      return { row: updated, writeBack: null, childWriteBacks: [] };
    });
  });

  const request = (method: "POST" | "PATCH", data: Record<string, unknown>) =>
    routeApp.request(
      method === "POST" ? "/events" : `/events/${KEY}`,
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      },
      routeEnv,
    );

  for (const method of ["POST", "PATCH"] as const) {
    for (const field of FIELDS) {
      it(`${method}: NUL in ${field} is 422 invalid naming only ${field}, without writing`, async () => {
        const data = method === "POST" ? { ...base, [field]: "a\u0000b" } : { [field]: "a\u0000b" };
        const res = await request(method, data);
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: string; fields: Record<string, string> };
        expect(body.error).toBe("invalid");
        expect(Object.keys(body.fields)).toEqual([field]);
        expect(body.fields[field]!.length).toBeGreaterThan(0);
        expect(createEvent).not.toHaveBeenCalled();
        expect(updateEvent).not.toHaveBeenCalled();
      });
    }

    it(`${method}: BEL in game is 422 invalid naming only game, without writing`, async () => {
      const game = "a\u0007b 将棋";
      const data = method === "POST" ? { ...base, game } : { game };
      const res = await request(method, data);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; fields: Record<string, string> };
      expect(body.error).toBe("invalid");
      expect(Object.keys(body.fields)).toEqual(["game"]);
      expect(body.fields.game!.length).toBeGreaterThan(0);
      expect(createEvent).not.toHaveBeenCalled();
      expect(updateEvent).not.toHaveBeenCalled();
    });
  }

  it("PATCH: a NUL game blocks the whole update — no partial persistence", async () => {
    const res = await request("PATCH", { title: "Renamed", game: "bad\u0000game" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fields: Record<string, string> };
    expect(Object.keys(body.fields)).toEqual(["game"]);
    expect(updateEvent).not.toHaveBeenCalled();
  });
});
