// Kit featured create/edit loads must await moderator admission before any
// work. The shared layout guard owns guest (302), non-moderator (403) and
// unavailable (503) rejections; each page load must propagate those unchanged
// with zero dbFor/getFeatured/setHeaders calls, and must do zero work while
// parent() is still pending. Admitted create returns the empty model with one
// private/no-store header write; admitted edit reads once through the real
// resolveKitFeaturedEdit and preserves the view/header behavior with the Hono
// 404/503 mappings. The create load's reuse read keeps the same failure
// distinction: a missing database and a classified outage 503 through the
// real shared resolver, while an ordinary read error rethrows unchanged.
//
// Bundles both real routes with esbuild (like test/kit-admin-featured-load)
// so a missing `await parent()` fails here instead of shipping a guard
// bypass: without the await, the pending-period assertions see early header/db
// work and the rejection cases see headers set or the error swallowed.
import { build } from "esbuild";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const sveltekitStub = `export function error(status, message) {
  throw Object.assign(new Error(message), { status });
}`;

// Live proxy so per-test env reassignment is visible to the bundled load,
// which reads env.APP_URL / env.FEATURED_IMAGE_HOSTS at request time.
const cloudflareStub = `export const env = new Proxy({}, {
  get: (_target, prop) => globalThis.__kitFeaturedFormEnv?.[prop],
});`;

const adminDbStub = `export async function dbFor() {
  globalThis.__kitFeaturedFormDbForCalls.push("dbFor");
  const v = globalThis.__kitFeaturedFormDb;
  return typeof v === "function" ? v() : v;
}`;

const adminStoreStub = `export async function getFeatured(...args) {
  globalThis.__kitFeaturedFormGetCalls.push(args);
  return globalThis.__kitFeaturedFormGetImpl(...args);
}`;

async function bundleLoad(entryUrl, namespace) {
  const virtualModules = new Map([
    ["sveltekit", sveltekitStub],
    ["cloudflare-workers", cloudflareStub],
    ["admin-db", adminDbStub],
    ["admin-store-featured", adminStoreStub],
  ]);
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(entryUrl)],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: namespace,
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace,
          }));
          pluginBuild.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace,
          }));
          pluginBuild.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace,
          }));
          pluginBuild.onResolve({ filter: /src\/admin\/store-featured$/ }, () => ({
            path: "admin-store-featured",
            namespace,
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace }, ({ path }) => ({
            contents: virtualModules.get(path),
            loader: "js",
          }));
        },
      },
    ],
  });
  const source = outputFiles[0].text;
  const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return (await import(bundled)).load;
}

let newLoad;
let editLoad;

beforeAll(async () => {
  globalThis.__kitFeaturedFormEnv = {};
  newLoad = await bundleLoad(
    new URL("../web/src/routes/admin/featured/new/+page.server.ts", import.meta.url),
    "kit-featured-new-admission-test",
  );
  editLoad = await bundleLoad(
    new URL("../web/src/routes/admin/featured/[id]/+page.server.ts", import.meta.url),
    "kit-featured-edit-admission-test",
  );
});

function baseRow(overrides = {}) {
  return {
    id: 7,
    legacyId: null,
    title: "Game night",
    body: "Bring a friend",
    url: null,
    imageUrl: null,
    imageAlt: null,
    isPublished: true,
    position: 2,
    startsAt: null,
    endsAt: null,
    createdBy: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    startsAtText: null,
    endsAtText: null,
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.__kitFeaturedFormDbForCalls = [];
  globalThis.__kitFeaturedFormGetCalls = [];
  globalThis.__kitFeaturedFormDb = {};
  globalThis.__kitFeaturedFormGetImpl = async () => baseRow();
  globalThis.__kitFeaturedFormEnv = {};
});

function dbForCalls() {
  return globalThis.__kitFeaturedFormDbForCalls;
}

function getCalls() {
  return globalThis.__kitFeaturedFormGetCalls;
}

