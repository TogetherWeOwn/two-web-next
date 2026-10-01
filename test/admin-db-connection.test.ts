import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbFor } from "../src/admin/db";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

const { makeSql, makeDb } = vi.hoisted(() => ({ makeSql: vi.fn(), makeDb: vi.fn() }));
vi.mock("postgres", () => ({ default: makeSql }));
vi.mock("drizzle-orm/postgres-js", async (importOriginal) => ({
  ...await importOriginal<typeof import("drizzle-orm/postgres-js")>(), drizzle: makeDb,
}));

beforeEach(() => {
  vi.resetAllMocks();
  makeSql.mockReturnValue({ client: true });
  makeDb.mockReturnValue({ db: true });
});

describe("dbFor connection wiring", () => {
  it("keeps injected DBs ahead of runtime configuration", async () => {
    const execute = vi.fn().mockResolvedValue([{ injected: true }]);
    const injected = { marker: "injected", execute } as unknown as Db;
    const wrapped = await dbFor({ env: { ADMIN_DB: injected, DB: { connectionString: "postgres://hyperdrive.test/db" } } as unknown as Env });
    expect(wrapped).toMatchObject({ marker: "injected" });
    expect(await wrapped!.execute("select 1" as never)).toEqual([{ injected: true }]);
    expect(execute).toHaveBeenCalledExactlyOnceWith("select 1");
    expect(makeSql).not.toHaveBeenCalled();
    expect(makeDb).not.toHaveBeenCalled();
  });

  it("builds the route DB from Hyperdrive when the explicit URL is absent", async () => {
    expect(await dbFor({ env: { DB: { connectionString: "postgres://hyperdrive.test/db" } } as Env }))
      .toEqual({ db: true });
    expect(makeSql).toHaveBeenCalledExactlyOnceWith("postgres://hyperdrive.test/db", {
      max: 1, idle_timeout: 10, connect_timeout: 10, prepare: false, fetch_types: false,
    });
    expect(makeDb).toHaveBeenCalledWith({ client: true }, { schema: expect.any(Object) });
  });

  it("returns null without either source", async () => {
    expect(await dbFor({ env: {} as Env })).toBeNull();
    expect(makeSql).not.toHaveBeenCalled();
  });

  it("does not retry a failed explicit connection with the binding", async () => {
    const refused = new Error("connection refused");
    makeSql.mockImplementation(() => { throw refused; });
    await expect(dbFor({ env: {
      DATABASE_URL: "postgres://explicit.test/db",
      DB: { connectionString: "postgres://hyperdrive.test/db" },
    } as Env })).rejects.toBe(refused);
    expect(makeSql).toHaveBeenCalledTimes(1);
    expect(makeSql.mock.calls[0]?.[0]).toBe("postgres://explicit.test/db");
    expect(makeDb).not.toHaveBeenCalled();
  });
});
