// TOG-20410: ordered-script fake Db for hermetic RSVP write-admission kills.
//
// `writeRsvp` in src/events/rsvp.ts needs a `Db` transaction, but the nightly
// mutation run is DB-free by contract (no DATABASE_URL, no Discord, no
// secrets). This double scripts one `writeRsvp` transaction — executes in call
// order (advisory lock, prune, charge lock, budget count, hit insert,
// waitlist position), bare selects in call order (event row, existing row,
// final row), projected selects by shape — so a kill test can force a
// throttle refusal or observe the waitlisted allocation without a database.
// Select chains are thenables: every builder method returns another chainable
// resolving to the scripted value.

import type { Db } from "../../src/db/index";

export type FakeRsvpRow = Record<string, unknown>;

export type FakeRsvpScript = {
  event: FakeRsvpRow;
  existing: FakeRsvpRow | null;
  throttleCount: { n: number; wait: number };
  /** Evaluated when the final row read runs, so it can echo the insert. */
  finalRow: () => FakeRsvpRow;
};

// A drizzle query chain: any builder method returns another chain, and the
// chain resolves to the scripted value when awaited.
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

export function fakeRsvpDb(script: FakeRsvpScript): { db: Db; inserted: FakeRsvpRow[] } {
  const inserted: FakeRsvpRow[] = [];
  // Bare selects (no projection arg) run in a fixed order: the event row, the
  // existing RSVP row, then the final allocation row. Projected selects are
  // identified by shape: `{ n }` is the goingCount tally (skipped when the
  // event has unlimited capacity), `{ id }` rows are waitlist locks/heads.
  let bare = 0;
  const bareSelects: Array<() => unknown> = [
    () => [script.event],
    () => (script.existing ? [script.existing] : []),
    () => [script.finalRow()],
  ];
  let executes = 0;
  const executeValues: Array<() => unknown> = [
    () => [], // writeRsvp advisory lock
    () => [], // pruneThrottle
    () => [], // chargeThrottle advisory lock
    () => [{ ...script.throttleCount }], // chargeThrottle budget count
    () => [], // chargeThrottle hit insert
    () => [], // waitlistPosition (only reached on waitlisted answers)
  ];
  const tx = {
    execute: async (..._args: unknown[]) => (executeValues[executes++] ?? (() => []))(),
    select: (...args: unknown[]): Chain => {
      const first = args[0] as Record<string, unknown> | undefined;
      if (first && typeof first === "object") {
        return chainable("n" in first ? [{ n: 0 }] : []);
      }
      return chainable((bareSelects[bare++] ?? (() => []))());
    },
    insert: (..._args: unknown[]) => ({
      values: (v: FakeRsvpRow) => {
        inserted.push(v);
        return { onConflictDoUpdate: (..._a: unknown[]) => Promise.resolve([]) };
      },
    }),
    delete: (..._args: unknown[]): Chain => chainable([]),
    update: (..._args: unknown[]) => ({
      set: (..._a: unknown[]) => ({ where: (..._w: unknown[]) => Promise.resolve([]) }),
    }),
  };
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
  return { db, inserted };
}