describe("Kit featured-new load: moderator admission ordering", () => {
  it("does no header work while parent() is still pending", async () => {
    let resolveParent;
    const gate = new Promise((resolve) => {
      resolveParent = resolve;
    });
    const parent = () => gate;
    const headerCalls = [];
    const event = { parent, setHeaders: (h) => headerCalls.push(h) };

    const pending = newLoad(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(headerCalls).toEqual([]);

    resolveParent({ actor: { id: "100000000000000111", username: "mod" } });
    const data = await pending;
    expect(data).toEqual({});
    expect(headerCalls).toEqual([{ "cache-control": "private, no-store" }]);
  });

  it("a guest redirect from parent propagates unchanged with zero work", async () => {
    const redirect = Object.assign(new Error("Redirect"), {
      status: 302,
      location: "/login?next=/admin/featured/new",
    });
    const parent = async () => {
      throw redirect;
    };
    const headerCalls = [];
    const err = await newLoad({ parent, setHeaders: (h) => headerCalls.push(h) }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBe(redirect);
    expect(err?.status).toBe(302);
    expect(err?.location).toBe("/login?next=/admin/featured/new");
    expect(headerCalls).toEqual([]);
  });

  it("a non-moderator rejection from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    };
    const headerCalls = [];
    const err = await newLoad({ parent, setHeaders: (h) => headerCalls.push(h) }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(403);
    expect(headerCalls).toEqual([]);
  });

  it("an unavailable session from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Admin temporarily unavailable"), { status: 503 });
    };
    const headerCalls = [];
    const err = await newLoad({ parent, setHeaders: (h) => headerCalls.push(h) }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(503);
    expect(headerCalls).toEqual([]);
  });

  it("an admitted create returns the empty model with one private/no-store header write", async () => {
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const headerCalls = [];
    const data = await newLoad({ parent, setHeaders: (h) => headerCalls.push(h) });
    expect(data).toEqual({});
    expect(headerCalls).toEqual([{ "cache-control": "private, no-store" }]);
  });

  it("a reuse source with a missing database 503s with no store read or header write", async () => {
    globalThis.__kitFeaturedFormDb = null;
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const headerCalls = [];
    const err = await newLoad({
      parent,
      url: new URL("https://example.com/admin/featured/new?source=41"),
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(503);
    expect(dbForCalls()).toEqual(["dbFor"]);
    expect(getCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });

  it("a classified reuse-read outage 503s with no header write", async () => {
    const outage = Object.assign(new Error("connection terminated"), {
      name: "PostgresError",
      code: "57P01",
    });
    globalThis.__kitFeaturedFormGetImpl = async () => Promise.reject(outage);
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const headerCalls = [];
    const err = await newLoad({
      parent,
      url: new URL("https://example.com/admin/featured/new?source=41"),
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(503);
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0][1]).toBe(41);
    expect(headerCalls).toEqual([]);
  });

  it("an ordinary reuse-read failure rethrows unchanged instead of mapping to 503", async () => {
    const failure = new TypeError("fixture programming error");
    globalThis.__kitFeaturedFormGetImpl = async () => Promise.reject(failure);
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const headerCalls = [];
    const err = await newLoad({
      parent,
      url: new URL("https://example.com/admin/featured/new?source=41"),
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBe(failure);
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0][1]).toBe(41);
    expect(headerCalls).toEqual([]);
  });
});

describe("Kit featured-edit load: moderator admission ordering", () => {
  it("does no database, store or header work while parent() is still pending", async () => {
    let resolveParent;
    const gate = new Promise((resolve) => {
      resolveParent = resolve;
    });
    const parent = () => gate;
    const headerCalls = [];
    const event = {
      parent,
      params: { id: "7" },
      setHeaders: (h) => headerCalls.push(h),
    };

    const pending = editLoad(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(dbForCalls()).toEqual([]);
    expect(getCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);

    resolveParent({ actor: { id: "100000000000000111", username: "mod" } });
    const data = await pending;
    expect(dbForCalls()).toEqual(["dbFor"]);
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0][1]).toBe(7);
    expect(headerCalls).toEqual([{ "cache-control": "private, no-store" }]);
    expect(data.view.id).toBe(7);
  });

  it("a guest redirect from parent propagates unchanged with zero work", async () => {
    const redirect = Object.assign(new Error("Redirect"), {
      status: 302,
      location: "/login?next=/admin/featured/7",
    });
    const parent = async () => {
      throw redirect;
    };
    const headerCalls = [];
    const err = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBe(redirect);
    expect(err?.status).toBe(302);
    expect(err?.location).toBe("/login?next=/admin/featured/7");
    expect(dbForCalls()).toEqual([]);
    expect(getCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });

  it("a non-moderator rejection from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    };
    const headerCalls = [];
    const err = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(403);
    expect(dbForCalls()).toEqual([]);
    expect(getCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });

  it("an unavailable session from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Admin temporarily unavailable"), { status: 503 });
    };
    const headerCalls = [];
    const err = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(503);
    expect(dbForCalls()).toEqual([]);
    expect(getCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });

  it("an admitted edit reads once and preserves the view and headers", async () => {
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const headerCalls = [];
    const data = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: (h) => headerCalls.push(h),
    });
    expect(dbForCalls()).toEqual(["dbFor"]);
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0][1]).toBe(7);
    expect(headerCalls).toEqual([{ "cache-control": "private, no-store" }]);
    expect(data.view.id).toBe(7);
    expect(data.view.values).toMatchObject({
      title: "Game night",
      body: "Bring a friend",
      position: "2",
      is_published: "on",
    });
    expect(data.view.status).toBe("live");
    expect(data.view.updatedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(data.view.imageSrc).toBeNull();
    expect(data.view.imageAlt).toBe("Game night");
  });

  it("passes the site origin and image hosts into the preview policy", async () => {
    globalThis.__kitFeaturedFormEnv = {
      APP_URL: "https://next.example.test",
      FEATURED_IMAGE_HOSTS: "images.unsplash.com",
    };
    globalThis.__kitFeaturedFormGetImpl = async () =>
      baseRow({ imageUrl: "https://images.unsplash.com/x.png" });
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const data = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: () => {},
    });
    expect(data.view.imageSrc).toBe("https://images.unsplash.com/x.png");
  });

  it("a missing row 404s with no header write", async () => {
    globalThis.__kitFeaturedFormGetImpl = async () => null;
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const headerCalls = [];
    const err = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(404);
    expect(getCalls()).toHaveLength(1);
    expect(headerCalls).toEqual([]);
  });

  it("a missing database 503s with no store read or header write", async () => {
    globalThis.__kitFeaturedFormDb = null;
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const headerCalls = [];
    const err = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(503);
    expect(getCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });

  it("a classified outage 503s with no header write", async () => {
    const outage = Object.assign(new Error("connection terminated"), {
      name: "PostgresError",
      code: "57P01",
    });
    globalThis.__kitFeaturedFormGetImpl = async () => Promise.reject(outage);
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const headerCalls = [];
    const err = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: (h) => headerCalls.push(h),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(503);
    expect(headerCalls).toEqual([]);
  });

  it("an ordinary store failure rethrows instead of mapping to 503", async () => {
    const failure = new Error("boom");
    globalThis.__kitFeaturedFormGetImpl = async () => Promise.reject(failure);
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    const err = await editLoad({
      parent,
      params: { id: "7" },
      setHeaders: () => {},
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBe(failure);
  });
});
