import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const binder = readFileSync(new NodeURL("../public/islands/going-count.js", import.meta.url), "utf8");
const EVENT = "going-count-updated";

class TextTarget {
  writes: string[] = [];
  private value: string;

  constructor(initial: string) { this.value = initial; }
  get textContent() { return this.value; }
  set textContent(value: string) {
    this.value = value;
    this.writes.push(value);
  }
}

class Badge {
  count: TextTarget;
  spots: TextTarget | null;
  announcement = new TextTarget("You're going. ");

  constructor(readonly key: string, readonly capacity: string) {
    this.count = new TextTarget(capacity ? `2 of ${capacity} going` : "2 going");
    this.spots = capacity ? new TextTarget(`${Number(capacity) - 2} of ${capacity} spots left`) : null;
  }

  getAttribute(name: string) {
    if (name === "data-event-key") return this.key;
    if (name === "data-capacity") return this.capacity;
    return null;
  }
  querySelector(selector: string) {
    if (selector === "[data-count]") return this.count;
    if (selector === "[data-spots]") return this.spots;
    if (selector === "[data-announcement]") return this.announcement;
    return null;
  }
}

interface ReadResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

// Evaluate the shipped binder with fixture mounts and deferred fetches only.
// A task boundary drains its promises without timers, polling or live services.
function browser() {
  const badges = [new Badge("a", "4"), new Badge("a", "8"), new Badge("a", "")];
  const other = new Badge("b", "4");
  const listeners: ((event: { detail: { eventKey: string; viewerState: string } }) => void)[] = [];
  const requests: { resolve: (response: ReadResponse) => void }[] = [];
  runInContext(binder, createContext({
    document: {
      addEventListener(type: string, listener: typeof listeners[number]) {
        expect(type).toBe(EVENT);
        listeners.push(listener);
      },
      querySelectorAll(selector: string) {
        expect(selector).toBe('[data-island="going-count"]');
        return [...badges, other];
      },
    },
    fetch(url: string, init: { headers: Record<string, string> }) {
      expect(url).toBe("/events.json?event_key=a");
      expect(init.headers).toEqual({ accept: "application/json" });
      return new Promise<ReadResponse>((resolve) => requests.push({ resolve }));
    },
  }), { filename: "public/islands/going-count.js" });

  return {
    badges, other, requests,
    broadcast(viewerState = "none") {
      listeners.forEach((listener) => listener({ detail: { eventKey: "a", viewerState } }));
    },
    async respond(index: number, body: unknown) {
      requests[index]!.resolve({ ok: true, json: async () => body });
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function expectUntouched(b: ReturnType<typeof browser>) {
  expect(b.badges.map((badge) => badge.count.textContent)).toEqual(["2 of 4 going", "2 of 8 going", "2 going"]);
  for (const badge of [...b.badges, b.other]) {
    expect(badge.count.writes).toEqual([]);
    if (badge.spots) {
      expect(badge.spots.textContent).toBe(`${Number(badge.capacity) - 2} of ${badge.capacity} spots left`);
      expect(badge.spots.writes).toEqual([]);
    }
    expect(badge.announcement.textContent).toBe("You're going. ");
    expect(badge.announcement.writes).toEqual([]);
  }
}

const invalidRows = [
  ["missing", { event_key: "a" }],
  ["undefined", { event_key: "a", going_count: undefined }],
  ["null", { event_key: "a", going_count: null }],
  ["numeric string", { event_key: "a", going_count: "3" }],
  ["empty string", { event_key: "a", going_count: "" }],
  ["boolean", { event_key: "a", going_count: true }],
  ["object", { event_key: "a", going_count: {} }],
  ["array", { event_key: "a", going_count: [3] }],
  ["negative", { event_key: "a", going_count: -1 }],
  ["fractional", { event_key: "a", going_count: 1.5 }],
  ["NaN", { event_key: "a", going_count: NaN }],
  ["positive infinity", { event_key: "a", going_count: Infinity }],
  ["negative infinity", { event_key: "a", going_count: -Infinity }],
  ["unsafe integer", { event_key: "a", going_count: Number.MAX_SAFE_INTEGER + 1 }],
] as const;

const malformedBodies: [string, unknown][] = [
  ["null", null], ["undefined", undefined], ["string", "events"],
  ["number", 3], ["boolean", true], ["empty object", {}],
  ["null data", { data: null }], ["object data", { data: { event_key: "a", going_count: 3 } }],
  ["string data", { data: "events" }], ["number data", { data: 3 }],
  ["empty array", []], ["malformed candidates", [null, undefined, false, 3, "a", [], {}]],
  ["missing matching row", [{ event_key: "b", going_count: 9 }]],
  ["wrong key type", [{ event_key: ["a"], going_count: 9 }]],
];

const envelopes = [
  ["array", (rows: unknown[]) => rows],
  ["data", (rows: unknown[]) => ({ data: rows })],
] as const;

describe.each(envelopes)("GoingCount %s envelope admission", (_name, envelope) => {
  it.each(invalidRows)("preserves all badges and announcements for %s counts", async (_label, row) => {
    const b = browser();
    b.broadcast();
    await b.respond(0, envelope([{ event_key: "b", going_count: 9 }, row]));
    expect(b.requests).toHaveLength(1);
    expectUntouched(b);
  });

  it.each([0, 1, 3, Number.MAX_SAFE_INTEGER])("updates same-key mounts together for valid count %s", async (count) => {
    const b = browser();
    b.broadcast();
    await b.respond(0, envelope([{ event_key: "b", going_count: 9 }, { event_key: "a", going_count: count }]));
    expect(b.requests).toHaveLength(1);
    expect(b.badges.map((badge) => badge.count.textContent)).toEqual([`${count} of 4 going`, `${count} of 8 going`, `${count} going`]);
    for (const badge of b.badges) {
      expect(badge.count.writes).toHaveLength(1);
      if (badge.spots) {
        const capacity = Number(badge.capacity);
        expect(badge.spots.writes).toEqual([count >= capacity ? "Full" : `${capacity - count} of ${capacity} spots left`]);
      }
      expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
    }
    expect(b.other.count.writes).toEqual([]);
    expect(b.other.announcement.writes).toEqual([]);
  });

  it("ignores malformed candidates around a valid matching row", async () => {
    const b = browser();
    b.broadcast();
    await b.respond(0, envelope([null, false, "a", [], {}, { event_key: "a", going_count: 3 }, null]));
    expect(b.badges.map((badge) => badge.count.textContent)).toEqual(["3 of 4 going", "3 of 8 going", "3 going"]);
    for (const badge of b.badges) expect(badge.announcement.writes).toEqual(["RSVP removed. "]);
    expect(b.other.count.writes).toEqual([]);
    expect(b.other.announcement.writes).toEqual([]);
  });
});

describe("GoingCount invalid response ownership", () => {
  it.each([...invalidRows.map(([name, row]): [string, unknown] => [name, [row]]), ...malformedBodies])(
    "newer %s response preserves the last good state and invalidates older completions",
    async (_label, body) => {
      const b = browser();
      b.broadcast("going");
      b.broadcast("none");
      await b.respond(1, body);
      expectUntouched(b);
      await b.respond(0, [{ event_key: "a", going_count: 4 }]);
      expectUntouched(b);
      b.broadcast("waitlisted");
      await b.respond(2, { data: [{ event_key: "a", going_count: 1 }] });
      expect(b.badges.map((badge) => badge.count.textContent)).toEqual(["1 of 4 going", "1 of 8 going", "1 going"]);
      for (const badge of b.badges) expect(badge.announcement.writes).toEqual(["You're on the waitlist. "]);
      expect(b.other.count.writes).toEqual([]);
      expect(b.other.announcement.writes).toEqual([]);
    },
  );
});
