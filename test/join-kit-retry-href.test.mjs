// Execute the real Kit load: reverting its source arms must lose attribution
// here, not stay green behind source-text checks or a copied href builder.
// Like kit-admin-dashboard-load.test.mjs, bundle in memory so root Vitest
// needs neither Kit's generated route types nor the Workers runtime.
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

let load;

beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL("../web/src/routes/join/+page.server.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
    plugins: [
      {
        name: "join-kit-retry-href-test",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "cloudflare-workers",
            namespace: "join-kit-retry-href-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "join-kit-retry-href-test" }, () => ({
            // No guild binding: the real widget cache cannot start a network probe.
            contents: `export const env = {
              APP_URL: "https://next.example.test",
              DISCORD_INVITE_URL: "https://discord.gg/invite",
              SESSION_SECRET: "test-session-secret-at-least-32-bytes-long"
            };
            export function waitUntil() { throw new Error("unexpected background probe"); }`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const bundled = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`;
  ({ load } = await import(bundled));
});

const cases = [
  { name: "bare", query: "", href: "/join/discord" },
  {
    name: "next only",
    query: "?next=%2Fevents%3Fmonth%3D2026-10%26view%3Dlist",
    href: "/join/discord?next=%2Fevents%3Fmonth%3D2026-10%26view%3Dlist",
  },
  {
    name: "source only",
    query: "?source=Partner%3Afall-drive_01",
    href: "/join/discord?source=Partner%3Afall-drive_01",
  },
  {
    name: "next and source",
    query: "?next=%2Fevents%3Fmonth%3D2026-10%26view%3Dlist&source=Partner%3Afall-drive_01",
    href: "/join/discord?next=%2Fevents%3Fmonth%3D2026-10%26view%3Dlist&source=Partner%3Afall-drive_01",
  },
  {
    name: "hostile next with safe source",
    query: "?next=https%3A%2F%2Fevil.test%2F&source=Partner%3Afall-drive_01",
    href: "/join/discord?source=Partner%3Afall-drive_01",
  },
  {
    name: "hostile source with safe next",
    query: "?next=%2Fevents&source=a%2Fb",
    href: "/join/discord?next=%2Fevents",
  },
  {
    name: "both hostile",
    query: "?next=%2F%2Fevil.test%2F&source=bad%20source",
    href: "/join/discord",
  },
];

describe("Kit join load preserves sanitized retry intent", () => {
  it.each(cases)("$name", async ({ query, href }) => {
    const url = new URL(`/join${query}`, "https://next.example.test");
    const data = await load({
      url,
      request: new Request(url),
      cookies: {
        delete() {
          throw new Error("cookie-free landing must not delete cookies");
        },
      },
      setHeaders() {},
    });
    expect(data.oneClickHref).toBe(href);
  });
});
