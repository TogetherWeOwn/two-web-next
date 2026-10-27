// Owned by the queue-ledger server-timeout slice: the needsSync eligibility read
// must carry its lock-first budgets (lock 50ms under statement) on the TxClient
// savepoint path too, not just the pool begin path. Only the postgres boundary
// is fake; no database, queue service or network. Regression pin: dropping the
// lockTimeout argument at the savepoint set_config call must fail this suite.
import { describe, expect, it } from "vitest";
import { LEDGER_DB_LOCK_TIMEOUT_MS, LEDGER_DB_TIMEOUT_MS } from "../src/jobs/constants";
import { pgEventStore } from "../src/jobs/events";
import type { TxClient } from "../src/jobs/types";

const KEY = "33333333-3333-4333-8333-333333333333";
// Caller-owned settings, distinct from every budget so a restore mix-up shows.
const PREVIOUS = { lock_timeout: "17s", statement_timeout: "23s" };

type SetPair = { lock: string; statement: string };
type Event =
  | { kind: "savepoint-enter" }
  | { kind: "savepoint-exit" }
  | { kind: "set"; pair: SetPair }
  | { kind: "statement"; sql: string };

function render(sql: string, parameters: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_, n: string) => {
    const value = parameters[Number(n) - 1];
    return typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
  });
}

function setPairOf(sql: string, parameters: unknown[]): SetPair | undefined {
  const rendered = render(sql, parameters);
  const configs = [
    ...rendered.matchAll(
      /set_config\(\s*'(lock_timeout|statement_timeout)'\s*,\s*'([^']+)'\s*,\s*true\s*\)/gi,
    ),
  ];
  if (configs.length === 0) return undefined;
  const pair: Partial<SetPair> = {};
  for (const [, name, value] of configs) {
    if (name === "lock_timeout") pair.lock = value!;
    else pair.statement = value!;
  }
  if (pair.lock === undefined || pair.statement === undefined) return undefined;
  return pair as SetPair;
}

// Minimal TxClient double: records set_config pairs and application statements,
// answers current_setting with the caller's previous values, and reports no
// stale keys. postgres.js tags are lazy, so fragments compose without running.
function txDouble(events: Event[]) {
  function tag(parts: TemplateStringsArray, ...values: unknown[]) {
    let sql = parts[0]!;
    const parameters: unknown[] = [];
    for (const [i, value] of values.entries()) {
      if (value && typeof value === "object" && "sql" in value && "parameters" in value) {
        const fragment = value as { sql: string; parameters: unknown[] };
        const offset = parameters.length;
        sql += fragment.sql.replace(/\$(\d+)/g, (_, n: string) => `$${offset + Number(n)}`);
        parameters.push(...fragment.parameters);
      } else {
        parameters.push(value);
        sql += `$${parameters.length}`;
      }
      sql += parts[i + 1]!;
    }
    return {
      sql,
      parameters,
      then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
        const pair = setPairOf(sql, parameters);
        if (pair) {
          events.push({ kind: "set", pair });
          return Promise.resolve([]).then(resolve, reject);
        }
        if (/^\s*select current_setting/i.test(sql)) {
          return Promise.resolve([{ ...PREVIOUS }]).then(resolve, reject);
        }
        events.push({ kind: "statement", sql });
        return Promise.resolve([]).then(resolve, reject);
      },
    };
  }
  // The nested client is the same double; the event log orders the statements.
  const tx = Object.assign(tag, {
    async savepoint<T>(work: (client: TxClient) => Promise<T>): Promise<T> {
      events.push({ kind: "savepoint-enter" });
      try {
        return await work(tx as unknown as TxClient);
      } finally {
        events.push({ kind: "savepoint-exit" });
      }
    },
  });
  return tx;
}

describe("needsSync TxClient lock-first budgets (offline pin)", () => {
  it("applies the 1950ms lock bound inside the savepoint and restores the caller", async () => {
    const events: Event[] = [];
    const tx = txDouble(events);
    const store = pgEventStore(tx as unknown as TxClient);

    await expect(store.needsSync(KEY)).resolves.toBe(false);

    const kinds = events.map((event) => event.kind);
    expect(kinds).toEqual(["savepoint-enter", "set", "statement", "set", "savepoint-exit"]);
    const [apply, restore] = events.filter(
      (event): event is Extract<Event, { kind: "set" }> => event.kind === "set",
    );
    expect(apply!.pair).toEqual({
      lock: `${LEDGER_DB_LOCK_TIMEOUT_MS}ms`,
      statement: `${LEDGER_DB_TIMEOUT_MS}ms`,
    });
    expect(`${LEDGER_DB_LOCK_TIMEOUT_MS}ms`).toBe("1950ms");
    expect(`${LEDGER_DB_TIMEOUT_MS}ms`).toBe("2000ms");
    expect(restore!.pair).toEqual({ lock: PREVIOUS.lock_timeout, statement: PREVIOUS.statement_timeout });
    const [statement] = events.filter(
      (event): event is Extract<Event, { kind: "statement" }> => event.kind === "statement",
    );
    expect(statement!.sql).toMatch(/select event_key/i);
  });
});
