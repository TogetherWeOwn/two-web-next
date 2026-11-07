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

  it("retains the independent sharp and undici security overrides", () => {
    expect(manifest.overrides).toMatchObject({ sharp: "0.35.5", undici: "7.30.1" });
  });
});
