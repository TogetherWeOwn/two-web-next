// route-inventory: POST /api/agent-events
// Acceptance suite: control/invisible characters in the event `game` field.
//
// The sibling text fields (title, description, location) already refuse
// control, bidi and zero-width characters on both event write paths, while
// `game` is only length-checked and then persists to the same row. This suite
// pins the sibling rule for `game`, from the spec:
// - a `game` bearing NUL, another C0/C1/DEL control, a bidi control/isolate,
//   a zero-width character or a BOM is refused with a 422 naming `game` (the
//   field-error key is the pin; the message wording is free), and no row is
//   written — on POST/PATCH /events and on agent create/update alike;
// - there is no silent stripping: a refused value never persists in cleaned
//   form, and a refused correction retry reuses its idempotency key;
// - valid `game` values keep passing verbatim: tab, LF and CR inside the
//   value, a genuine emoji ZWJ sequence, multibyte text, and the 100
//   code-point edge length; a blank `game` stays null and 101 code points
//   stays refused on length.
//
// Hermetic: pure validator pins, the real moderator JSON handlers over a
// stubbed store (no SQL), and the mounted agent route against an owned
// schema on the guarded disposable test database only (skipped without
// DATABASE_URL). Synthetic rows only; never production or staging data.
import { Hono } from "hono";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mountedApp from "./app";
import type { EnvWithAdminDb } from "../src/admin/db";
import {
  createEvent,
  getEvent,
  mergePatchInput,
  patchEvent,
  updateEvent,
} from "../src/admin/store";
import { parseEventForm, ValidationError, type EventFormInput } from "../src/admin/validation";
import { DEFAULT_CONFIG, validateFields } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import type { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env, Session } from "../src/env";
import { getPublicEvent } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { clearAuditRows } from "./helpers/audit-rows";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  patchEvent: vi.fn(),
  updateEvent: vi.fn(),
}));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getPublicEvent: vi.fn(),
}));
vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const state = vi.hoisted(() => ({
  schema: "",
  clients: [] as { end: () => Promise<void> }[],
}));
// Keep the real mounted route, driver and SQL. Only pin request connections to
// the fixture's schema and the explicitly authorized empty test password.
vi.mock("postgres", async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof postgres }>();
  return {
    default: (url: string, options: Record<string, unknown> = {}) => {
      const safe = testDatabaseUrl(url);
      const client = original(url, {
        ...options,
        port: 5432,
        password: () => safe.password,
        ...(state.schema ? { connection: { search_path: state.schema }, onnotice: () => {} } : {}),
      });
      if (state.schema) state.clients.push(client);
      return client;
    },
  };
});

// Representatives of every class the sibling fields refuse. Embedded mid-word
// so the character itself — never trimming or length — decides the verdict.
const FORBIDDEN = [
  { label: "NUL U+0000", char: "\u0000" },
  { label: "BEL U+0007", char: "\u0007" },
  { label: "vertical tab U+000B", char: "\u000b" },
  { label: "unit separator U+001F", char: "\u001f" },
  { label: "DEL U+007F", char: "\u007f" },
  { label: "C1 NEL U+0085", char: "\u0085" },
  { label: "bidi override U+202E", char: "\u202e" },
  { label: "bidi isolate U+2066", char: "\u2066" },
  { label: "zero-width space U+200B", char: "\u200b" },
  { label: "BOM U+FEFF", char: "\ufeff" },
] as const;
const forbiddenGame = (char: string) => `Che${char}ss`;

const ACCEPTED = [
  { label: "plain text", value: "Chess" },
  { label: "tab inside", value: "Game\tnight" },
  { label: "line feed inside", value: "Game\nnight" },
  { label: "carriage return inside", value: "Game\rnight" },
  { label: "genuine emoji ZWJ sequence", value: "👩‍💻 Chess" },
  { label: "multibyte BMP and astral text", value: "将棋 😀 café" },
  { label: "exactly 100 ASCII code points", value: "G".repeat(100) },
  { label: "exactly 100 astral code points", value: "😀".repeat(100) },
] as const;

const HUMAN_BASE = {
  title: "Game night",
  game: "Chess",
  description: "Friendly game night",
  location: "Discord",
  timezone: "UTC",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
};
const MACHINE_FIELDS = {
  title: "Synthetic game-controls event",
  game: "Chess",
  description: null,
  starts_at: "2026-10-01 20:00",
  ends_at: "2026-10-01 22:00",
  timezone: "UTC",
  location: "Synthetic voice",
  capacity: 1,
};

