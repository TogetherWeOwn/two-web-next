import { describe, expect, it } from "vitest";
import { databaseOptions, databaseUrl } from "../src/db/connection";

describe("web database connection selection", () => {
  it("uses the provisioned Hyperdrive binding without DATABASE_URL", () => {
    expect(databaseUrl({ DB: { connectionString: "postgres://hyperdrive.test/db" } })).toBe(
      "postgres://hyperdrive.test/db",
    );
  });

  it("keeps the explicit URL authoritative when both are configured", () => {
    expect(
      databaseUrl({
        DATABASE_URL: "postgres://explicit.test/db",
        DB: { connectionString: "postgres://hyperdrive.test/db" },
      }),
    ).toBe("postgres://explicit.test/db");
  });

  it("treats an empty explicit URL as absent", () => {
    expect(
      databaseUrl({ DATABASE_URL: "", DB: { connectionString: "postgres://hyperdrive.test/db" } }),
    ).toBe("postgres://hyperdrive.test/db");
  });

  it("does not invent a database when neither is configured", () => {
    expect(databaseUrl({})).toBeUndefined();
  });

  it("uses Hyperdrive-compatible driver options", () => {
    expect(databaseOptions).toEqual({
      max: 1,
      idle_timeout: 10,
      connect_timeout: 10,
      prepare: false,
      fetch_types: false,
    });
  });
});
