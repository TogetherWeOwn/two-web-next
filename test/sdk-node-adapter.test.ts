import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

describe("SDK Node adapter resolution", () => {
  it("loads the patched adapter through the SDK and serves a request", async () => {
    const rootRequire = createRequire(import.meta.url);
    const sdkEntry = rootRequire.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const sdkRequire = createRequire(sdkEntry);
    const adapterEntry = sdkRequire.resolve("@hono/node-server");
    const adapterPackage = JSON.parse(
      readFileSync(join(dirname(adapterEntry), "..", "package.json"), "utf8"),
    );
    expect(adapterPackage.version).toBe("2.1.6");
    expect(
      typeof sdkRequire("@modelcontextprotocol/sdk/server/streamableHttp.js")
        .StreamableHTTPServerTransport,
    ).toBe("function");

    const { getRequestListener } = sdkRequire("@hono/node-server");
    expect(typeof getRequestListener).toBe("function");
    const server = createServer(
      getRequestListener((request: Request) =>
        Response.json({ method: request.method, path: new URL(request.url).pathname }),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const response = await fetch(`http://127.0.0.1:${address.port}/adapter-fixture`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ method: "GET", path: "/adapter-fixture" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
