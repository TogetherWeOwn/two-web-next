// Kit join-attempts load must await moderator admission before touching the
// database. The layout guard owns guest (302), non-moderator (403) and
// unavailable (503) rejections; the page load must propagate those unchanged
// with zero dbFor/listJoinAttempts/setHeaders calls, and must do zero work
// while parent() is still pending. A resolving moderator admission allows the
// read and preserves the existing result/headers.
//
// Bundles the real route with esbuild (like test/kit-admin-dashboard-load)
// so a missing `await parent()` fails here instead of shipping silent reads.
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
      globalThis.__kitJoinAttemptsDbForCalls.push("dbFor");
      const v = globalThis.__kitJoinAttemptsDb;
      return typeof v === "function" ? v() : v;
    }`,
  ],
  [
    "admin-reads",
    `export const JOIN_RETENTION_DAYS = 90;
    export async function listJoinAttempts(...args) {
      globalThis.__kitJoinAttemptsListCalls.push(args);
      return globalThis.__kitJoinAttemptsListImpl(...args);
    }`,
  ],
  [
    "join-service",
    `export const JOIN_OUTCOMES = ["added", "already_member", "error", "denied", "degraded"];`,
  ],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../web/src/routes/admin/join-attempts/+page.server.ts", import.meta.url),
      ),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-join-attempts-admission-test",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-join-attempts-admission-test",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-join-attempts-admission-test",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-join-attempts-admission-test",
          }));
          build.onResolve({ filter: /src\/admin\/reads$/ }, () => ({
            path: "admin-reads",
            namespace: "kit-join-attempts-admission-test",
          }));
          build.onResolve({ filter: /src\/join\/service$/ }, () => ({
            path: "join-service",
            namespace: "kit-join-attempts-admission-test",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "kit-join-attempts-admission-test" },
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
  globalThis.__kitJoinAttemptsDbForCalls = [];
  globalThis.__kitJoinAttemptsListCalls = [];
  globalThis.__kitJoinAttemptsDb = {};
  globalThis.__kitJoinAttemptsListImpl = async () => [];
});

function makeEvent({ parent }) {
  const headers = {};
  return {
    event: {
      url: new URL("https://example.com/admin/join-attempts"),
      setHeaders: (h) => {
        Object.assign(headers, h);
      },
      parent,
    },
    headers,
  };
}

function dbForCalls() {
  return globalThis.__kitJoinAttemptsDbForCalls;
}

function listCalls() {
  return globalThis.__kitJoinAttemptsListCalls;
}

describe("Kit join-attempts load: moderator admission ordering", () => {
  it("does no database or header work while parent() is still pending", async () => {
    let resolveParent;
    const gate = new Promise((resolve) => {
      resolveParent = resolve;
    });
    const parent = () => gate;
    globalThis.__kitJoinAttemptsListImpl = async () => [];
    const { event, headers } = makeEvent({ parent });

    const pending = load(event);
    await new Promise((r) => setTimeout(r, 10));
    expect(dbForCalls()).toEqual([]);
    expect(listCalls()).toEqual([]);
    expect(headers).toEqual({});

    resolveParent({ actor: { id: "100000000000000111", username: "mod" } });
    const data = await pending;
    expect(dbForCalls().length).toBeGreaterThan(0);
    expect(listCalls().length).toBeGreaterThan(0);
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(data.rows).toEqual([]);
  });

  it("a guest redirect from parent propagates unchanged with zero work", async () => {
    const parent = async () => {
      throw Object.assign(new Error("Redirect"), {
        status: 302,
        location: "/login?next=/admin/join-attempts",
      });
    };
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/join-attempts"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const err = await load(event).then(
      () => null,
      (e) => e,
    );
    expect(err?.status).toBe(302);
    expect(err?.location).toBe("/login?next=/admin/join-attempts");
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
      url: new URL("https://example.com/admin/join-attempts"),
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
      url: new URL("https://example.com/admin/join-attempts"),
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
    const createdAt = new Date("2026-10-01T00:00:00.000Z");
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `attempt-${i}`,
      outcome: "added",
      source: "join",
      requestId: `req-${i}`,
      discordId: `discord-${i}`,
      createdAt,
    }));
    globalThis.__kitJoinAttemptsListImpl = async () => rows;
    const headerCalls = [];
    const event = {
      url: new URL("https://example.com/admin/join-attempts"),
      setHeaders: (h) => headerCalls.push(h),
      parent,
    };
    const data = await load(event);
    expect(listCalls().length).toBe(1);
    expect(dbForCalls().length).toBe(1);
    expect(headerCalls).toEqual([{ "cache-control": "private, no-store" }]);
    expect(data.rows).toHaveLength(100);
    expect(data.rows[0]).toEqual({
      id: "attempt-0",
      outcome: "added",
      source: "join",
      requestId: "req-0",
      discordId: "discord-0",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(data.hasNext).toBe(true);
    expect(data.retentionDays).toBe(90);
    expect(data.outcomes).toContain("added");
    expect(data.contextSearch).toBe("?from_outcome=&from_q=&from_page=1");
    expect(data.emptyText).toBe(
      "No join attempts recorded in the last 90 days (the retention window).",
    );
    expect(data.firstPageUrl).toBeNull();
  });

  it.each(["future", " added", "added ", "Added", '"><script>alert(1)</script>', "A & B"])(
    "prepares diagnostic text and the exact unknown outcome %j on the server",
    async (outcome) => {
      globalThis.__kitJoinAttemptsListImpl = async () => [
        {
          id: 7,
          outcome: "future",
          source: null,
          requestId: " ",
          discordId: "  recorded  ",
          createdAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      ];
      const { event } = makeEvent({ parent: async () => ({}) });
      event.url = new URL(
        `https://example.com/admin/join-attempts?${new URLSearchParams({ outcome })}`,
      );
      const data = await load(event);
      expect(data.rows[0]).toEqual({
        id: 7,
        outcome: "future",
        source: "Not recorded",
        requestId: "Not recorded",
        discordId: "  recorded  ",
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      expect(data.outcomes).toEqual([
        "added",
        "already_member",
        "error",
        "denied",
        "degraded",
        outcome,
      ]);
      expect(data.evidenceNote).toBe(
        "Not recorded means evidence is missing, not verified anonymity. Missing evidence does not prove success or that no join was attempted. Ordinary sign-in does not write these records.",
      );
      expect(listCalls()).toHaveLength(1);
    },
  );

  it("prepares filter-preserving recovery and context after admission without another read", async () => {
    const { event } = makeEvent({ parent: async () => ({}) });
    event.url = new URL("https://example.com/admin/join-attempts?outcome=error&q=exact&page=2");
    const data = await load(event);
    expect(data.contextSearch).toBe("?from_outcome=error&from_q=exact&from_page=2");
    expect(data.emptyText).toBe("No join attempts on this page. Try the first page.");
    expect(data.firstPageUrl).toBe("/admin/join-attempts?page=1&outcome=error&q=exact");
    expect(listCalls()).toHaveLength(1);
    expect(dbForCalls()).toHaveLength(1);
  });
});
