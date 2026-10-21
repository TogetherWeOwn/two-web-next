// Seed-staging guard parity acceptance: destructive `bin/seed-staging.mjs`
// enforces the erase-grade operator-db floor, and that floor is single-sourced
// from `bin/operator-db-core.mjs`. Sliced from the roadmap M219 H6 slice at pin
// 8fdb4e44. Seed keeps its own semantics (staging/local APP_URL allowlist plus
// outright prod refusal, no --target flow); only the TLS and prod-guard legs
// are raised to the core.
//
// Contract for the build:
// - Remote seed connections require verify-full TLS (or sslrootcert alias);
//   `require` is refused; local/test paths are unchanged.
// - `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused on every host.
// - Prod-host regex, denied names, and local hosts are single-sourced with the
//   core (import, not copy); seed's outright prod refusal and APP_URL allowlist
//   are preserved.
//
// These tests fail on current main (seed admits `require`, defaults non-test
// clients to `require`, never checks the TLS override, refuses `sslrootcert`,
// and duplicates the core without importing it) and pass only after the
// unification. Hermetic: validate/client unit calls, dry-run CLI spawns (no
// driver connection), and source scans. No database, offline only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGING_APP_URL } from "../src/qa";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { createSeedClient, validateEnvironment } from "../bin/seed-staging.mjs";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { isProductionDatabaseUrl, LOCAL_HOSTS } from "../bin/operator-db-core.mjs";

const script = fileURLToPath(new URL("../bin/seed-staging.mjs", import.meta.url).href);
const LOCAL_DB = "postgres://agent_test@agent-testdb:5432/two_web_next";
const REMOTE_BASE = "postgres://fixture:synthetic-password@ep-staging.example.neon.tech/neondb";
const REMOTE_NO_TLS = REMOTE_BASE;
const REMOTE_REQUIRE = `${REMOTE_BASE}?sslmode=require`;
const REMOTE_VERIFY = `${REMOTE_BASE}?sslmode=verify-full`;
const REMOTE_ROOTCERT = `${REMOTE_BASE}?sslrootcert=system`;

const localEnv = {
  APP_URL: "http://localhost:8787",
  SEED_CONFIRM: "staging",
  DATABASE_URL: LOCAL_DB,
};
const remoteEnvFor = (databaseUrl: string) => ({
  APP_URL: STAGING_APP_URL,
  SEED_CONFIRM: "staging",
  DATABASE_URL: databaseUrl,
  SEED_STAGING_DB_HOST: "ep-staging.example.neon.tech",
  SEED_STAGING_DB_NAME: "neondb",
  SEED_PRODUCTION_DB_HOSTS: "ep-live.example.neon.tech,ep-live-pooler.example.neon.tech",
});
const run = (args: string[] = [], env: Record<string, string>) =>
  spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 20_000 });
// Seed passes (rawUrl, options) to the driver; capture the options to pin TLS.
const captureOptions =
  (calls: Record<string, unknown>[]) => (_url: string, options: Record<string, unknown>) => {
    calls.push(options);
    return options;
  };

describe("seed guard parity: remote URLs need verify-full like the operator floor", () => {
  it("refuses a remote URL without sslmode (never silently defaults)", () => {
    expect(() => validateEnvironment(remoteEnvFor(REMOTE_NO_TLS))).toThrow(/verify-full/);
  });

  it("refuses sslmode=require on a remote URL", () => {
    expect(() => validateEnvironment(remoteEnvFor(REMOTE_REQUIRE))).toThrow(/verify-full/);
  });

  it("refuses present-but-wrong sslmode values on a remote URL (control)", () => {
    for (const query of ["?sslmode=verify-ca", "?sslmode=disable"]) {
      expect(() => validateEnvironment(remoteEnvFor(`${REMOTE_BASE}${query}`)), query).toThrow(
        /Refusing seed:/,
      );
    }
  });

  it("accepts sslmode=verify-full on a remote URL (control)", () => {
    expect(validateEnvironment(remoteEnvFor(REMOTE_VERIFY))).toMatchObject({
      host: "ep-staging.example.neon.tech",
      name: "neondb",
    });
  });

  it("accepts the sslrootcert alias on a remote URL", () => {
    expect(validateEnvironment(remoteEnvFor(REMOTE_ROOTCERT))).toMatchObject({
      host: "ep-staging.example.neon.tech",
      name: "neondb",
    });
  });
});

