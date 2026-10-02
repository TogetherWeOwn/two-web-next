import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Proves the buffer/refusal contract in workerd, not Postgres persistence or
// the mounted app's role matrix. The real-row assertions live in the DB suite.
describe("member buffered response contract in workerd", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["test/fixtures/keyed-member-worker.ts"], bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:*"],
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: bundle.outputFiles![0]!.text, compatibilityDate: "2026-09-29",
      compatibilityFlags: ["nodejs_compat"],
      outboundService: async () => { throw new Error("External network forbidden in keyed-read fixture"); },
    }));
    await mf.ready;
  }, 30_000);
  afterAll(() => mf?.dispose());
  const request = (path: string) => mf.dispatchFetch(`https://member.test${path}`);

  it("serves classified buffered bytes without confusing ordinary bodies with unsupported streams", async () => {
    const res = await request("/reads/buffered");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("known buffered bytes");
  });
  it.each(["declared", "undeclared", "ordinary"])("refuses %s response attempts before sensitive bytes", async (mode) => {
    const res = await request(`/reads/${mode}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const contents = await res.text();
    expect(contents).not.toContain("stream-sensitive-token");
    expect(contents).not.toContain("unclassified sensitive token");
    expect(await (await request("/state")).json()).toEqual({ pulls: 0, entries: 0 });
  });
});
