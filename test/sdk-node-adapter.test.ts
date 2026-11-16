import { readFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

async function withListener(listener: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    const timeout = AbortSignal.timeout(5_000);
    await Promise.race([
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<never>((_, reject) => {
        timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
      }),
    ]);
  }
}

describe("SDK Node adapter resolution", () => {
  it("handles an MCP initialization through the published Node transport", async () => {
    const rootRequire = createRequire(import.meta.url);
    const { Server } = rootRequire("@modelcontextprotocol/sdk/server/index.js");
    const { StreamableHTTPServerTransport } = rootRequire(
      "@modelcontextprotocol/sdk/server/streamableHttp.js",
    );
    const protocol = new Server(
      { name: "transport-fixture", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await protocol.connect(transport);
    try {
      await withListener(
        (request, response) => {
          void transport.handleRequest(request, response).catch((error: Error) => {
            response.destroy(error);
          });
        },
        async (url) => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "transport-client", version: "1.0.0" },
              },
            }),
            signal: AbortSignal.timeout(5_000),
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain("application/json");
          expect(await response.json()).toMatchObject({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "transport-fixture", version: "1.0.0" },
            },
          });
        },
      );
    } finally {
      await Promise.race([
        protocol.close(),
        new Promise<never>((_, reject) => {
          const timeout = AbortSignal.timeout(5_000);
          timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
        }),
      ]);
    }
  });

  it("loads the SDK's adapter and serves ordinary requests and a finite response stream", async () => {
    const rootRequire = createRequire(import.meta.url);
    const sdkEntry = rootRequire.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const sdkRequire = createRequire(sdkEntry);
    const sdkPackage = JSON.parse(
      readFileSync(join(dirname(sdkEntry), "..", "..", "..", "package.json"), "utf8"),
    );
    expect(sdkPackage.name).toBe("@modelcontextprotocol/sdk");
    expect(
      typeof sdkRequire("@modelcontextprotocol/sdk/server/streamableHttp.js")
        .StreamableHTTPServerTransport,
    ).toBe("function");
    const { getRequestListener } = sdkRequire("@hono/node-server");
    expect(typeof getRequestListener).toBe("function");

    await withListener(
      getRequestListener(async (request: Request) => {
        if (request.method === "POST") {
          const body = await request.text();
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode("received:"));
                controller.enqueue(encoder.encode(body));
                controller.close();
              },
            }),
          );
        }
        return Response.json({ method: request.method, path: new URL(request.url).pathname });
      }),
      async (url) => {
        const get = await fetch(`${url}/adapter-fixture`, { signal: AbortSignal.timeout(5_000) });
        expect(get.status).toBe(200);
        expect(await get.json()).toEqual({ method: "GET", path: "/adapter-fixture" });

        const post = await fetch(`${url}/adapter-fixture`, {
          method: "POST",
          body: "stream fixture",
          signal: AbortSignal.timeout(5_000),
        });
        expect(post.status).toBe(200);
        expect(await post.text()).toBe("received:stream fixture");
      },
    );
  });
});
