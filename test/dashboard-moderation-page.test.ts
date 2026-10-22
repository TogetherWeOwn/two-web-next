// route-inventory: GET /admin/moderation
// route-inventory: POST /admin/moderation
// Builder-owned unit pins for the dashboard moderation page: key registry,
// form parsing, and the queued carrier. Endpoint behavior lives in
// test/dashboard-moderation-page-acceptance.test.ts (Test Author owned);
// the two POST outage tests below cover the 503 branches the acceptance
// suite leaves to the builder.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import {
  auditModerationWrite,
  buildSettingsSetMessage,
  familyOf,
  isEnvOnlyKey,
  MODERATION_ENVONLY_KEYS,
  MODERATION_ENVONLY_PREFIXES,
  MODERATION_HOT_KEYS,
  MODERATION_KEY_FAMILIES,
  moderationPageModel,
  parseModerationSubmission,
} from "../src/admin/moderation";
import type { Env } from "../src/env";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const HOT_KEY = "TWO_AUTOMOD_MENTION_LIMIT";
const ENVONLY_KEY = "TWO_MODERATION";
const BOT_URL = "https://bot.moderation-unit-fixture.test";
const MOD_ROLE = "555000000000000001";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("moderation key registry", () => {
  it("edits exactly the pinned hot key, nothing invented", () => {
    expect([...MODERATION_HOT_KEYS]).toEqual([HOT_KEY]);
  });

  it("names the bot-owned families for classification, not for editing", () => {
    for (const family of ["TWO_RAID_", "TWO_JOIN_RISK_", "TWO_ANTI_NUKE_", "LOG_CHANNEL_ID"]) {
      expect(
        MODERATION_KEY_FAMILIES.some((prefix) => family.startsWith(prefix) || prefix === family),
        `family ${family}`,
      ).toBe(true);
    }
    expect(familyOf("TWO_RAID_BURST_WINDOW")).toBe("TWO_RAID_");
    expect(familyOf("TWO_JOIN_RISK_SCORE_CAP")).toBe("TWO_JOIN_RISK_");
    expect(familyOf("TWO_ANTI_NUKE_MASS_BAN")).toBe("TWO_ANTI_NUKE_");
    expect(familyOf("DISCORD_MOD_LOG_CHANNEL_ID")).toBe("LOG_CHANNEL_ID");
    expect(familyOf(HOT_KEY)).toBe("TWO_AUTOMOD_");
    expect(familyOf("warn_escalation_policy")).toBeNull();
  });

  it("marks the reach/identity keys EnvOnly, never the hot key", () => {
    expect(MODERATION_ENVONLY_KEYS).toContain(ENVONLY_KEY);
    expect(MODERATION_ENVONLY_KEYS).toContain("TWO_OWEN_USER_ID");
    expect(MODERATION_ENVONLY_PREFIXES).toContain("TWO_INTERNAL_");
    expect(isEnvOnlyKey(ENVONLY_KEY)).toBe(true);
    expect(isEnvOnlyKey("TWO_INTERNAL_ALLOW_EVENT_CANCEL")).toBe(true);
    expect(isEnvOnlyKey("TWO_ASSISTANT_MODEL")).toBe(true);
    expect(isEnvOnlyKey(HOT_KEY)).toBe(false);
    expect(isEnvOnlyKey("TWO_RAID_BURST_WINDOW")).toBe(false);
  });
});