describe("seed guard parity: remote client construction needs verify-full", () => {
  it("defaults a non-test client to verify-full, never require", () => {
    const calls: Record<string, unknown>[] = [];
    // Either shape is a pass after the unification: throw unless verify-full
    // (like the core) or default the effective TLS to verify-full. Returning
    // `require` is the current gap and must fail.
    let options: Record<string, unknown> | undefined;
    let refusal: unknown;
    try {
      options = createSeedClient(captureOptions(calls), REMOTE_NO_TLS) as Record<string, unknown>;
    } catch (error) {
      refusal = error;
    }
    if (refusal !== undefined) {
      expect((refusal as Error).message).toMatch(/verify-full/);
    } else {
      expect(options?.ssl, "non-test default must be verify-full").toBe("verify-full");
    }
  });

  it("refuses explicit sslmode=require when building a remote client", () => {
    const calls: Record<string, unknown>[] = [];
    expect(() => createSeedClient(captureOptions(calls), REMOTE_REQUIRE)).toThrow(/verify-full/);
  });

  it("builds a remote client at verify-full (control)", () => {
    const calls: Record<string, unknown>[] = [];
    const options = createSeedClient(captureOptions(calls), REMOTE_VERIFY) as Record<
      string,
      unknown
    >;
    expect(options.ssl).toBe("verify-full");
  });

  it("builds a remote client at the sslrootcert alias as verify-full", () => {
    const calls: Record<string, unknown>[] = [];
    const options = createSeedClient(captureOptions(calls), REMOTE_ROOTCERT) as Record<
      string,
      unknown
    >;
    expect(options.ssl).toBe("verify-full");
  });

  it("keeps the test client without TLS (control)", () => {
    const calls: Record<string, unknown>[] = [];
    const options = createSeedClient(captureOptions(calls), LOCAL_DB) as Record<string, unknown>;
    expect(options).toMatchObject({ host: "agent-testdb", ssl: false });
  });
});

