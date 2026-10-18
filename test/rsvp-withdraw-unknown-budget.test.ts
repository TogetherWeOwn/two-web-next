// Unknown-event withdraw must not spend throttle budget.
//
// Hermetic unit kill for `withdrawRsvp` in src/events/rsvp.ts: an event key
// that resolves to no event row must return quietly WITHOUT stamping a
// `web_throttle_hits` row. A mutant that keeps the prune+charge calls on the
// unknown-event path inserts one hit per call, so the burst below observes
// nonzero inserts and fails.
//
// DB-free by design: drives `withdrawRsvp` directly with a minimal ordered
// fake Db (no DATABASE_URL, no Discord, no secrets). The fake scripts one
// withdraw transaction — member advisory lock, then the event-row select —
// and records every `tx.execute` whose serialization mentions the throttle
// table with an insert, so the assertion is mechanism-agnostic about lock
// versus prune ordering.
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { withdrawRsvp } from "../src/events/rsvp";

type Chain = PromiseLike<unknown> & {
  [method: string]: (...args: unknown[]) => Chain;
};

function chainable(value: unknown): Chain {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(value);
      }
      return (..._args: unknown[]) => chainable(value);
    },
    apply() {
      return chainable(value);
    },
  });
  return proxy as unknown as Chain;
}

function serializeExecuteArg(arg: unknown): string {
  try {
    const v = arg as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof arg === "string") parts.push(arg);
    if (v && typeof v === "object") {
      for (const k of ["sql", "query", "text", "command"]) {
        const f = v[k];
        if (typeof f === "string") parts.push(f);
      }
      const chunks = v["queryChunks"] as Array<unknown> | undefined;
      if (Array.isArray(chunks)) {
        for (const c of chunks) {
          if (typeof c === "string") parts.push(c);
          else if (c && typeof c === "object") {
            const value = (c as { value?: unknown }).value;
            if (typeof value === "string") parts.push(value);
            else if (Array.isArray(value)) {
              for (const item of value) {
                if (typeof item === "string") parts.push(item);
              }
            }
          }
        }
      }
    }
    parts.push(String(arg));
    return parts.join(" ").toLowerCase();
  } catch {
    return "";
  }
}

function fakeUnknownEventDb() {
  let throttleInserts = 0;
  let executes = 0;
  const tx = {
    execute: async (arg: unknown) => {
      executes += 1;
      const text = serializeExecuteArg(arg);
      if (text.includes("web_throttle_hits") && text.includes("insert")) {
        throttleInserts += 1;
      }
      // The budget-count select (only reached on the buggy path): report an
      // empty window so the burst is never `limited` and every call inserts.
      if (text.includes("web_throttle_hits") && text.includes("count")) {
        return [{ n: 0, wait: 1 }];
      }
      return [];
    },
    select: (..._args: unknown[]): Chain => chainable([]),
    insert: (..._args: unknown[]) => ({
      values: (..._a: unknown[]) => ({
        onConflictDoUpdate: (..._b: unknown[]) => Promise.resolve([]),
      }),
    }),
    delete: (..._args: unknown[]): Chain => chainable([]),
    update: (..._args: unknown[]) => ({
      set: (..._a: unknown[]) => ({ where: (..._w: unknown[]) => Promise.resolve([]) }),
    }),
  };
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
  return {
    db,
    stats: () => ({ throttleInserts, executes }),
  };
}

describe("withdrawRsvp unknown-event budget", () => {
  it("an unknown-key withdraw burst stamps zero throttle hits", async () => {
    const { db, stats } = fakeUnknownEventDb();
    for (let i = 0; i < 3; i++) {
      const result = await withdrawRsvp(db, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "member-1");
      expect(result.limited, `unknown withdraw #${i + 1}`).toBe(false);
    }
    expect(stats().throttleInserts).toBe(0);
    // Only the member advisory lock may run before the early return; the
    // prune/count/insert sequence must never execute. The count check guards
    // against a serialization blind spot in the text match above.
    expect(stats().executes).toBe(3);
  });
});
