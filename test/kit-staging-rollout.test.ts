import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import {
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
  dispatchHookRequest,
  productionManifestFor,
  resolveRouteOwner,
  stagingManifestFor,
} from "../src/route-ownership";

const STAGING_APP_URL = "https://next.togetherweown.com";
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

async function dispatchAt(path: string, flags: RolloutFlags = {}) {
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

  it("keeps a manifest-disabled family entry on Hono under archive-static (rollback)", () => {
    // Kills the `enabled: familyEnabled` mutant: returning /about to
    // enabled:false must restore Hono even when the static stage is on.
    const manifest = stagingManifestFor(
      { APP_URL: STAGING_APP_URL, KIT_ROUTE_ARCHIVE: "true", KIT_ROUTE_STATIC: "true" },
      [{ method: "GET", path: "/about", enabled: false }],
    );
    expect(manifest?.[0]?.enabled).toBe(false);
    expect(resolveRouteOwner({ method: "GET", path: "/about" }, manifest ?? [])).toBe("hono");
  });

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
    ).toEqual(["GET /events/past", "GET /about", "GET /faq"]);
    expect(
      enabledPaths(stagingManifestFor({ APP_URL: STAGING_APP_URL, KIT_ROUTE_STATIC: "true" })),
    ).toEqual([]);
    expect(enabledPaths(stagingManifestFor({ APP_URL: STAGING_APP_URL })) ?? []).toEqual([]);
  });

  it.each([
    ["archive only", { archive: "true" }, ["/events/past"]],
    ["archive-static", { archive: "true", static: "true" }, ["/events/past", "/about", "/faq"]],
    ["events only", { events: "true" }, ["/events"]],
  ] as const)(
    "keeps every unselected Kit route on Hono under %s",
    async (_name, flags, kitPaths) => {
      // Exhaustive flags-on negative coverage: the flags-off loop above plus
      // one sampled sibling per stage left widening mutants green.
      const kitEnabled = ROUTE_MANIFEST.filter((entry) => entry.enabled);
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

describe("Kit production route selection", () => {
  const apex = "https://togetherweown.com";
  const archive = "/events/past";
  const archiveStatic = [archive, "/about", "/faq"];
  // Try even staging-only opt-ins, to catch accidental reuse of its admission rules.
  const allOn = { archive: "true", static: "true", events: "true", home: "true", join: "true" };

  function productionEvent(path: string, method = "GET", origin = apex) {
    const request = new Request(`${origin}${path}`, { method });
    const url = new URL(request.url);
    return { request, url, route: { id: url.pathname }, isDataRequest: false };
  }

  async function expectOwner(
    event: ReturnType<typeof productionEvent>,
    expected: "hono" | "kit",
    flags: RolloutFlags = allOn,
    appUrl = apex,
  ) {
    const deps = { ...stagingDeps(flags), appUrl };
    const cacheControl = "public, max-age=300";
    deps.honoFetch.mockResolvedValue(
      new Response("Hono", { headers: { vary: "Cookie", "cache-control": cacheControl } }),
    );
    deps.resolve.mockResolvedValue(
      new Response("<html>kit page</html>", {
        headers: { "content-type": "text/html", "cache-control": cacheControl },
      }),
    );
    const response = await dispatchHookRequest(event, deps);
    const path = event.url.pathname;
    if (expected === "hono") {
      expect(deps.honoFetch, path).toHaveBeenCalledExactlyOnceWith(event.request);
      expect(deps.resolve, path).not.toHaveBeenCalled();
      expect(response.headers.get(KIT_RENDERER_HEADER), path).toBeNull();
    } else {
      expect(deps.resolve, path).toHaveBeenCalledOnce();
      expect(deps.honoFetch, path).not.toHaveBeenCalled();
      expect(response.headers.get(KIT_RENDERER_HEADER), path).toBe(KIT_RENDERER_VALUE);
      expect(response.headers.get("X-Robots-Tag"), path).toBeNull();
    }
    return response;
  }

  const { vars } = readWranglerConfig(readFileSync("web/wrangler.production.jsonc", "utf8"));
  const shippedFlags = {
    archive: vars.KIT_ROUTE_ARCHIVE,
    static: vars.KIT_ROUTE_STATIC,
    events: vars.KIT_ROUTE_EVENTS,
    home: vars.KIT_ROUTE_HOME,
    join: vars.KIT_ROUTE_JOIN,
  };

  it("keeps the shipped production config inert", () => {
    expect(vars.APP_URL).toBe(apex);
    expect(Object.values(shippedFlags)).toEqual(Array(5).fill("false"));
  });

  it.each([
    ["shipped false flags", shippedFlags, []],
    ["absent flags", {}, []],
    ["malformed archive", { archive: "TRUE", static: "true" }, []],
    ["static alone", { static: "true" }, []],
    ["archive alone", { archive: "true" }, [archive]],
    ["malformed static", { archive: "true", static: "true " }, [archive]],
    ["cumulative opt-in", allOn, archiveStatic],
  ] as const)("selects only the expected routes with %s", async (_name, flags, kitPaths) => {
    for (const route of ROUTE_MANIFEST) {
      const path = route.path.replace(":id", "1").replace(":key", "event");
      const expected = (kitPaths as readonly string[]).includes(path) ? "kit" : "hono";
      await expectOwner(productionEvent(path, route.method), expected, flags);
    }
  });

  it.each([
    "",
    "not a URL",
    `${apex}/`,
    `${apex}/nested`,
    `${apex}?config=invalid`,
    `${apex}:443`,
    "http://togetherweown.com",
    "https://TOGETHERWEOWN.COM",
    "https://togetherweown.com.evil.test",
    STAGING_APP_URL,
  ])("fails closed for a noncanonical production APP_URL (%s)", async (appUrl) => {
    await expectOwner(productionEvent(archive), "hono", allOn, appUrl);
    await expectOwner(productionEvent(archive), "hono", {}, appUrl);
  });

  it.each(["http://togetherweown.com", `${apex}:8443`, "https://preview.example.test"])(
    "requires the original request origin even when the Kit event uses the apex (%s)",
    async (origin) => {
      const event = productionEvent(archive, "GET", origin);
      await expectOwner({ ...event, url: new URL(`${apex}${archive}`) }, "hono");
    },
  );

  it("does not use a preview manifest if the event URL masks a production request", async () => {
    const preview = "https://preview.example.test";
    const event = productionEvent(archive);
    await expectOwner({ ...event, url: new URL(`${preview}${archive}`) }, "hono", {}, preview);
  });

  it.each(["HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"])(
    "leaves %s on Hono even with both flags on",
    async (method) => {
      for (const path of archiveStatic) await expectOwner(productionEvent(path, method), "hono");
    },
  );

  it.each([
    "/up",
    "/version",
    "/csp-reports",
    "/api/agent-events",
    "/_app/immutable/asset.js",
    "/events/past/",
    "/events/%70ast",
    "/events/past/other",
    "/events/past/__data.json",
    "/about/other",
  ])("does not admit unlisted paths (%s)", async (path) => {
    await expectOwner(productionEvent(path), "hono");
  });

  it.each([
    [{ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }, "kit"],
    [{ "x-two-island": "past-events", accept: "text/html" }, "hono"],
    [{ "sec-fetch-dest": "empty", "sec-fetch-mode": "same-origin" }, "hono"],
    [{ "sec-purpose": "prefetch" }, "hono"],
    [{ "x-moz": "prefetch" }, "hono"],
  ] as const)("routes archive page 2 and varies its response for %j", async (headers, owner) => {
    const event = productionEvent(`${archive}?page=2`);
    event.request = new Request(event.request.url, { headers });
    const response = await expectOwner(event, owner);
    expect(response.headers.get("vary")?.toLowerCase().split(/,\s*/)).toEqual(
      expect.arrayContaining([
        "x-two-island",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "purpose",
        "sec-purpose",
        "x-moz",
        ...(owner === "hono" ? ["cookie"] : []),
      ]),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const rolledBack = await expectOwner(event, "hono", shippedFlags);
    expect(rolledBack.headers.get("vary")).toBe("Cookie");
    expect(rolledBack.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it.each(archiveStatic)(
    "does not let a cached Kit response outlast rollback at %s",
    async (path) => {
      const event = productionEvent(path);
      const optedIn = await expectOwner(event, "kit");
      expect(optedIn.headers.get("cache-control")).toBe("private, no-store");
      const rolledBack = await expectOwner(event, "hono", shippedFlags);
      expect(rolledBack.headers.get("cache-control")).toBe("public, max-age=300");
    },
  );

  it("keeps Kit data requests on Hono after Kit strips the data suffix", async () => {
    const event = productionEvent(`${archive}/__data.json`);
    await expectOwner(
      { ...event, url: new URL(`${apex}${archive}`), route: { id: archive }, isDataRequest: true },
      "hono",
    );
  });

  it.each(archiveStatic)("honors the manifest rollback and public-read scope at %s", (path) => {
    const event = productionEvent(path);
    const deps = { appUrl: apex, kitRouteArchive: "true", kitRouteStatic: "true" };
    const manifest = productionManifestFor(event, deps, [
      { method: "GET", path, enabled: false, reads: "public" },
    ]);
    expect(resolveRouteOwner({ method: "GET", path }, manifest ?? [])).toBe("hono");
    const notPublic = productionManifestFor(event, deps, [{ method: "GET", path, enabled: true }]);
    expect(resolveRouteOwner({ method: "GET", path }, notPublic ?? [])).toBe("hono");
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
