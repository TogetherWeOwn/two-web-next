// Root layout requestId forwarding: web/src/routes/+layout.server.ts turns the
// dispatch's locals id into page.data.requestId for every page and error
// boundary. The boundary suites pin that +error.svelte reads page.data and
// the dispatch suite pins that locals carries the id; this file pins the
// middle link, which no suite executed before (returning undefined kept 92
// targeted tests green).
//
// Same bundling pattern as test/kit-activity-log-load.test.mjs: the root
// Vitest config does not run SvelteKit's sync hook, so Vite/OXC cannot
// resolve the route's generated `$app/tsconfig`. Bundle the real route with
// esbuild instead. Keep the real request-log validator and virtualize only
// the Workers env and the session bridge. These no-notice requests exercise
// the excluded path; banner composition is covered in the paired banner suite.
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const RAY = "0123456789abcdef-LHR";
const ULID = "01ARYZ6S41AAAAAAAAAAAAAAAA";

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../web/src/routes/+layout.server.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "root-layout-session-fixture",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$|src\/kit-session$/ }, ({ path }) => ({
            path,
            namespace: "root-layout-session-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "root-layout-session-fixture" }, ({ path }) => ({
            contents:
              path === "cloudflare:workers"
                ? "export const env = {};"
                : "export const isRestoredBannerEligible = () => false; export const readReturnJourney = () => { throw new Error('excluded request must not peek'); };",
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

describe("Kit root layout load: requestId forwarding", () => {
  it("forwards a validated cf-ray verbatim", async () => {
    expect(
      await load({
        request: new Request("https://example.test/auth/recover"),
        locals: { requestId: RAY },
      }),
    ).toEqual({ restoredWrite: null, requestId: RAY });
  });

  it("forwards a validated ULID verbatim", async () => {
    expect(
      await load({
        request: new Request("https://example.test/auth/recover"),
        locals: { requestId: ULID },
      }),
    ).toEqual({ restoredWrite: null, requestId: ULID });
  });

  it("serializes only the safe reference, never member or session locals", async () => {
    const payload = await load({
      request: new Request("https://example.test/auth/recover"),
      locals: {
        requestId: RAY,
        session: { username: "private-member", token: "private-token" },
        userId: "123456789012345678",
        email: "private@example.test",
      },
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ restoredWrite: null, requestId: RAY });
  });

  it("drops a hostile locals id to undefined", async () => {
    expect(
      await load({
        request: new Request("https://example.test/auth/recover"),
        locals: { requestId: "<script>alert(1)</script>" },
      }),
    ).toEqual({
      restoredWrite: null,
      requestId: undefined,
    });
  });

  it("renders blank-safe when locals carries no id", async () => {
    expect(
      await load({ request: new Request("https://example.test/auth/recover"), locals: {} }),
    ).toEqual({ restoredWrite: null, requestId: undefined });
    expect(
      await load({
        request: new Request("https://example.test/auth/recover"),
        locals: { requestId: undefined },
      }),
    ).toEqual({ restoredWrite: null, requestId: undefined });
  });

  it("drops a non-string locals id to undefined", async () => {
    expect(
      await load({
        request: new Request("https://example.test/auth/recover"),
        locals: { requestId: 42 },
      }),
    ).toEqual({ restoredWrite: null, requestId: undefined });
  });
});
