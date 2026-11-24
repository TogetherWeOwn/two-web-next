import assert from "node:assert/strict";
import { withEnv } from "cloudflare:workers";
import { makeFakeAgentDb } from "../../test/helpers/fake-agent-ingress-db.ts";
import {
  agentCaller,
  agentCreate,
  agentCredential,
  mcpListEventsArgs,
  mcpToolCall,
} from "../../test/helpers/machine-requests.ts";

const ulid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function checkHeaders(response, status, mediaType) {
  assert.equal(response.status, status, `${mediaType} status`);
  const headers = response.headers;
  assert.equal(headers.get("content-type")?.split(";")[0], mediaType);
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.has("set-cookie"), false);
  assert.ok(headers.get("x-request-id"), "machine response has a request id");
}

async function checkAgentCreate(post) {
  const db = makeFakeAgentDb();
  const guild = "123456789012345678";
  await db.addGrant(agentCredential, {
    id: "fixture-grant",
    agent_id: agentCaller,
    guild_id: guild,
    expires_at: null,
    disabled_at: null,
  });
  const response = await post(
    "/api/agent-events",
    agentCreate,
    { authorization: `Bearer ${agentCredential}` },
    {
      AGENT_EVENT_SQL: db.sql,
      AGENT_EVENTS_ENABLED: "true",
      AGENT_EVENTS_CALLER_AGENT_ID: agentCaller,
      AGENT_EVENTS_GUILD_ID: guild,
    },
  );
  checkHeaders(response, 201, "application/json");
  const { event_key, proof_marker, request_id, ...body } = await response.json();
  assert.match(event_key, ulid);
  assert.ok(proof_marker.startsWith("agent-proof-"));
  assert.match(proof_marker.slice("agent-proof-".length), ulid);
  assert.match(request_id, ulid);
  assert.deepEqual(body, { status: "draft", agent_version: 1 });
}

async function checkMcpStream(post, disconnect) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const adminDb = {
    // Hold the published-event count at the existing in-process Db seam.
    select(fields) {
      return {
        from: () => ({
          where: () => {
            if (!fields) return { orderBy: () => ({ limit: () => ({ offset: async () => [] }) }) };
            assert.deepEqual(Object.keys(fields), ["n"]);
            entered.resolve();
            return release.promise.then(() => [{ n: 0 }]);
          },
        }),
      };
    },
  };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("MCP SSE did not open or close before deadline")),
      5_000,
    );
  });
  const id = disconnect ? 92 : 91;
  let reader;
  try {
    const [response] = await Promise.race([
      deadline,
      Promise.all([
        post(
          "/mcp",
          mcpToolCall("list_events", mcpListEventsArgs, id),
          { accept: "application/json, text/event-stream" },
          { ADMIN_DB: adminDb },
        ),
        entered.promise,
      ]),
    ]);
    checkHeaders(response, 200, "text/event-stream");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(response.headers.has("mcp-session-id"), false);
    assert.ok(response.body, "MCP returned a readable body while the tool was held");

    if (disconnect) {
      reader = response.body.getReader();
      await Promise.race([deadline, reader.cancel("synthetic client disconnect")]);
      assert.deepEqual(await reader.read(), { done: true, value: undefined });
      return;
    }

    release.resolve();
    // Reading to EOF proves the server closes its response after the result.
    const wire = await Promise.race([deadline, response.text()]);
    const frame = /^event: message\r?\ndata: (.+)\r?\n\r?\n$/.exec(wire);
    assert.ok(frame, "MCP sent exactly one complete SSE message");
    const message = JSON.parse(frame[1]);
    const payload = {
      data: [],
      page: 1,
      limit: 20,
      meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
    };
    assert.deepEqual(message, {
      jsonrpc: "2.0",
      id,
      result: {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      },
    });
  } finally {
    clearTimeout(timer);
    release.resolve();
    reader?.releaseLock();
  }
}

// This wrapper exists only in the loopback test. Run the probes in the same
// Worker invocation to hold the tool result and read or cancel the real body.
export function machineParityWorker(inner, probePath) {
  return {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname !== probePath) return inner.fetch(request, env, ctx);
      const { APP_URL } = env;
      const post = (path, body, headers, fixture) => {
        const url = new URL(path, APP_URL);
        const input = new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", host: url.host, ...headers },
          body: JSON.stringify(body),
        });
        const bindings = { APP_URL, ...fixture };
        return withEnv(bindings, () => inner.fetch(input, bindings, ctx));
      };
      await checkAgentCreate(post);
      await checkMcpStream(post, false);
      await checkMcpStream(post, true);
      return Response.json({ agentCreate: 201, mcpComplete: "eof", mcpDisconnect: "cancelled" });
    },
  };
}
