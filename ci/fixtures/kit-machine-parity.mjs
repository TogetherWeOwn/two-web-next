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

function checkMcpHeaders(response) {
  checkHeaders(response, 200, "text/event-stream");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.has("mcp-session-id"), false);
  assert.ok(response.body, "MCP returned a readable body while the tool was held");
}

async function checkMcpStream(post, cancelReader) {
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
    checkMcpHeaders(response);

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
      const read = (path, fixture) => {
        const bindings = { APP_URL, KIT_ROUTE_EVENT_MARKDOWN: "true", ...fixture };
        const input = new Request(new URL(path, APP_URL), {
          headers: { accept: "application/json", "if-none-match": "*" },
        });
        return withEnv(bindings, () => inner.fetch(input, bindings, ctx));
      };
      await checkAgentCreate(post);
      await checkMcpStream(post, false);
      await checkMcpStream(post, true);
      await checkMarkdownErrors(read, kit ? "kit" : null);
      return Response.json({
        agentCreate: 201,
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
    async fetch(request, _env, ctx) {
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
      const bindings = { APP_URL: url.origin, ADMIN_DB: adminDb };
      const response = await withEnv(bindings, () => inner.fetch(request, bindings, ctx));
      checkMcpHeaders(response);
      return response;
    },
  };
}
