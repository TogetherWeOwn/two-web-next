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
// esbuild instead — no stubs needed, since its only value import is the pure
// src/request-log validator and the $types import is type-only.
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
  });
  const source = outputFiles[0].text;
  const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  ({ load } = await import(bundled));
});

describe("Kit root layout load: requestId forwarding", () => {
  it("forwards a validated cf-ray verbatim", () => {
    expect(load({ locals: { requestId: RAY } })).toEqual({ requestId: RAY });
  });

  it("forwards a validated ULID verbatim", () => {
    expect(load({ locals: { requestId: ULID } })).toEqual({ requestId: ULID });
  });

  it("serializes only the safe reference, never member or session locals", () => {
    const payload = load({
      locals: {
        requestId: RAY,
        session: { username: "private-member", token: "private-token" },
        userId: "123456789012345678",
        email: "private@example.test",
      },
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ requestId: RAY });
  });

  it("drops a hostile locals id to undefined", () => {
    expect(load({ locals: { requestId: "<script>alert(1)</script>" } })).toEqual({
      requestId: undefined,
    });
  });

  it("renders blank-safe when locals carries no id", () => {
    expect(load({ locals: {} })).toEqual({ requestId: undefined });
    expect(load({ locals: { requestId: undefined } })).toEqual({ requestId: undefined });
  });

  it("drops a non-string locals id to undefined", () => {
    expect(load({ locals: { requestId: 42 } })).toEqual({ requestId: undefined });
  });
});
