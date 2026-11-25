import assert from "node:assert/strict";
import { withEnv } from "cloudflare:workers";
import { BODY_LIMIT_BYTES } from "../../src/http/body-limit.ts";
import { makeFakeAgentDb } from "../../test/helpers/fake-agent-ingress-db.ts";
import {
  agentCaller,
  agentCreate,
  agentCredential,
  mcpListEventsArgs,
  mcpToolCall,
} from "../../test/helpers/machine-requests.ts";
import { withThrottleTx } from "../../test/helpers/throttle-tx-double.ts";
import { FIXTURE_SECRETS, identityCookies } from "../parity/fixture.mjs";

const ulid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const renderer = "x-two-renderer";
const rpcHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

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

function eventDb(readCount) {
  return {
    select(fields) {
      return {
        from: () => ({
          where: () => {
            if (!fields) return { orderBy: () => ({ limit: () => ({ offset: async () => [] }) }) };
            assert.deepEqual(Object.keys(fields), ["n"]);
            return readCount().then(() => [{ n: 0 }]);
          },
        }),
      };
    },
  };
}

function checkMcpHeaders(response, owner) {
  checkHeaders(response, 200, "text/event-stream");
  assert.equal(response.headers.get(renderer), owner);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.has("mcp-session-id"), false);
  assert.ok(response.body, "MCP returned a readable body while the tool was held");
}

