// A cookieless /events hit serves before admission: the throttle guard, DB
// acquisition and session read all precede the anonymous-cache lookup, so
// even a cache hit pays ~170ms of database round trips on staging. A request
// with no Cookie header cannot carry a session or a join flash (both are
// cookies), so eligibility is known from headers alone and a hit returns
// without touching the throttle store or the database.
//
// Live against agent-testdb in an owned disposable schema; the throttle store
// is a counting fake that always allows, so the test pins that the second
// request skips admission entirely.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

describe.skipIf(!process.env.DATABASE_URL)("cookieless /events cache-first (agent-testdb)", () => {
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.reset();
    __resetAnonEventCacheForTests();
  });

  it("second cookieless fetch skips the throttle store and serves the settled bytes", async () => {
    const dayMs = 86_400_000;
    const base = Date.now();
    await fixture.client`
      insert into events (event_key, title, starts_at, ends_at, status)
      values ('cache-first-0', 'Cache First', ${new Date(base + dayMs).toISOString()}, ${new Date(base + dayMs + 3_600_000).toISOString()}, 'published')`;
    let throttleCalls = 0;
    const env = {
      APP_URL: "https://next.example.test",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      ADMIN_DB: fixture.db,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      THROTTLE_STORE: async () => {
        throttleCalls += 1;
        return null;
      },
    } as unknown as Env;

    const first = await app.request("/events", { method: "GET" }, env);
    expect(first.status).toBe(200);
    expect(throttleCalls).toBe(1);
    const firstBody = await first.text();
    expect(first.headers.get("cache-control")).toMatch(/^public, max-age=60/);

    const second = await app.request("/events", { method: "GET" }, env);
    expect(second.status).toBe(200);
    // The hit serves before admission: no second throttle call.
    expect(throttleCalls).toBe(1);
    expect(await second.text()).toBe(firstBody);
  });
});
