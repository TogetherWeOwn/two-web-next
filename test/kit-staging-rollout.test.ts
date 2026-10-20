import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import {
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
  dispatchHookRequest,
  resolveRouteOwner,
  stagingManifestFor,
} from "../src/route-ownership";

const STAGING_APP_URL = "https://next.togetherweown.com";
const staging = readWranglerConfig(readFileSync("web/wrangler.staging.jsonc", "utf8"));
const main = readWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
const jobs = readWranglerConfig(readFileSync("wrangler.jobs.jsonc", "utf8"));
const deployWorkflow = readFileSync(".github/workflows/deploy.yml", "utf8");

function stagingDeps(flags: { archive?: string; static?: string } = {}) {
  return {
    appUrl: STAGING_APP_URL,
    kitRouteArchive: flags.archive,
    kitRouteStatic: flags.static,
    featuredImageHosts: "",
    honoFetch: vi.fn(async () => new Response("hono", { status: 200 })),
    resolve: vi.fn(
      async () =>
        new Response("<html>kit page</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ),
  };
}

async function dispatchAt(path: string, flags: { archive?: string; static?: string } = {}) {
  const request = new Request(new URL(path, STAGING_APP_URL), {
    headers: { host: new URL(STAGING_APP_URL).host },
  });
  const event = { request, url: new URL(request.url), route: { id: path } };
  const deps = stagingDeps(flags);
  const response = await dispatchHookRequest(event, deps);
  return { deps, response };
}

describe("Kit staging route rollout", () => {
  it("defaults every currently Kit-enabled route to the Hono fallback", async () => {
    const kitEnabled = ROUTE_MANIFEST.filter((entry) => entry.enabled);
    expect(kitEnabled.length).toBeGreaterThan(0);

    for (const route of kitEnabled) {
      const path = route.path.replace(":id", "1").replace(":key", "event");
      const { deps, response } = await dispatchAt(path);
      expect(deps.honoFetch, path).toHaveBeenCalledOnce();
      expect(deps.resolve, path).not.toHaveBeenCalled();
      expect(response.headers.get(KIT_RENDERER_HEADER), path).toBeNull();
    }
  });

  it.each(["/nested", "?config=invalid", "#fragment", ":8443", "/"])(
    "keeps a noncanonical staging APP_URL (%s) fail-closed",
    async (suffix) => {
      const request = new Request(`${STAGING_APP_URL}/hotzones`);
      const deps = {
        ...stagingDeps({ archive: "true", static: "true" }),
        appUrl: `${STAGING_APP_URL}${suffix}`,
      };
      const response = await dispatchHookRequest(
        { request, url: new URL(request.url), route: { id: "/hotzones" } },
        deps,
      );
      expect(deps.honoFetch).toHaveBeenCalledOnce();
      expect(deps.resolve).not.toHaveBeenCalled();
      expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
      const manifest = stagingManifestFor({
        APP_URL: deps.appUrl,
        KIT_ROUTE_ARCHIVE: "true",
        KIT_ROUTE_STATIC: "true",
      });
      expect(manifest).toBeDefined();
      expect(manifest?.some((entry) => entry.enabled)).toBe(false);
    },
  );

  it.each(["", "not a URL", "https://preview.example.test", "http://localhost:8787"])(
    "refuses runtime flags outside the exact staging URL (%s)",
    (appUrl) => {
      const manifest = stagingManifestFor({
        APP_URL: appUrl,
        KIT_ROUTE_ARCHIVE: "true",
        KIT_ROUTE_STATIC: "true",
      });
      expect(manifest).toBeDefined();
      expect(manifest?.some((entry) => entry.enabled)).toBe(false);
      expect(stagingManifestFor({ APP_URL: appUrl })).toBeUndefined();
    },
  );

  it("keeps unflagged staging on Hono even when APP_URL has a path", async () => {
    const request = new Request(`${STAGING_APP_URL}/hotzones`);
    const deps = { ...stagingDeps(), appUrl: `${STAGING_APP_URL}/nested` };
    await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/hotzones" } },
      deps,
    );
    expect(deps.honoFetch).toHaveBeenCalledOnce();
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it("does not enable a non-GET entry at an archive-family path", () => {
    const manifest = stagingManifestFor({ APP_URL: STAGING_APP_URL, KIT_ROUTE_ARCHIVE: "true" }, [
      { method: "POST", path: "/events/past", enabled: true },
    ]);
    expect(manifest?.[0]?.enabled).toBe(false);
    expect(resolveRouteOwner({ method: "POST", path: "/events/past" }, manifest ?? [])).toBe(
      "hono",
    );
  });

  it.each([
    ["archive only", { archive: "true" }, "/events/past", "kit"],
    ["archive does not enable static leaves", { archive: "true" }, "/about", "hono"],
    ["static cannot roll out ahead of archive", { static: "true" }, "/faq", "hono"],
    ["static does not enable the archive", { static: "true" }, "/events/past", "hono"],
    ["cumulative rollout", { archive: "true", static: "true" }, "/about", "kit"],
    [
      "unselected Kit routes stay Hono-owned",
      { archive: "true", static: "true" },
      "/hotzones",
      "hono",
    ],
    ["malformed flags fail closed", { archive: "TRUE", static: "yes" }, "/events/past", "hono"],
  ] as const)(
    "routes the %s selection through the expected renderer",
    async (_name, flags, path, owner) => {
      const { deps, response } = await dispatchAt(path, flags);
      if (owner === "kit") {
        expect(deps.resolve, path).toHaveBeenCalledOnce();
        expect(deps.honoFetch, path).not.toHaveBeenCalled();
        expect(response.headers.get(KIT_RENDERER_HEADER), path).toBe(KIT_RENDERER_VALUE);
      } else {
        expect(deps.honoFetch, path).toHaveBeenCalledOnce();
        expect(deps.resolve, path).not.toHaveBeenCalled();
        expect(response.headers.get(KIT_RENDERER_HEADER), path).toBeNull();
      }
    },
  );
});

describe("Kit staging Wrangler config", () => {
  it("keeps the existing staging Worker contract and starts both families on Hono", () => {
    expect(staging.name).toBe("two-web-next");
    expect(staging.main).toBe(".svelte-kit/cloudflare/_worker.js");
    expect(staging.routes).toEqual([{ pattern: "next.togetherweown.com", custom_domain: true }]);
    expect(staging.vars?.APP_URL).toBe(STAGING_APP_URL);
    expect(staging.vars?.KIT_ROUTE_ARCHIVE).toBe("false");
    expect(staging.vars?.KIT_ROUTE_STATIC).toBe("false");
    expect(staging.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(staging.tail_consumers).toEqual([{ service: "two-web-next-alerts" }]);
    expect(staging.assets).toMatchObject({
      directory: ".svelte-kit/cloudflare",
      binding: "ASSETS",
      run_worker_first: true,
    });
    expect(staging.placement).toEqual({ region: "aws:us-east-1" });
    expect(staging.hyperdrive).toEqual(main.hyperdrive);
    expect(staging.vars?.DISCORD_CLIENT_ID).toBe(main.vars?.DISCORD_CLIENT_ID);
    expect(staging.vars?.DISCORD_GUILD_ID).toBe(main.vars?.DISCORD_GUILD_ID);
    expect(staging.vars?.DISCORD_MODERATOR_ROLE_IDS).toBe(main.vars?.DISCORD_MODERATOR_ROLE_IDS);
    expect(staging.vars?.DISCORD_INVITE_URL).toBe(main.vars?.DISCORD_INVITE_URL);
    expect(staging.vars?.FEATURED_IMAGE_HOSTS).toBe(main.vars?.FEATURED_IMAGE_HOSTS);
    expect(staging.keep_vars).toBe(true);
    expect(staging.queues?.producers).toEqual(main.queues?.producers);
    expect(staging.queues?.consumers).toBeUndefined();
    expect(staging.triggers?.crons).toEqual([]);
    expect(staging.vars).not.toHaveProperty("QA_AUTH_TOKEN");
  });

  it("leaves the jobs Worker as the sole consumer and cron owner", () => {
    expect(staging.queues?.producers).toEqual(jobs.queues?.producers);
    expect(staging.queues?.consumers).toBeUndefined();
    expect(staging.triggers?.crons).toEqual([]);
    expect(jobs.queues?.consumers?.map((entry: { queue: string }) => entry.queue)).toEqual([
      "two-sync-event",
      "two-internal-action",
    ]);
    expect(jobs.triggers?.crons).toEqual(["*/10 * * * *", "0 0 * * *"]);
  });
});

describe("staging deployment selection", () => {
  it("offers an ordered Hono, archive, then archive-plus-static rollout", () => {
    expect(deployWorkflow).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+kit_route_family:/);
    expect(deployWorkflow).toContain("default: hono");
    expect(deployWorkflow).toContain("- hono\n          - archive\n          - archive-static");
    expect(deployWorkflow).toContain(
      "KIT_ROUTE_ARCHIVE:${{ steps.kit-route-flags.outputs.archive }}",
    );
    expect(deployWorkflow).toContain(
      "KIT_ROUTE_STATIC:${{ steps.kit-route-flags.outputs.static }}",
    );
    expect(deployWorkflow).toContain("--config web/wrangler.staging.jsonc");
    expect(deployWorkflow).not.toContain("--config wrangler.jsonc --tag");
  });

  it("builds the Kit Worker before deployment and retains the queue handoff order", () => {
    const build = deployWorkflow.indexOf("npm run build --prefix web");
    const deploy = deployWorkflow.indexOf("--config web/wrangler.staging.jsonc --tag");
    const detach = deployWorkflow.indexOf("queues consumer remove");
    const jobsDeploy = deployWorkflow.indexOf("--config wrangler.jobs.jsonc --tag");
    expect(build).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(build);
    expect(detach).toBeGreaterThan(deploy);
    expect(jobsDeploy).toBeGreaterThan(detach);
    expect(deployWorkflow).toContain("node ci/staging-deploy-gate.mjs");
  });
});
