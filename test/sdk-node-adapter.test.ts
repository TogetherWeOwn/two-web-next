import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

describe("SDK Node adapter resolution", () => {
  it("loads the patched adapter through the SDK and serves a request", async () => {
    const rootRequire = createRequire(import.meta.url);
    const sdkEntry = rootRequire.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const sdkRequire = createRequire(sdkEntry);
    const sdkPackage = JSON.parse(
      readFileSync(join(dirname(sdkEntry), "..", "..", "..", "package.json"), "utf8"),
    );
    expect(sdkPackage.name).toBe("@modelcontextprotocol/sdk");
    expect(sdkPackage.version).toBe("1.32.1");
    const adapterEntry = sdkRequire.resolve("@hono/node-server");
    const adapterPackage = JSON.parse(
      readFileSync(join(dirname(adapterEntry), "..", "package.json"), "utf8"),
    );
    expect(adapterPackage.version).toBe("2.1.8");
    expect(
      typeof sdkRequire("@modelcontextprotocol/sdk/server/streamableHttp.js")
        .StreamableHTTPServerTransport,
    ).toBe("function");

    const { getRequestListener } = sdkRequire("@hono/node-server");
    expect(typeof getRequestListener).toBe("function");
    let receivedFirstChunk!: () => void;
    const firstChunkReceived = new Promise<void>((resolve) => {
      receivedFirstChunk = resolve;
    });
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let responseCancelled!: () => void;
    const responseCancellation = new Promise<void>((resolve) => {
      responseCancelled = resolve;
    });
    let earlyBodyStarted!: () => void;
    const earlyBodyStart = new Promise<void>((resolve) => {
      earlyBodyStarted = resolve;
    });
    let earlyBodyFailed!: (failed: boolean) => void;
    const earlyBodyFailure = new Promise<boolean>((resolve) => {
      earlyBodyFailed = resolve;
    });
    const server = createServer(
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
                responseCancelled();
              },
            }),
          );
        }
        if (path === "/early-read") {
          if (!request.body) throw new Error("Expected a request body");
          const reader = request.body.getReader();
          await reader.read();
          earlyBodyStarted();
          try {
            await reader.read();
            earlyBodyFailed(false);
          } catch {
            earlyBodyFailed(true);
          }
          return new Response("finished");
        }
        if (path === "/stream") {
          if (!request.body) throw new Error("Expected a request body");
          const reader = request.body.getReader();
          const first = await reader.read();
          receivedFirstChunk();
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
                await responseReleased;
                controller.enqueue(encoder.encode(body));
                controller.close();
              },
            }),
          );
        }
        return Response.json({ method: request.method, path: new URL(request.url).pathname });
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const response = await fetch(`http://127.0.0.1:${address.port}/adapter-fixture`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ method: "GET", path: "/adapter-fixture" });
      const post = await fetch(`http://127.0.0.1:${address.port}/adapter-fixture`, {
        method: "POST",
        body: "stream fixture",
        signal: AbortSignal.timeout(5_000),
      });
      expect(post.status).toBe(200);
      if (!post.body) throw new Error("Expected a response body");
      const responseReader = post.body.getReader();
      const firstResponse = await responseReader.read();
      expect(new TextDecoder().decode(firstResponse.value)).toBe("received:");
      releaseResponse();
      const secondResponse = await responseReader.read();
      expect(new TextDecoder().decode(secondResponse.value)).toBe("stream fixture");
      expect((await responseReader.read()).done).toBe(true);

      const encoder = new TextEncoder();
      const streamingBody = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("first"));
          await firstChunkReceived;
          controller.enqueue(encoder.encode("second"));
          controller.close();
        },
      });
      const streamResponse = await fetch(`http://127.0.0.1:${address.port}/stream`, {
        method: "POST",
        body: streamingBody,
        duplex: "half",
        signal: AbortSignal.timeout(5_000),
      } as RequestInit & { duplex: "half" });
      expect(streamResponse.status).toBe(200);
      expect(await streamResponse.text()).toBe("firstsecond");

      const failedResponse = await fetch(`http://127.0.0.1:${address.port}/response-error`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(failedResponse.status).toBe(500);
      await failedResponse.body?.cancel();

      const timeout = AbortSignal.timeout(5_000);
      const timedOut = new Promise<never>((_, reject) => {
        timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
      });
      const cancelController = new AbortController();
      const cancelled = await fetch(`http://127.0.0.1:${address.port}/cancel`, {
        signal: AbortSignal.any([cancelController.signal, timeout]),
      });
      if (!cancelled.body) throw new Error("Expected a cancellable response body");
      const cancelReader = cancelled.body.getReader();
      expect(new TextDecoder().decode((await cancelReader.read()).value)).toBe("first");
      cancelController.abort();
      await Promise.race([responseCancellation, timedOut]);

      const interruptedTimeout = AbortSignal.timeout(5_000);
      const interruptedTimedOut = new Promise<never>((_, reject) => {
        interruptedTimeout.addEventListener("abort", () => reject(interruptedTimeout.reason), {
          once: true,
        });
      });
      const interrupted = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/early-read",
        method: "POST",
        headers: { "content-length": "100" },
      });
      const clientError = new Promise<Error>((resolve) => interrupted.once("error", resolve));
      try {
        interrupted.write("first");
        await Promise.race([earlyBodyStart, interruptedTimedOut]);
        interrupted.destroy();
        expect(await Promise.race([earlyBodyFailure, interruptedTimedOut])).toBe(true);
        expect(await Promise.race([clientError, interruptedTimedOut])).toBeInstanceOf(Error);
      } finally {
        interrupted.destroy();
      }
    } finally {
      receivedFirstChunk();
      releaseResponse();
      server.closeAllConnections();
      const closeTimeout = AbortSignal.timeout(5_000);
      await Promise.race([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<never>((_, reject) => {
          closeTimeout.addEventListener("abort", () => reject(closeTimeout.reason), { once: true });
        }),
      ]);
    }
  }, 35_000);
});
