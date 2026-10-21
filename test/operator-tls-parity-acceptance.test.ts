// Operator TLS parity acceptance: both destructive CLIs (erase-member and
// revoke-sessions) enforce one shared TLS floor, and that floor is the erase
// floor. Sliced from the roadmap M192 operator-hardening slice at pin
// d8fe53590. The chase loops stay uncapped by design; this file pins only the
// shared TLS floor and its identical outcomes.
//
// Contract for the build:
// - Shared parse/validate/client TLS logic lives in bin/operator-db-core.mjs;
//   both CLIs import and use it.
// - erase-member behavior is unchanged (it already defines the floor).
// - revoke-sessions is raised to that floor: the TLS-verification override is
//   refused on every host (not only remote ones), a remote URL without
//   verify-full TLS is refused (never silently defaulted), and remote client
//   construction throws unless the effective TLS is verify-full.
// - --target mismatch outcomes are identical in both CLIs (already true; pinned
//   here so the shared-core move cannot regress them).
//
// These tests fail on current code (revoke-sessions allows what erase-member
// refuses, and the shared core does not exist) and pass after the build.
// Hermetic: validate/client unit calls plus source scans. No database.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { createEraseClient, parseEraseArgs, validateEraseEnvironment } from "../bin/erase-member.mjs";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { createRevokeClient, parseRevokeArgs, validateRevokeEnvironment } from "../bin/revoke-sessions.mjs";

const MEMBER = "100000000000000201";
const REMOTE_NO_TLS = "postgres://fixture@db.example.test/neondb";
const REMOTE_VERIFY = "postgres://fixture@db.example.test/neondb?sslmode=verify-full";
const REMOTE_ROOTCERT = "postgres://fixture@db.example.test/neondb?sslrootcert=system";
const PROD_VERIFY = "postgres://fixture@db.production.test/neondb?sslmode=verify-full";
const LOCALS = [
  "postgres://agent_test@agent-testdb:5432/two_web_next",
  "postgres://fixture@localhost:5432/postgres",
  "postgres://fixture@127.0.0.1:5432/postgres",
  "postgres://fixture@[::1]:5432/postgres",
];

const fakePostgres = () => ({});

describe("operator TLS parity: remote URLs need verify-full in both CLIs", () => {
  it("refuses a remote URL without sslmode at the erase floor in both CLIs", () => {
    for (const target of ["staging", "production"]) {
      expect(
        () => validateEraseEnvironment({ DATABASE_URL: REMOTE_NO_TLS }, target),
        `erase ${target}`,
      ).toThrow(/verify-full/);
      expect(
        () => validateRevokeEnvironment({ DATABASE_URL: REMOTE_NO_TLS }, target),
        `revoke ${target}`,
      ).toThrow(/verify-full/);
    }
  });

  it("refuses a present-but-wrong sslmode in both CLIs", () => {
    for (const query of ["?sslmode=require", "?sslmode=verify-ca", "?sslmode=disable"]) {
      const raw = `postgres://fixture@db.example.test/neondb${query}`;
      expect(
        () => validateEraseEnvironment({ DATABASE_URL: raw }, "staging"),
        `erase ${query}`,
      ).toThrow(/verify-full/);
      expect(
        () => validateRevokeEnvironment({ DATABASE_URL: raw }, "staging"),
        `revoke ${query}`,
      ).toThrow(/verify-full/);
    }
  });

  it("accepts verify-full and the sslrootcert alias in both CLIs (control)", () => {
    for (const raw of [REMOTE_VERIFY, REMOTE_ROOTCERT]) {
      expect(validateEraseEnvironment({ DATABASE_URL: raw }, "staging")).toEqual({
        databaseUrl: raw,
      });
      expect(validateRevokeEnvironment({ DATABASE_URL: raw }, "staging")).toEqual({
        databaseUrl: raw,
      });
    }
  });

  it("builds a remote client only at verify-full in both CLIs", () => {
    for (const raw of [
      REMOTE_NO_TLS,
      "postgres://fixture@db.example.test/neondb?sslmode=require",
      "postgres://fixture@db.example.test/neondb?sslmode=disable",
    ]) {
      expect(() => createEraseClient(fakePostgres, raw), `erase ${raw}`).toThrow(/verify-full/);
      expect(() => createRevokeClient(fakePostgres, raw), `revoke ${raw}`).toThrow(/verify-full/);
    }
    for (const raw of [REMOTE_VERIFY, REMOTE_ROOTCERT]) {
      let eraseOptions: Record<string, unknown> = {};
      let revokeOptions: Record<string, unknown> = {};
      createEraseClient((options: Record<string, unknown>) => {
        eraseOptions = options;
        return {};
      }, raw);
      createRevokeClient((options: Record<string, unknown>) => {
        revokeOptions = options;
        return {};
      }, raw);
      expect(eraseOptions.ssl, `erase ${raw}`).toBe("verify-full");
      expect(revokeOptions.ssl, `revoke ${raw}`).toBe("verify-full");
    }
  });
});

