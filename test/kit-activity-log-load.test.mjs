// Kit activity-log load wiring: the guard-ordering decision in
// web/src/routes/admin/activity-log/+page.server.ts is behavioural, not
// source text. SvelteKit starts layout and page server loads together, so the
// page must await parent() before the member-subject read: otherwise a guest
// or non-moderator request runs listActivityLog — declaring snowflake causers
// as member subjects — before the layout guard's 302/403 settles, and a still
// pending read turns the bounce into a 503 or writes an access-log row for a
// refused viewer. Awaiting parent() suspends the read until the guard
// resolves, and the guard's redirect/error propagates before any database
// work; only helper failures map to 503.
//
// The root Vitest config does not run SvelteKit's sync hook, so Vite/OXC cannot
// resolve the route's generated `$app/tsconfig`. Bundle the real route with
// esbuild instead, stubbing only its framework, env, and helper imports.
import { build } from "esbuild";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    "kit-activity-log",
    `export async function loadActivityLogPage(args) {
      globalThis.__kitActivityLogCalls.push(args);
      if (globalThis.__kitActivityLogImpl) return globalThis.__kitActivityLogImpl(args);
      return { rows: [], query: { subject: "", causer: "", page: 1 }, hasNext: false };
    }`,
  ],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../web/src/routes/admin/activity-log/+page.server.ts", import.meta.url),
      ),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-activity-log-load-test",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-activity-log-load-test",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-activity-log-load-test",
          }));
          build.onResolve({ filter: /src\/admin\/kit-activity-log$/ }, () => ({
            path: "kit-activity-log",
            namespace: "kit-activity-log-load-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "kit-activity-log-load-test" }, ({ path }) => ({
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

beforeEach(() => {
  globalThis.__kitActivityLogCalls = [];
  delete globalThis.__kitActivityLogImpl;
});

afterEach(() => {
  delete globalThis.__kitActivityLogCalls;
  delete globalThis.__kitActivityLogImpl;
});

const actor = { id: "100000000000000111", username: "mod" };
const url = (qs = "") => new URL(`https://example.test/admin/activity-log${qs}`);
const setHeaders = () => {};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Kit activity-log load: guard ordering", () => {
  it("awaits parent() before the helper: no read while the guard is pending", async () => {
    const order = [];
    let resolveParent;
    const parent = () =>
      new Promise((resolve) => {
        order.push("parent-start");
        resolveParent = () => {
          order.push("parent-end");
          resolve({ actor });
        };
      });
    globalThis.__kitActivityLogImpl = async () => {
      order.push("helper");
      return { rows: [], query: { subject: "", causer: "", page: 1 }, hasNext: false };
    };
    // SvelteKit always supplies locals; the binding forwards its requestId.
    const pending = load({ parent, url: url(), locals: {}, setHeaders });
    await tick();
    // The guard has not settled: the member-subject read must not have run.
    expect(globalThis.__kitActivityLogCalls).toHaveLength(0);
    resolveParent();
    await pending;
    expect(order).toEqual(["parent-start", "parent-end", "helper"]);
    expect(globalThis.__kitActivityLogCalls).toHaveLength(1);
  });

  it("a guest redirect from parent() runs no activity-log read", async () => {
    const redirect = Object.assign(new Error("redirect"), {
      status: 302,
      location: "/auth/discord",
    });
    const err = await load({
      parent: async () => {
        throw redirect;
      },
      url: url("?causer=100000000000000111"),
      locals: {},
      setHeaders,
    }).catch((e) => e);
    expect(err?.status).toBe(302);
    expect(globalThis.__kitActivityLogCalls).toHaveLength(0);
  });

  it("a non-moderator 403 from parent() runs no activity-log read", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
    const err = await load({
      parent: async () => {
        throw forbidden;
      },
      url: url("?causer=100000000000000111"),
      locals: {},
      setHeaders,
    }).catch((e) => e);
    expect(err?.status).toBe(403);
    expect(globalThis.__kitActivityLogCalls).toHaveLength(0);
  });

  it("a moderator guard runs the read once with the page query", async () => {
    const out = await load({
      parent: async () => ({ actor }),
      url: url("?subject=Alpha&page=2"),
      locals: { requestId: "01ARYZ6S41AAAAAAAAAAAAAAAA" },
      setHeaders,
    });
    expect(globalThis.__kitActivityLogCalls).toHaveLength(1);
    expect(globalThis.__kitActivityLogCalls[0]).toMatchObject({
      subjectParam: "Alpha",
      pageParam: "2",
      requestId: "01ARYZ6S41AAAAAAAAAAAAAAAA",
    });
    expect(out).toMatchObject({ hasNext: false });
  });

  it("a helper failure after the guard passes still maps to 503", async () => {
    globalThis.__kitActivityLogImpl = async () => {
      throw new Error("seam down");
    };
    const err = await load({
      parent: async () => ({ actor }),
      url: url(),
      locals: {},
      setHeaders,
    }).catch((e) => e);
    expect(err?.status).toBe(503);
  });
});
