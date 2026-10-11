import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const binder = readFileSync(
  new NodeURL("../public/islands/auth-status.js", import.meta.url),
  "utf8",
);
const BUDGET_MS = 4000;
const RECOVERY_URL = "/auth/recover?next=" + encodeURIComponent("/profile?tab=about");

type Listener = (event: object) => void;
type Reply = { ok: boolean; json: () => Promise<unknown> };
type Api = { check: () => Promise<boolean | null> };
type Timer = { due: number; run: () => void };

class FakeEvent {
  defaultPrevented = false;
  readonly detail: unknown;
  constructor(
    readonly type: string,
    init: { detail?: unknown } = {},
  ) {
    this.detail = init.detail;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

function browser() {
  let now = 1_000_000;
  let timerId = 0;
  const timers = new Map<number, Timer>();
  const requests: { signal: AbortSignal; respond: (reply: Reply) => void }[] = [];
  const listeners = new Map<string, Listener[]>();
  const expiries: unknown[] = [];
  const navigations: string[] = [];
  const on = (key: string, listener: Listener) => {
    listeners.set(key, [...(listeners.get(key) ?? []), listener]);
  };
  const window = {
    TwoAuth: undefined as Api | undefined,
    addEventListener: (type: string, listener: Listener) => on(`window:${type}`, listener),
    dispatchEvent(event: FakeEvent) {
      if (event.type === "two:session-expired") expiries.push(event.detail);
      for (const listener of listeners.get(`window:${event.type}`) ?? []) listener(event);
      return !event.defaultPrevented;
    },
    fire(type: string, init: { persisted?: boolean } = {}) {
      for (const listener of listeners.get(`window:${type}`) ?? []) listener(init);
    },
  };
  const document = {
    visibilityState: "visible",
    addEventListener: (type: string, listener: Listener) => on(`document:${type}`, listener),
    querySelector: () => null,
  };
  const location = {
    pathname: "/profile",
    search: "?tab=about",
    reload: () => navigations.push("reload"),
    assign: (href: string) => navigations.push(href),
  };
  const fakeSetTimeout = (run: () => void, ms: number) => {
    timerId += 1;
    timers.set(timerId, { due: now + ms, run });
    return timerId;
  };
  const fakeClearTimeout = (id: number) => {
    timers.delete(id);
  };
  const fakeFetch = (_url: string, init: { signal: AbortSignal }) =>
    new Promise<Reply>((respond) => {
      requests.push({ signal: init.signal, respond });
    });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  function nextDue(target: number) {
    let found: [number, Timer] | undefined;
    for (const entry of timers) {
      if (entry[1].due <= target && (!found || entry[1].due < found[1].due)) found = entry;
    }
    return found;
  }
  // Fires timers in due order and lets promise callbacks run after each one.
  async function advance(ms: number) {
    const target = now + ms;
    for (let due = nextDue(target); due; due = nextDue(target)) {
      timers.delete(due[0]);
      now = due[1].due;
      due[1].run();
      await flush();
    }
    now = target;
    await flush();
  }
  runInNewContext(binder, {
    window,
    document,
    location,
    fetch: fakeFetch,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    AbortController,
    CustomEvent: FakeEvent,
    Date: { now: () => now },
  });
  return {
    api: window.TwoAuth as Api,
    window,
    requests,
    expiries,
    navigations,
    advance,
    flush,
  };
}

const reply = (body: unknown): Reply => ({ ok: true, json: async () => body });
const never = (): Promise<unknown> => new Promise(() => {});

function track(promise: Promise<unknown>) {
  const state: { settled: boolean; value?: unknown } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

describe("auth-status check budget when fetch ignores abort", () => {
  it("hung headers settle unknown at the four-second budget and renew checking", async () => {
    const b = browser();
    const first = track(b.api.check());
    await b.advance(BUDGET_MS - 1);
    expect(first.settled).toBe(false);
    await b.advance(1);
    expect(first).toMatchObject({ settled: true, value: null });
    expect(b.requests[0]?.signal.aborted).toBe(true);
    expect(b.expiries).toEqual([]);
    expect(b.navigations).toEqual([]);

    const next = track(b.api.check());
    expect(b.requests).toHaveLength(2);
    b.requests[1]?.respond(reply({ authenticated: true }));
    await b.flush();
    expect(next).toMatchObject({ settled: true, value: true });
  });

  it("a hung JSON body shares the same budget as the headers", async () => {
    const b = browser();
    const first = track(b.api.check());
    await b.advance(3500);
    b.requests[0]?.respond({ ok: true, json: never });
    await b.flush();
    await b.advance(BUDGET_MS - 3500 - 1);
    expect(first.settled).toBe(false);
    await b.advance(1);
    expect(first).toMatchObject({ settled: true, value: null });
    expect(b.expiries).toEqual([]);
  });

  it("a recheck queued during a hung request runs once the budget releases it", async () => {
    const b = browser();
    const first = track(b.api.check());
    void b.api.check();
    await b.advance(BUDGET_MS);
    expect(first).toMatchObject({ settled: true, value: null });
    expect(b.requests).toHaveLength(1);
    await b.advance(100);
    expect(b.requests).toHaveLength(2);
  });

  it("timely authenticated true and false keep their outcomes and effects", async () => {
    const b = browser();
    const yes = track(b.api.check());
    b.requests[0]?.respond(reply({ authenticated: true }));
    await b.flush();
    expect(yes).toMatchObject({ settled: true, value: true });
    expect(b.expiries).toEqual([]);

    const no = track(b.api.check());
    b.requests[1]?.respond(reply({ authenticated: false }));
    await b.flush();
    expect(no).toMatchObject({ settled: true, value: false });
    expect(b.expiries).toEqual([{ recoveryUrl: RECOVERY_URL }]);
    expect(b.navigations).toEqual(["reload"]);
    expect(await b.api.check()).toBe(false);
    expect(b.requests).toHaveLength(2);
  });

  it("a settled request's budget timer cannot abort a newer request", async () => {
    const b = browser();
    const first = track(b.api.check());
    await b.advance(1000);
    b.requests[0]?.respond(reply({ authenticated: true }));
    await b.flush();
    expect(first).toMatchObject({ settled: true, value: true });
    void b.api.check();
    expect(b.requests).toHaveLength(2);
    await b.advance(BUDGET_MS - 1000);
    expect(b.requests[0]?.signal.aborted).toBe(false);
    expect(b.requests[1]?.signal.aborted).toBe(false);
  });

  it("a late false after the budget cannot expire the session", async () => {
    const b = browser();
    const first = track(b.api.check());
    await b.advance(BUDGET_MS);
    b.requests[0]?.respond(reply({ authenticated: false }));
    await b.flush();
    expect(first).toMatchObject({ settled: true, value: null });
    expect(b.expiries).toEqual([]);
    expect(b.navigations).toEqual([]);
  });

  it("a late response from an expired request cannot clear a newer request", async () => {
    const b = browser();
    track(b.api.check());
    await b.advance(BUDGET_MS);
    const current = b.api.check();
    const currentState = track(current);
    expect(b.requests).toHaveLength(2);
    b.requests[0]?.respond(reply({ authenticated: true }));
    await b.flush();
    expect(currentState.settled).toBe(false);
    expect(b.api.check()).toBe(current);
    expect(b.requests).toHaveLength(2);
    b.requests[1]?.respond(reply({ authenticated: true }));
    await b.flush();
    expect(currentState).toMatchObject({ settled: true, value: true });
    void b.api.check();
    expect(b.requests).toHaveLength(3);
  });

  it("pagehide and pageshow keep rechecking alive when fetch ignores abort", async () => {
    const b = browser();
    const first = track(b.api.check());
    b.window.fire("pagehide");
    expect(b.requests[0]?.signal.aborted).toBe(true);
    b.window.fire("pageshow", { persisted: true });
    await b.advance(BUDGET_MS);
    expect(first).toMatchObject({ settled: true, value: null });
    await b.advance(100);
    expect(b.requests).toHaveLength(2);
  });
});
