import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// workerd proves actual route/session/HTML behavior, NOT Postgres persistence.
// Real audit INSERT and existing-handler bypass proofs are in keyed-profile-routes.
describe("keyed profile route in workerd", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const bundle = await build({
      entryPoints: ["test/fixtures/keyed-profile-worker.ts"],
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
          throw new Error("External network forbidden in profile fixture");
        },
      }),
    );
    await mf.ready;
  }, 30_000);
  afterAll(() => mf?.dispose());
  const request = (mode: string) =>
    mf.dispatchFetch(`https://profile.test/fixture/${mode}`, { redirect: "manual" });

  it.each(["member", "moderator", "self"])(
    "%s receives buffered HTML and actual-key sink attribution",
    async (mode) => {
      const res = await request(mode);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.text()).toContain("workerd-bio-sensitive");
      const entries = JSON.parse(res.headers.get("x-fixture-audit")!);
      if (mode === "self") expect(entries).toEqual([]);
      else
        expect(entries).toEqual([
          {
            viewerDiscordId: "100000000000000102",
            viewerUserId: "100000000000000102",
            resource: "profile",
            action: "view",
            route: "profiles.show",
            subjectUserIds: ["100000000000000101"],
          },
        ]);
    },
  );
  it.each([
    ["guest", 302],
    ["non-member", 403],
    ["invalid", 503],
    ["audit-failure", 503],
  ] as const)("%s refuses sensitive bytes (%s)", async (mode, status) => {
    const res = await request(mode);
    expect(res.status).toBe(status);
    const body = await res.text();
    expect(body).not.toContain("workerd-profile-sensitive");
    expect(body).not.toContain("workerd-bio-sensitive");
    expect(JSON.parse(res.headers.get("x-fixture-audit")!)).toEqual([]);
  });
});
