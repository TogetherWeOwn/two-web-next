// EventsCalendar IME composition (TOG-11394): partial composition text must not
// trigger live-search fetches or history updates. Hermetic Node VM with a fake
// clock; no database, browser or network.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const APP_URL = "https://next.example.test";
const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const LIVE_IDS = [
  "events-view-status",
  "events-search-status",
  "events-past-status",
  "calendar-month-status",
];

class Node {
  childNodes: unknown[] = [];
  hidden = false;
  textContent = "";
  value = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (e: unknown) => void>();
  setAttribute(k: string, v: string) {
    this.attributes.set(k, v);
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  replaceChildren(...c: unknown[]) {
    this.childNodes = c;
  }
  focus() {}
  addEventListener(t: string, fn: (e: unknown) => void) {
    this.listeners.set(t, fn);
  }
  closest() {
    return null as unknown;
  }
}

function browser() {
  const form = new Node();
  const input = new Node();
  input.closest = () => form;
  const zones = ["head", "actions", "miss", "content"].map((n) => {
    const z = new Node();
    z.attributes.set("data-cal-zone", n);
    return z;
  });
  const skeleton = new Node();
  skeleton.hidden = true;
  const live = Object.fromEntries(LIVE_IDS.map((id) => [id, new Node()])) as Record<string, Node>;
  const root = Object.assign(new Node(), {
    querySelector: (s: string) => {
      if (s === '[data-testid="events-loading"]') return skeleton;
      if (s === "[data-cal-feedback]") return new Node();
      if (s === '[data-testid="events-search"]') return input;
      if (s === '[data-cal-zone="content"]') return zones[3];
      const id = /data-testid="([^"]+)"/.exec(s)?.[1];
      return (id && live[id]) || null;
    },
    querySelectorAll: () => zones,
    contains: () => true,
  });
  const history: string[] = [];
  const location = { href: `${APP_URL}/events`, origin: APP_URL, assign: () => {} };
  const requests: { url: string; init: RequestInit }[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  let next = 0;
  runInNewContext(binder, {
    URL,
    AbortController,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    document: {
      querySelector: (s: string) =>
        s === '[data-island="events-calendar"]' ? root : { href: `${APP_URL}/events`, content: "" },
      importNode: (n: unknown) => n,
    },
    window: {
      location,
      history: {
        pushState: (_s: unknown, _t: string, url: string) => {
          history.push(url);
          location.href = APP_URL + url;
        },
      },
      addEventListener: () => {},
    },
    DOMParser: class {
      parseFromString() {
        return null;
      }
    },
    fetch: (url: string, init: RequestInit) => new Promise(() => requests.push({ url, init })),
  });
  const fire = (type: string, e: Record<string, unknown> = {}) => input.listeners.get(type)!(e);
  return {
    input,
    requests,
    history,
    root,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
    },
    pending: () => timers.size,
    compositionstart: () => fire("compositionstart"),
    compositionend: () => fire("compositionend"),
    inputEvent: (isComposing = false) => fire("input", { isComposing }),
    submit: () => form.listeners.get("submit")!({ preventDefault() {}, isComposing: false }),
    submitComposing: () =>
      form.listeners.get("submit")!({ preventDefault() {}, isComposing: true }),
  };
}

describe("EventsCalendar IME composition", () => {
  it("performs no fetch or history update while composing past the debounce", () => {
    const b = browser();
    b.compositionstart();
    b.input.value = "に";
    b.inputEvent(true);
    b.advance(1000);
    expect(b.requests).toHaveLength(0);
    expect(b.history).toEqual([]);
    expect(b.pending()).toBe(0);
  });

  it("schedules exactly one search from the committed text on compositionend", () => {
    const b = browser();
    b.compositionstart();
    b.input.value = "に";
    b.inputEvent(true);
    b.input.value = "日本";
    b.compositionend();
    b.inputEvent(false); // trailing input event
    expect(b.pending()).toBe(1);
    b.advance(300);
    expect(b.requests.map((r) => r.url)).toEqual(["/events?q=%E6%97%A5%E6%9C%AC"]);
  });

  it("does not submit on Enter during composition but submits normally otherwise", () => {
    const b = browser();
    b.input.value = "に";
    b.compositionstart();
    b.submitComposing();
    b.submit();
    expect(b.requests).toHaveLength(0);
    b.compositionend();
    b.advance(300);
    expect(b.requests).toHaveLength(1);
    b.input.value = "jam";
    b.inputEvent();
    b.submit();
    expect(b.requests[1]!.url).toBe("/events?q=jam");
  });

  it("aborts an active search when composition begins and ordinary typing still debounces", () => {
    const b = browser();
    b.input.value = "jam";
    b.inputEvent();
    b.advance(300);
    expect(b.requests).toHaveLength(1);
    b.compositionstart();
    expect(b.requests[0]!.init.signal!.aborted).toBe(true);
    b.compositionend();
    b.input.value = "jams";
    b.inputEvent();
    b.advance(300);
    expect(b.requests.map((r) => r.url)).toEqual(["/events?q=jam", "/events?q=jams"]);
  });

  it("cancels a pending composed search on explicit navigation", () => {
    const b = browser();
    b.compositionstart();
    b.input.value = "日本";
    b.compositionend();
    expect(b.pending()).toBe(1);
    const link = {
      href: `${APP_URL}/events?view=calendar`,
      hash: "",
      target: "",
      hasAttribute: () => false,
    };
    b.root.listeners.get("click")!({
      defaultPrevented: false,
      button: 0,
      target: { closest: () => link },
      preventDefault() {},
    });
    expect(b.pending()).toBe(0);
    b.advance(1000);
    expect(b.requests.map((r) => r.url)).toEqual(["/events?view=calendar"]);
  });
});
