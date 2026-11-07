import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

describe("fixed SSR clock in a local Worker", () => {
  for (const localBuild of [false, true]) {
    it(`requires the local build gate on the real loopback socket (${localBuild})`, async () => {
      const bundle = await build({
        stdin: {
          contents:
            'import app from "./src/index"; export default { fetch: (req, env, ctx) => app.fetch(req, env, ctx) };',
          resolveDir: process.cwd(),
          loader: "ts",
        },
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        conditions: ["workerd", "worker", "browser"],
        external: ["node:*", "cloudflare:*"],
        ...(localBuild ? { define: { __TWO_LOCAL_CAPTURE__: "true" } } : {}),
      });
      const options = {
        modules: true,
        script: bundle.outputFiles![0]!.text,
        compatibilityDate: "2026-09-29",
        compatibilityFlags: ["nodejs_compat"],
        host: "127.0.0.1",
        port: 0,
        outboundService: async () => {
          throw new Error("Capture clock test forbids outbound network");
        },
      };
      const worker = new Miniflare(convertV4MiniflareOptions(options));
      try {
        const origin = (await worker.ready).origin;
        await worker.setOptions(
          convertV4MiniflareOptions({
            ...options,
            bindings: { APP_URL: origin, SSR_CAPTURE_FIXTURE: "true" },
          }),
        );
        const local = await fetch(new URL("/faq", await worker.ready));
        expect(local.status).toBe(200);
        expect(local.headers.get("x-two-ssr-clock")).toBe(
          localBuild ? "2098-12-31T20:00:00Z" : null,
        );
        const remote = await worker.dispatchFetch(
          "https://example.test/faq?SSR_CAPTURE_FIXTURE=true",
          {
            headers: {
              host: new URL(origin).host,
              origin,
              "x-forwarded-host": new URL(origin).host,
              cookie: "SSR_CAPTURE_FIXTURE=true",
            },
          },
        );
        expect(remote.headers.has("x-two-ssr-clock")).toBe(false);
      } finally {
        await worker.dispose();
      }
    });
  }
});
