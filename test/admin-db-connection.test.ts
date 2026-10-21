import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbFor } from "../src/admin/db";
import { sessionStoreFor } from "../src/admin/guard";
import { PER_REQUEST_STATEMENT_TIMEOUT_LOCAL } from "../src/db/connection";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

const { makeSql, makeDb } = vi.hoisted(() => ({ makeSql: vi.fn(), makeDb: vi.fn() }));
vi.mock("postgres", () => ({ default: makeSql }));
vi.mock("drizzle-orm/postgres-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm/postgres-js")>()),
  drizzle: makeDb,
}));

const txUnsafe = vi.fn();
const tx = { unsafe: txUnsafe };
const rawUnsafe = vi.fn();
const rawBegin = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  txUnsafe.mockResolvedValue([]);
  rawBegin.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(tx));
  makeSql.mockReturnValue({ client: true, unsafe: rawUnsafe, begin: rawBegin });
  makeDb.mockReturnValue({ db: true });
});

describe("dbFor connection wiring", () => {
  it("keeps injected DBs ahead of runtime configuration", async () => {
    const execute = vi.fn().mockResolvedValue([{ injected: true }]);
    const injected = { marker: "injected", execute } as unknown as Db;
    const wrapped = await dbFor({
      env: {
        ADMIN_DB: injected,
        DB: { connectionString: "postgres://hyperdrive.test/db" },
      } as unknown as Env,
    });
    expect(wrapped).toMatchObject({ marker: "injected" });
    expect(await wrapped!.execute("select 1" as never)).toEqual([{ injected: true }]);
    expect(execute).toHaveBeenCalledExactlyOnceWith("select 1");
    expect(makeSql).not.toHaveBeenCalled();
    expect(makeDb).not.toHaveBeenCalled();
  });

  it("builds the route DB from Hyperdrive when the explicit URL is absent", async () => {
    expect(
      await dbFor({ env: { DB: { connectionString: "postgres://hyperdrive.test/db" } } as Env }),
    ).toEqual({ db: true });
    expect(makeSql).toHaveBeenCalledExactlyOnceWith("postgres://hyperdrive.test/db", {
      max: 1,
      idle_timeout: 10,
      connect_timeout: 10,
      prepare: false,
      fetch_types: false,
    });
    // The bound lives in short transactions, not the client options: drizzle
    // receives the same client with unsafe/begin wrapped to install SET LOCAL.
    expect(makeDb).toHaveBeenCalledWith(expect.objectContaining({ client: true }), {
      schema: expect.any(Object),
    });
    const passed = makeDb.mock.calls[0]![0] as {
      unsafe: (...args: unknown[]) => Promise<unknown>;
      begin: (run: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    expect(passed.unsafe).not.toBe(rawUnsafe);
    expect(passed.begin).not.toBe(rawBegin);
    await passed.unsafe("SELECT 1");
    expect(rawBegin).toHaveBeenCalledTimes(1);
    expect(txUnsafe).toHaveBeenNthCalledWith(1, PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
    expect(txUnsafe).toHaveBeenNthCalledWith(2, "SELECT 1");
  });

  it("returns null without either source", async () => {
    expect(await dbFor({ env: {} as Env })).toBeNull();
    expect(makeSql).not.toHaveBeenCalled();
  });

  it("does not retry a failed explicit connection with the binding", async () => {
    const refused = new Error("connection refused");
    makeSql.mockImplementation(() => {
      throw refused;
    });
    await expect(
      dbFor({
        env: {
          DATABASE_URL: "postgres://explicit.test/db",
          DB: { connectionString: "postgres://hyperdrive.test/db" },
        } as Env,
      }),
    ).rejects.toBe(refused);
    expect(makeSql).toHaveBeenCalledTimes(1);
    expect(makeSql.mock.calls[0]?.[0]).toBe("postgres://explicit.test/db");
    expect(makeDb).not.toHaveBeenCalled();
  });
});

describe("admin session store wiring", () => {
  it("bounds the mirror client's statements like the site builder", async () => {
    // sessionStoreFor mirrors storeForEnv's construction, including the
    // per-request statement bound: every statement runs in a short
    // transaction starting with SET LOCAL statement_timeout.
    const queries: string[] = [];
    const txSql = Object.assign(
      async (strings: TemplateStringsArray) => {
        queries.push(strings.join("?"));
        return [];
      },
      { unsafe: txUnsafe },
    );
    const client = Object.assign(txSql, {
      begin: async (run: (tx: unknown) => Promise<unknown>) => run(txSql),
    });
    makeSql.mockReturnValueOnce(client);
    const store = await sessionStoreFor({
      env: { DB: { connectionString: "postgres://hyperdrive.test/db" } } as Env,
    });
    expect(store).not.toBeNull();
    expect(makeSql).toHaveBeenCalledExactlyOnceWith("postgres://hyperdrive.test/db", {
      max: 1,
      idle_timeout: 10,
      connect_timeout: 10,
      prepare: false,
      fetch_types: false,
    });
    await expect(store!.statusHash("nope")).resolves.toBeNull();
    expect(txUnsafe).toHaveBeenNthCalledWith(1, PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
    expect(queries).toHaveLength(1);
  });
});
