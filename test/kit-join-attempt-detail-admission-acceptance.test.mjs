// Acceptance: the Kit join-attempt detail load must await moderator
// admission (the admin layout guard) before touching the database. Guest
// (302), non-moderator (403) and unavailable (503) rejections propagate
// unchanged with zero dbFor/getJoinAttempt/setHeaders calls, and the load
// does zero work while parent() is still pending. A resolving moderator
// admission allows exactly the shared retention-window read.
//
// Bundles the real route with esbuild (like
// test/kit-join-attempts-admission.test.mjs) so a missing `await parent()`
// fails here instead of shipping silent reads. Failing-first: without the
// Kit detail route this bundle cannot be built.
import { build } from "esbuild";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
      globalThis.__kitDetailDbForCalls.push("dbFor");
      const v = globalThis.__kitDetailDb;
      return typeof v === "function" ? v() : v;
    }`,
  ],
  [
    "admin-reads",
    `export async function getJoinAttempt(...args) {
      globalThis.__kitDetailGetCalls.push(args);
      return globalThis.__kitDetailGetImpl(...args);
    }`,
  ],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../web/src/routes/admin/join-attempts/[id]/+page.server.ts", import.meta.url),
      ),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-join-attempt-detail-admission-acceptance",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-detail-acceptance",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-detail-acceptance",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-detail-acceptance",
          }));
          build.onResolve({ filter: /src\/admin\/reads$/ }, () => ({
            path: "admin-reads",
            namespace: "kit-detail-acceptance",
          }));
          build.onLoad({ filter: /.*/, namespace: "kit-detail-acceptance" }, ({ path }) => ({
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

const ROW = {
  id: 7,
  outcome: "added",
  source: "join",
  requestId: "detail-request",
  discordId: "100000000000000201",
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
};

beforeEach(() => {
  globalThis.__kitDetailDbForCalls = [];
  globalThis.__kitDetailGetCalls = [];
  globalThis.__kitDetailDb = { fake: "db" };
  globalThis.__kitDetailGetImpl = async () => ({ attempt: ROW });
});

const eventFor = ({ parent, id = "7", url }) => ({
  parent,
  params: { id },
  setHeaders: vi.fn(),
  url: new URL(url ?? `https://next.example.test/admin/join-attempts/${id}`),
});

describe("acceptance: detail load admission (role denial)", () => {
  it.each([
    ["guest redirect", Object.assign(new Error("Redirect"), { status: 302, location: "/join" })],
    ["non-moderator denial", Object.assign(new Error("Forbidden"), { status: 403 })],
    ["guard unavailable", Object.assign(new Error("Unavailable"), { status: 503 })],
  ])("%s propagates unchanged with zero database or read work", async (_label, denial) => {
    const parent = vi.fn(async () => {
      throw denial;
    });
    await expect(load(eventFor({ parent }))).rejects.toBe(denial);
    expect(globalThis.__kitDetailDbForCalls).toEqual([]);
    expect(globalThis.__kitDetailGetCalls).toEqual([]);
  });

  it("does zero work while moderator admission is still pending", async () => {
    let release;
    const parent = vi.fn(
      () =>
        new Promise((resolvePromise) => {
          release = resolvePromise;
        }),
    );
    const event = eventFor({ parent });
    const pending = load(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(globalThis.__kitDetailDbForCalls).toEqual([]);
    expect(globalThis.__kitDetailGetCalls).toEqual([]);
    release({});
    await expect(pending).resolves.toEqual({
      view: {
        id: 7,
        outcome: "added",
        source: "join",
        requestId: "detail-request",
        discordId: "100000000000000201",
        createdAt: "2026-10-01T12:00:00.000Z",
      },
      returnUrl: "/admin/join-attempts",
    });
  });
});

describe("acceptance: detail load outcomes for an admitted moderator", () => {
  it("valid id returns the view and marks the response private, no-store", async () => {
    const event = eventFor({ parent: async () => ({}) });
    await expect(load(event)).resolves.toEqual({
      view: {
        id: 7,
        outcome: "added",
        source: "join",
        requestId: "detail-request",
        discordId: "100000000000000201",
        createdAt: "2026-10-01T12:00:00.000Z",
      },
      returnUrl: "/admin/join-attempts",
    });
    expect(globalThis.__kitDetailGetCalls).toHaveLength(1);
    expect(event.setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("missing id answers 404 and releases no private cache header", async () => {
    globalThis.__kitDetailGetImpl = async () => null;
    const event = eventFor({ parent: async () => ({}) });
    await expect(load(event)).rejects.toMatchObject({
      status: 404,
      message: "Join attempt not found",
    });
    expect(event.setHeaders).not.toHaveBeenCalled();
  });

  it.each(["01", "0", "-1", "abc", "1.0"])(
    "invalid id %j answers 404 before any record lookup",
    async (id) => {
      const event = eventFor({ parent: async () => ({}), id });
      await expect(load(event)).rejects.toMatchObject({ status: 404 });
      expect(globalThis.__kitDetailGetCalls).toEqual([]);
      expect(event.setHeaders).not.toHaveBeenCalled();
    },
  );

  it("no database answers 503, never a render", async () => {
    globalThis.__kitDetailDb = null;
    const event = eventFor({ parent: async () => ({}) });
    await expect(load(event)).rejects.toMatchObject({
      status: 503,
      message: "Admin temporarily unavailable",
    });
    expect(globalThis.__kitDetailGetCalls).toEqual([]);
    expect(event.setHeaders).not.toHaveBeenCalled();
  });
});