describe("operator TLS parity: the verification override is refused on every host", () => {
  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 on local hosts in both CLIs", () => {
    for (const local of LOCALS) {
      const env = { DATABASE_URL: local, NODE_TLS_REJECT_UNAUTHORIZED: "0" };
      expect(() => validateEraseEnvironment(env, undefined), `erase ${local}`).toThrow(
        /NODE_TLS_REJECT_UNAUTHORIZED/,
      );
      expect(() => validateRevokeEnvironment(env, undefined), `revoke ${local}`).toThrow(
        /NODE_TLS_REJECT_UNAUTHORIZED/,
      );
    }
  });

  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 on remote hosts in both CLIs (control)", () => {
    for (const target of ["staging", "production"]) {
      const env = { DATABASE_URL: REMOTE_VERIFY, NODE_TLS_REJECT_UNAUTHORIZED: "0" };
      expect(() => validateEraseEnvironment(env, target), `erase ${target}`).toThrow(
        /disables TLS verification/,
      );
      expect(() => validateRevokeEnvironment(env, target), `revoke ${target}`).toThrow(
        /disables TLS verification/,
      );
    }
  });
});

describe("operator TLS parity: --target mismatch outcomes are identical", () => {
  it("refuses each mismatch class in both CLIs and allows each matched twin", () => {
    const refusals: { url: string; target: string | undefined; message: RegExp }[] = [
      { url: REMOTE_VERIFY, target: undefined, message: /--target staging/ },
      { url: PROD_VERIFY, target: undefined, message: /--target production/ },
      { url: PROD_VERIFY, target: "staging", message: /--target production/ },
      {
        url: "postgres://fixture@localhost/prod",
        target: undefined,
        message: /--target production/,
      },
      {
        url: "postgres://fixture@localhost/prod",
        target: "staging",
        message: /--target production/,
      },
    ];
    for (const { url, target, message } of refusals) {
      expect(
        () => validateEraseEnvironment({ DATABASE_URL: url }, target),
        `erase ${url} target=${target}`,
      ).toThrow(message);
      expect(
        () => validateRevokeEnvironment({ DATABASE_URL: url }, target),
        `revoke ${url} target=${target}`,
      ).toThrow(message);
    }
    expect(validateEraseEnvironment({ DATABASE_URL: PROD_VERIFY }, "production")).toEqual({
      databaseUrl: PROD_VERIFY,
    });
    expect(validateRevokeEnvironment({ DATABASE_URL: PROD_VERIFY }, "production")).toEqual({
      databaseUrl: PROD_VERIFY,
    });
    expect(validateEraseEnvironment({ DATABASE_URL: REMOTE_VERIFY }, "staging")).toEqual({
      databaseUrl: REMOTE_VERIFY,
    });
    expect(validateRevokeEnvironment({ DATABASE_URL: REMOTE_VERIFY }, "staging")).toEqual({
      databaseUrl: REMOTE_VERIFY,
    });
    for (const local of LOCALS) {
      expect(validateEraseEnvironment({ DATABASE_URL: local }, undefined), local).toEqual({
        databaseUrl: local,
      });
      expect(validateRevokeEnvironment({ DATABASE_URL: local }, undefined), local).toEqual({
        databaseUrl: local,
      });
    }
  });

  it("accepts only staging or production as --target in both CLIs (control)", () => {
    for (const bad of ["sideways", "dev", "STAGING", ""]) {
      expect(() => parseEraseArgs([`--discord-id=${MEMBER}`, "--target", bad])).toThrow();
      expect(() => parseRevokeArgs([`--discord-id=${MEMBER}`, "--target", bad])).toThrow();
    }
    expect(parseEraseArgs([`--discord-id=${MEMBER}`, "--target", "staging"]).target).toBe(
      "staging",
    );
    expect(parseRevokeArgs([`--discord-id=${MEMBER}`, "--target", "staging"]).target).toBe(
      "staging",
    );
  });
});

describe("operator TLS parity: one shared core serves both CLIs", () => {
  it("shares parse/validate/client TLS logic through bin/operator-db-core.mjs", () => {
    const corePath = fileURLToPath(new URL("../bin/operator-db-core.mjs", import.meta.url).href);
    expect(existsSync(corePath), "bin/operator-db-core.mjs must exist").toBe(true);
    const core = readFileSync(corePath, "utf8");
    expect(core, "shared core refuses the TLS override").toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(core, "shared core requires verify-full").toMatch(/verify-full/);
    for (const cli of ["../bin/erase-member.mjs", "../bin/revoke-sessions.mjs"]) {
      const source = readFileSync(fileURLToPath(new URL(cli, import.meta.url).href), "utf8");
      expect(source, `${cli} must import the shared core`).toMatch(/operator-db-core\.mjs/);
    }
  });
});