function humanErrors(data: Record<string, unknown>): Record<string, string> | null {
  try {
    parseEventForm(data);
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
}

describe("human form parser: game control characters (pure)", () => {
  it.each(FORBIDDEN)("refuses $label in game, naming only game", ({ char }) => {
    const fields = humanErrors({ ...HUMAN_BASE, game: forbiddenGame(char) });
    expect(fields).not.toBeNull();
    expect(Object.keys(fields!)).toEqual(["game"]);
    expect(fields!.game).toEqual(expect.any(String));
  });

  it.each(["\u0000Chess", "Chess\u0000", " \u0000Chess", "Chess\u0000 "])(
    "refuses NUL at the edge of game: %j",
    (game) => {
      const fields = humanErrors({ ...HUMAN_BASE, game });
      expect(fields).not.toBeNull();
      expect(Object.keys(fields!)).toEqual(["game"]);
    },
  );

  it.each(ACCEPTED)("accepts $label verbatim", ({ value }) => {
    expect(parseEventForm({ ...HUMAN_BASE, game: value }).game).toBe(value);
  });

  it("keeps a blank game null and the 101 code-point length refusal", () => {
    expect(parseEventForm({ ...HUMAN_BASE, game: "   " }).game).toBeNull();
    const fields = humanErrors({ ...HUMAN_BASE, game: "G".repeat(101) });
    expect(Object.keys(fields!)).toEqual(["game"]);
  });
});

describe("machine ingress: game control characters (pure)", () => {
  it.each(FORBIDDEN)("refuses $label in game, naming only game", ({ char }) => {
    const result = validateFields({ ...MACHINE_FIELDS, game: forbiddenGame(char) });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(Object.keys(result.errors)).toEqual(["game"]);
      expect(result.errors.game).toEqual([expect.any(String)]);
    }
  });

  it.each(ACCEPTED)("accepts $label verbatim", ({ value }) => {
    expect(validateFields({ ...MACHINE_FIELDS, game: value })).toMatchObject({
      ok: true,
      fields: { game: value },
    });
  });

  it("keeps a blank game null and the 101 code-point length refusal", () => {
    expect(validateFields({ ...MACHINE_FIELDS, game: "   " })).toMatchObject({
      ok: true,
      fields: { game: null },
    });
    const result = validateFields({ ...MACHINE_FIELDS, game: "G".repeat(101) });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(Object.keys(result.errors)).toEqual(["game"]);
  });
});

// The two parsers must agree on game, so neither path can be fixed alone.
describe("human/machine parity on game (pure)", () => {
  it.each([
    ...FORBIDDEN.map(({ label, char }) => ({ label, value: forbiddenGame(char), refused: true })),
    ...ACCEPTED.map(({ label, value }) => ({ label, value, refused: false })),
  ])("$label: both parsers give the same game verdict", ({ value, refused }) => {
    const fields = humanErrors({ ...HUMAN_BASE, game: value });
    const machine = validateFields({ ...MACHINE_FIELDS, game: value });
    if (refused) {
      expect(fields).not.toBeNull();
      expect(Object.keys(fields!)).toEqual(["game"]);
      expect(machine.ok).toBe(false);
    } else {
      expect(fields).toBeNull();
      expect(machine).toMatchObject({ ok: true, fields: { game: value } });
    }
  });
});

