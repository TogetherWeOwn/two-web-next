import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const binder = readFileSync(
  new NodeURL("../public/islands/going-count.js", import.meta.url),
  "utf8",
);
const MOUNT = '[data-island="going-count"]';
const EVENT = "going-count-updated";

class TextTarget {
  private value: string;
  writes: string[] = [];

  constructor(initial: string) {
    this.value = initial;
  }

  get textContent() {
    return this.value;
  }
  set textContent(value: string) {
    this.value = value;
    this.writes.push(value);
  }
}

class SpotsTarget extends TextTarget {
  removed = false;
  remove() {
    this.removed = true;
  }
}

class Badge {
  private attributes: Map<string, string>;
  count: TextTarget;
  spots: SpotsTarget | null;
  announcement = new TextTarget("");

  constructor(key: string, capacity: string) {
    this.attributes = new Map([
      ["data-island", "going-count"],
      ["data-event-key", key],
      ["data-capacity", capacity],
    ]);
    this.count = new TextTarget(capacity ? `4 of ${capacity} going` : "4 going");
    this.spots = capacity
      ? new SpotsTarget(`${Number(capacity) - 4} of ${capacity} spots left`)
      : null;
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  querySelector(selector: string) {
    if (selector === "[data-count]") return this.count;
    if (selector === "[data-spots]") return this.spots && !this.spots.removed ? this.spots : null;
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
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Detail = { eventKey?: string; viewerState?: string };
type PendingRead = ReturnType<typeof deferred<ReadResponse>>;

// Same hermetic VM harness as the ownership/admission suites: the shipped
// source evaluates against fixture mounts with deferred fetches only — no
// network, database or shared document.
function browser(...badges: Badge[]) {
  const listeners: ((event: { detail: Detail }) => void)[] = [];
  const requests: { url: string; init: { headers: Record<string, string> }; read: PendingRead }[] =
    [];
  runInContext(
    binder,
    createContext({
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
    }),
    { filename: "public/islands/going-count.js" },
  );

  return {
    requests,
    broadcast(detail: Detail) {
      listeners.forEach((listener) => listener({ detail }));
    },
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

describe("GoingCount capacity refresh from the admitted snapshot", () => {
  it("SSR 5 with response capacity 10/count 4 yields 4 of 10 going and 6 of 10 spots left", async () => {
    const badge = new Badge("a", "5");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.respond(0, { data: [{ event_key: "a", going_count: 4, capacity: 10 }] });
    expect(badge.count.textContent).toBe("4 of 10 going");
    expect(badge.spots!.textContent).toBe("6 of 10 spots left");
    expect(badge.announcement.textContent).toBe("You're going. ");
  });

  it("finite-to-unlimited snapshot drops the cap from both displays", async () => {
    const badge = new Badge("a", "5");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.respond(0, [{ event_key: "a", going_count: 4, capacity: null }]);
    expect(badge.count.textContent).toBe("4 going");
    expect(badge.count.writes).toEqual(["4 going"]);
    // The stale spots line is removed and the mount binding follows the cap,
    // so a later read cannot compute against the retired number.
    expect(badge.spots!.removed).toBe(true);
    expect(badge.getAttribute("data-capacity")).toBe("");
    expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
  });

  it("unlimited-to-finite snapshot adopts the cap in both displays coherently", async () => {
    const badge = new Badge("a", "");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.respond(0, { data: [{ event_key: "a", going_count: 4, capacity: 10 }] });
    expect(badge.count.textContent).toBe("4 of 10 going");
    expect(badge.announcement.writes).toEqual(["You're going. "]);
  });

  it("keeps count-capacity pairs from the same snapshot across same-key badges", async () => {
    const badges = [new Badge("a", "5"), new Badge("a", "")];
    const other = new Badge("b", "5");
    const b = browser(...badges, other);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.respond(0, { data: [{ event_key: "a", going_count: 9, capacity: 10 }] });
    expect(badges.map((badge) => badge.count.textContent)).toEqual([
      "9 of 10 going",
      "9 of 10 going",
    ]);
    expect(badges[0]!.spots!.textContent).toBe("1 of 10 spots left");
    expect(other.count.writes).toEqual([]);
    expect(other.announcement.writes).toEqual([]);
  });

  it.each([
    ["string", "10"],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["object", {}],
    ["array", [10]],
    ["boolean", true],
    ["empty string", ""],
  ])(
    "rejects malformed capacity (%s) as a whole and preserves the prior display",
    async (_label, capacity) => {
      const badge = new Badge("a", "5");
      const b = browser(badge);
      b.broadcast({ eventKey: "a", viewerState: "going" });
      await b.respond(0, { data: [{ event_key: "a", going_count: 4, capacity }] });
      expect(badge.count.textContent).toBe("4 of 5 going");
      expect(badge.count.writes).toEqual([]);
      expect(badge.spots!.writes).toEqual([]);
      expect(badge.announcement.writes).toEqual([]);
      // A later valid snapshot still recovers.
      b.broadcast({ eventKey: "a", viewerState: "none" });
      await b.respond(1, { data: [{ event_key: "a", going_count: 1, capacity: 10 }] });
      expect(badge.count.textContent).toBe("1 of 10 going");
      expect(badge.spots!.textContent).toBe("9 of 10 spots left");
      expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
    },
  );

  it("falls back to the SSR cap when the snapshot carries no capacity key", async () => {
    const badge = new Badge("a", "5");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.respond(0, [{ event_key: "a", going_count: 4 }]);
    expect(badge.count.textContent).toBe("4 of 5 going");
    expect(badge.spots!.textContent).toBe("1 of 5 spots left");
    expect(badge.announcement.writes).toEqual(["You're going. "]);
  });

  it("invalidates stale completions carrying a superseded capacity", async () => {
    const badge = new Badge("a", "5");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.respond(1, { data: [{ event_key: "a", going_count: 1, capacity: 10 }] });
    expect(badge.count.textContent).toBe("1 of 10 going");
    expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
    await b.respond(0, { data: [{ event_key: "a", going_count: 4, capacity: 8 }] });
    expect(badge.count.textContent).toBe("1 of 10 going");
    expect(badge.spots!.textContent).toBe("9 of 10 spots left");
    expect(badge.count.writes).toEqual(["1 of 10 going"]);
    expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
  });
});
