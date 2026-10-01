import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const binder = readFileSync(new NodeURL("../public/islands/going-count.js", import.meta.url), "utf8");
const MOUNT = '[data-island="going-count"]';
const EVENT = "going-count-updated";

class TextTarget {
  private value: string;
  writes: string[] = [];

  constructor(initial: string) {
    this.value = initial;
  }

  get textContent() { return this.value; }
  set textContent(value: string) {
    this.value = value;
    this.writes.push(value);
  }
}

class Badge {
  private attributes: Map<string, string>;
  count: TextTarget;
  announcement = new TextTarget("");

  constructor(key: string, capacity: string = "4") {
    this.attributes = new Map([["data-island", "going-count"], ["data-event-key", key], ["data-capacity", capacity]]);
    this.count = new TextTarget(capacity ? `2 of ${capacity} going` : "2 going");
  }

  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelector(selector: string) {
    if (selector === "[data-count]") return this.count;
    if (selector === "[data-announcement]") return this.announcement;
    return null;
  }
}

interface ReadResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Detail = { eventKey?: string; viewerState?: string };
type PendingRead = ReturnType<typeof deferred<ReadResponse>>;

// Each fixture evaluates the distributed source in its own VM, with only the
// DOM surface the binder uses and deferred fetch/JSON responses. No helper
// implementation, real network, database or shared document is involved.
function browser(...badges: Badge[]) {
  const listeners: ((event: { detail: Detail }) => void)[] = [];
  const requests: { url: string; init: { headers: Record<string, string> }; read: PendingRead }[] = [];
  runInContext(binder, createContext({
    document: {
      addEventListener(type: string, listener: (event: { detail: Detail }) => void) {
        expect(type).toBe(EVENT);
        listeners.push(listener);
      },
      querySelectorAll(selector: string) {
        expect(selector).toBe(MOUNT);
        return badges;
      },
    },
    fetch(url: string, init: { headers: Record<string, string> }) {
      const read = deferred<ReadResponse>();
      requests.push({ url, init, read });
      return read.promise;
    },
  }), { filename: "public/islands/going-count.js" });

  return {
    requests,
    broadcast(detail: Detail) { listeners.forEach((listener) => listener({ detail })); },
    async respond(index: number, body: unknown) {
      requests[index]!.read.resolve({ ok: true, status: 200, json: async () => body });
      await settle();
    },
  };
}

// A task boundary drains the entire fetch -> JSON -> DOM promise chain,
// including promises created in the VM, without sleeps or timed polling.
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const rows = (key: string, count: number) => [{ event_key: key, going_count: count }];

async function fail(b: ReturnType<typeof browser>, index: number, failure: string) {
  const read = b.requests[index]!.read;
  if (failure === "network") read.reject(new Error("offline"));
  else if (failure === "http") read.resolve({ ok: false, status: 500, json: async () => rows("a", 99) });
  else if (failure === "json") read.resolve({ ok: true, status: 200, json: async () => { throw new Error("invalid JSON"); } });
  else read.resolve({ ok: true, status: 200, json: async () => ({ data: rows("other", 99) }) });
  await settle();
}

const failures = ["network", "http", "json", "missing row"];

