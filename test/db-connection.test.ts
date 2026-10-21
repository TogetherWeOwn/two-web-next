import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  databaseOptions,
  databaseUrl,
  installPerRequestStatementBound,
  PER_REQUEST_STATEMENT_TIMEOUT_LOCAL,
  PER_REQUEST_STATEMENT_TIMEOUT_MS,
  withPerRequestStatementBound,
} from "../src/db/connection";
import type { Sql } from "../src/sessions";

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

  it("keeps the bound off the shared options, never global settings", () => {
    expect(databaseOptions).not.toHaveProperty("statement_timeout");
    expect(databaseOptions).not.toHaveProperty("lock_timeout");
  });

  it("pins the per-request statement bound at 5 seconds", () => {
    expect(PER_REQUEST_STATEMENT_TIMEOUT_MS).toBe(5000);
    expect(PER_REQUEST_STATEMENT_TIMEOUT_LOCAL).toBe("SET LOCAL statement_timeout = '5000ms'");
  });
});

describe("per-request statement bound adapters (offline)", () => {
  const txDouble = (calls: string[]) => {
    const tx = Object.assign(
      async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        calls.push(`query:${strings.join("?")}`);
        return [{ ok: true }];
      },
      {
        unsafe: async (query: string) => {
          calls.push(`unsafe:${query}`);
          return [];
        },
      },
    );
    return Object.assign(tx, {
      begin: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
        calls.push("begin");
        try {
          return await run(tx);
        } finally {
          calls.push("end");
        }
      },
    });
  };

  it("runs each Sql statement in a transaction starting with SET LOCAL", async () => {
    const calls: string[] = [];
    const bounded = withPerRequestStatementBound(txDouble(calls) as unknown as Sql);
    await bounded`SELECT 1`;
    expect(calls).toEqual([
      "begin",
      `unsafe:${PER_REQUEST_STATEMENT_TIMEOUT_LOCAL}`,
      "query:SELECT 1",
      "end",
    ]);
    calls.length = 0;
    await bounded.unsafe("SELECT 2");
    expect(calls).toEqual([
      "begin",
      `unsafe:${PER_REQUEST_STATEMENT_TIMEOUT_LOCAL}`,
      "unsafe:SELECT 2",
      "end",
    ]);
  });

  it("leaves minimal doubles without begin unmodified", () => {
    const bare = Object.assign(async () => [], { unsafe: async () => [] });
    expect(withPerRequestStatementBound(bare as unknown as Sql)).toBe(bare);
  });

  const clientDouble = () => {
    const calls: string[] = [];
    const execute = vi.fn(async () => "executed");
    const rawUnsafe = vi.fn((query: string) => {
      calls.push(`raw:${query}`);
      return { execute };
    });
    const tx = {
      unsafe: (query: string, params?: unknown, options?: unknown) => {
        calls.push(`unsafe:${query}`);
        return {
          then: (resolve: (value: unknown) => void) => resolve([{ query, params, options }]),
          values: async () => [[query]],
        };
      },
    };
    const client = {
      unsafe: rawUnsafe,
      begin: async (first: unknown, second?: unknown) => {
        const run = (typeof first === "function" ? first : second) as (
          tx: unknown,
        ) => Promise<unknown>;
        calls.push("begin");
        return run(tx);
      },
    };
    return { client, calls, tx, rawUnsafe, execute };
  };
  type UnsafeDouble = (...args: unknown[]) => PromiseLike<unknown> & {
    values: () => Promise<unknown>;
    execute: () => Promise<unknown>;
  };

  it("runs top-level unsafe queries in a bound transaction, forwarding arguments", async () => {
    const { client, calls, rawUnsafe } = clientDouble();
    const out = installPerRequestStatementBound(client as unknown as postgres.Sql);
    expect(out).toBe(client);
    const rows = await (out.unsafe as unknown as UnsafeDouble)("SELECT 1", [1], {
      prepare: false,
    });
    expect(rows).toEqual([{ query: "SELECT 1", params: [1], options: { prepare: false } }]);
    expect(calls).toEqual([
      "begin",
      `unsafe:${PER_REQUEST_STATEMENT_TIMEOUT_LOCAL}`,
      "unsafe:SELECT 1",
    ]);
    expect(rawUnsafe).not.toHaveBeenCalled();
  });

  it("keeps the .values() surface drizzle uses for mapped rows", async () => {
    const { client, calls, rawUnsafe } = clientDouble();
    const out = installPerRequestStatementBound(client as unknown as postgres.Sql);
    await expect((out.unsafe as unknown as UnsafeDouble)("SELECT 2").values()).resolves.toEqual([
      ["SELECT 2"],
    ]);
    expect(calls).toEqual([
      "begin",
      `unsafe:${PER_REQUEST_STATEMENT_TIMEOUT_LOCAL}`,
      "unsafe:SELECT 2",
    ]);
    expect(rawUnsafe).not.toHaveBeenCalled();
  });

  it("passes .execute() through for postgres.js begin internals", async () => {
    const { client, rawUnsafe, execute } = clientDouble();
    const out = installPerRequestStatementBound(client as unknown as postgres.Sql);
    const options = { onexecute: () => {} };
    await expect(
      (out.unsafe as unknown as UnsafeDouble)("begin ", [], options).execute(),
    ).resolves.toBe("executed");
    expect(rawUnsafe).toHaveBeenCalledExactlyOnceWith("begin ", [], options);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("injects SET LOCAL first in begin bodies and forwards options", async () => {
    const { client, calls, tx } = clientDouble();
    const out = installPerRequestStatementBound(client as unknown as postgres.Sql);
    const seen: unknown[] = [];
    await (out.begin as unknown as (run: (tx: unknown) => Promise<string>) => Promise<string>)(
      async (inner) => {
        seen.push(inner);
        return "work";
      },
    );
    expect(calls).toEqual(["begin", `unsafe:${PER_REQUEST_STATEMENT_TIMEOUT_LOCAL}`]);
    expect(seen).toEqual([tx]);
    await (
      out.begin as unknown as (
        options: string,
        run: (tx: unknown) => Promise<null>,
      ) => Promise<null>
    )("read only", async () => null);
    expect(calls).toEqual([
      "begin",
      `unsafe:${PER_REQUEST_STATEMENT_TIMEOUT_LOCAL}`,
      "begin",
      `unsafe:${PER_REQUEST_STATEMENT_TIMEOUT_LOCAL}`,
    ]);
  });
});
