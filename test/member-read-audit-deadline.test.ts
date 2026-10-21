// Acceptance: waiting for the member-read access audit is bounded.
//
// A member read is released only after its audit row is written. That wait
// must have a finite, named deadline: if the audit write never settles, the
// read is refused with the existing sanitized 503 / private-no-store
// response and none of the buffered success body or its sensitive headers
// (cookies, subject markers) escape. The exact deadline value is the
// implementation's named constant; these tests only require that some
// finite deadline at or below OUTER_BOUND_MS exists, that it is driven by
// timers (so fake timers govern it deterministically, matching the house
// setTimeout + Promise.race pattern), and that a sink settling after the
// deadline cannot change the response, replay the write, or surface as an
// unhandled rejection. Audit failure must never fail open.
//
// The audit await site is covered: the shared boundary behind
// memberReadResponse (Kit) / memberReadBoundary. (The old Hono
// declare-subjects middleware was retired; production never used it.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as accessLog from "../src/access-log";
import type { AccessEntry, AccessSink } from "../src/access-log";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import * as memberReads from "../src/member-reads";
import { declareMemberResult, keyedMemberRead, memberQueryPermit } from "../src/member-reads";

const OUTER_BOUND_MS = 60_000;
const READ_REFUSAL = "Member data is temporarily unavailable.";

// Kit-side fixtures mirror test/kit-member-read.test.ts.
const VIEWER = "100000000000000101";
const SUBJECT = "100000000000000102";
const meta = { method: "GET", route: "/members/:id" };
const declared = () => ({
  resource: "profile",
  action: "view" as const,
  route: "profile",
  viewer: VIEWER,
});
const readOwners = <T>(owners: string[], value: T) =>
  keyedMemberRead(async () => {
    memberQueryPermit();
    declareMemberResult(owners);
    return value;
  });

function deferredSink() {
  let settle!: { resolve: (recorded: boolean) => void; reject: (err: unknown) => void };
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const sink = vi.fn(
    (_entry: AccessEntry) =>
      new Promise<boolean>((resolve, reject) => {
        settle = { resolve, reject };
        entered();
      }),
  );
  return {
    sink: sink as unknown as AccessSink & typeof sink,
    calls: sink.mock.calls,
    enteredPromise,
    resolve: (recorded: boolean) => settle?.resolve(recorded),
    reject: (err: unknown) => settle?.reject(err),
  };
}

function tracked<T>(promise: Promise<T>) {
  let settled = false;
  const trackedPromise = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    },
  );
  // The test body asserts on `settled` before awaiting; keep a handler
  // attached so a failed assertion cannot leave an unhandled rejection.
  trackedPromise.catch(() => undefined);
  return { promise: trackedPromise, isSettled: () => settled };
}

const flushMicrotasks = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

function unhandledRejectionCollector() {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => process.removeListener("unhandledRejection", onUnhandled),
  };
}

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("named audit-wait deadline", () => {
  it("exports a finite named deadline constant at or below the outer bound", async () => {
    vi.useRealTimers();
    const storeAccess = await import("../src/admin/store-access");
    const deadlines = [memberReads, accessLog, storeAccess].flatMap((mod) =>
      Object.entries(mod).filter(
        ([name, value]) =>
          /(DEADLINE|TIMEOUT)/.test(name) &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          value > 0 &&
          value <= OUTER_BOUND_MS,
      ),
    );
    expect(deadlines.length).toBeGreaterThan(0);
  });
});

describe("memberReadResponse audit deadline (Kit boundary)", () => {
  const kitRender =
    (owners: string[] = [SUBJECT, VIEWER]) =>
    async () =>
      new Response(await readOwners(owners, `<p>${SUBJECT}</p>`), {
        headers: { "set-cookie": "__Host-leak=1; Path=/; Secure", "x-member-marker": SUBJECT },
      });

  const expectKitRefused = async (res: Response) => {
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("x-member-marker")).toBeNull();
    const body = await res.text();
    expect(body).toBe(READ_REFUSAL);
    expect(body).not.toContain(SUBJECT);
  };

  it("refuses with the sanitized 503 when the audit write never settles", async () => {
    const audit = deferredSink();
    const pending = tracked(
      memberReads.memberReadResponse(meta, declared(), audit.sink, kitRender()),
    );
    try {
      await audit.enteredPromise;
      // Still withheld before any deadline passes: the audit remains required.
      expect(pending.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(OUTER_BOUND_MS);
      expect(pending.isSettled()).toBe(true);
      await expectKitRefused(await pending.promise);
      expect(audit.calls).toHaveLength(1);
      expect(audit.calls[0]?.[0]).toMatchObject({
        viewerDiscordId: VIEWER,
        subjectUserIds: [SUBJECT],
        resource: "profile",
        action: "view",
        route: "profile",
      });
    } finally {
      audit.resolve(true);
      await pending.promise.catch(() => undefined);
    }
  });

  it("releases the buffered response when the audit succeeds before the deadline", async () => {
    const audit = deferredSink();
    const pending = tracked(
      memberReads.memberReadResponse(meta, declared(), audit.sink, kitRender()),
    );
    await audit.enteredPromise;
    audit.resolve(true);
    const res = await pending.promise;
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(["__Host-leak=1; Path=/; Secure"]);
    expect(await res.text()).toContain(SUBJECT);
    expect(audit.calls).toHaveLength(1);
  });

  it("a late audit success cannot alter the refused response or replay the write", async () => {
    const audit = deferredSink();
    const collector = unhandledRejectionCollector();
    const pending = tracked(
      memberReads.memberReadResponse(meta, declared(), audit.sink, kitRender()),
    );
    try {
      await audit.enteredPromise;
      await vi.advanceTimersByTimeAsync(OUTER_BOUND_MS);
      expect(pending.isSettled()).toBe(true);
      const res = await pending.promise;
      await expectKitRefused(res);
      audit.resolve(true);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(OUTER_BOUND_MS);
      expect(audit.calls).toHaveLength(1);
      expect(res.status).toBe(503);
      expect(collector.seen).toEqual([]);
    } finally {
      audit.resolve(true);
      await pending.promise.catch(() => undefined);
      collector.stop();
    }
  });

  it("a late audit rejection cannot alter the refused response or escape unhandled", async () => {
    const audit = deferredSink();
    const collector = unhandledRejectionCollector();
    const pending = tracked(
      memberReads.memberReadResponse(meta, declared(), audit.sink, kitRender()),
    );
    try {
      await audit.enteredPromise;
      await vi.advanceTimersByTimeAsync(OUTER_BOUND_MS);
      expect(pending.isSettled()).toBe(true);
      const res = await pending.promise;
      await expectKitRefused(res);
      audit.reject(new Error(`insert failed for ${SUBJECT}`));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(OUTER_BOUND_MS);
      expect(audit.calls).toHaveLength(1);
      expect(res.status).toBe(503);
      expect(collector.seen).toEqual([]);
      const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(logged).not.toContain(SUBJECT);
    } finally {
      audit.resolve(true);
      await pending.promise.catch(() => undefined);
      collector.stop();
    }
  });

  it("a self-only read waits for no audit and is released without a sink call", async () => {
    const audit = deferredSink();
    const res = await memberReads.memberReadResponse(
      meta,
      declared(),
      audit.sink,
      kitRender([VIEWER]),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SUBJECT);
    expect(audit.calls).toHaveLength(0);
  });
});