// Real moderator JSON handlers over a stubbed store; a refused request must
// never reach the write seam, an accepted one must carry game verbatim.
const KEY = "01J0000000000000000000ABCD";
const storedRow = {
  id: 1,
  eventKey: KEY,
  title: HUMAN_BASE.title,
  game: HUMAN_BASE.game,
  description: HUMAN_BASE.description,
  location: HUMAN_BASE.location,
  timezone: HUMAN_BASE.timezone,
  capacity: null,
  purpose: null,
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
const moderatorEnv: EnvWithAdminDb = {
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
const humanApp = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  humanApp,
  async () => moderator,
  async () => moderator,
);
function saved(input: EventFormInput): typeof events.$inferSelect {
  const { startsAtUtc, endsAtUtc, ...fields } = input;
  return { ...storedRow, ...fields, startsAt: startsAtUtc, endsAt: endsAtUtc };
}

const ROUTE_FORBIDDEN = FORBIDDEN.filter(({ char }) =>
  ["\u0000", "\u0007", "\u202e", "\u2066", "\u200b", "\ufeff"].includes(char),
);
const ROUTE_ACCEPTED = ACCEPTED.filter(({ label }) =>
  [
    "tab inside",
    "line feed inside",
    "carriage return inside",
    "genuine emoji ZWJ sequence",
    "exactly 100 astral code points",
  ].includes(label),
);

for (const method of ["POST", "PATCH"] as const) {
  describe(`${method} /events: game control characters (mounted handlers, no SQL)`, () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(getEvent).mockResolvedValue(storedRow);
      vi.mocked(createEvent).mockImplementation(async (_db, _actor, input) => ({
        row: saved(input),
        writeBack: null,
      }));
      vi.mocked(updateEvent).mockImplementation(async (_db, _actor, _key, input) => {
        const updated = saved(input);
        vi.mocked(getPublicEvent).mockResolvedValue({
          ...updated,
          goingCount: 0,
          goingOccupancy: 0,
        });
        return { row: updated, writeBack: null, childWriteBacks: [] };
      });
      // PATCH merges through the real pure seam against the fixture row (no
      // SQL): invalid patches throw before any write, like the live store.
      vi.mocked(patchEvent).mockImplementation(async (_db, _actor, _key, patch) => {
        const updated = saved(mergePatchInput(storedRow, patch));
        vi.mocked(getPublicEvent).mockResolvedValue({
          ...updated,
          goingCount: 0,
          goingOccupancy: 0,
        });
        return { row: updated, writeBack: null, childWriteBacks: [] };
      });
    });

    const path = method === "POST" ? "/events" : `/events/${KEY}`;
    async function request(game: string): Promise<Response> {
      const data = method === "POST" ? { ...HUMAN_BASE, game } : { game };
      return humanApp.request(
        path,
        { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) },
        moderatorEnv,
      );
    }

    it.each(ROUTE_FORBIDDEN)(
      "answers 422 naming game for $label and writes nothing",
      async ({ char }) => {
        const response = await request(forbiddenGame(char));
        expect(response.status).toBe(422);
        const body = (await response.json()) as { fields?: Record<string, unknown> };
        expect(Object.keys(body.fields ?? {})).toEqual(["game"]);
        expect(body.fields!.game).toEqual(expect.any(String));
        expect(createEvent).not.toHaveBeenCalled();
        expect(updateEvent).not.toHaveBeenCalled();
      },
    );

    it.each(ROUTE_ACCEPTED)("persists $label verbatim", async ({ value }) => {
      const response = await request(value);
      expect(response.status).toBe(method === "POST" ? 201 : 200);
      if (method === "POST") {
        expect(createEvent).toHaveBeenCalledTimes(1);
        expect(vi.mocked(createEvent).mock.calls[0]!.at(-1)).toMatchObject({ game: value });
        expect(patchEvent).not.toHaveBeenCalled();
        expect(updateEvent).not.toHaveBeenCalled();
      } else {
        // PATCH carries the raw one-field edit; the merge happens inside the
        // store seam against the locked row.
        expect(patchEvent).toHaveBeenCalledTimes(1);
        expect(vi.mocked(patchEvent).mock.calls[0]!.at(-1)).toEqual({ game: value });
        expect(createEvent).not.toHaveBeenCalled();
        expect(updateEvent).not.toHaveBeenCalled();
      }
    });
  });
}

