import assert from "node:assert/strict";
import { withEnv } from "cloudflare:workers";
import { makeFakeAgentDb } from "../../test/helpers/fake-agent-ingress-db.ts";
import { agentCaller, agentCreate, agentCredential } from "../../test/helpers/machine-requests.ts";

const path = "/api/agent-events";
const requestId = "0123456789abcdef-IAD";
const ulid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const guild = "123456789012345678";
const grantId = "fixture-grant";
const authorization = `Bearer ${agentCredential}`;

async function verifyAgentEvents(inner, { APP_URL }, ctx) {
  let dispatches = 0;
  function blockDispatch() {
    dispatches++;
    throw new Error("Unexpected outbound agent event fixture dispatch");
  }
  const queue = { send: blockDispatch, sendBatch: blockDispatch };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = blockDispatch;
  try {
    const bindings = {
      APP_URL,
      AGENT_EVENTS_ENABLED: "true",
      AGENT_EVENTS_CALLER_AGENT_ID: agentCaller,
      AGENT_EVENTS_GUILD_ID: guild,
      SYNC_EVENT_QUEUE: queue,
      INTERNAL_ACTION_QUEUE: queue,
      BOT_ENDPOINT_URL: "https://agent-events-fixture.invalid",
      BOT_KEY_ID: "fixture-only",
      BOT_SHARED_SECRET: "synthetic-agent-events-fixture",
    };
    const send = async (flag, status, options = {}) => {
      const { method = "POST", target = path, body, headers, overrides, db } = options;
      const input = new Request(new URL(target, APP_URL), {
        method,
        headers: {
          accept: "application/json",
          "cf-ray": requestId,
          "content-type": "application/json",
          ...headers,
        },
        body,
      });
      const env = { ...bindings, AGENT_EVENT_SQL: db?.sql, ...overrides };
      if (flag !== undefined) env.KIT_ROUTE_AGENT_EVENTS = flag;
      const response = await withEnv(env, () => inner.fetch(input, env, ctx));
      const label = `${method} ${target} (${flag ?? "unset"})`;
      assert.equal(response.status, status, label);
      assert.equal(
        response.headers.get("x-two-renderer"),
        flag === "true" && method === "POST" && target === path ? "kit" : null,
        label,
      );
      assert.equal(response.headers.get("x-request-id"), requestId, label);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
      assert.equal(response.headers.has("set-cookie"), false, label);
      assert.equal(response.headers.has("access-control-allow-origin"), false, label);
      return response;
    };
    const json = async (flag, status, options, cache = "no-store") => {
      const response = await send(flag, status, options);
      assert.match(response.headers.get("content-type"), /^application\/json(?:;|$)/);
      assert.equal(response.headers.get("cache-control"), cache);
      const body = await response.json();
      if (status === 429) {
        assert.ok(Number.isInteger(body.retry_after) && body.retry_after > 0);
        assert.equal(response.headers.get("retry-after"), String(body.retry_after));
      } else {
        assert.equal(response.headers.has("retry-after"), false);
      }
      return body;
    };
    function checkDenial(body, reason, correlation = ulid) {
      assert.equal(body.code, reason);
      assert.equal(body.reason, reason);
      assert.match(body.request_id, correlation);
      assert.ok(body.message);
      assert.ok(body.next);
    }
    const edgeId = /^0123456789abcdef-IAD$/;
    const payload = JSON.stringify(agentCreate);
    const authorized = { body: payload, headers: { authorization } };
    const disabled = { AGENT_EVENTS_ENABLED: "false" };
    for (const flag of [undefined, "false", "1", "TRUE", "true"]) {
      checkDenial(
        await json(flag, 404, { ...authorized, overrides: disabled }),
        "ingress_disabled",
        edgeId,
      );
    }

    for (const flag of [undefined, "true"]) {
      for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
        const refused = await send(flag, 404, { method, headers: { origin: APP_URL } });
        if (method === "HEAD") assert.equal(await refused.text(), "");
        else await refused.body?.cancel();
      }
      const crossOrigin = await send(flag, 403, {
        method: "PUT",
        headers: { origin: "https://foreign.example.test" },
      });
      await crossOrigin.body?.cancel();
      for (const target of [`${path}/`, "/api/%61gent-events", `${path}/__data.json`]) {
        const alias = await send(flag, 404, {
          target,
          body: payload,
          headers: { origin: APP_URL, authorization },
          overrides: disabled,
        });
        await alias.body?.cancel();
      }

      const db = makeFakeAgentDb();
      await db.addGrant(agentCredential, {
        id: grantId,
        agent_id: agentCaller,
        guild_id: guild,
        expires_at: null,
        disabled_at: null,
      });
      checkDenial(await json(flag, 503, authorized), "ingress_unavailable", edgeId);
      for (const [body, length] of [
        [payload, "32769"],
        ["x".repeat(32769), "1"],
      ]) {
        const refusal = await json(
          flag,
          413,
          { db, body, headers: { authorization, "content-length": length } },
          "no-store, private",
        );
        assert.equal(refusal.reason, "payload_too_large");
        assert.equal(refusal.request_id, requestId);
      }
      assert.equal(db.hits.length, 0, "byte limits run before admission");

      checkDenial(
        await json(flag, 401, {
          db,
          body: payload,
          headers: { authorization: "Bearer unknown-fixture-credential" },
        }),
        "unauthenticated",
      );
      assert.equal(db.audits.length, 0, "unknown credentials leave no audit row");
      checkDenial(
        await json(flag, 422, { db, body: "{", headers: { authorization } }),
        "validation_failed",
      );
      assert.equal(db.audits.at(-1)?.reason, "validation_failed");

      const { request_id, event_key, proof_marker, ...draft } = await json(flag, 201, {
        db,
        ...authorized,
        headers: { authorization, origin: "https://foreign.example.test" },
      });
      assert.match(request_id, ulid);
      assert.match(event_key, ulid);
      assert.match(proof_marker, /^agent-proof-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      assert.deepEqual(draft, { status: "draft", agent_version: 1 });
      assert.equal(db.audits.at(-1)?.result, "ok");

      db.prespend(`mutating:${grantId}`, 10);
      const hitsBeforeReplay = db.hits.length;
      const other = flag === "true" ? undefined : "true";
      const replay = await json(other, 201, { db, ...authorized });
      assert.match(replay.request_id, ulid);
      assert.notEqual(replay.request_id, request_id);
      assert.deepEqual(replay, {
        ...draft,
        event_key,
        proof_marker,
        request_id: replay.request_id,
        replayed: true,
      });
      assert.equal(db.hits.length, hitsBeforeReplay + 1, "replay spends only the shield hit");
      assert.equal(db.audits.at(-1)?.result, "replayed");

      const newBody = JSON.stringify({ ...agentCreate, idempotency_key: "other-fixture-key" });
      checkDenial(await json(flag, 429, { db, ...authorized, body: newBody }), "rate_limited");
      const hitsBeforeShield = db.hits.length;
      checkDenial(
        await json(flag, 429, {
          db,
          ...authorized,
          overrides: { AGENT_EVENTS_ROUTE_PER_MINUTE: "1" },
        }),
        "rate_limited",
      );
      assert.equal(db.hits.length, hitsBeforeShield, "spent shield refuses before inserting a hit");
    }
    return { draftOwners: ["hono", "kit"], replayedBothWays: true, dispatches };
  } finally {
    globalThis.fetch = originalFetch;
    assert.equal(dispatches, 0, "draft, replay and refusals never dispatch");
  }
}

export function agentEventsFixtureWorker(inner, probePath) {
  return {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === probePath) {
        return Response.json(await verifyAgentEvents(inner, env, ctx));
      }
      return inner.fetch(request, env, ctx);
    },
  };
}
