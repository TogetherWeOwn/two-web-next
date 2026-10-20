import { describe, expect, it } from "vitest";
import {
  createRevokeClient,
  parseRevokeArgs,
  validateRevokeEnvironment,
} from "../bin/revoke-sessions.mjs";

const discordId = "100000000000000201";
const classes = [
  { url: "postgres://fixture@agent-testdb/test", local: true, production: false },
  { url: "postgres://fixture@localhost/test", local: true, production: false },
  { url: "postgres://fixture@127.0.0.1/test", local: true, production: false },
  { url: "postgres://fixture@[::1]/test", local: true, production: false },
  { url: "postgres://fixture@db.staging.test/test", local: false, production: false },
  { url: "postgres://fixture@db.example.test/test", local: false, production: false },
  { url: "postgres://fixture@db.prod.test/test", local: false, production: true },
  { url: "postgres://fixture@db.PRODUCTION.test./test", local: false, production: true },
  { url: "postgres://fixture@db.example.test/production", local: false, production: true },
  { url: "postgres://fixture@localhost/prod", local: true, production: true },
  { url: "postgres://fixture@[::1]/%70roduction", local: true, production: true },
];

describe("revocation target by URL class", () => {
  for (const { url, local, production } of classes) {
    for (const target of [undefined, "staging", "production"]) {
      it(`${url} with target ${target ?? "omitted"}`, () => {
        const args = [`--discord-id=${discordId}`];
        if (target) args.push("--target", target);
        const parsed = parseRevokeArgs(args);
        const validate = () => validateRevokeEnvironment({ DATABASE_URL: url }, parsed.target);
        const allowed = production ? target === "production" : local || target !== undefined;
        if (allowed) expect(validate()).toEqual({ databaseUrl: url });
        else expect(validate).toThrow(production ? "--target production" : "--target staging");
      });
    }
  }
});

describe("staging retains remote TLS requirements", () => {
  for (const sslmode of ["disable", "require", "prefer", "verify-ca"]) {
    it(`refuses sslmode=${sslmode}`, () => {
      expect(() =>
        validateRevokeEnvironment(
          { DATABASE_URL: `postgres://fixture@db.staging.test/test?sslmode=${sslmode}` },
          "staging",
        ),
      ).toThrow();
    });
  }

  it("refuses the process TLS-verification override", () => {
    expect(() =>
      validateRevokeEnvironment(
        {
          DATABASE_URL: "postgres://fixture@db.staging.test/test?sslmode=verify-full",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
        },
        "staging",
      ),
    ).toThrow("disables TLS verification");
  });

  for (const query of ["", "?sslmode=verify-full", "?sslrootcert=system"]) {
    it(`constructs a verified staging client for ${query || "default TLS"}`, () => {
      const raw = `postgres://fixture@db.staging.test/test${query}`;
      const { databaseUrl } = validateRevokeEnvironment({ DATABASE_URL: raw }, "staging");
      let options;
      createRevokeClient((value) => {
        options = value;
        return {};
      }, databaseUrl);
      expect(options.ssl).toBe("verify-full");
      expect(options).not.toHaveProperty("sslrootcert");
      expect(options.connection).not.toHaveProperty("sslrootcert");
    });
  }
});
