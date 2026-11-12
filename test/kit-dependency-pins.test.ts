import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("web/package.json", "utf8"));
const lock = JSON.parse(readFileSync("web/package-lock.json", "utf8"));
const floors = [
  ["@sveltejs/kit", [3, 1, 1]],
  ["@sveltejs/adapter-cloudflare", [8, 0, 2]],
] as const;

describe("Kit defensive patch pins", () => {
  it.each(floors)(
    "keeps %s on an exact stable patched version in the same major",
    (name, floor) => {
      const version = manifest.devDependencies[name];
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      const [major, minor, patch] = version.split(".").map(Number);
      expect(major).toBe(floor[0]);
      expect(minor > floor[1] || (minor === floor[1] && patch >= floor[2])).toBe(true);
    },
  );

  it.each(floors)("locks %s coherently to its public registry artifact", (name) => {
    const version = manifest.devDependencies[name];
    const entry = lock.packages[`node_modules/${name}`];
    const basename = name.split("/")[1];
    expect(lock.packages[""].devDependencies[name]).toBe(version);
    expect(entry.version).toBe(version);
    expect(entry.resolved).toBe(`https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`);
    expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  it.each([
    ["@sveltejs/adapter-cloudflare", "8.0.2"],
    ["@sveltejs/kit", "3.1.1"],
    ["@sveltejs/vite-plugin-svelte", "7.3.1"],
    ["svelte", "5.57.2"],
    ["svelte-check", "4.7.7"],
    ["typescript", "6.0.3"],
    ["vite", "8.3.5"],
    ["wrangler", "4.156.1"],
  ])("retains the held %s toolchain pin", (name, version) => {
    expect(manifest.devDependencies[name]).toBe(version);
    expect(lock.packages[""].devDependencies[name]).toBe(version);
    expect(lock.packages[`node_modules/${name}`].version).toBe(version);
  });

  it.each([
    ["@cloudflare/workers-types", "5.20261101.1"],
    ["miniflare", "5.20261101.0-beta"],
    ["workerd", "1.20261101.1"],
    ["sharp", "0.35.5"],
    ["undici", "7.30.1"],
    ["lightningcss", "1.32.0"],
    ["vite/node_modules/lightningcss", "1.33.0"],
  ])("retains the held %s transitive copy", (path, version) => {
    expect(lock.packages[`node_modules/${path}`].version).toBe(version);
  });

  it("retains all held workerd and Lightning CSS platform copies", () => {
    for (const platform of ["darwin-64", "darwin-arm64", "linux-64", "linux-arm64", "windows-64"]) {
      expect(lock.packages[`node_modules/@cloudflare/workerd-${platform}`].version).toBe(
        "1.20261101.1",
      );
    }
    for (const platform of [
      "android-arm64",
      "darwin-arm64",
      "darwin-x64",
      "freebsd-x64",
      "linux-arm-gnueabihf",
      "linux-arm64-gnu",
      "linux-arm64-musl",
      "linux-x64-gnu",
      "linux-x64-musl",
      "win32-arm64-msvc",
      "win32-x64-msvc",
    ]) {
      expect(lock.packages[`node_modules/lightningcss-${platform}`].version).toBe("1.32.0");
      expect(lock.packages[`node_modules/vite/node_modules/lightningcss-${platform}`].version).toBe(
        "1.33.0",
      );
    }
  });

  it("updates Tailwind CSS without advancing its held Vite integration", () => {
    expect(manifest.devDependencies.tailwindcss).toBe("^4.3.4");
    expect(lock.packages["node_modules/tailwindcss"].version).toBe("4.3.4");
    for (const name of ["node", "vite"]) {
      const path = `node_modules/@tailwindcss/${name}`;
      expect(lock.packages[path].version).toBe("4.3.3");
      expect(lock.packages[`${path}/node_modules/tailwindcss`].version).toBe("4.3.3");
    }
  });

  it("retains the independent sharp and undici security overrides", () => {
    expect(manifest.overrides).toMatchObject({ sharp: "0.35.5", undici: "7.30.1" });
  });
});
