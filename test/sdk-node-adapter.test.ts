import { readFileSync } from "node:fs";
import { createServer, type RequestListener, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

describe("SDK Node adapter candidate", () => {
  it("loads the patched adapter through the SDK and serves a request", async () => {
    const rootRequire = createRequire(import.meta.url);
    const sdkEntry = rootRequire.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const sdkRequire = createRequire(sdkEntry);
    const sdkPackage = JSON.parse(
      readFileSync(join(dirname(sdkEntry), "..", "..", "..", "package.json"), "utf8"),
    );
    expect(sdkPackage.version).toBe("1.32.2");
    const adapterEntry = sdkRequire.resolve("@hono/node-server");
    const adapterPackage = JSON.parse(
      readFileSync(join(dirname(adapterEntry), "..", "package.json"), "utf8"),
    );
    expect(adapterPackage.version).toBe("2.1.8");
    const { getRequestListener } = sdkRequire("@hono/node-server");
    const firstChunk = deferred<void>();
    const responseRelease = deferred<void>();
    const responseCancellation = deferred<void>();
    const earlyBodyStart = deferred<void>();
    const earlyBodyFailure = deferred<boolean>();
    await withListener(
      getRequestListener(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/response-error") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("fixture response failure"));
              },
            }),
          );
        }
        if (path === "/cancel") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
              },
              cancel() {
                responseCancellation.resolve();
              },
            }),
          );
        }
        if (path === "/early-read") {
          if (!request.body) throw new Error("Expected a request body");
          const reader = request.body.getReader();
          await reader.read();
          earlyBodyStart.resolve();
          try {
            await reader.read();
            earlyBodyFailure.resolve(false);
          } catch {
            earlyBodyFailure.resolve(true);
          }
          return new Response("finished");
        }
        if (path === "/stream") {
          if (!request.body) throw new Error("Expected a request body");
          const reader = request.body.getReader();
          const first = await reader.read();
          firstChunk.resolve();
          const decoder = new TextDecoder();
          let body = decoder.decode(first.value, { stream: true });
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            body += decoder.decode(chunk.value, { stream: true });
          }
          return new Response(body + decoder.decode());
        }
        if (request.method === "POST") {
          const body = await request.text();
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(encoder.encode("received:"));
                await responseRelease.promise;
                controller.enqueue(encoder.encode(body));
                controller.close();
              },
            }),
          );
        }
        return Response.json({ method: request.method, path: new URL(request.url).pathname });
      }),
      async (url) => {
        try {
          const post = await fetch(`${url}/adapter-fixture`, {
            method: "POST",
            body: "stream fixture",
            signal: AbortSignal.timeout(5_000),
          });
          expect(post.status).toBe(200);
          if (!post.body) throw new Error("Expected a response body");
          const responseReader = post.body.getReader();
          const firstResponse = await responseReader.read();
          expect(new TextDecoder().decode(firstResponse.value)).toBe("received:");
          responseRelease.resolve();
          const secondResponse = await responseReader.read();
          expect(new TextDecoder().decode(secondResponse.value)).toBe("stream fixture");
          expect((await responseReader.read()).done).toBe(true);

          const encoder = new TextEncoder();
          const streamingBody = new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode("first"));
              await firstChunk.promise;
              controller.enqueue(encoder.encode("second"));
              controller.close();
            },
          });
          const streamResponse = await fetch(`${url}/stream`, {
            method: "POST",
            body: streamingBody,
            duplex: "half",
            signal: AbortSignal.timeout(5_000),
          } as RequestInit & { duplex: "half" });
          expect(streamResponse.status).toBe(200);
          expect(await streamResponse.text()).toBe("firstsecond");

          const responseErrorTimeout = AbortSignal.timeout(5_000);
          const failedResponse = await fetch(`${url}/response-error`, {
            signal: responseErrorTimeout,
          });
          expect(failedResponse.status).toBe(200);
          const errorBody = await failedResponse.text().then(
            (body) => ({ body }),
            (error: unknown) => ({ error }),
          );
          expect(responseErrorTimeout.aborted).toBe(false);
          if ("error" in errorBody) {
            // The adapter may destroy the socket after headers have been sent.
            expect(errorBody.error).toBeInstanceOf(TypeError);
            console.info("Adapter response error: socket reset after headers");
          } else {
            expect(errorBody.body).toBe("Error: fixture response failure");
            console.info("Adapter response error: error body received");
          }

          const timeout = AbortSignal.timeout(5_000);
          const timedOut = new Promise<never>((_, reject) => {
            timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
          });
          const cancelController = new AbortController();
          const cancelled = await fetch(`${url}/cancel`, {
            signal: AbortSignal.any([cancelController.signal, timeout]),
          });
          if (!cancelled.body) throw new Error("Expected a cancellable response body");
          const cancelReader = cancelled.body.getReader();
          expect(new TextDecoder().decode((await cancelReader.read()).value)).toBe("first");
          cancelController.abort();
          await Promise.race([responseCancellation.promise, timedOut]);

          const interruptedTimeout = AbortSignal.timeout(5_000);
          const interruptedTimedOut = new Promise<never>((_, reject) => {
            interruptedTimeout.addEventListener("abort", () => reject(interruptedTimeout.reason), {
              once: true,
            });
          });
          const interrupted = httpRequest({
            hostname: "127.0.0.1",
            port: Number(new URL(url).port),
            path: "/early-read",
            method: "POST",
            headers: { "content-length": "100" },
          });
          const clientError = new Promise<Error>((resolve) => interrupted.once("error", resolve));
          try {
            interrupted.write("first");
            await Promise.race([earlyBodyStart.promise, interruptedTimedOut]);
            interrupted.destroy();
            expect(await Promise.race([earlyBodyFailure.promise, interruptedTimedOut])).toBe(true);
            expect(await Promise.race([clientError, interruptedTimedOut])).toBeInstanceOf(Error);
          } finally {
            interrupted.destroy();
          }
        } finally {
          firstChunk.resolve();
          responseRelease.resolve();
        }
      },
    );
  }, 35_000);
});
