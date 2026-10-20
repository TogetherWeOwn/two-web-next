// Kit admin dashboard load wiring: the outage-to-503 decision in
// web/src/routes/admin/+page.server.ts is behavioural, not source text.
// resolveDashboardWidgets is unit-tested; this drives the real load with a
// fake Db so an inverted `if (!widgets.outage)` fails here instead of
// shipping a 500/503 swap silently.
//
// The root Vitest config does not run SvelteKit's sync hook, so Vite/OXC cannot
// resolve the route's generated `$app/tsconfig`. Bundle the real route with
// esbuild instead, stubbing only its framework and database-binding imports.
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const virtualModules = new Map([
  [
    "sveltekit",
    `export function error(status, message) {
      throw Object.assign(new Error(message), { status });
    }`,
  ],
  ["cloudflare-workers", "export const env = {};"],
  ["admin-db", "export async function dbFor() { return globalThis.__kitAdminDashboardDb; }"],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL("../web/src/routes/admin/+page.server.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-admin-dashboard-load-test",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-admin-dashboard-load-test",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-admin-dashboard-load-test",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-admin-dashboard-load-test",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "kit-admin-dashboard-load-test" },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

const actor = { id: "100000000000000111", username: "mod" };
const parent = async () => ({ actor });

const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

describe("Kit admin dashboard load: outage wiring", () => {
  it("a refused database makes the load throw 503, never page data", async () => {
    const fakeDb = {
      transaction: async () => {
        throw refused();
      },
    };
    vi.stubGlobal("__kitAdminDashboardDb", fakeDb);
    const err = await load({ parent }, {}).catch((e) => e);
    expect(err?.status).toBe(503);
  });

  it.each([false, true])(
    "zero-search outage throws 503 with funnel cache warm=%s",
    async (warm) => {
      let outage = false;
      let calls = 0;
      const fakeDb = {
        transaction: vi.fn(async () => {
          if (outage) throw refused();
          return ++calls === 1 ? { added: 3 } : [];
        }),
      };
      vi.stubGlobal("__kitAdminDashboardDb", fakeDb);
      if (warm) expect((await load({ parent }, {})).funnel).toEqual({ added: 3 });
      else {
        fakeDb.transaction.mockImplementationOnce(async () => ({ added: 3 }));
      }
      outage = true;
      await expect(load({ parent }, {})).rejects.toMatchObject({ status: 503 });
      expect(fakeDb.transaction).toHaveBeenCalledTimes(warm ? 3 : 2);
    },
  );

  it.each([
    Object.assign(new Error("missing table"), { code: "42P01", name: "PostgresError" }),
    new TypeError("programming error"),
    Object.assign(new Error("statement timeout"), { code: "57014", name: "PostgresError" }),
  ])("an ordinary zero-search failure preserves the funnel: %s", async (error) => {
    let calls = 0;
    vi.stubGlobal("__kitAdminDashboardDb", {
      transaction: async () => {
        if (++calls === 1) return { added: 3 };
        throw error;
      },
    });
    const data = await load({ parent }, {});
    expect(data.funnel).toEqual({ added: 3 });
    expect(data.zeroSearches).toBeUndefined();
  });

  it("a zero-search deadline omits only that section", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.stubGlobal("__kitAdminDashboardDb", {
        transaction: async () => (++calls === 1 ? { added: 3 } : new Promise(() => {})),
      });
      const pending = load({ parent }, {});
      await vi.advanceTimersByTimeAsync(1500);
      const data = await pending;
      expect(data.funnel).toEqual({ added: 3 });
      expect(data.zeroSearches).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a moderator dashboard load succeeds when optional database widgets are unavailable", async () => {
    vi.stubGlobal("__kitAdminDashboardDb", null);
    const data = await load({ parent }, {});
    expect(data.actor).toEqual(actor);
    expect(data.funnel).toBeUndefined();
    expect(data.zeroSearches).toBeUndefined();
  });

  it("an ordinary widget failure resolves with omitted sections, never 503", async () => {
    const fakeDb = {
      transaction: async () => {
        throw new Error("syntax error at end of input");
      },
    };
    vi.stubGlobal("__kitAdminDashboardDb", fakeDb);
    const data = await load({ parent }, {});
    expect(data.funnel).toBeUndefined();
    expect(data.zeroSearches).toBeUndefined();
  });
});
