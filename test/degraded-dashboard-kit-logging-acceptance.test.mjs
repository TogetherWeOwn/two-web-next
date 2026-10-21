// Acceptance (roadmap Q6, errors): a degraded Kit dashboard widget logs one
// console.warn/console.info line carrying the widget name and the request's
// correlation id — the same contract as the Hono twin. Drives the real load
// (esbuild bundle, like kit-admin-dashboard-load.test.mjs) with a fake Db,
// so a missing log line fails here. Failing-first: the widget-line
// assertions fail until the Q6 build lands. Owned by the Test Author: do not
// edit this file on the build card — return incorrect tests to the Test
// Author instead.
import { build } from "esbuild";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const virtualModules = new Map([
  [
    "sveltekit",
    `export function error(status, message) {
      throw Object.assign(new Error(message), { status });
    }`,
  ],
  ["cloudflare-workers", "export const env = {};"],
  ["admin-db", "export async function dbFor() { return globalThis.__kitDashboardLogDb; }"],
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
        name: "kit-dashboard-log-acceptance",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-dashboard-log-acceptance",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-dashboard-log-acceptance",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-dashboard-log-acceptance",
          }));
          build.onLoad({ filter: /.*/, namespace: "kit-dashboard-log-acceptance" }, ({ path }) => ({
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

const RAY = "0123456789abcdef-LHR";

const actor = { id: "100000000000000111", username: "mod" };
const parent = async () => ({ actor });

/** Every plausible request-id source carries the same value. */
function event() {
  return {
    parent,
    request: new Request("https://next.example.test/admin", {
      headers: { "cf-ray": RAY, "x-request-id": RAY },
    }),
    locals: { requestId: RAY },
  };
}

function widgetLines(pattern) {
  const out = [];
  for (const spy of [vi.mocked(console.warn), vi.mocked(console.info)]) {
    for (const call of spy.mock.calls) {
      const line = call
        .map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg))))
        .join(" ");
      if (pattern.test(line)) out.push(line);
    }
  }
  return out;
}

const cancellation = () =>
  Object.assign(new Error("statement timeout"), {
    code: "57014",
    name: "PostgresError",
  });

describe("degraded Kit dashboard widgets log one correlated line", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a cancelled zero-search widget logs one line with the widget name and request id", async () => {
    let calls = 0;
    vi.stubGlobal("__kitDashboardLogDb", {
      transaction: async () => {
        if (++calls === 1) return { added: 3 };
        throw cancellation();
      },
    });
    const data = await load(event(), {});
    expect(data.funnel).toEqual({ added: 3 });
    expect(data.zeroSearches).toBeUndefined();
    const lines = widgetLines(/zero.?searches/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(RAY);
  });

  // No funnel/ordinary-failure line tests: the real helpers resolve
  // undefined on funnel cancellations and ordinary failures
  // (dashboardJoinFunnel/topZeroResultSearches catch them), so those
  // settlements are fulfilled and the settlement-layer contract emits no
  // line for them. The only rejected-but-swallowed settlement the real
  // helpers produce is a zero-search cancellation, covered above.
  it("healthy widgets log no widget lines (control)", async () => {
    let calls = 0;
    vi.stubGlobal("__kitDashboardLogDb", {
      transaction: async () => (++calls === 1 ? { added: 3 } : []),
    });
    const data = await load(event(), {});
    expect(data.funnel).toEqual({ added: 3 });
    expect(data.zeroSearches).toEqual([]);
    expect(widgetLines(/funnel|zero.?searches/i)).toEqual([]);
  });

  it("a refused database keeps the 503 outage (control)", async () => {
    vi.stubGlobal("__kitDashboardLogDb", {
      transaction: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
        });
      },
    });
    const err = await load(event(), {}).catch((e) => e);
    expect(err?.status).toBe(503);
  });
});
