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
const NEW_STATIC_LEAVES = ["/privacy", "/rules"];
const ARCHIVE_STATIC = { archive: "true", static: "true" };
const rolloutCandidates = ROUTE_MANIFEST.filter(
  (entry) => entry.enabled || NEW_STATIC_LEAVES.includes(entry.path),
);
const staging = readWranglerConfig(readFileSync("web/wrangler.staging.jsonc", "utf8"));
const main = readWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
const jobs = readWranglerConfig(readFileSync("wrangler.jobs.jsonc", "utf8"));
const deployWorkflow = readFileSync(".github/workflows/deploy.yml", "utf8");

type RolloutFlags = {
  archive?: string;
  static?: string;
  events?: string;
  home?: string;
  join?: string;
};

function stagingDeps(flags: RolloutFlags = {}) {
  return {
    appUrl: STAGING_APP_URL,
    kitRouteArchive: flags.archive,
    kitRouteStatic: flags.static,
    kitRouteEvents: flags.events,
    kitRouteHome: flags.home,
    kitRouteJoin: flags.join,
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

async function dispatchAt(
  path: string,
  flags: RolloutFlags = {},
  { appUrl = STAGING_APP_URL, method = "GET", pagePath = path } = {},
) {
  const requestUrl = new URL(path, appUrl);
  const request = new Request(requestUrl, { method, headers: { host: requestUrl.host } });
  const event = { request, url: new URL(pagePath, appUrl), route: { id: pagePath } };
  const deps = { ...stagingDeps(flags), appUrl };
  const response = await dispatchHookRequest(event, deps);
  return { deps, response };
}

describe("Kit staging route rollout", () => {
  it("defaults every currently Kit-enabled route to the Hono fallback", async () => {
    const kitEnabled = rolloutCandidates;
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

  it.each(["https://togetherweown.com", `${STAGING_APP_URL}/`, "not a URL"])(
    "refuses the events flag by itself outside the exact staging URL (%s)",
    (appUrl) => {
      const manifest = stagingManifestFor({ APP_URL: appUrl, KIT_ROUTE_EVENTS: "true" });
      expect(manifest?.some((entry) => entry.enabled)).toBe(false);
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

  it("keeps manifest-disabled About on Hono under archive-static", () => {
    const manifest = stagingManifestFor(
      { APP_URL: STAGING_APP_URL, KIT_ROUTE_ARCHIVE: "true", KIT_ROUTE_STATIC: "true" },
      [{ method: "GET", path: "/about", enabled: false, reads: "public" }],
    );
    expect(manifest?.[0]?.enabled).toBe(false);
    expect(resolveRouteOwner({ method: "GET", path: "/about" }, manifest ?? [])).toBe("hono");
  });

  it.each(NEW_STATIC_LEAVES)("can roll back staging %s independently of its family", (path) => {
    const manifest = stagingManifestFor(
      { APP_URL: STAGING_APP_URL, KIT_ROUTE_ARCHIVE: "true", KIT_ROUTE_STATIC: "true" },
      ROUTE_MANIFEST,
      new Map(NEW_STATIC_LEAVES.map((leaf) => [leaf, leaf !== path])),
    );
    expect(resolveRouteOwner({ method: "GET", path }, manifest ?? [])).toBe("hono");
    for (const sibling of ["/events/past", "/about", "/faq", ...NEW_STATIC_LEAVES]) {
      if (sibling === path) continue;
      expect(resolveRouteOwner({ method: "GET", path: sibling }, manifest ?? [])).toBe("kit");
    }
  });

  it("requires public GET entries for the staging-only leaves", () => {
    const manifest = stagingManifestFor(
      { APP_URL: STAGING_APP_URL, KIT_ROUTE_ARCHIVE: "true", KIT_ROUTE_STATIC: "true" },
      [
        { method: "POST", path: "/privacy", enabled: true, reads: "public" },
        { method: "GET", path: "/rules", enabled: true },
      ],
    );
    expect(manifest?.map((entry) => entry.enabled)).toEqual([false, false]);
  });

  it.each(NEW_STATIC_LEAVES)("keeps %s on Hono outside the staging document GET", async (path) => {
    for (const [flags, options, requestPath = path] of [
      [{ static: "true" }, {}],
      [{ archive: "TRUE", static: "true" }, {}],
      [{ archive: "true", static: "yes" }, {}],
      [{ archive: "true", static: "false" }, {}],
      [ARCHIVE_STATIC, { appUrl: "https://togetherweown.com" }],
      [ARCHIVE_STATIC, { method: "HEAD" }],
      [ARCHIVE_STATIC, { method: "POST" }],
      [ARCHIVE_STATIC, { method: "OPTIONS" }],
      [ARCHIVE_STATIC, {}, `${path}/`],
      [ARCHIVE_STATIC, {}, `${path}.md`],
      [ARCHIVE_STATIC, {}, `${path}/child`],
      [
        ARCHIVE_STATIC,
        {},
        path.replace(/p|r/, (letter) => `%${letter.charCodeAt(0).toString(16)}`),
      ],
      // Kit strips the data suffix from event.url before invoking the hook.
      [ARCHIVE_STATIC, { pagePath: path }, `${path}/__data.json`],
    ] as const) {
      const { deps, response } = await dispatchAt(requestPath, flags, options);
      expect(deps.honoFetch, requestPath).toHaveBeenCalledOnce();
      expect(deps.resolve, requestPath).not.toHaveBeenCalled();
      expect(response.headers.get(KIT_RENDERER_HEADER), requestPath).toBeNull();
    }
    expect(resolveRouteOwner({ method: "GET", path })).toBe("hono");
  });

  it.each(["/about", "/faq"])(
    "preserves the existing staging HEAD behavior for %s",
    async (path) => {
      const { deps, response } = await dispatchAt(path, ARCHIVE_STATIC, { method: "HEAD" });
      expect(deps.resolve).toHaveBeenCalledOnce();
      expect(deps.honoFetch).not.toHaveBeenCalled();
      expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    },
  );

  it("does not let the events flag bypass method, detail, or manifest gates", () => {
    const manifest = stagingManifestFor({ APP_URL: STAGING_APP_URL, KIT_ROUTE_EVENTS: "true" }, [
      { method: "GET", path: "/events", enabled: false },
      { method: "POST", path: "/events", enabled: true },
      { method: "GET", path: "/e/:key", enabled: true },
    ]);
    expect(manifest?.map((entry) => entry.enabled)).toEqual([false, false, false]);
  });

  it("enables exactly the reviewed families per flag combination at manifest level", () => {
    // Kills family-widening mutants (for example matching /events or
    // /leaderboards/members under archive): the restrictive manifest is the
    // boundary that keeps unreviewed Kit routes off staging.
    const enabledPaths = (manifest: ReturnType<typeof stagingManifestFor>) =>
      (manifest ?? [])
        .filter((entry) => entry.enabled)
        .map((entry) => `${entry.method} ${entry.path}`);
    expect(
      enabledPaths(stagingManifestFor({ APP_URL: STAGING_APP_URL, KIT_ROUTE_ARCHIVE: "true" })),
    ).toEqual(["GET /events/past"]);
    expect(
      enabledPaths(
        stagingManifestFor({
          APP_URL: STAGING_APP_URL,
          KIT_ROUTE_ARCHIVE: "true",
          KIT_ROUTE_STATIC: "true",
        }),
      ),
    ).toEqual(["GET /events/past", "GET /about", "GET /privacy", "GET /rules", "GET /faq"]);
    expect(
      enabledPaths(stagingManifestFor({ APP_URL: STAGING_APP_URL, KIT_ROUTE_STATIC: "true" })),
    ).toEqual([]);
    expect(enabledPaths(stagingManifestFor({ APP_URL: STAGING_APP_URL })) ?? []).toEqual([]);
  });

  it.each([
    ["archive only", { archive: "true" }, ["/events/past"]],
    ["archive-static", ARCHIVE_STATIC, ["/events/past", "/about", "/privacy", "/rules", "/faq"]],
    ["events only", { events: "true" }, ["/events"]],
  ] as const)(
    "keeps every unselected Kit route on Hono under %s",
    async (_name, flags, kitPaths) => {
      // Exhaustive flags-on negative coverage: the flags-off loop above plus
      // one sampled sibling per stage left widening mutants green.
      const kitEnabled = rolloutCandidates;
      expect(kitEnabled.length).toBeGreaterThan(0);
      for (const route of kitEnabled) {
        const path = route.path.replace(":id", "1").replace(":key", "event");
        const expectKit = (kitPaths as readonly string[]).includes(route.path);
        const { deps, response } = await dispatchAt(path, flags);
        if (expectKit) {
          expect(deps.resolve, path).toHaveBeenCalledOnce();
          expect(deps.honoFetch, path).not.toHaveBeenCalled();
          expect(response.headers.get(KIT_RENDERER_HEADER), path).toBe(KIT_RENDERER_VALUE);
        } else {
          expect(deps.honoFetch, path).toHaveBeenCalledOnce();
          expect(deps.resolve, path).not.toHaveBeenCalled();
          expect(response.headers.get(KIT_RENDERER_HEADER), path).toBeNull();
        }
      }
    },
  );

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
    ["events flag off", { events: "false" }, "/events", "hono"],
    ["malformed events flag", { events: "TRUE" }, "/events", "hono"],
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

describe("staging home and join opt-ins", () => {
  it("keeps the shipped join and recovery entries on Hono by default", () => {
    const env = { APP_URL: STAGING_APP_URL };
    const off = stagingManifestFor(env);
    const on = stagingManifestFor({ ...env, KIT_ROUTE_JOIN: "true" });
    expect(off?.filter(({ enabled }) => enabled)).toEqual([]);
    expect(on?.filter(({ enabled }) => enabled)).toEqual([
      { method: "GET", path: "/join", enabled: true, reads: "public" },
    ]);
    expect(resolveRouteOwner({ method: "HEAD", path: "/join" }, on)).toBe("kit");
    for (const method of ["GET", "HEAD"]) {
      expect(resolveRouteOwner({ method, path: "/auth/recover" }, on)).toBe("hono");
    }
  });

  // Use enabled fixture entries to exercise opt-in before the page PRs land.
  const pages = ["/", "/join", "/events", "/events/past", "/about"];
  const excluded = ["/join/discord", "/join/callback", "/auth/recover", "/e/:key"];
  const routes: typeof ROUTE_MANIFEST = [
    ...[...pages, ...excluded].map((path) => ({ method: "GET", path, enabled: true })),
    ...["/", "/join"].map((path) => ({ method: "POST", path, enabled: true })),
  ];

  it.each([
    ["/", "KIT_ROUTE_HOME"],
    ["/join", "KIT_ROUTE_JOIN"],
  ] as const)("admits only the enabled GET %s entry; HEAD follows GET", (path, flag) => {
    const env = { APP_URL: STAGING_APP_URL, [flag]: "true" };
    const manifest = stagingManifestFor(env, routes);
    expect(manifest?.filter(({ enabled }) => enabled)).toEqual([
      { method: "GET", path, enabled: true },
    ]);
    expect(resolveRouteOwner({ method: "HEAD", path }, manifest)).toBe("kit");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(resolveRouteOwner({ method, path }, manifest)).toBe("hono");
    }
    const disabled = stagingManifestFor(env, [{ method: "GET", path, enabled: false }]);
    expect(resolveRouteOwner({ method: "GET", path }, disabled)).toBe("hono");
    for (const APP_URL of ["https://togetherweown.com", `${STAGING_APP_URL}/`, "not a URL"]) {
      expect(stagingManifestFor({ ...env, APP_URL }, routes)?.some((r) => r.enabled)).toBe(false);
    }
    for (const value of [undefined, "false", "TRUE", "true ", "1"]) {
      const invalid = stagingManifestFor({ ...env, [flag]: value }, routes);
      expect(invalid?.some((r) => r.enabled)).toBe(false);
    }
  });

  it.each([
    ["/", "home"],
    ["/join", "join"],
  ] as const)(
    "dispatches shipped GET %s to Kit on staging only when opted in",
    async (path, flag) => {
      const off = await dispatchAt(path, { [flag]: "false" });
      expect(off.deps.honoFetch).toHaveBeenCalledOnce();
      expect(off.response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
      const on = await dispatchAt(path, { [flag]: "true" });
      expect(on.deps.honoFetch).not.toHaveBeenCalled();
      expect(on.response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
      const url = new URL(path, "https://preview.example.test");
      const preview = await dispatchHookRequest(
        { request: new Request(url), url, route: { id: path } },
        { ...stagingDeps({ [flag]: "true" }), appUrl: url.origin },
      );
      expect(await preview.text()).toBe("hono");
    },
  );
});

describe("Kit staging Wrangler config", () => {
  it("keeps the existing staging Worker contract and starts all families on Hono", () => {
    expect(staging.name).toBe("two-web-next");
    expect(staging.main).toBe(".svelte-kit/cloudflare/_worker.js");
    expect(staging.routes).toEqual([{ pattern: "next.togetherweown.com", custom_domain: true }]);
    expect(staging.vars?.APP_URL).toBe(STAGING_APP_URL);
    expect(staging.vars?.KIT_ROUTE_ARCHIVE).toBe("false");
    expect(staging.vars?.KIT_ROUTE_STATIC).toBe("false");
    expect(staging.vars?.KIT_ROUTE_EVENTS).toBe("false");
    expect(main.env?.production?.vars).not.toHaveProperty("KIT_ROUTE_EVENTS");
    expect(main.env?.production?.vars).toBeDefined();
    for (const flag of ["KIT_ROUTE_HOME", "KIT_ROUTE_JOIN"]) {
      expect(staging.vars?.[flag]).toBe("false");
      expect(main.env?.production?.vars).not.toHaveProperty(flag);
    }
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
  it("offers an ordered archive rollout and separate and combined Ember choices", () => {
    expect(deployWorkflow).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+kit_route_family:/);
    expect(deployWorkflow).toContain("default: hono");
    expect(deployWorkflow).toContain(
      "- hono\n          - archive\n          - archive-static\n          - events\n          - home\n          - events-join\n          - events-home\n          - join\n          - ember-pages",
    );
    const deployStep = deployWorkflow
      .split("      - name: Deploy to Cloudflare Workers\n")[1]
      ?.split(/\n      - /)[0];
    const deployEnv = deployStep?.match(/^        env:\n((?: {10}.*\n)+)/m)?.[1];
    expect(deployStep).toContain('"KIT_ROUTE_ARCHIVE:$KIT_ROUTE_ARCHIVE"');
    expect(deployStep).toContain('"KIT_ROUTE_STATIC:$KIT_ROUTE_STATIC"');
    expect(deployStep).toContain('"KIT_ROUTE_EVENTS:$KIT_ROUTE_EVENTS"');
    expect(deployEnv).toContain("KIT_ROUTE_ARCHIVE: ${{ steps.kit-route-flags.outputs.archive }}");
    expect(deployEnv).toContain("KIT_ROUTE_STATIC: ${{ steps.kit-route-flags.outputs.static }}");
    expect(deployEnv).toContain(
      "KIT_ROUTE_EVENTS: ${{ steps.kit-route-flags.outputs.events || 'false' }}",
    );
    for (const family of ["home", "join"]) {
      const flag = `KIT_ROUTE_${family.toUpperCase()}`;
      expect(deployStep).toContain(`"${flag}:$${flag}"`);
      expect(deployEnv).toContain(
        `${flag}: \${{ steps.kit-route-flags.outputs.${family} || 'false' }}`,
      );
    }
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
