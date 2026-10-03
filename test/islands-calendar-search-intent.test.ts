import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://calendar.example.test";
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
  href = "";
  content = "";
  value = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
  swaps = 0;
  focused = false;
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  replaceChildren(...children: unknown[]) {
    this.childNodes = children;
    this.swaps++;
  }
  addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void) {
    this.listeners.set(type, listener);
  }
  focus() {
    this.focused = true;
  }
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

type Response = { ok: boolean; text: () => Promise<string> };
type Click = {
  defaultPrevented: boolean;
  button: number;
  target: { closest: () => unknown };
  preventDefault: () => void;
};

// Execute the shipped binder with a fixture-local DOM, controllable fetch/body
// responses (deliberately able to finish after abort), and Vitest's 300ms clock.
// No server, DB, real network or copied search implementation is involved.
function browser(entry = "/events") {
  const form = new Node();
  const input = Object.assign(new Node(), { closest: () => form });
  input.focus();
  const zones = ["head", "actions", "miss", "content"].map((name) => {
    const node = new Node();
    node.setAttribute("data-cal-zone", name);
    node.childNodes = [`initial ${name}`];
    return node;
  });
  const content = zones[3]!;
  const skeleton = new Node();
  skeleton.hidden = true;
  const feedback = new Node();
  feedback.textContent = "last-good feedback";
  const live = LIVE_IDS.map((id) => Object.assign(new Node(), { textContent: `initial ${id}` }));
  const canonical = Object.assign(new Node(), { href: ORIGIN + entry });
  const og = Object.assign(new Node(), { content: canonical.href });
  let click!: (event: Click) => void;
  let popstate!: () => void;
  const root = Object.assign(new Node(), {
    dataset: {
      view: "list",
      month: "2026-10",
      past: "",
      loadError: "Calendar unavailable. Try again.",
    },
    querySelector(selector: string) {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-testid="events-search"]') return input;
      if (selector === '[data-cal-zone="content"]') return content;
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
      return live[LIVE_IDS.indexOf(id ?? "")] ?? null;
    },
    querySelectorAll: () => zones,
    contains: () => true,
    addEventListener(_type: string, listener: typeof click) {
      click = listener;
    },
  });
  const history: string[] = [];
  const reloads: string[] = [];
  const location = {
    href: ORIGIN + entry,
    origin: ORIGIN,
    assign: (href: string) => reloads.push(href),
  };
  const requests: {
    url: string;
    signal: AbortSignal;
    response: ReturnType<typeof deferred<Response>>;
  }[] = [];
  const pages = new Map<string, { querySelector: (selector: string) => unknown }>();
  runInNewContext(
    binder,
    {
      URL: NodeURL,
      AbortController,
      setTimeout,
      clearTimeout,
      document: {
        querySelector: (selector: string) =>
          selector.startsWith("link") ? canonical : selector.startsWith("meta") ? og : root,
        importNode: (node: unknown) => node,
      },
      window: {
        location,
        history: {
          pushState(_state: unknown, _title: string, path: string) {
            history.push(path);
            location.href = ORIGIN + path;
          },
        },
        addEventListener(_type: string, listener: () => void) {
          popstate = listener;
        },
      },
      DOMParser: class {
        parseFromString(html: string) {
          return pages.get(html);
        }
      },
      fetch(url: string, init: { signal: AbortSignal }) {
        const response = deferred<Response>();
        requests.push({ url, signal: init.signal, response });
        return response.promise;
      },
    },
    { filename: "public/islands/events-calendar.js" },
  );

  function page(index: number) {
    const url = new NodeURL(requests[index]!.url, ORIGIN);
    const sourceZones = zones.map((target) => {
      const node = new Node();
      const name = target.getAttribute("data-cal-zone")!;
      node.setAttribute("data-cal-zone", name);
      node.childNodes = [`${url.search || "all"} ${name}`];
      return node;
    });
    const next = {
      dataset: {
        view: url.searchParams.get("view") ?? "list",
        month: "2026-10",
        past: url.searchParams.get("past") ?? "",
      },
      querySelectorAll: () => sourceZones,
    };
    const key = `page-${index}`;
    pages.set(key, {
      querySelector(selector: string) {
        if (selector === '[data-island="events-calendar"]') return next;
        if (selector.startsWith("link")) return { href: url.href };
        const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
        if (id === "events-search") return { getAttribute: () => url.searchParams.get("q") ?? "" };
        if (LIVE_IDS.includes(id ?? "")) return { textContent: `${url.search || "all"} ${id}` };
        return null;
      },
    });
    return key;
  }

  return {
    input,
    zones,
    content,
    skeleton,
    root,
    feedback,
    live,
    canonical,
    og,
    history,
    reloads,
    location,
    requests,
    type(value: string) {
      input.value = value;
      input.listeners.get("input")!({ preventDefault() {} });
    },
    submit() {
      let prevented = false;
      form.listeners.get("submit")!({
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    },
    navigate(path: string, jump = false) {
      const url = new NodeURL(path, ORIGIN);
      const link = {
        href: url.href,
        hash: url.hash,
        target: "",
        hasAttribute: (name: string) => jump && name === "data-cal-jump",
      };
      let prevented = false;
      click({
        defaultPrevented: false,
        button: 0,
        target: { closest: () => link },
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    },
    back(path: string) {
      location.href = ORIGIN + path;
      popstate();
    },
    async respond(index: number) {
      const html = page(index);
      requests[index]!.response.resolve({ ok: true, text: async () => html });
      await settle();
    },
    async delayBody(index: number) {
      const html = page(index);
      const body = deferred<string>();
      requests[index]!.response.resolve({ ok: true, text: () => body.promise });
      await settle();
      return async () => {
        body.resolve(html);
        await settle();
      };
    },
  };
}

// Drain the complete VM promise chain without advancing the debounce clock.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Browser = ReturnType<typeof browser>;
const rendered = (b: Browser) => ({
  zones: b.zones.map((zone) => ({
    children: zone.childNodes,
    swaps: zone.swaps,
    hidden: zone.hidden,
  })),
  state: { ...b.root.dataset },
  live: b.live.map((node) => node.textContent),
  canonical: b.canonical.href,
  og: b.og.content,
  history: [...b.history],
  address: b.location.href,
  feedback: b.feedback.textContent,
  reloads: [...b.reloads],
});

function startSearch(b: Browser, value = "A", submit = false) {
  b.type(value);
  if (submit) expect(b.submit()).toBe(true);
  else vi.advanceTimersByTime(300);
  expect(b.requests).toHaveLength(1);
}

async function fail(b: Browser, index: number, kind: string) {
  const response = b.requests[index]!.response;
  if (kind === "http") response.resolve({ ok: false, text: async () => "unavailable" });
  else if (kind === "body")
    response.resolve({
      ok: true,
      text: async () => {
        throw new Error("broken body");
      },
    });
  else
    response.reject(
      Object.assign(new Error("offline"), { name: kind === "abort" ? "AbortError" : "Error" }),
    );
  await settle();
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("EventsCalendar search intent before the next debounce", () => {
  it.each([false, true])(
    "invalidates A immediately on B input (submitted A=%s), without fetching early",
    async (submitted) => {
      const b = browser();
      startSearch(b, "A", submitted);
      const previous = rendered(b);
      b.type("B");
      expect(b.requests[0]!.signal.aborted).toBe(true);
      await b.respond(0);
      expect(rendered(b)).toEqual(previous);
      expect(b.input.value).toBe("B");
      expect(b.input.focused).toBe(true);
      vi.advanceTimersByTime(299);
      expect(b.requests).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(b.requests.map((r) => r.url)).toEqual(["/events?q=A", "/events?q=B"]);
      await b.respond(1);
      expect(b.content.childNodes).toEqual(["?q=B content"]);
      expect(b.live.map((node) => node.textContent)).toEqual(LIVE_IDS.map((id) => `?q=B ${id}`));
      expect(b.canonical.href).toBe(ORIGIN + "/events?q=B");
      expect(b.og.content).toBe(b.canonical.href);
      expect(b.feedback.textContent).toBe("");
      expect(b.history).toEqual(["/events?q=B"]);
      expect(b.zones.every((zone) => zone.swaps === 1)).toBe(true);
      expect(b.skeleton.hidden).toBe(true);
    },
  );

  it.each([false, true])(
    "releases inherited navigation loading when B revokes search A (submitted A=%s)",
    async (submitted) => {
      const b = browser();
      const previous = rendered(b);
      b.navigate("/events?view=calendar");
      expect(b.skeleton.hidden).toBe(false);
      expect(b.content.hidden).toBe(true);
      expect(b.root.getAttribute("aria-busy")).toBe("true");
      b.type("A");
      if (submitted) b.submit();
      else vi.advanceTimersByTime(300);
      expect(b.requests).toHaveLength(2);
      expect(b.requests[0]!.signal.aborted).toBe(true);
      b.type("B");
      expect(b.requests[1]!.signal.aborted).toBe(true);
      expect(b.skeleton.hidden).toBe(true);
      expect(b.content.hidden).toBe(false);
      expect(b.root.getAttribute("aria-busy")).toBeNull();
      expect(rendered(b)).toEqual(previous);
      await b.respond(0);
      await b.respond(1);
      vi.advanceTimersByTime(200);
      b.type("B final");
      vi.advanceTimersByTime(299);
      expect(b.requests).toHaveLength(2);
      expect(b.skeleton.hidden).toBe(true);
      expect(b.root.getAttribute("aria-busy")).toBeNull();
      expect(rendered(b)).toEqual(previous);
      vi.advanceTimersByTime(1);
      expect(b.requests[2]!.url).toBe("/events?q=B+final");
      await b.respond(2);
      expect(b.history).toEqual(["/events?q=B+final"]);
      expect(b.zones.every((zone) => zone.swaps === 1)).toBe(true);
    },
  );

  it("obsolete finalizers cannot clear loading owned by navigation after search revocation", async () => {
    const b = browser();
    b.navigate("/events?view=calendar");
    b.type("A");
    b.submit();
    b.type("B");
    expect(b.skeleton.hidden).toBe(true);
    b.navigate("/events?past=1");
    await b.respond(0);
    await fail(b, 1, "network");
    expect(b.skeleton.hidden).toBe(false);
    expect(b.content.hidden).toBe(true);
    expect(b.root.getAttribute("aria-busy")).toBe("true");
    expect(b.history).toEqual([]);
    expect(b.feedback.textContent).toBe("last-good feedback");
    vi.advanceTimersByTime(1000);
    expect(b.requests).toHaveLength(3);
    await b.respond(2);
    expect(b.skeleton.hidden).toBe(true);
    expect(b.content.hidden).toBe(false);
    expect(b.root.getAttribute("aria-busy")).toBeNull();
    expect(b.history).toEqual(["/events?past=1"]);
  });

  it("ignores an obsolete response whose body finishes inside B's debounce window", async () => {
    const b = browser();
    startSearch(b);
    const finishBody = await b.delayBody(0);
    const previous = rendered(b);
    b.type("B");
    await finishBody();
    expect(rendered(b)).toEqual(previous);
    expect(b.requests).toHaveLength(1);
    vi.advanceTimersByTime(300);
    await b.respond(1);
    expect(b.history).toEqual(["/events?q=B"]);
  });

  it.each(["network", "http", "body", "abort"])(
    "never publishes obsolete A's %s failure before B starts",
    async (kind) => {
      const b = browser();
      startSearch(b);
      const previous = rendered(b);
      b.type("B");
      await fail(b, 0, kind);
      expect(rendered(b)).toEqual(previous);
      vi.advanceTimersByTime(300);
      await b.respond(1);
      expect(b.history).toEqual(["/events?q=B"]);
    },
  );

  it.each(["A first", "B first"])(
    "permits only B's commit after its debounce (%s)",
    async (order) => {
      const b = browser();
      startSearch(b);
      b.type("B");
      vi.advanceTimersByTime(300);
      if (order === "A first") {
        const previous = rendered(b);
        await b.respond(0);
        expect(rendered(b)).toEqual(previous);
        await b.respond(1);
      } else {
        await b.respond(1);
        const previous = rendered(b);
        await b.respond(0);
        expect(rendered(b)).toEqual(previous);
      }
      expect(b.history).toEqual(["/events?q=B"]);
      expect(b.zones.every((zone) => zone.swaps === 1)).toBe(true);
    },
  );

  it("keeps newest failure feedback when aborted A eventually succeeds", async () => {
    const b = browser();
    startSearch(b);
    b.type("B");
    vi.advanceTimersByTime(300);
    await fail(b, 1, "network");
    expect(b.feedback.textContent).toBe(b.root.dataset.loadError);
    const previous = rendered(b);
    await b.respond(0);
    expect(rendered(b)).toEqual(previous);
    b.type("C");
    vi.advanceTimersByTime(300);
    await b.respond(2);
    expect(b.history).toEqual(["/events?q=C"]);
    expect(b.feedback.textContent).toBe("");
  });

  it.each(["", "   "])(
    "invalidates A when clearing to %j and preserves the drawer URL contract",
    async (value) => {
      const b = browser("/events?view=calendar&month=2026-10&past=1");
      startSearch(b);
      const previous = rendered(b);
      b.type(value);
      await b.respond(0);
      expect(rendered(b)).toEqual(previous);
      vi.advanceTimersByTime(300);
      expect(b.requests[1]!.url).toBe("/events?past=1");
      await b.respond(1);
      expect(b.history).toEqual(["/events?past=1"]);
      expect(b.input.value).toBe(value);
    },
  );

  it("restarts exactly the existing 300ms debounce for repeated input, including the same query", async () => {
    const b = browser();
    startSearch(b);
    const previous = rendered(b);
    b.type("A");
    await b.respond(0);
    expect(rendered(b)).toEqual(previous);
    vi.advanceTimersByTime(200);
    b.type("B");
    vi.advanceTimersByTime(200);
    b.type("B final");
    vi.advanceTimersByTime(299);
    expect(b.requests).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(b.requests[1]!.url).toBe("/events?q=B+final");
    await b.respond(1);
    vi.advanceTimersByTime(1000);
    expect(b.requests).toHaveLength(2);
    expect(b.history).toEqual(["/events?q=B+final"]);
  });

  it("submit cancels B's debounce and lets the current query commit once", async () => {
    const b = browser();
    startSearch(b);
    b.type("B");
    vi.advanceTimersByTime(100);
    expect(b.submit()).toBe(true);
    expect(b.requests[1]!.url).toBe("/events?q=B");
    await b.respond(1);
    const previous = rendered(b);
    await b.respond(0);
    expect(rendered(b)).toEqual(previous);
    vi.advanceTimersByTime(1000);
    expect(b.requests).toHaveLength(2);
    expect(b.history).toEqual(["/events?q=B"]);
  });

  it.each(["link", "popstate"])(
    "%s cancels pending typing and supersedes an active search",
    async (action) => {
      const b = browser();
      startSearch(b);
      if (action === "link") b.navigate("/events?past=1");
      else b.back("/events?past=1");
      expect(b.requests[0]!.signal.aborted).toBe(true);
      await b.respond(1);
      const previous = rendered(b);
      await b.respond(0);
      expect(rendered(b)).toEqual(previous);
      b.type("pending");
      if (action === "link") b.navigate("/events");
      else b.back("/events");
      vi.advanceTimersByTime(1000);
      expect(b.requests).toHaveLength(3);
      await b.respond(2);
      expect(b.input.value).toBe("");
      expect(b.history).toEqual(action === "link" ? ["/events?past=1", "/events"] : []);
    },
  );

  it.each(["view", "drawer", "jump", "popstate"])(
    "new typing does not invalidate explicit %s navigation",
    async (action) => {
      const b = browser();
      b.type("pending");
      const path =
        action === "view"
          ? "/events?view=calendar"
          : action === "drawer"
            ? "/events?past=1"
            : "/events#event-a";
      if (action === "popstate") b.back(path);
      else b.navigate(path, action === "jump");
      expect(b.requests).toHaveLength(1);
      expect(b.skeleton.hidden).toBe(false);
      b.type("B");
      expect(b.requests[0]!.signal.aborted).toBe(false);
      await b.respond(0);
      expect(b.zones.every((zone) => zone.swaps === 1)).toBe(true);
      expect(b.input.value).toBe("B");
      expect(b.input.focused).toBe(true);
      expect(b.skeleton.hidden).toBe(true);
      expect(b.root.getAttribute("aria-busy")).toBeNull();
      vi.advanceTimersByTime(299);
      expect(b.requests).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(b.requests[1]!.url).toBe(action === "drawer" ? "/events?q=B&past=1" : "/events?q=B");
      await b.respond(1);
      expect(b.history).toEqual(
        action === "popstate" ? ["/events?q=B"] : [path, b.requests[1]!.url],
      );
    },
  );
});
