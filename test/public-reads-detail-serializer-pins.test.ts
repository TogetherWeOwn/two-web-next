// route-inventory: GET /api/public/events/:key
// route-inventory: GET /e/:file{.+\.md}
// Builder-owned pins: detail serializer faults stay route-native. The
// acceptance matrix (Test Author owned, never edited here) pins the
// collection serializer paths; these two rows pin the single-event REST and
// Markdown detail serializer paths the same way: a corrupt row (invalid
// instant reaching toISOString) answers the static route-native 500 envelope,
// never branded HTML, with no row text leaked. Real app +
// agent-testdb/CI Postgres only.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import app from "./app";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { MARKDOWN_MIME } from "../src/ai-friendly/md";
import type { Env } from "../src/env";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { parseJsonLines } from "./helpers/parse-json-lines";

// Serializer-fault injection only: with the flags off every read delegates to
// the real implementation.
const faultFlags = vi.hoisted(() => ({ restSerializerBoom: false, mdSerializerBoom: false }));
vi.mock("../src/events/reads", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/events/reads")>();
  const badInstant = new Date(NaN);
  return {
    ...original,
    getPublicApiEvent: async (...args: Parameters<typeof original.getPublicApiEvent>) => {
      if (!faultFlags.restSerializerBoom) return original.getPublicApiEvent(...args);
      return {
        eventKey: "00000000000000000000000072",
        title: "serializer-boom secret-row-marker",
        game: null,
        description: null,
        startsAt: badInstant,
        endsAt: badInstant,
        timezone: "UTC",
        location: null,
        capacity: null,
        goingCount: null,
        goingOccupancy: null,
        rsvpOpen: true,
        discordEventId: null,
      } as never;
    },
    getPublicEvent: async (...args: Parameters<typeof original.getPublicEvent>) => {
      if (!faultFlags.mdSerializerBoom) return original.getPublicEvent(...args);
      return {
        eventKey: "01J0000000000000000000PXB1",
        title: "md-serializer-boom secret-row-marker",
        game: null,
        description: null,
        startsAt: badInstant,
        endsAt: badInstant,
        timezone: "UTC",
        location: null,
        capacity: null,
        status: "published",
      } as never;
    },
  };
});

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const MD_DETAIL_KEY = "01J0000000000000000000PXB1";

const key = (n: number) => String(n).padStart(26, "0");

const REST_INTERNAL = {
  error: {
    code: "internal",
    message: "Event data could not be read.",
    request_id: expect.any(String),
    next: "Retry the read shortly.",
  },
};
const MD_INTERNAL_BODY = "Events temporarily unavailable. Try again shortly.";

describe.skipIf(!process.env.DATABASE_URL)("public reads detail serializer pins", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let env: Env & EnvWithThrottle;
  let now: number;
  let hits: { bucket: string; at: number }[];
  let eventStore: Mock<() => unknown>;
  let spy: ReturnType<typeof vi.spyOn>;

  const throttleDouble = () => {
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join("?");
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("SELECT count(*)")) {
          const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
          return [
            {
              n: rows.length,
              wait: rows.length ? Math.ceil((rows[0]!.at + 60_000 - now) / 1000) : 1,
            },
          ];
        }
        if (statement.includes("INSERT INTO web_throttle_hits")) {
          hits.push({ bucket: String(values[0]), at: now });
          return [];
        }
        if (statement.includes("DELETE FROM web_throttle_hits")) return [];
        throw new Error("Unexpected throttle statement");
      },
      {
        begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
        unsafe: async () => [],
      },
    );
    return sql;
  };

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    now = Date.now();
    hits = [];
    eventStore = vi.fn(() => db);
    env = {
      APP_URL,
      SESSION_SECRET,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_STORE: createMemorySessionStore(),
      THROTTLE_STORE: async () => throttleDouble() as unknown as Sql,
      get ADMIN_DB() {
        return eventStore();
      },
    } as unknown as Env & EnvWithThrottle;
  });
  beforeEach(async () => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await fixture.reset();
    __resetApiPublicCacheForTests();
    __resetAlertRateLimitForTests();
    now = Date.now();
    hits = [];
    eventStore.mockReset();
    eventStore.mockImplementation(() => db);
    faultFlags.restSerializerBoom = false;
    faultFlags.mdSerializerBoom = false;
  });
  afterEach(() => {
    spy.mockRestore();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const get = async (path: string, headers: Record<string, string> = {}, ip = "192.0.2.71") =>
    app.request(path, { headers: { "cf-connecting-ip": ip, ...headers } }, env);

  const alerts = () => {
    const { parsed, skipped } = parseJsonLines(spy.mock.calls);
    expect(skipped, `unparsed log lines: ${JSON.stringify(skipped)}`).toEqual([]);
    return parsed
      .map(({ value }) => value as Record<string, unknown>)
      .filter((line) => line?.["event"] === "error.alert");
  };

  const expectNoLeak = (text: string) => {
    expect(text).not.toContain("<html");
    expect(text).not.toContain("<!doctype");
    expect(text).not.toContain("secret-row-marker");
    expect(text).not.toContain("serializer-boom");
  };

  it("REST single serializer fault -> 500 internal envelope, never HTML", async () => {
    faultFlags.restSerializerBoom = true;
    const res = await get(`/api/public/events/${key(11)}`, {}, "192.0.2.91");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toContain("Accept");
    const text = await res.text();
    expectNoLeak(text);
    expect(JSON.parse(text)).toEqual(REST_INTERNAL);
    // Same privacy boundary as the collection pin: one alert, class only.
    const lines = alerts();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      method: "GET",
      route: "/api/public/events/:key",
      fingerprint: "RangeError@/api/public/events/:key",
    });
    expect(JSON.stringify(lines[0])).not.toContain("secret-row-marker");
  });

  it("Markdown detail serializer fault -> 500 Markdown guidance, never HTML", async () => {
    faultFlags.mdSerializerBoom = true;
    const res = await get(`/e/${MD_DETAIL_KEY}.md`, {}, "192.0.2.92");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const text = await res.text();
    expect(text).toBe(MD_INTERNAL_BODY);
    expectNoLeak(text);
    const lines = alerts();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      method: "GET",
      route: "/e/:file{.+\\.md}",
      fingerprint: "RangeError@/e/:file{.+\\.md}",
    });
    expect(JSON.stringify(lines[0])).not.toContain("secret-row-marker");
  });
});