describe("seed guard parity: the TLS override is refused on every host", () => {
  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 on the local test path", () => {
    expect(() => validateEnvironment({ ...localEnv, NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow(
      /NODE_TLS_REJECT_UNAUTHORIZED/,
    );
  });

  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 on a remote path", () => {
    expect(() =>
      validateEnvironment({ ...remoteEnvFor(REMOTE_VERIFY), NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    ).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

describe("seed guard parity: prod refusal via the shared core, outright in seed", () => {
  it("refuses production hosts outright, with the denylist winning over the allowlist (control)", () => {
    for (const host of [
      "db.production.test",
      "prod.example.test",
      "my-prod-db.example.test",
      "ep-live.example.neon.tech",
    ]) {
      const env = {
        ...remoteEnvFor(`postgres://fixture:synthetic-password@${host}/neondb?sslmode=verify-full`),
        SEED_STAGING_DB_HOST: host,
      };
      expect(() => validateEnvironment(env), host).toThrow(/production database host/);
    }
    // Configured denylist wins even when the allowlist names the same host.
    expect(() =>
      validateEnvironment({
        ...remoteEnvFor(REMOTE_VERIFY),
        SEED_PRODUCTION_DB_HOSTS: "EP-STAGING.EXAMPLE.NEON.TECH.",
      }),
    ).toThrow(/production database host/);
  });

  it("refuses production names outright, including configured names (control)", () => {
    for (const name of ["prod", "production", "PROD"]) {
      expect(
        () =>
          validateEnvironment({
            ...localEnv,
            DATABASE_URL: `postgres://agent_test@agent-testdb/${name}`,
          }),
        name,
      ).toThrow(/production database name/);
    }
    expect(() =>
      validateEnvironment({ ...localEnv, SEED_PRODUCTION_DB_NAMES: "two_web_next" }),
    ).toThrow(/production database name/);
  });

  it("agrees with the shared core on production-looking URLs (control)", () => {
    // Behavioral parity pin: seed and the core must agree on these shared
    // cases, so the import move cannot silently widen or narrow the refusal.
    const prodCases = [
      "postgres://fixture@db.production.test/neondb?sslmode=verify-full",
      "postgres://fixture@prod.example.test/neondb?sslmode=verify-full",
      "postgres://agent_test@agent-testdb/prod",
      "postgres://agent_test@agent-testdb/production",
    ];
    for (const raw of prodCases) {
      expect(isProductionDatabaseUrl(raw), `core must flag ${raw}`).toBe(true);
      const env = raw.includes("agent-testdb")
        ? { ...localEnv, DATABASE_URL: raw }
        : remoteEnvFor(raw);
      expect(() => validateEnvironment(env), `seed must refuse ${raw}`).toThrow(
        /production database/,
      );
    }
    expect(isProductionDatabaseUrl(REMOTE_VERIFY)).toBe(false);
    expect(isProductionDatabaseUrl(LOCAL_DB)).toBe(false);
    expect(LOCAL_HOSTS.has("agent-testdb")).toBe(true);
  });

  it("has no production-target escape: prod is always refused (control)", () => {
    // Seed keeps outright refusal; unlike the operator CLIs there is no
    // --target production flow that admits a prod host or name.
    expect(() =>
      validateEnvironment({
        ...localEnv,
        DATABASE_URL: "postgres://agent_test@agent-testdb/production",
      }),
    ).toThrow(/production database name/);
    expect(() =>
      validateEnvironment(remoteEnvFor("postgres://fixture@db.production.test/x")),
    ).toThrow(/production database host/);
  });

  it("single-sources prod/TLS guards from bin/operator-db-core.mjs", () => {
    const corePath = fileURLToPath(new URL("../bin/operator-db-core.mjs", import.meta.url).href);
    expect(existsSync(corePath), "bin/operator-db-core.mjs must exist").toBe(true);
    const seedPath = fileURLToPath(new URL("../bin/seed-staging.mjs", import.meta.url).href);
    const source = readFileSync(seedPath, "utf8");
    expect(source, "seed must import the shared operator-db core").toMatch(/operator-db-core\.mjs/);
  });
});

describe("seed guard parity: local/test allowlist and APP_URL floor preserved", () => {
  it("admits the agent-testdb path (control)", () => {
    expect(validateEnvironment(localEnv)).toMatchObject({
      host: "agent-testdb",
      name: "two_web_next",
    });
  });

  it("admits localhost, 127.0.0.1, and bracketed-[::1] APP_URLs (control)", () => {
    for (const appUrl of [
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
      "https://[::1]:8787",
    ]) {
      expect(validateEnvironment({ ...localEnv, APP_URL: appUrl }), appUrl).toMatchObject({
        host: "agent-testdb",
      });
    }
  });

  it("admits the staging APP_URL with a verify-full allowlisted remote (control)", () => {
    expect(validateEnvironment(remoteEnvFor(REMOTE_VERIFY))).toMatchObject({
      host: "ep-staging.example.neon.tech",
    });
  });

  it("refuses production and unknown APP_URLs (control)", () => {
    for (const appUrl of [
      "https://togetherweown.com",
      "https://www.togetherweown.com",
      "https://next.togetherweown.com.evil.test",
      "https://next.example.test",
    ]) {
      expect(() => validateEnvironment({ ...localEnv, APP_URL: appUrl }), appUrl).toThrow(
        /Refusing seed:/,
      );
    }
  });
});

describe("seed guard parity: CLI fixtures refuse without leaking", () => {
  it("refuses require-mode remote URLs in both modes without disclosing URLs", () => {
    for (const args of [[], ["--apply"]]) {
      const result = run(args, remoteEnvFor(REMOTE_REQUIRE));
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/verify-full/);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("synthetic-password");
      expect(result.stderr).not.toContain("postgres://");
    }
  });

  it("refuses the TLS override in both modes without disclosing URLs", () => {
    for (const args of [[], ["--apply"]]) {
      const result = run(args, { ...localEnv, NODE_TLS_REJECT_UNAUTHORIZED: "0" });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("postgres://");
    }
  });

  it("dry-runs the local path and a verify-full remote (control)", () => {
    expect(run([], localEnv).status).toBe(0);
    const remote = run([], remoteEnvFor(REMOTE_VERIFY));
    expect(remote.status, remote.stderr).toBe(0);
    expect(remote.stdout).toContain('"mode": "dry-run"');
    expect(remote.stdout).not.toContain("synthetic-password");
  });
});
