import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

async function withListener(
  listener: Parameters<typeof createServer>[0],
  run: (url: string) => Promise<void>,
) {
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
