// Kit admin event-create load wiring: the guard-first/no-store decisions in
// web/src/routes/admin/events/new/+page.server.ts are behavioural, not source
// text. buildEventCreateView is unit-tested; this drives the real load so a
// dropped parent() await or a missing cache header fails here instead of
// shipping a guard bypass or a shared-cacheable moderator form.
//
// The root Vitest config does not run SvelteKit's sync hook, so Vite/OXC
// cannot resolve the route's generated `$app/tsconfig`. Bundle the real route
// with esbuild instead, stubbing only its framework import.
import { build } from "esbuild";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const virtualModules = new Map([
  [
    "sveltekit",
    `export function error(status, message) {
      throw Object.assign(new Error(message), { status });
    }`,
  ],
]);

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL("../web/src/routes/admin/events/new/+page.server.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "kit-admin-event-create-load-test",
        setup(build) {
          build.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
            path: "sveltekit",
            namespace: "kit-admin-event-create-load-test",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "kit-admin-event-create-load-test" },
            ({ path }) => ({
              contents: virtualModules.get(path),
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const source = outputFiles[0].text;
  const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  ({ load } = await import(bundled));
});

const actor = { id: "100000000000000111", username: "mod" };

describe("Kit admin event-create load: guard and cache wiring", () => {
  it("awaits the layout guard before returning the empty form", async () => {
    let entered = false;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const parent = async () => {
      entered = true;
      await gate;
      return { actor };
    };
    const setHeaders = vi.fn();
    let settled = false;
    const pending = load({ parent, setHeaders }, {}).then((value) => {
      settled = true;
      return value;
    });
    for (let i = 0; i < 100 && !entered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(entered).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release();
    const data = await pending;
    expect(data).toEqual({ values: {}, errors: {}, hasErrors: false, isDraft: false });
    expect(data.hasErrors).toBe(false);
    expect(data.isDraft).toBe(false);
    expect(setHeaders).toHaveBeenCalledOnce();
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("propagates a guest redirect and sets no cache headers", async () => {
    const redirect = Object.assign(new Error("redirect"), {
      status: 302,
      location: "/auth/discord",
    });
    const parent = async () => {
      throw redirect;
    };
    const setHeaders = vi.fn();
    const err = await load({ parent, setHeaders }, {}).catch((e) => e);
    expect(err).toBe(redirect);
    expect(setHeaders).not.toHaveBeenCalled();
  });
});
