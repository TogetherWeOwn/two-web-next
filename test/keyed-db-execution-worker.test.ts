import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Actual execution-time observation in workerd. Storage is memory; PostgreSQL
// attribution/mutation proofs live in keyed-member-reads.test.ts.
describe("borrowed Drizzle execution in workerd", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["test/fixtures/keyed-db-execution-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:*"],
    });
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles![0]!.text,
        compatibilityDate: "2026-09-29",
        compatibilityFlags: ["nodejs_compat"],
        outboundService: async () => {
          throw new Error("External network forbidden in DB execution fixture");
        },
      }),
    );
    await mf.ready;
  }, 30_000);
  afterAll(() => mf?.dispose());
  it.each(["prebuilt-prepared", "prebuilt-lazy", "alias-missing", "cte", "count"])(
    "%s refuses before adapter execution or sensitive bytes",
    async (mode) => {
      const response = await mf.dispatchFetch(`https://runtime.test/${mode}`);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-fixture-executions")).toBe("0");
      expect(JSON.parse(response.headers.get("x-fixture-audit")!)).toEqual([]);
      expect(await response.text()).not.toContain("workerd-private-name");
    },
  );
  it.each(["prebuilt-prepared-keyed", "prebuilt-lazy-keyed", "alias-owned"])(
    "%s captures the actual owner exactly once",
    async (mode) => {
      const response = await mf.dispatchFetch(`https://runtime.test/${mode}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("workerd-private-name");
      expect(response.headers.get("x-fixture-executions")).toBe("1");
      expect(JSON.parse(response.headers.get("x-fixture-audit")!)).toMatchObject([
        {
          viewerDiscordId: "100000000000000102",
          subjectUserIds: ["100000000000000101"],
          route: "fixture.existing",
        },
      ]);
    },
  );
});
