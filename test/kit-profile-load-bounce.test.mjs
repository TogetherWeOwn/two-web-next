// Execute both real loads and SvelteKit's cookie serializer. The root suite
// has no Kit transform; bundle the binding with fixture env/store imports,
// as in kit-admin-dashboard-load.test.mjs. OAuth completion stays synthetic.
import { build } from "esbuild";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { kitProfileDeps, resolveKitProfile } from "../src/profiles/kit";
import { consumeLoginReturn, LOGIN_INTENDED_COOKIE } from "../src/return-journey";

const APP = "https://next.example.test";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const USER = "100000000000000001";
const fixtureEnv = { SESSION_SECRET: SECRET, APP_URL: APP };
const callback = new Hono();
callback.get("/consume", async (c) => c.text((await consumeLoginReturn(c)) ?? "default"));

async function bundledModule(entry, virtualModules = new Map()) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    define: {
      __SVELTEKIT_DEV__: "false",
      __SVELTEKIT_PATHS_BASE__: '""',
      __SVELTEKIT_PATHS_ASSETS__: '""',
      __SVELTEKIT_APP_DIR__: '"_app"',
      __SVELTEKIT_PATHS_RELATIVE__: "false",
      "process.env.NODE_ENV": '"production"',
    },
    write: false,
    plugins: [
      {
        name: "profile-load-fixtures",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path }) => {
            if (virtualModules.has(path)) return { path, namespace: "profile-load-fixtures" };
          });
          builder.onLoad({ filter: /.*/, namespace: "profile-load-fixtures" }, ({ path }) => ({
            contents: virtualModules.get(path),
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
}

let cookieRuntime;
const loads = new Map();
beforeAll(async () => {
  cookieRuntime = await bundledModule(
    "../web/node_modules/@sveltejs/kit/src/runtime/server/cookie.js",
    // Cookie path utilities import the generated router, unused by this API.
    new Map([["<sveltekit:generated>/server.js", "export const get_hooks = async () => ({});"]]),
  );
  for (const [route, entry, modelImport] of [
    ["/profile", "../web/src/routes/profile/+page.server.ts", "../../../../src/profiles/kit"],
    [
      `/members/${USER}`,
      "../web/src/routes/members/[user]/+page.server.ts",
      "../../../../../src/profiles/kit",
    ],
  ]) {
    const modules = new Map([
      [
        "@sveltejs/kit",
        `export const error = (status, message) => { throw {status, message}; };
        export const redirect = (status, location) => { throw {status, location}; };`,
      ],
      ["cloudflare:workers", `export const env = ${JSON.stringify(fixtureEnv)};`],
      [
        modelImport,
        "export const kitProfileDeps = (env) => globalThis.__profileLoadDeps(env); export const resolveKitProfile = (...args) => globalThis.__profileLoadResolve(...args);",
      ],
    ]);
    loads.set(route, (await bundledModule(entry, modules)).load);
  }
});

async function bounce(route, suffix, status = "guest") {
  let storeReads = 0;
  // Only the database factory is replaced. The signer wiring and decision
  // model are real, so missing URL/secret propagation fails the round trip.
  globalThis.__profileLoadDeps = (env) => ({
    ...kitProfileDeps(env),
    storeFor: async () => ({
      find: async () => {
        storeReads++;
        throw new Error("unexpected read");
      },
    }),
  });
  globalThis.__profileLoadResolve = resolveKitProfile;
  const url = new URL(`${APP}${route}${suffix}`);
  const request = new Request(url);
  const state = cookieRuntime.get_cookies(request, url);
  state.set_trailing_slash("ignore");
  let refusal;
  try {
    await loads.get(route)({
      locals: { status, session: null },
      url,
      cookies: state.cookies,
      params: { user: USER },
      setHeaders: () => {},
    });
  } catch (e) {
    refusal = e;
  } finally {
    delete globalThis.__profileLoadDeps;
    delete globalThis.__profileLoadResolve;
  }
  const headers = new Headers();
  cookieRuntime.add_cookies_to_headers(headers, [...state.new_cookies.values()]);
  return { refusal, headers, storeReads };
}

for (const route of ["/profile", `/members/${USER}`]) {
  describe(`${route} real load guest bounce`, () => {
    it.each(["", "?tab=games&from=board", "?q=%E4%B8%AD%25%2B%3D%3B"])(
      "returns to the exact intended page after sign-in (%s)",
      async (suffix) => {
        const { refusal, headers, storeReads } = await bounce(route, suffix);
        expect(refusal).toEqual({ status: 302, location: "/auth/discord" });
        expect(storeReads).toBe(0);
        const cookies = headers.getSetCookie();
        expect(cookies).toHaveLength(1);
        expect(cookies[0]).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax/i);
        expect(cookies[0]).toMatch(/Max-Age=600/i);
        const done = await callback.request(
          "/consume",
          {
            headers: { cookie: cookies[0].split(";")[0] },
          },
          fixtureEnv,
        );
        expect(await done.text()).toBe(`${route}${suffix}`);
      },
    );

    it("emits a clearing cookie when the destination exceeds the byte bound", async () => {
      const { refusal, headers, storeReads } = await bounce(route, `?q=${"a".repeat(513)}`);
      expect(refusal).toEqual({ status: 302, location: "/auth/discord" });
      expect(storeReads).toBe(0);
      expect(headers.getSetCookie()).toHaveLength(1);
      expect(headers.getSetCookie()[0]).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
    });

    it("unknown session refuses without an intended cookie or private store read", async () => {
      const { refusal, headers, storeReads } = await bounce(route, "", "unknown");
      expect(refusal.status).toBe(503);
      expect(headers.getSetCookie()).toEqual([]);
      expect(storeReads).toBe(0);
    });
  });
}
