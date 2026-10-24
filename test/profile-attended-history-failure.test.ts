// Attended-history failure policy (U3 builder owned): an ordinary database
// error hides the section instead of 503ing the self-view; only contract
// refusals propagate. Pure unit tests over a stubbed execute, no database.
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PgDialect, type PgSession } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { MemberReadRefused } from "../src/member-reads";
import { readAttendedHistory } from "../src/profiles/history";

const MEMBER = "100000000000000001";

function fixture(execute: (query: unknown) => Promise<unknown[]>) {
  const session = {
    prepareQuery: (query: unknown) => ({ execute: () => execute(query) }),
  } as unknown as PgSession;
  const db = new PostgresJsDatabase(new PgDialect(), session, undefined) as Db;
  db.execute = db.execute.bind(db);
  return db;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attended-history failure policy", () => {
  it("degrades to null with a class-only warn on an ordinary database error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fixture(async () => {
      throw new Error("connect ENETUNREACH agent-testdb");
    });
    await expect(readAttendedHistory(db, MEMBER)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Attended history unavailable; hiding the section.",
      { exception: "Error" },
    );
    // Never a driver message (connection strings) or member data in the warn.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("ENETUNREACH");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MEMBER);
  });

  it("propagates a contract refusal instead of hiding it behind a missing section", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fixture(async () => {
      throw new MemberReadRefused();
    });
    await expect(readAttendedHistory(db, MEMBER)).rejects.toThrow(MemberReadRefused);
    expect(warn).not.toHaveBeenCalled();
  });
});