async function checkMcpStream(post, owner, cancelReader) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const adminDb = eventDb(() => {
    entered.resolve();
    return release.promise;
  });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("MCP SSE did not open or close before deadline")),
      5_000,
    );
  });
  const id = cancelReader ? 92 : 91;
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
    checkMcpHeaders(response, owner);

    if (cancelReader) {
      reader = response.body.getReader();
      await Promise.race([deadline, reader.cancel("in-Worker reader cancellation")]);
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

async function checkMcpRefusal(response, owner, status, message) {
  checkHeaders(response, status, "application/json");
  assert.equal(response.headers.get(renderer), owner);
  const envelope = await response.json();
  assert.equal(envelope.jsonrpc, "2.0");
  assert.equal(envelope.id, null);
  assert.equal(envelope.error.code, -32600);
  assert.ok(envelope.error.message.startsWith(message));
  assert.equal(envelope.error.data.request_id, response.headers.get("x-request-id"));
}

async function checkMcpAdmission(send, owner, appUrl) {
  const endpoint = "/mcp";
  const call = JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/list" });
  const post = (body, headers, bindings) =>
    send(endpoint, { method: "POST", headers: { ...rpcHeaders, ...headers }, body }, bindings);
  const anonymous = await post(call);
  checkMcpHeaders(anonymous, owner);
  const list = await anonymous.text();
  const frame = /^event: message\r?\ndata: (.+)\r?\n\r?\n$/.exec(list);
  assert.ok(frame, "MCP sent a tool list in one SSE message");
  assert.deepEqual(
    JSON.parse(frame[1])
      .result.tools.map(({ name }) => name)
      .sort(),
    ["get_community", "get_event", "get_join", "list_events"],
  );

  const { SESSION_SECRET } = FIXTURE_SECRETS;
  const { moderator: cookie } = await identityCookies();
  let sessionReads = 0;
  const credentialed = await post(
    call,
    { cookie, authorization: "Bearer synthetic-mcp-fixture", origin: "http://localhost:6274" },
    {
      SESSION_SECRET,
      SESSION_STORE: {
        async get() {
          sessionReads++;
          return null;
        },
      },
    },
  );
  checkMcpHeaders(credentialed, owner);
  assert.equal(await credentialed.text(), list);
  assert.equal(sessionReads, 0, "credentials never reach the session store");

  const preflight = await send(endpoint, {
    method: "OPTIONS",
    headers: { origin: "http://localhost:6274", "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get(renderer), owner);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, DELETE, OPTIONS");
  assert.equal(await preflight.text(), "");

  const foreign = { origin: "https://foreign.example.test" };
  for (const response of [
    await post(call, foreign),
    await send(endpoint, { method: "OPTIONS", headers: foreign }),
  ]) {
    checkHeaders(response, 403, "application/json");
    assert.equal(response.headers.get(renderer), owner);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Invalid Origin: foreign.example.test" },
    });
  }

  for (const [method, path, status, headers] of [
    ["GET", endpoint, 404],
    ["HEAD", endpoint, 404],
    ["DELETE", endpoint, 403, foreign],
    ["PUT", endpoint, 404, { origin: appUrl }],
    ["POST", "/mcp/", 404, { origin: appUrl }],
    ["POST", "/mcp/__data.json", 404, { origin: appUrl }],
    ["POST", "/m%63p", 404, { origin: appUrl }],
    ["POST", endpoint, 404, { host: "foreign.example.test" }],
  ]) {
    const response = await send(path, { method, headers });
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(response.headers.get(renderer), null, `${method} ${path} stays with Hono`);
    await response.body?.cancel();
  }

  const brokenUpload = new ReadableStream({
    pull(controller) {
      controller.error(new Error("synthetic MCP upload failure"));
    },
  });
  for (const [body, headers, status, message] of [
    ["{}", { "content-length": String(BODY_LIMIT_BYTES.mcp + 1) }, 413, "Reduce the size"],
    [" ".repeat(BODY_LIMIT_BYTES.mcp + 1), {}, 413, "Reduce the size"],
    [brokenUpload, {}, 400, "Check your request"],
    ["[]", {}, 400, "Invalid Request: batched requests"],
  ]) {
    await checkMcpRefusal(await post(body, headers), owner, status, message);
  }

  let budgetReads = 0;
  const budgetBuckets = [];
  const budgetHeaders = { "cf-connecting-ip": "192.0.2.180" };
  const spentBudget = {
    async THROTTLE_STORE() {
      budgetReads++;
      return withThrottleTx(async (strings, bucket) => {
        const statement = strings.join("?");
        if (statement.includes("SELECT count(*)")) {
          budgetBuckets.push(bucket);
          return [{ n: 60, wait: 37 }];
        }
        if (statement.includes("DELETE FROM web_throttle_hits")) return [];
        throw new Error("Unexpected MCP budget fixture statement");
      });
    },
  };
  const overCap = await post(" ".repeat(BODY_LIMIT_BYTES.mcp + 1), budgetHeaders, spentBudget);
  await checkMcpRefusal(overCap, owner, 413, "Reduce the size");
  assert.equal(budgetReads, 0, "the body cap runs before budget admission");
  const refused = await post("[]", budgetHeaders, spentBudget);
  assert.equal(refused.headers.get("retry-after"), "37");
  await checkMcpRefusal(refused, owner, 429, "Too many requests. Try again in 37 seconds.");
  assert.equal(budgetReads, 1, "budget admission runs before batch refusal");
  assert.deepEqual(budgetBuckets, ["events-read:192.0.2.180"], "MCP shares the public read bucket");
}

async function checkMarkdownErrors(read, expectedOwner) {
  const detail = "/e/01J0000000000000000000A001.md";
  for (const path of ["/events.md", detail]) {
    for (const [status, body, fixture] of [
      [
        500,
        "Events temporarily unavailable. Try again shortly.",
        {
          ADMIN_DB: {
            select() {
              throw new Error("synthetic Markdown query fault");
            },
          },
        },
      ],
      [503, "Events temporarily unavailable", {}],
    ]) {
      const response = await read(path, fixture);
      checkHeaders(response, status, "text/markdown");
      assert.equal(response.headers.get("x-two-renderer"), expectedOwner);
      assert.equal(response.headers.get("cache-control"), "no-store, private");
      assert.equal(response.headers.get("etag"), null);
      assert.equal(response.headers.get("vary"), null);
      assert.equal(await response.text(), body);
    }
  }
}

// This wrapper exists only in the loopback test. Run the probes in the same
// Worker invocation to hold the tool result and read or cancel the real body.
export function machineParityWorker(inner, probePath, kit) {
  return {
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname !== probePath) return inner.fetch(request, env, ctx);
      const { APP_URL } = env;
      const send = (path, init, fixture) => {
        const url = new URL(path, APP_URL);
        const input = new Request(url, {
          ...init,
          headers: { host: url.host, ...init.headers },
          duplex: "half",
        });
        const bindings = { APP_URL, ...fixture };
        return withEnv(bindings, () => inner.fetch(input, bindings, ctx));
      };
      const post = (path, body, headers, fixture) =>
        send(
          path,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          },
          fixture,
        );
      const read = (path, fixture) => {
        const bindings = { APP_URL, KIT_ROUTE_EVENT_MARKDOWN: "true", ...fixture };
        const input = new Request(new URL(path, APP_URL), {
          headers: { accept: "application/json", "if-none-match": "*" },
        });
        return withEnv(bindings, () => inner.fetch(input, bindings, ctx));
      };
      await checkAgentCreate(post);
      const mcpPost = (path, body, headers, fixture) =>
        post(path, body, headers, { ...fixture, KIT_ROUTE_MCP: "true" });
      const owner = kit ? "kit" : null;
      await checkMcpAdmission(
        (path, init, fixture) => send(path, init, { ...fixture, KIT_ROUTE_MCP: "true" }),
        owner,
        APP_URL,
      );
      await checkMcpStream(mcpPost, owner, false);
      await checkMcpStream(mcpPost, owner, true);
      if (kit) {
        await checkMcpStream(post, null, false);
        for (const flag of ["false", "TRUE"]) {
          const off = await send("/mcp", { method: "OPTIONS" }, { KIT_ROUTE_MCP: flag });
          assert.equal(off.status, 200);
          assert.equal(off.headers.get("access-control-allow-origin"), "*");
          assert.equal(off.headers.get(renderer), null);
          await off.text();
        }
      }
      await checkMarkdownErrors(read, kit ? "kit" : null);
      return Response.json({
        agentCreate: 201,
        mcpAdmission: "verified",
        mcpComplete: "eof",
        mcpReaderCancel: "cancelled",
        eventMarkdownErrors: [500, 503],
      });
    },
  };
}