// Mounted agent route against real SQL in an owned schema: a refused game
// leaves the events table untouched and does not burn the idempotency key.
describe.skipIf(!process.env.DATABASE_URL)(
  "agent events: game control characters (mounted route / SQL)",
  () => {
    const CALLER = "game-controls-test-agent";
    const TOKEN = "synthetic-game-controls-credential";
    let fixture: MemberDataFixture;
    let sql: MemberDataFixture["client"];
    let url: string;

    beforeAll(async () => {
      url = testDatabaseUrl(process.env.DATABASE_URL!).href;
      fixture = await createMemberDataFixture(url);
      sql = fixture.client;
      state.schema = fixture.schemaName;
    });
    beforeEach(async () => {
      await fixture.reset();
      await clearAuditRows(sql, ["agent_event_audits"]);
      await sql`DELETE FROM agent_event_grants`;
      await sql`DELETE FROM agent_event_hits`;
      await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${CALLER}, 'synthetic-company', ${DEFAULT_CONFIG.stagingGuildId}, ${await sha256Hex(TOKEN)})`;
    });
    afterAll(async () => {
      await Promise.all(state.clients.splice(0).map((client) => client.end()));
      state.schema = "";
      await fixture?.dispose();
    });

    async function call(body: Record<string, unknown>) {
      const pending: Promise<unknown>[] = [];
      try {
        const response = await mountedApp.request(
          "/api/agent-events",
          {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          {
            APP_URL: "https://next.example.test",
            DATABASE_URL: url,
            AGENT_EVENTS_ENABLED: "true",
            AGENT_EVENTS_CALLER_AGENT_ID: CALLER,
          } as never,
          {
            waitUntil: (promise: Promise<unknown>) => pending.push(promise),
            passThroughOnException: () => {},
          } as never,
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      } finally {
        await Promise.all(pending);
        await Promise.all(state.clients.splice(0).map((client) => client.end()));
      }
    }

    async function createClean(game: string, idempotencyKey: string) {
      const result = await call({
        op: "create",
        idempotency_key: idempotencyKey,
        fields: { ...MACHINE_FIELDS, game },
      });
      expect(result.status).toBe(201);
      expect(result.body.event_key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      return result.body.event_key as string;
    }

    it.each([
      { label: "NUL U+0000", game: "Che\u0000ss" },
      { label: "bidi isolate U+2066", game: "Che\u2066ss" },
    ])(
      "create refuses $label in game with 422, writes no row, and a corrected retry reuses the key",
      async ({ game }) => {
        const before = await sql`SELECT * FROM events`;
        const rejected = await call({
          op: "create",
          idempotency_key: "game-retry-create",
          fields: { ...MACHINE_FIELDS, game },
        });
        expect(rejected.status).toBe(422);
        expect(rejected.body).toMatchObject({ reason: "validation_failed" });
        expect(rejected.body.errors).toMatchObject({ game: [expect.any(String)] });
        expect(await sql`SELECT * FROM events`).toEqual(before);
        expect(
          await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = 'game-retry-create'`,
        ).toHaveLength(0);

        const eventKey = await createClean("Chess", "game-retry-create");
        expect((await sql`SELECT game FROM events WHERE event_key = ${eventKey}`)[0]!.game).toBe(
          "Chess",
        );
      },
    );

    it("update refuses a control-bearing game with 422, leaving the stored row untouched", async () => {
      const eventKey = await createClean("Chess", "seed-update");
      const before = await sql`SELECT * FROM events`;
      const rejected = await call({
        op: "update",
        idempotency_key: "game-retry-update",
        event_key: eventKey,
        version: 1,
        fields: { ...MACHINE_FIELDS, game: "Che\u0000ss" },
      });
      expect(rejected.status).toBe(422);
      expect(rejected.body).toMatchObject({ reason: "validation_failed" });
      expect(rejected.body.errors).toMatchObject({ game: [expect.any(String)] });
      expect(await sql`SELECT * FROM events`).toEqual(before);
      expect(
        await sql`SELECT key FROM agent_event_idempotency_keys WHERE key = 'game-retry-update'`,
      ).toHaveLength(0);

      const corrected = await call({
        op: "update",
        idempotency_key: "game-retry-update",
        event_key: eventKey,
        version: 1,
        fields: { ...MACHINE_FIELDS, game: "👩‍💻 Chess" },
      });
      expect(corrected.status).toBe(200);
      expect(
        (await sql`SELECT game, agent_version FROM events WHERE event_key = ${eventKey}`)[0],
      ).toMatchObject({ game: "👩‍💻 Chess", agent_version: 2 });
    });

    it.each([
      { label: "tab inside", game: "Game\tnight" },
      { label: "line feed inside", game: "Game\nnight" },
      { label: "carriage return inside", game: "Game\rnight" },
      { label: "genuine emoji ZWJ sequence", game: "👩‍💻 Chess" },
      { label: "exactly 100 astral code points", game: "😀".repeat(100) },
    ])("create persists $label in game verbatim", async ({ game }, index) => {
      const eventKey = await createClean(game, `game-accepted-${index}`);
      expect((await sql`SELECT game FROM events WHERE event_key = ${eventKey}`)[0]!.game).toBe(
        game,
      );
    });
  },
);
