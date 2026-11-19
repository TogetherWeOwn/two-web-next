import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./helpers/get-uri-ftp-fixture.mjs", import.meta.url).href);
const root = fileURLToPath(new URL("..", import.meta.url).href);

// Exercise both actual consumers, including the metadata fallback and download.
describe("get-uri FTP compatibility with the basic-ftp override", () => {
  for (const chain of ["lhci", "browser-helper"]) {
    for (const scenario of ["mdtm", "list-fallback"]) {
      it(`${chain}: ${scenario === "mdtm" ? "MDTM success" : "non-550 MDTM error falls back to LIST"}`, () => {
        const result = spawnSync(process.execPath, [fixture, chain, scenario], {
          cwd: root,
          encoding: "utf8",
          timeout: 20000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain(`ok ${chain} ${scenario}`);
      });
    }
  }
});