// Only the direct loopback listener uses this entry. The control request reads
// observations from the same isolate after the MCP client's socket has closed.
export function machineDisconnectWorker(inner, probePath) {
  const events = [];
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      assert.equal(url.hostname, "127.0.0.1");
      if (request.method === "GET" && url.pathname === probePath) return Response.json(events);
      if (request.method !== "POST" || url.pathname !== "/mcp" || events.length) {
        return new Response(null, { status: 404 });
      }
      const signal = request.signal;
      assert.equal(signal.aborted, false, "incoming request starts live");
      const adminDb = eventDb(() => {
        const release = Promise.withResolvers();
        const onAbort = () => {
          events.push("incoming-abort");
          release.resolve(signal.aborted ? "abort" : "abort-event-with-live-signal");
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => release.resolve("deadline"), 12_000);
        events.push("read-held");
        const read = release.promise.then((reason) => {
          events.push(`read-settled:${reason}`);
        });
        ctx.waitUntil(
          read.then(() => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            events.push("waitUntil-cleanup");
          }),
        );
        return read;
      });
      const flag = env.KIT_ROUTE_MCP;
      const bindings = { APP_URL: url.origin, ADMIN_DB: adminDb, KIT_ROUTE_MCP: flag };
      const response = await withEnv(bindings, () => inner.fetch(request, bindings, ctx));
      checkMcpHeaders(response, flag === "true" ? "kit" : null);
      return response;
    },
  };
}
