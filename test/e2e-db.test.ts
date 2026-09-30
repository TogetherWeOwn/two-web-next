import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import app from "../src/index";
import { createPostgresSessionStore, hashToken, migrate, type Sql } from "../src/sessions";
import type { Env } from "../src/env";

const url = process.env.DATABASE_URL;
const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

// Full login → rotate → logout → replay flow against a real Postgres (agent-testdb
// locally; skipped in CI). The memory store proves the same contract in test/db.test.ts;
// this proves the wiring: callback writes a row, views rotate it, logout revokes it.
describe.skipIf(!url)("login/logout/rotation against Postgres", () => {
  const sql = postgres(url!, { max: 4 }) as unknown as Sql & { end: () => Promise<void> };

  const env: Env = {
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    DISCORD_MODERATOR_ROLE_IDS: "508654771276873729",
    SESSION_STORE: createPostgresSessionStore(sql),
  } as Env;

  beforeAll(async () => migrate(sql));
  afterAll(async () => sql.end());
  afterEach(async () => {
    vi.unstubAllGlobals();
    await sql`delete from web_sessions`;
  });

  it("sign-in writes a hashed row; views rotate it; logout revokes; replay is a guest", async () => {
    await migrate(sql);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: RequestInit) => {
        if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
        if (u.endsWith("/users/@me"))
          return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
        if (u.includes("/members/42") && (init as RequestInit)?.method === "PUT") return new Response(null, { status: 201 });
        if (u.includes("/members/42"))
          return Response.json({ roles: ["508654771276873729"], joined_at: "2024-01-01T00:00:00Z" });
        return new Response("unexpected", { status: 500 });
      }),
    );
    const start = await app.request("/auth/discord", {}, env);
    const location = new URL(start.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    const cb = await app.request(`/auth/discord/callback?code=abc&state=${state}`, {
      headers: { cookie: cookiesFrom(start) },
    }, env);
    expect(cb.headers.get("location")).toBe("/?n=joined");

    const firstCookie = cookiesFrom(cb);
    const count = await sql<{ n: string }[]>`select count(*)::text as n from web_sessions`;
    expect(count[0]!.n).toBe("1");

    const view1 = await app.request("/", { headers: { cookie: firstCookie } }, env);
    expect(await view1.text()).toContain("Rick");
    const secondCookie = cookiesFrom(view1);
    expect(secondCookie).not.toBe(firstCookie);

    const replay = await app.request("/", { headers: { cookie: firstCookie } }, env);
    expect(await replay.text()).toContain("Sign in with Discord");

    const out = await app.request("/logout", { method: "POST", headers: { cookie: secondCookie } }, env);
    expect(out.status).toBe(303);
    const afterLogout = await app.request("/", { headers: { cookie: secondCookie } }, env);
    expect(await afterLogout.text()).toContain("Sign in with Discord");

    // Only hashes on disk: no bearer token fragment is stored anywhere.
    const rows = await sql<{ token_hash: string }[]>`select token_hash from web_sessions`;
    for (const r of rows) expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken("two_probe")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("W15 QA login writes the 30-day expiry and an expired DB row cannot authenticate", async () => {
    const qaEnv = { ...env, APP_URL: "https://next.togetherweown.com", QA_AUTH_TOKEN: "test-only-qa-token" };
    const res = await app.request("/auth/qa/qa-member", { method: "POST", headers: { "X-TWO-QA-Auth": "test-only-qa-token" } }, qaEnv);
    expect(res.status).toBe(204);
    const rows = await sql<{ token_hash: string; user_id: string; lifetime: number }[]>`
      select token_hash, user_id, extract(epoch from (expires_at - created_at))::float8 as lifetime from web_sessions`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe("900000000000001396");
    expect(Math.abs(rows[0]!.lifetime - 30 * 24 * 60 * 60)).toBeLessThan(5);
    await sql`update web_sessions set expires_at = now() where token_hash = ${rows[0]!.token_hash}`;
    const expired = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, qaEnv);
    expect(await expired.text()).toContain("Sign in with Discord");
    expect(expired.headers.getSetCookie()).toHaveLength(0);
  });

  it("W15 concurrent DB rotation has one winner and creates no losing orphan row", async () => {
    const store = createPostgresSessionStore(sql);
    const original = {
      tokenHash: await hashToken("two_test_concurrent_original"), userId: "42", username: "Concurrent Member",
      avatar: null, member: true, moderator: false, expiresAt: new Date(Date.now() + 60_000),
    };
    await store.create(original);
    const results = await Promise.all(["a", "b"].map(async (suffix) => {
      const replacement = { ...original, tokenHash: await hashToken(`two_test_replacement_${suffix}`) };
      return store.rotate(original.tokenHash, replacement);
    }));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get(original.tokenHash)).toBeNull();
    const count = await sql<{ n: number }[]>`select count(*)::int as n from web_sessions`;
    expect(count[0]!.n).toBe(1);
  });
});
