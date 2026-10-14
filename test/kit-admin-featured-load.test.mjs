// Kit featured load must await moderator admission before touching the
// database. The layout guard owns guest (302), non-moderator (403) and
// unavailable (503) rejections; the page load must propagate those unchanged
// with zero dbFor/listFeatured/setHeaders calls, and must do zero work while
// parent() is still pending. A resolving moderator admission allows the read
// once, keeps Hono's first-value duplicate-key rule, and preserves the
// result/headers.
//
// Bundles the real route with esbuild (like test/kit-join-attempts-admission)
// so a missing `await parent()` or a dropped `.reverse()` fails here instead
// of shipping silent reads or last-value query keys.
import { build } from "esbuild";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const virtualModules = new Map([
  [
    "sveltekit",
    `export function error(status, message) {
      throw Object.assign(new Error(message), { status });
    }`,
  ],
  ["cloudflare-workers", "export const env = {};"],
  [
    "admin-db",
    `export async function dbFor() {
      globalThis.__kitFeaturedDbForCalls.push("dbFor");
      const v = globalThis.__kitFeaturedDb;
      return typeof v === "function" ? v() : v;
    }`,
  ],
  [
    "admin-store-featured",
    `export async function listFeatured(...args) {
      globalThis.__kitFeaturedListCalls.push(args);
      return globalThis.__kitFeaturedListImpl(...args);
    }`,
  ],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL("../web/src/routes/admin/featured/+page.server.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-featured-load-test",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-featured-load-test",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-featured-load-test",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-featured-load-test",
          }));
          build.onResolve({ filter: /src\/admin\/store-featured$/ }, () => ({
            path: "admin-store-featured",
            namespace: "kit-featured-load-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "kit-featured-load-test" }, ({ path }) => ({
            contents: virtualModules.get(path),
            loader: "js",
          }));
        },
      },
    ],
  });
  const source = outputFiles[0].text;
  const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  ({ load } = await import(bundled));
});

function featuredRow(overrides = {}) {
  return {
    id: 7,
    title: "Game night",
    isPublished: true,
    position: 3,
    startsAt: null,
    endsAt: null,
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.__kitFeaturedDbForCalls = [];
  globalThis.__kitFeaturedListCalls = [];
  globalThis.__kitFeaturedDb = {};
  globalThis.__kitFeaturedListImpl = async () => [featuredRow()];
});

function makeEvent({ parent, search = "" }) {
  const headers = {};
  return {
    event: {
      url: new URL(`https://example.com/admin/featured${search}`),
      setHeaders: (h) => {
        Object.assign(headers, h);
      },
      parent,
    },
    headers,
  };
}

function dbForCalls() {
  return globalThis.__kitFeaturedDbForCalls;
}

function listCalls() {
  return globalThis.__kitFeaturedListCalls;
}

describe("Kit featured load: moderator admission ordering", () => {
  it("does no database or header work while parent() is still pending", async () => {
    let resolveParent;
    const gate = new Promise((resolve) => {
      resolveParent = resolve;
    });
    const parent = () => gate;
    const { event, headers } = makeEvent({ parent });

    const pending = load(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(dbForCalls()).toEqual([]);
    expect(listCalls()).toEqual([]);
    expect(headers).toEqual({});

    resolveParent({ actor: { id: "100000000000000111", username: "mod" } });
    const data = await pending;
    expect(dbForCalls()).toEqual(["dbFor"]);
    expect(listCalls()).toHaveLength(1);
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(data.rows).toHaveLength(1);
  });

  it("a guest redirect from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Redirect"), {
        status: 302,
        location: "/login?next=/admin/featured",
      });
    };
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/featured"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const err = await load(event).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(302);
    expect(err?.location).toBe("/login?next=/admin/featured");
    expect(dbForCalls()).toEqual([]);
    expect(listCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });

  it("a non-moderator rejection from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    };
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/featured"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const err = await load(event).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(403);
    expect(dbForCalls()).toEqual([]);
    expect(listCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });

  it("an unavailable session from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Admin temporarily unavailable"), { status: 503 });
    };
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/featured"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const err = await load(event).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(503);
    expect(dbForCalls()).toEqual([]);
    expect(listCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });

  it("a resolving moderator admission reads once and keeps Hono first-value keys", async () => {
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    globalThis.__kitFeaturedListImpl = async () => [featuredRow()];
    const headerCalls = [];
    const event = {
      // Duplicate keys must keep the first value, like Hono: published=1 wins.
      url: new URL("https://example.com/admin/featured?published=1&published=0"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const data = await load(event);
    expect(dbForCalls()).toEqual(["dbFor"]);
    expect(listCalls()).toHaveLength(1);
    // The shared list read sees the Hono-mapped boolean, not the raw string.
    expect(listCalls()[0][1]).toMatchObject({ published: true });
    expect(data.query.published).toBe("1");
    expect(headerCalls).toEqual([{ "cache-control": "private, no-store" }]);
    expect(data.rows).toHaveLength(1);
    expect(data.positionHeader.href).toContain("sort=position");
    expect(data.updatedHeader.href).toContain("sort=updated_at");
    expect(data.previousHref).toBeNull();
    expect(data.nextHref).toBeNull();
  });

  it("a missing database maps to 503 with no list read", async () => {
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    globalThis.__kitFeaturedDb = null;
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/featured"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const err = await load(event).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(503);
    expect(listCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);
  });
});
