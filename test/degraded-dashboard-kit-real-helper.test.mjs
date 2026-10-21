// Builder-owned companion to
// test/degraded-dashboard-kit-logging-acceptance.test.mjs (which the Test
// Author owns and this card must not edit): the real widget helpers resolve
// undefined — not rejection — on funnel cancellations and ordinary failures,
// so the Kit load must log the omitted section for fulfilled-undefined
// settlements too, and each request-id candidate must be validated before
// fallback selection. Drives the real load (esbuild bundle, like the
// acceptance file) with a fake Db.
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
        name: "kit-dashboard-real-helper",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-dashboard-real-helper",
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "kit-dashboard-real-helper",
          }));
          build.onResolve({ filter: /src\/admin\/db$/ }, () => ({
            path: "admin-db",
            namespace: "kit-dashboard-real-helper",
          }));
          build.onLoad({ filter: /.*/, namespace: "kit-dashboard-real-helper" }, ({ path }) => ({
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
const RAY_X = "fedcba9876543210-CDG";

const actor = { id: "100000000000000111", username: "mod" };
const parent = async () => ({ actor });

/** Funnel cancels through the real helper; the zero-search read stays healthy. */
function cancellingFunnelDb() {
  let calls = 0;
  vi.stubGlobal("__kitDashboardLogDb", {
    transaction: async () => {
      if (++calls === 1) throw cancellation();
      return [];
    },
  });
}

function event(headers, requestId) {
  return {
    parent,
    request: new Request("https://next.example.test/admin", { headers }),
    locals: requestId === undefined ? {} : { requestId },
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

describe("degraded Kit dashboard widgets resolve undefined through the real helpers", () => {
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

  it("a funnel statement cancellation logs one funnel line and omits only the funnel", async () => {
    cancellingFunnelDb();
    const data = await load(event({ "cf-ray": RAY, "x-request-id": RAY }, RAY), {});
    expect(data.funnel).toBeUndefined();
    expect(data.zeroSearches).toEqual([]);
    const lines = widgetLines(/funnel/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(RAY);
    expect(widgetLines(/zero.?searches/i)).toEqual([]);
  });

  it("an invalid cf-ray falls back to the valid x-request-id", async () => {
    cancellingFunnelDb();
    const data = await load(
      event({ "cf-ray": "not-a-ray-id", "x-request-id": RAY_X }, undefined),
      {},
    );
    expect(data.funnel).toBeUndefined();
    const lines = widgetLines(/funnel/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(RAY_X);
  });

  it("a valid cf-ray keeps precedence over x-request-id", async () => {
    cancellingFunnelDb();
    await load(event({ "cf-ray": RAY, "x-request-id": RAY_X }, undefined), {});
    const lines = widgetLines(/funnel/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(RAY);
    expect(lines[0]).not.toContain(RAY_X);
  });

  it("missing header ids fall back to the locals request id", async () => {
    cancellingFunnelDb();
    await load(event({}, RAY), {});
    const lines = widgetLines(/funnel/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(RAY);
  });
});
