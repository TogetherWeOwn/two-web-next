import type postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconciliationServiceFor } from "../src/admin/reconciliation-service";
import { databaseOptions } from "../src/db/connection";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

const connect = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => ({ default: connect }));

const actor = "123456789012345678";
const key = "00000000-0000-0000-0000-000000000001";

function database() {
  const tx = vi.fn(async (parts: TemplateStringsArray, ..._values: unknown[]) =>
    parts.join("").includes("update bot_reconciliation_intents") ? [{ idempotency_key: key }] : [],
  );
  const sql = { begin: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) };
  return { tx, sql: sql as unknown as ReturnType<typeof postgres> };
}

describe("dormant reconciliation service", () => {
  beforeEach(() => connect.mockReset());

  it("prefers the injected admin DB and binds read and write receipts to the same actor", async () => {
    const { tx, sql } = database();
    const env = {
      ADMIN_DB: { $client: sql } as unknown as Db,
      DATABASE_URL: "postgres://example.invalid/test",
    } as Env & { ADMIN_DB: Db };
    const service = await reconciliationServiceFor(env, actor);
    expect(connect).not.toHaveBeenCalled();
    expect(await service!.listOpen()).toEqual([]);
    expect(await service!.resolve(key, "confirmed")).toBe("resolved");
    const receipts = tx.mock.calls.filter(([parts]) =>
      parts.join("").includes("insert into activity_log"),
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toContain(actor);
    expect(receipts[1]).toContain(actor);
    expect(receipts[1]).toContain(key);
  });

  it("uses the configured web connection with bounded options or returns unavailable", async () => {
    const { sql } = database();
    const url = "postgres://example.invalid/test";
    connect.mockReturnValue(sql);
    expect(await reconciliationServiceFor({} as Env, actor)).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(await reconciliationServiceFor({ DATABASE_URL: url } as Env, actor)).not.toBeNull();
    expect(connect).toHaveBeenCalledExactlyOnceWith(url, databaseOptions);
  });
});