describe("parseModerationSubmission", () => {
  it("accepts a versioned hot-key write", () => {
    expect(parseModerationSubmission({ [HOT_KEY]: "8", expected_version: "7" })).toEqual({
      ok: true,
      submission: { key: HOT_KEY, value: "8", expectedVersion: 7 },
    });
  });

  it("ignores the forged guild field: the session guild always wins", () => {
    expect(
      parseModerationSubmission({
        [HOT_KEY]: "8",
        expected_version: "7",
        guild_id: "999000000000000999",
      }),
    ).toEqual({
      ok: true,
      submission: { key: HOT_KEY, value: "8", expectedVersion: 7 },
    });
  });

  it("refuses an EnvOnly write before anything else is checked", () => {
    const res = parseModerationSubmission({ [ENVONLY_KEY]: "off", expected_version: "3" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.status).toBe(422);
    expect(res.ok === false && res.detail).toContain(ENVONLY_KEY);
    expect(res.ok === false && res.detail).toMatch(/read-only|operator/i);
  });

  it("refuses unknown fields without echoing attacker-controlled names raw", () => {
    const res = parseModerationSubmission({
      warn_escalation_policy: "three-strikes",
      mute_role_id: "555000000000000002",
      expected_version: "7",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.status).toBe(422);
    expect(res.ok === false && res.detail).toMatch(/unknown setting/i);
  });

  it("refuses a missing or non-numeric expected version", () => {
    for (const fields of [
      { [HOT_KEY]: "8" },
      { [HOT_KEY]: "8", expected_version: "" },
      { [HOT_KEY]: "8", expected_version: "seven" },
      { [HOT_KEY]: "8", expected_version: "-1" },
    ]) {
      const res = parseModerationSubmission(fields);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.status).toBe(422);
      expect(res.ok === false && res.detail).toMatch(/version/i);
    }
  });

  it("refuses a non-threshold value, naming the key", () => {
    for (const value of ["abc", "-1", "", "8.5", "8 "] as const) {
      const res = parseModerationSubmission({ [HOT_KEY]: value, expected_version: "7" });
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.status).toBe(422);
      expect(res.ok === false && res.detail).toContain(HOT_KEY);
    }
  });

  it("refuses a submission with nothing to write", () => {
    const res = parseModerationSubmission({ expected_version: "7" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.status).toBe(422);
  });
});

describe("moderationPageModel", () => {
  const row = {
    key: HOT_KEY,
    value: "5",
    version: 7,
    updatedBy: "discord:/automod",
    updatedAt: "2026-10-20T12:00:00.000Z",
  };
  const envRow = {
    key: ENVONLY_KEY,
    value: "on",
    version: 3,
    updatedBy: "operator:deploy",
    updatedAt: "2026-10-19T08:00:00.000Z",
  };

  it("carries the live value, version, and audit trail per hot key", () => {
    expect(moderationPageModel([row, envRow])).toEqual({
      hotKeys: [row],
      envOnly: [{ key: ENVONLY_KEY, value: "on" }],
    });
  });

  it("is null when the live response omits the pinned hot key", () => {
    expect(moderationPageModel([envRow])).toBeNull();
    expect(moderationPageModel([])).toBeNull();
  });
});

describe("buildSettingsSetMessage", () => {
  it("builds the attributed carrier over the session guild", () => {
    const msg = buildSettingsSetMessage({
      key: HOT_KEY,
      value: "8",
      expectedVersion: 7,
      actorId: MODERATOR.userId,
      guildId: env.DISCORD_GUILD_ID,
    });
    expect(msg).toEqual({
      kind: "settings-set",
      idempotencyKey: expect.stringMatching(UUID_RE),
      guildId: env.DISCORD_GUILD_ID,
      actor: `dashboard:${MODERATOR.userId}`,
      action: {
        verb: "settings.set",
        key: HOT_KEY,
        value: "8",
        expected_version: 7,
      },
    });
  });

  it("mints a fresh idempotency key per dispatch", () => {
    const args = {
      key: HOT_KEY,
      value: "8",
      expectedVersion: 7,
      actorId: MODERATOR.userId,
      guildId: env.DISCORD_GUILD_ID,
    };
    expect(buildSettingsSetMessage(args).idempotencyKey).not.toBe(
      buildSettingsSetMessage(args).idempotencyKey,
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("moderation POST outages (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let sessions: SessionStore;
  const sent: unknown[] = [];
  const realFetch = globalThis.fetch;

  const bindings = (overrides: Record<string, unknown> = {}) =>
    ({
      ...env,
      ADMIN_DB: fixture.db,
      INTERNAL_ACTION_QUEUE: {
        send: async (message: unknown) => {
          sent.push(message);
          return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
        },
      },
      BOT_ENDPOINT_URL: BOT_URL,
      BOT_KEY_ID: "fixture-key-id",
      BOT_SHARED_SECRET: "fixture-secret-not-a-credential",
      DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
      ...overrides,
    }) as unknown as Env;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await fixture.reset();
    sessions = createMemorySessionStore();
    sent.length = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url === BOT_URL || url.startsWith(`${BOT_URL}/`))
        return new Response("bot down", { status: 500 });
      if (url.startsWith("https://discord.com/api/v10/guilds/")) {
        return new Response(JSON.stringify({ roles: [MOD_ROLE], joined_at: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input as RequestInfo | URL);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });
  afterAll(() => fixture?.dispose());

  async function postForm(cookie: string, params: Record<string, string>, envOverride = {}) {
    return adminApp({ sessionStore: sessions, db: fixture.db }).request(
      "/moderation",
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params),
      },
      bindings(envOverride),
    );
  }

  it("a bot outage on write answers 503 with nothing dispatched or audited", async () => {
    const { activityLog } = await import("../src/db/admin-schema");
    const res = await postForm(await cookieFor(sessions, MODERATOR), {
      [HOT_KEY]: "8",
      expected_version: "7",
    });
    expect(res.status).toBe(503);
    expect(sent).toHaveLength(0);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(0);
  });

  it("a missing queue binding answers 503 before anything is audited", async () => {
    const { activityLog } = await import("../src/db/admin-schema");
    const okFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === BOT_URL || url.startsWith(`${BOT_URL}/`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              settings: [
                {
                  key: HOT_KEY,
                  value: "5",
                  version: 7,
                  updated_by: "discord:/automod",
                  updated_at: "2026-10-20T12:00:00.000Z",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return okFetch(input as RequestInfo | URL, init);
    }) as typeof fetch;
    const res = await postForm(
      await cookieFor(sessions, MODERATOR),
      { [HOT_KEY]: "8", expected_version: "7" },
      { INTERNAL_ACTION_QUEUE: undefined },
    );
    expect(res.status).toBe(503);
    expect(sent).toHaveLength(0);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(0);
  });

  it("a mid-flight dispatch failure answers 503 with the attempt on record", async () => {
    const { activityLog } = await import("../src/db/admin-schema");
    const okFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === BOT_URL || url.startsWith(`${BOT_URL}/`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              settings: [
                {
                  key: HOT_KEY,
                  value: "5",
                  version: 7,
                  updated_by: "discord:/automod",
                  updated_at: "2026-10-20T12:00:00.000Z",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return okFetch(input as RequestInfo | URL, init);
    }) as typeof fetch;
    const res = await postForm(
      await cookieFor(sessions, MODERATOR),
      { [HOT_KEY]: "8", expected_version: "7" },
      {
        INTERNAL_ACTION_QUEUE: {
          send: async () => {
            throw new Error("queue unavailable");
          },
        },
      },
    );
    expect(res.status).toBe(503);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(1);
  });

  it("auditModerationWrite records one attributable row", async () => {
    const { activityLog } = await import("../src/db/admin-schema");
    await auditModerationWrite(fixture.db, {
      actorId: MODERATOR.userId,
      key: HOT_KEY,
      before: "5",
      after: "8",
      expectedVersion: 7,
    });
    const rows = await fixture.db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ causerId: MODERATOR.userId, subjectId: HOT_KEY });
  });
});
