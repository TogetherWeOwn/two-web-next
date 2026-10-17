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
