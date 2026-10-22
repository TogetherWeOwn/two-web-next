// route-inventory: GET /api/public/community
// route-inventory: GET /api/public/join
// Bounded public read API: community snapshot (live counts, null when
// unavailable — never 0) and the join handoff (Discord only, no member
// data). Real app + agent-testdb/CI Postgres only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import {
  COMMUNITY_SNAPSHOT_FIELDS,
  JOIN_HANDOFF_FIELDS,
  type CommunitySnapshotDto,
  type JoinHandoffDto,
} from "../src/public-data/contracts";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { JOIN_INTRO } from "../src/screens/join";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { validatePublicSchema } from "./helpers/public-api-schema";

const APP_URL = "https://next.example.test";
const INVITE_URL = "https://discord.gg/test-invite-handoff";
const BOT_TOKEN_CANARY = "bot-token-canary-never-served";

describe.skipIf(!process.env.DATABASE_URL)("public read API: community + join", () => {
  let fixture: MemberDataFixture;
  let env: Env & EnvWithThrottle;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    env = {
      APP_URL,
      DATABASE_URL: process.env.DATABASE_URL!,
      DISCORD_INVITE_URL: INVITE_URL,
      DISCORD_BOT_TOKEN: BOT_TOKEN_CANARY,
      THROTTLE_STORE: async () => null,
    } as unknown as Env & EnvWithThrottle;
  });
  beforeEach(async () => {
    await fixture.reset();
    __resetApiPublicCacheForTests();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const get = (path: string, init: RequestInit = {}) =>
    app.request(
      path,
      { ...init, headers: { "cf-connecting-ip": "192.0.2.73", ...init.headers } },
      env,
    );

  it("returns null counts, never 0, when the collectors are unavailable", async () => {
    const res = await get("/api/public/community");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await res.json()) as CommunitySnapshotDto;
    expect(Object.keys(body).sort()).toEqual([...COMMUNITY_SNAPSHOT_FIELDS].sort());
    // A fresh test database has no bot snapshots: absence must read as
    // unknown, not as an empty community.
    expect(body.member_count).toBeNull();
    expect(body.online_count).toBeNull();
    expect(body.ranks).toEqual([]);
    expect(validatePublicSchema(body, "CommunitySnapshot")).toEqual([]);
  });

  it("serves the identical snapshot to cookie-bearing viewers", async () => {
    const anon = await (await get("/api/public/community")).text();
    const cookied = await (
      await get("/api/public/community", { headers: { cookie: "stray=crumb" } })
    ).text();
    expect(cookied).toBe(anon);
  });

  it("hands off to Discord with the public invite and no member data", async () => {
    const res = await get("/api/public/join");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await res.json()) as JoinHandoffDto;
    expect(Object.keys(body).sort()).toEqual([...JOIN_HANDOFF_FIELDS].sort());
    expect(body.invite_url).toBe(INVITE_URL);
    expect(body.intro).toBe(JOIN_INTRO);
    expect(validatePublicSchema(body, "JoinHandoff")).toEqual([]);
    const raw = await (await get("/api/public/join")).text();
    expect(raw).not.toContain(BOT_TOKEN_CANARY);
    expect(raw).not.toContain("client-secret");
  });

  it("keeps join available when the database is down", async () => {
    const offline = { ...env, DATABASE_URL: undefined } as unknown as Env & EnvWithThrottle;
    const res = await app.request(
      "/api/public/join",
      { headers: { "cf-connecting-ip": "192.0.2.74" } },
      offline,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as JoinHandoffDto).invite_url).toBe(INVITE_URL);
  });

  it("throttles community and join under the shared budget with a JSON 429", async () => {
    const now = Date.now();
    const hits: { bucket: string; at: number }[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join("?");
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("SELECT count(*)")) {
          const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
          return [{ n: rows.length, wait: 60 }];
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
        // The throttle sets `SET LOCAL lock_timeout` through `unsafe` before
        // the advisory lock; the double passes it through.
        unsafe: async () => [],
      },
    );
    const throttled = {
      ...env,
      THROTTLE_STORE: async () => sql as unknown as Sql,
    } as unknown as Env & EnvWithThrottle;
    const limited = (path: string) =>
      app.request(path, { headers: { "cf-connecting-ip": "192.0.2.75" } }, throttled);
    for (let n = 0; n < 60; n++) {
      expect((await limited("/api/public/join")).status).not.toBe(429);
    }
    const res = await limited("/api/public/community");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again in 60 seconds.",
        request_id: expect.any(String),
        next: "Wait for Retry-After, then retry.",
      },
    });
  });
});