describe("GoingCount distributed binder refresh ownership", () => {
  it("mounts silently and ignores unmatched or keyless broadcasts", () => {
    const badge = new Badge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "other", viewerState: "going" });
    b.broadcast({ viewerState: "going" });
    expect(b.requests).toHaveLength(0);
    expect(badge.count.textContent).toBe("2 of 4 going");
    expect(badge.announcement.writes).toEqual([]);
  });

  it("keeps B's count and announcement when B finishes before A", async () => {
    const badge = new Badge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    b.broadcast({ eventKey: "a", viewerState: "none" });
    expect(b.requests).toHaveLength(2);
    expect(b.requests[0]!.init.headers).toEqual({ accept: "application/json" });
    await b.respond(1, { data: rows("a", 1) });
    expect(badge.count.textContent).toBe("1 of 4 going");
    expect(badge.announcement.textContent).toBe("RSVP removed. ");
    await b.respond(0, rows("a", 3));
    expect(badge.count.textContent).toBe("1 of 4 going");
    expect(badge.count.writes).toEqual(["1 of 4 going"]);
    expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
  });

  it("does not publish A or steal B's announcement while B is pending", async () => {
    const badge = new Badge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    b.broadcast({ eventKey: "a", viewerState: "waitlisted" });
    await b.respond(0, rows("a", 3));
    expect(badge.count.textContent).toBe("2 of 4 going");
    expect(badge.announcement.writes).toEqual([]);
    await b.respond(1, rows("a", 4));
    expect(badge.count.textContent).toBe("4 of 4 going");
    expect(badge.announcement.writes).toEqual(["You're on the waitlist. "]);
  });

  it("checks ownership after a deferred JSON body, not only fetch completion", async () => {
    const badge = new Badge("a");
    const b = browser(badge);
    const body = deferred<unknown>();
    b.broadcast({ eventKey: "a", viewerState: "going" });
    b.requests[0]!.read.resolve({ ok: true, status: 200, json: () => body.promise });
    await settle();
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.respond(1, rows("a", 1));
    body.resolve(rows("a", 3));
    await settle();
    expect(badge.count.writes).toEqual(["1 of 4 going"]);
    expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
  });

  it.each(failures)("keeps the last good state when newest B fails (%s) and older A succeeds", async (failure) => {
    const badge = new Badge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.respond(0, rows("a", 3));
    b.broadcast({ eventKey: "a", viewerState: "waitlisted" });
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await fail(b, 2, failure);
    await b.respond(1, rows("a", 4));
    expect(badge.count.textContent).toBe("3 of 4 going");
    expect(badge.announcement.writes).toEqual(["You're going. "]);
    // A later successful operation can still recover from the failed read.
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.respond(3, rows("a", 1));
    expect(badge.count.textContent).toBe("1 of 4 going");
    expect(badge.announcement.writes).toEqual(["You're going. ", "RSVP removed. "]);
  });

  it.each(failures)("ignores stale A's failure (%s) after B succeeds", async (failure) => {
    const badge = new Badge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.respond(1, rows("a", 1));
    await fail(b, 0, failure);
    expect(badge.count.writes).toEqual(["1 of 4 going"]);
    expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
  });

  it("does not replay a failed operation's announcement on a count-only refresh", async () => {
    const badge = new Badge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await fail(b, 0, "network");
    b.broadcast({ eventKey: "a" });
    await b.respond(1, rows("a", 3));
    expect(badge.count.textContent).toBe("3 of 4 going");
    expect(badge.announcement.writes).toEqual([]);
  });

  it("shares one read and outcome across same-key badges with their own capacities", async () => {
    const badges = [new Badge("a"), new Badge("a", "8"), new Badge("a", "")];
    const other = new Badge("b");
    const b = browser(...badges, other);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    b.broadcast({ eventKey: "a", viewerState: "none" });
    expect(b.requests).toHaveLength(2);
    await b.respond(1, rows("a", 1));
    await b.respond(0, rows("a", 3));
    expect(badges.map((badge) => badge.count.textContent)).toEqual(["1 of 4 going", "1 of 8 going", "1 going"]);
    for (const badge of badges) expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
    expect(other.count.writes).toEqual([]);
    expect(other.announcement.writes).toEqual([]);
  });

  it("tracks ownership separately for interleaved event keys", async () => {
    const a = new Badge("a");
    const other = new Badge("b", "");
    const b = browser(a, other);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    b.broadcast({ eventKey: "b", viewerState: "waitlisted" });
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.respond(2, { data: [...rows("b", 99), ...rows("a", 1)] });
    await b.respond(1, rows("b", 6));
    await b.respond(0, rows("a", 3));
    expect(a.count.writes).toEqual(["1 of 4 going"]);
    expect(a.announcement.writes).toEqual(["RSVP removed. "]);
    expect(other.count.writes).toEqual(["6 going"]);
    expect(other.announcement.writes).toEqual(["You're on the waitlist. "]);
  });
});
