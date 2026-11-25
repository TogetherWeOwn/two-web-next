import assert from "node:assert/strict";
import { withEnv } from "cloudflare:workers";
import { signedCookieHeader } from "../../src/http/signed-cookie.ts";
import { PRODUCTION_APEX } from "../../src/http/robots.ts";
import { STAGING_APP_URL } from "../../src/qa.ts";
import { SESSION_COOKIE } from "../../src/session-cookie.ts";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions.ts";
import { withThrottleTx } from "../../test/helpers/throttle-tx-double.ts";

const member = "900000000000001397";
const ip = "192.0.2.51";

// Loaded only by the loopback test entry. Neither renderer can reach Discord
// or a database, and both see the same in-memory sessions and OAuth journeys.
export function authFixtureWorker(inner) {
  const store = createMemorySessionStore();
  const hits = new Map();
  let exchanges = 0;
  let joinAttempts = 0;
  const sql = withThrottleTx(async (strings, bucket) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)")) return [{ n: hits.get(bucket) ?? 0, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits"))
      hits.set(bucket, (hits.get(bucket) ?? 0) + 1);
    if (query.includes("INSERT INTO join_attempts")) joinAttempts++;
    return [];
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://discord.com");
    if (request.method === "POST" && url.pathname === "/api/v10/oauth2/token") {
      exchanges++;
      assert.ok(new URLSearchParams(await request.text()).get("code") === "fixture-code");
      return Response.json({ access_token: "fixture-access" });
    }
    if (request.method === "GET" && url.pathname === "/api/v10/users/@me") {
      return Response.json({
        id: member,
        username: "Synthetic member",
        global_name: null,
        avatar: null,
      });
    }
    if (request.method === "PUT" && url.pathname.endsWith(`/members/${member}`))
      return new Response(null, { status: 204 });
    if (request.method === "GET" && url.pathname.endsWith("/widget.json"))
      return new Response(null, { status: 404 });
    throw new Error("Unexpected outbound auth fixture request");
  };

  return {
    async fetch(incoming, env, ctx) {
      const url = new URL(incoming.url);
      assert.equal(url.hostname, "127.0.0.1");
      if (incoming.method === "POST" && url.pathname === "/__fixture/auth-sessions") {
        const cookies = [];
        for (const userId of [member, member, "900000000000001399"]) {
          const token = newSessionToken();
          await store.create({
            userId,
            username: "Synthetic member",
            avatar: null,
            member: true,
            moderator: false,
            tokenHash: await hashToken(token),
            expiresAt: new Date(Date.now() + 60_000),
          });
          const header = await signedCookieHeader(SESSION_COOKIE, token, env.SESSION_SECRET);
          cookies.push(header.split(";", 1)[0]);
        }
        return Response.json(cookies);
      }
      const flag = incoming.headers.get("x-fixture-auth-flag") ?? "true";
      // Loopback transport with a synthetic HTTPS URL at the Worker boundary.
      const target = incoming.headers.get("x-fixture-auth-app");
      const appUrl =
        target === "staging"
          ? STAGING_APP_URL
          : target === "production"
            ? `https://${PRODUCTION_APEX}`
            : env.APP_URL;
      const canonical = new URL(appUrl);
      url.protocol = canonical.protocol;
      url.host = canonical.host;
      url.port = canonical.port;
      if (incoming.headers.has("x-fixture-foreign-host")) url.hostname = "foreign.example.test";
      const request = new Request(url, incoming);
      request.headers.set("host", url.host);
      request.headers.set("cf-connecting-ip", ip);
      if (request.headers.has("x-fixture-fill-logout-budget")) hits.set(`logout:${ip}`, 30);
      const unavailable = async () => {
        throw new Error("Synthetic revocation outage");
      };
      let issued;
      const bindings = {
        ...env,
        APP_URL: appUrl,
        DATABASE_URL: undefined,
        QA_AUTH_TOKEN: incoming.headers.get("x-fixture-qa-config") ?? undefined,
        KIT_ROUTE_AUTH: flag === "unset" ? undefined : flag,
        THROTTLE_STORE: async () => sql,
        JOIN_DEPS: { store: async () => sql },
        SESSION_STORE: {
          ...store,
          revokeUserSessions: request.headers.has("x-fixture-revoke-outage")
            ? unavailable
            : store.revokeUserSessions,
          async create(row) {
            await store.create(row);
            issued = `${row.userId}:${row.member}:${row.moderator}`;
          },
        },
        DISCORD_EVENTS: { upcoming: async () => [] },
      };
      const response = await withEnv(bindings, () => inner.fetch(request, bindings, ctx));
      const headers = new Headers(response.headers);
      headers.set("x-fixture-exchanges", String(exchanges));
      headers.set("x-fixture-join-attempts", String(joinAttempts));
      if (issued) headers.set("x-fixture-issued", issued);
      for (const bucket of ["login-callback", "events-read", "logout", "join", "qa-login"])
        headers.set(`x-fixture-${bucket}-hits`, String(hits.get(`${bucket}:${ip}`) ?? 0));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
