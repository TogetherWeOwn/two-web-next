import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operatorErrorTable } from "../bin/operator-cli-errors.mjs";
import { parseEraseArgs, validateEraseEnvironment } from "../bin/erase-member.mjs";
import { parseRevokeArgs, validateRevokeEnvironment } from "../bin/revoke-sessions.mjs";

it("keeps the documented code table identical to the shared help table", () => {
  const doc = readFileSync(new URL("../docs/member-erasure.md", import.meta.url), "utf8");
  expect(doc).toContain(operatorErrorTable());
});

for (const [name, parse, validate] of [
  ["erase-member", parseEraseArgs, validateEraseEnvironment],
  ["revoke-sessions", parseRevokeArgs, validateRevokeEnvironment],
]) {
  describe(`${name} additional boundary diagnostics`, () => {
    for (const args of [null, {}, [null], [7], ["-x"]]) {
      it(`refuses non-string argv or unknown short flags: ${JSON.stringify(args)}`, () => {
        expect(() => parse(args)).toThrow(expect.objectContaining({ code: "E_UNKNOWN_FLAG" }));
      });
    }
    it("retains positional-id compatibility", () => {
      expect(parse(["100000000000000201", "--apply"])).toEqual({
        discordId: "100000000000000201",
        mode: "apply",
        target: undefined,
      });
    });
    for (const { env, target, code } of [
      { env: {}, code: "E_DATABASE_URL" },
      {
        env: {
          DATABASE_URL: "postgres://fixture@localhost/fixture",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
        },
        code: "E_TLS_OVERRIDE",
      },
      {
        env: {
          DATABASE_URL: "postgres://fixture@db.production.invalid/fixture?sslmode=verify-full",
        },
        target: "staging",
        code: "E_PRODUCTION_TARGET",
      },
      {
        env: { DATABASE_URL: "postgres://fixture@db.fixture.invalid/fixture?sslmode=verify-full" },
        code: "E_REMOTE_TARGET",
      },
      {
        env: { DATABASE_URL: "postgres://fixture@db.fixture.invalid/fixture" },
        target: "staging",
        code: "E_TLS_REQUIRED",
      },
    ]) {
      it(`configuration exposes a typed ${code} without endpoint data`, () => {
        expect(() => validate(env, target)).toThrow(expect.objectContaining({ code }));
      });
    }
  });
}
