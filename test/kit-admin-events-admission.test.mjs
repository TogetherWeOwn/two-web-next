// Kit admin events-list load must await moderator admission before touching
// the database. The layout guard owns guest (302), non-moderator (403) and
// unavailable (503) rejections; the page load must propagate those unchanged
// with zero dbFor/listEvents/setHeaders calls, and must do zero work while
// parent() is still pending. A resolving moderator admission allows the read
// and preserves the existing result/headers.
//
// Bundles the real route with esbuild (like test/kit-join-attempts-admission)
// so a missing `await parent()` fails here instead of shipping silent reads.
import { build } from "esbuild";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const virtualModules = new Map([
  [
    "sveltekit",
    `export function error(status, message) {
      throw Object.assign(new Error(message), { status });
    }
    export function redirect(status, location) {
      throw Object.assign(new Error("Redirect"), { status, location });
    }`,
  ],
  ["cloudflare-workers", "export const env = {};"],
  [
    "admin-db",
    `export async function dbFor() {
      globalThis.__kitAdminEventsDbForCalls.push("dbFor");
      const v = globalThis.__kitAdminEventsDb;
      return typeof v === "function" ? v() : v;
    }`,
  ],
  [
    "admin-event-reads",
    `export async function listEvents(...args) {
      globalThis.__kitAdminEventsListCalls.push(args);
      return globalThis.__kitAdminEventsListImpl(...args);
    }
    export async function listSeriesEvents(...args) {
      globalThis.__kitAdminEventsListCalls.push(args);
      return { rows: await globalThis.__kitAdminEventsListImpl(...args), scope: null };
    }`,
  ],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL("../web/src/routes/admin/events/+page.server.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-admin-events-admission-test",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-admin-events-admission-test",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-admin-events-admission-test",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-admin-events-admission-test",
          }));
          build.onResolve({ filter: /src\/admin\/store-event-reads$/ }, () => ({
            path: "admin-event-reads",
            namespace: "kit-admin-events-admission-test",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "kit-admin-events-admission-test" },
            ({ path }) => ({ contents: virtualModules.get(path), loader: "js" }),
          );
        },
      },
    ],
  });
  const source = outputFiles[0].text;
  const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  ({ load } = await import(bundled));
});

beforeEach(() => {
  globalThis.__kitAdminEventsDbForCalls = [];
  globalThis.__kitAdminEventsListCalls = [];
  globalThis.__kitAdminEventsDb = {};
  globalThis.__kitAdminEventsListImpl = async () => [];
});

function dbForCalls() {
  return globalThis.__kitAdminEventsDbForCalls;
}

function listCalls() {
  return globalThis.__kitAdminEventsListCalls;
}

describe("Kit admin events-list load: moderator admission ordering", () => {
  it("does no database or header work while parent() is still pending", async () => {
    let resolveParent;
    const gate = new Promise((resolve) => {
      resolveParent = resolve;
    });
    const parent = () => gate;
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/events"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };

    const pending = load(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(dbForCalls()).toEqual([]);
    expect(listCalls()).toEqual([]);
    expect(headerCalls).toEqual([]);

    resolveParent({ actor: { id: "100000000000000111", username: "mod" } });
    const data = await pending;
    expect(dbForCalls().length).toBeGreaterThan(0);
    expect(listCalls().length).toBeGreaterThan(0);
    expect(headerCalls).toEqual([{ "cache-control": "private, no-store" }]);
    expect(data.rows).toEqual([]);
  });

  it("a guest redirect from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Redirect"), {
        status: 302,
        location: "/login?next=/admin/events",
      });
    };
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/events"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const err = await load(event).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(302);
    expect(err?.location).toBe("/login?next=/admin/events");
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
      url: new URL("https://example.com/admin/events"),
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
      url: new URL("https://example.com/admin/events"),
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

  it("a resolving moderator admission allows the read and keeps result and headers", async () => {
    const parent = async () => ({ actor: { id: "100000000000000111", username: "mod" } });
    globalThis.__kitAdminEventsListImpl = async () => [
      {
        id: 1,
        eventKey: "EVT1",
        title: "Game night 1",
        status: "published",
        startsAt: new Date("2026-11-01T18:00:00.000Z"),
        endsAt: new Date("2026-11-01T21:00:00.000Z"),
        capacity: 8,
        rsvpOpen: true,
        goingCount: 4,
      },
    ];
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/events"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const data = await load(event);
    expect(listCalls().length).toBe(1);
    expect(dbForCalls().length).toBe(1);
    expect(headerCalls).toEqual([{ "cache-control": "private, no-store" }]);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ eventKey: "EVT1", goingCount: 4 });
    expect(data.hasNext).toBe(false);
  });
});
