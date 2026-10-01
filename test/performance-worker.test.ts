import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, type Request as WorkerRequest } from "miniflare";
import { auditPaths, fixtureKey } from "../ci/lighthouse-paths";

// Node does not reproduce workerd's epoch clock during module evaluation.
// Bundle the actual Lighthouse wrapper and exercise it in the Workers runtime.
describe("Lighthouse fixture in Miniflare", () => {
  let mf: Miniflare;
  const outbound: string[] = [];

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["ci/lighthouse-worker.ts"], bundle: true, write: false, format: "esm",
      platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:*"],
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: bundle.outputFiles![0]!.text,
      compatibilityDate: "2026-09-29", compatibilityFlags: ["nodejs_compat"],
      outboundService: async (request: WorkerRequest) => {
        outbound.push(request.url);
        throw new Error("Outbound network forbidden by Lighthouse fixture");
      },
      bindings: {
        DATABASE_URL: "postgres://must-not-connect.invalid/forbidden",
        DISCORD_BOT_TOKEN: "must-not-use",
      },
    }));
    await mf.ready;
  }, 30_000);
  afterAll(async () => { await mf?.dispose(); });

  it("renders future dates on both populated event pages without outbound access", async () => {
    for (const path of ["/events", `/e/${fixtureKey}`]) {
      const before = Date.now();
      const response = await mf.dispatchFetch(`http://127.0.0.1:8787${path}`);
      const html = await response.text();
      const after = Date.now();
      expect(response.status, path).toBe(200);
      expect(html).toContain("Lighthouse fixture game night");
      const times = [...html.matchAll(/<time\b[^>]*datetime="([^"]+)"/g)];
      expect(times.length, path).toBeGreaterThan(0);
      for (const [, instant] of times) {
        const startsAt = Date.parse(instant!);
        expect(startsAt, `${path}: ${instant}`).toBeGreaterThanOrEqual(before + 7 * 86400_000);
        expect(startsAt, `${path}: ${instant}`).toBeLessThanOrEqual(after + 7 * 86400_000);
      }
    }
    expect(outbound).toEqual([]);
  });

  it("serves every audit page and refuses nonfixture routes in workerd", async () => {
    for (const path of auditPaths) {
      expect((await mf.dispatchFetch(`http://127.0.0.1:8787${path}`)).status, path).toBe(200);
    }
    expect((await mf.dispatchFetch("http://127.0.0.1:8787/auth/discord")).status).toBe(404);
    expect((await mf.dispatchFetch("http://127.0.0.1:8787/join", { method: "POST" })).status).toBe(404);
    expect(outbound).toEqual([]);
  });
});
