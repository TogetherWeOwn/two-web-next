import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PAST_EVENTS_COPY } from "../src/islands/contracts";

const binder = readFileSync(
  new NodeURL("../public/islands/past-events.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://next.example.test";
const MOUNT = '[data-island="past-events"]';
const CANONICAL = 'link[rel="canonical"]';
const OG = 'meta[property="og:url"]';
const ZONES = ["[data-archive-state]", "[data-archive-list]", "[data-archive-pager]"];

class Node {
  childNodes: Node[] = [];
  matches = new Map<string, Node[]>();
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  hidden = false;
  textContent = "";
  href = "";
  content = "";
  focused = false;
  constructor(readonly label: string) {}
  querySelectorAll(selector: string) {
    return this.matches.get(selector) ?? [];
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getAttribute(name: string) {
    if (name === "href") return this.href || null;
    if (name === "content") return this.content || null;
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  contains(other: Node): boolean {
    return this === other || this.childNodes.some((child) => child.contains(other));
  }
  replaceChildren(...children: Node[]) {
    this.childNodes = children;
  }
  focus() {
    this.focused = true;
  }
}

function archive(page: number) {
  const document = new Node("document");
  const root = new Node("archive");
  const zones = ZONES.map((selector, i) => {
    const zone = new Node(selector);
    zone.childNodes = [new Node(`page ${page}, zone ${i}`)];
    zone.hidden = i === (page === 1 ? 0 : 1);
    root.matches.set(selector, [zone]);
    return zone;
  });
  const heading = new Node("heading");
  const feedback = new Node("feedback");
  root.matches.set("h1", [heading]);
  root.matches.set("[data-archive-feedback]", [feedback]);
  root.childNodes = [...zones, heading, feedback];
  root.dataset = {
    page: String(page),
    totalPages: String(page === 1 ? 3 : 4),
    loadError: PAST_EVENTS_COPY.failed,
  };
  const canonical = new Node("canonical");
  canonical.href = ORIGIN + (page === 1 ? "/events/past" : `/events/past?page=${page}`);
  const og = new Node("og:url");
  og.content = canonical.href;
  document.matches.set(MOUNT, [root]);
  document.matches.set(CANONICAL, [canonical]);
  document.matches.set(OG, [og]);
  return { document, root, zones, heading, feedback, canonical, og };
}

type Response = { ok: boolean; text: () => Promise<string> };
function browser() {
  const live = archive(1);
  const incoming = archive(2);
  const history: string[] = [];
  const reloads: string[] = [];
  const operations: string[] = [];
  const controllers: AbortController[] = [];
  const requests: {
    signal: AbortSignal;
    resolve: (value: Response) => void;
    reject: (error: Error) => void;
  }[] = [];
  const timers: { id: number; callback: () => void; ms: number }[] = [];
  let timerSeq = 0;
  const location = {
    origin: ORIGIN,
    href: ORIGIN + "/events/past",
    assign: (href: string) => reloads.push(href),
  };
  let click: (event: unknown) => void = () => {};
  let popstate: () => void = () => {};
  let onImport: (node: Node) => void = () => {};
  const body = new Node("body");
  const outside = new Node("stable-outside");
  let activeElement: Node = body;
  const focusListeners = new Set<(event: { target: Node }) => void>();
  function focusNode(node: Node) {
    if (activeElement === node) return;
    activeElement = node;
    focusListeners.forEach((fn) => fn({ target: node }));
  }
  body.focus = () => focusNode(body);
  outside.focus = () => {
    outside.focused = true;
    focusNode(outside);
  };
  Object.assign(live.root, {
    addEventListener: (_type: string, listener: typeof click) => {
      click = listener;
    },
  });
  live.zones.forEach((zone) => {
    const previous = zone.childNodes.slice();
    zone.replaceChildren = (...children) => {
      operations.push("replace");
      if (
        previous.some((child) => child.contains(activeElement)) ||
        zone.childNodes.some((child) => child.contains(activeElement))
      ) {
        activeElement = body;
      }
      zone.childNodes = children;
    };
  });
  live.heading.focus = () => {
    operations.push("focus");
    live.heading.focused = true;
    focusNode(live.heading);
  };
  const document = Object.assign(live.document, {
    body,
    addEventListener: (type: string, fn: (event: { target: Node }) => void) => {
      if (type === "focusin") focusListeners.add(fn);
    },
    removeEventListener: (type: string, fn: (event: { target: Node }) => void) => {
      if (type === "focusin") focusListeners.delete(fn);
    },
    importNode: (node: Node, deep: boolean) => {
      operations.push("import");
      expect(deep).toBe(true);
      onImport(node);
      return new Node(node.label);
    },
  });
  Object.defineProperty(document, "activeElement", {
    get() {
      return activeElement;
    },
    configurable: true,
  });
  runInNewContext(binder, {
    URL,
    setTimeout: (callback: () => void, ms: number) => {
      const id = ++timerSeq;
      timers.push({ id, callback, ms });
      return id;
    },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((timer) => timer.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    AbortController: class extends AbortController {
      constructor() {
        super();
        controllers.push(this);
      }
    },
    document,
    window: {
      location,
      history: {
        pushState: (_state: unknown, _title: string, url: string) => {
          operations.push("push");
          expect(live.zones.map((zone) => zone.childNodes[0]!.label)).toEqual(
            incoming.zones.map((zone) => zone.childNodes[0]!.label),
          );
          expect(live.root.dataset.page).toBe(incoming.root.dataset.page);
          expect(live.root.dataset.totalPages).toBe(incoming.root.dataset.totalPages);
          expect(live.canonical.href).toBe(incoming.canonical.href);
          expect(live.og.content).toBe(incoming.og.content);
          history.push(url);
          location.href = ORIGIN + url;
        },
      },
      addEventListener: (_type: string, listener: () => void) => {
        popstate = listener;
      },
    },
    DOMParser: class {
      parseFromString() {
        operations.push("parse");
        return incoming.document;
      }
    },
    fetch: (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        requests.push({ signal: init.signal, resolve, reject });
      }),
  });
  function turn(page = 2, keyboard = true) {
    const link = Object.assign(new Node(`activating-link-${page}-${requests.length}`), {
      href: `${ORIGIN}/events/past?page=${page}`,
      target: "",
      hasAttribute: () => false,
    });
    link.focus = () => focusNode(link);
    live.zones[2]!.childNodes.push(link);
    if (keyboard) link.focus();
    click({
      defaultPrevented: false,
      button: 0,
      detail: keyboard ? 0 : 1,
      target: { closest: () => link },
      preventDefault: () => {},
    });
  }
  function finish(index = 0) {
    requests[index]!.resolve({ ok: true, text: async () => "fixture" });
  }
  async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  function snapshot() {
    return {
      zones: live.zones.map((zone) => ({
        children: zone.childNodes
          .filter((child) => !child.label.startsWith("activating-link-"))
          .slice(),
        hidden: zone.hidden,
      })),
      dataset: { ...live.root.dataset },
      canonical: live.canonical.href,
      og: live.og.content,
      history: history.slice(),
      href: location.href,
    };
  }
  return {
    live,
    incoming,
    history,
    reloads,
    operations,
    requests,
    controllers,
    timers,
    location,
    outside,
    body,
    focused: () => activeElement,
    focusListeners,
    turn,
    finish,
    settle,
    snapshot,
    fireTimers: () => {
      timers.splice(0).forEach((timer) => timer.callback());
    },
    popstate: () => popstate(),
    importWith: (callback: typeof onImport) => {
      onImport = callback;
    },
  };
}

function hangBody(b: ReturnType<typeof browser>, index = 0) {
  let resolveBody: (value: string) => void = () => {};
  b.requests[index]!.resolve({
    ok: true,
    text: () =>
      new Promise<string>((resolve) => {
        resolveBody = resolve;
      }),
  });
  return () => resolveBody("late fixture");
}

describe("Archive focus-cleanup acceptance", () => {
  it("[AFC-01] releases the owned listener on timeout before hung headers settle", async () => {
    const b = browser();
    b.turn();
    expect(b.focusListeners.size).toBe(1);
    const snapshot = b.snapshot();
    b.fireTimers();
    await b.settle();
    // Discriminating: obsolete tracking is released immediately, not when the
    // abort-ignoring fetch finally settles.
    expect(b.focusListeners.size).toBe(0);
    expect(b.requests[0]!.signal.aborted).toBe(true);
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    expect(b.history).toEqual([]);
    expect(b.reloads).toEqual([]);
    expect(b.requests).toHaveLength(1);
    expect(b.operations).not.toContain("parse");
    b.finish();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    expect(b.history).toEqual([]);
  });

  it("[AFC-02] releases the owned listener on timeout before a hung body settles", async () => {
    const b = browser();
    b.turn();
    const releaseBody = hangBody(b);
    await b.settle();
    expect(b.focusListeners.size).toBe(1);
    expect(b.live.root.attributes.get("aria-busy")).toBe("true");
    const snapshot = b.snapshot();
    b.fireTimers();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.requests[0]!.signal.aborted).toBe(true);
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    expect(b.history).toEqual([]);
    releaseBody();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.operations).not.toContain("replace");
    expect(b.history).toEqual([]);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
  });

  it("[AFC-03] supersession releases the obsolete listener, leaving exactly the new read", async () => {
    const b = browser();
    b.turn();
    expect(b.focusListeners.size).toBe(1);
    b.turn();
    // Discriminating: the old read's listener is gone before either settles.
    expect(b.focusListeners.size).toBe(1);
    expect(b.requests[0]!.signal.aborted).toBe(true);
    expect(b.timers).toHaveLength(1);
    expect(b.live.root.attributes.get("aria-busy")).toBe("true");
    expect(b.live.feedback.textContent).toBe("Loading past events…");
    b.finish(1);
    await b.settle();
    expect(b.history).toEqual(["/events/past?page=2"]);
    expect(b.live.heading.focused).toBe(true);
    expect(b.focusListeners.size).toBe(0);
    expect(b.timers).toHaveLength(0);
    const snapshot = b.snapshot();
    const operations = b.operations.slice();
    b.finish(0);
    await b.settle();
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.operations).toEqual(operations);
    expect(b.focusListeners.size).toBe(0);
  });

  it("[AFC-04] repeated timeouts leave zero owned listeners before hung work settles", async () => {
    const b = browser();
    b.turn();
    const firstSnapshot = b.snapshot();
    b.fireTimers();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.snapshot()).toEqual(firstSnapshot);
    b.turn();
    // Only the second read owns a listener; the first never leaked.
    expect(b.focusListeners.size).toBe(1);
    const secondSnapshot = b.snapshot();
    b.fireTimers();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.snapshot()).toEqual(secondSnapshot);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    expect(b.requests).toHaveLength(2);
    expect(b.history).toEqual([]);
    b.finish(0);
    b.finish(1);
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.snapshot()).toEqual(secondSnapshot);
    expect(b.operations).not.toContain("replace");
  });

  it("[AFC-05] repeated supersessions leave exactly one owned listener before settlement", async () => {
    const b = browser();
    b.turn();
    b.turn();
    b.turn();
    // Discriminating: two obsolete listeners are gone, one current remains.
    expect(b.focusListeners.size).toBe(1);
    expect(b.requests[0]!.signal.aborted).toBe(true);
    expect(b.requests[1]!.signal.aborted).toBe(true);
    expect(b.requests[2]!.signal.aborted).toBe(false);
    expect(b.timers).toHaveLength(1);
    expect(b.live.root.attributes.get("aria-busy")).toBe("true");
    b.finish(2);
    await b.settle();
    expect(b.history).toEqual(["/events/past?page=2"]);
    expect(b.live.heading.focused).toBe(true);
    expect(b.focusListeners.size).toBe(0);
    const snapshot = b.snapshot();
    const operations = b.operations.slice();
    b.finish(0);
    b.finish(1);
    await b.settle();
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.operations).toEqual(operations);
    expect(b.focusListeners.size).toBe(0);
  });

  it("[AFC-06] obsolete late finally cannot remove new tracking, busy state or deadline", async () => {
    const b = browser();
    b.turn();
    b.turn();
    expect(b.focusListeners.size).toBe(1);
    const snapshot = b.snapshot();
    b.finish(0);
    await b.settle();
    // The stale read settled late: new tracking, busy and deadline survive.
    expect(b.focusListeners.size).toBe(1);
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.operations).toEqual([]);
    expect(b.live.root.attributes.get("aria-busy")).toBe("true");
    expect(b.live.feedback.textContent).toBe("Loading past events…");
    expect(b.timers).toHaveLength(1);
    // New focus ownership still works after the obsolete settlement.
    b.outside.focus();
    b.finish(1);
    await b.settle();
    expect(b.snapshot()).toMatchObject({ dataset: { page: "2", totalPages: "4" } });
    expect(b.history).toEqual(["/events/past?page=2"]);
    expect(b.live.heading.focused).toBe(false);
    expect(b.focused()).toBe(b.outside);
    expect(b.focusListeners.size).toBe(0);
  });

  it("[AFC-07] late success after timeout keeps zero listeners and failure recovery", async () => {
    const b = browser();
    b.turn();
    const snapshot = b.snapshot();
    b.fireTimers();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    b.finish();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    expect(b.history).toEqual([]);
    expect(b.operations).not.toContain("replace");
    expect(b.operations).not.toContain("push");
    expect(b.requests).toHaveLength(1);
  });

  it("[AFC-08] late failure after timeout keeps zero listeners and failure recovery", async () => {
    const b = browser();
    b.turn();
    const snapshot = b.snapshot();
    b.fireTimers();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    b.requests[0]!.reject(new Error("offline"));
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    expect(b.history).toEqual([]);
    expect(b.operations).not.toContain("replace");
    expect(b.requests).toHaveLength(1);
  });

  it("[AFC-09] deliberate focus before timeout is preserved with zero leaked listeners", async () => {
    const b = browser();
    b.turn();
    b.outside.focus();
    const snapshot = b.snapshot();
    b.fireTimers();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.focused()).toBe(b.outside);
    expect(b.live.heading.focused).toBe(false);
    expect(b.operations).not.toContain("focus");
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    b.finish();
    await b.settle();
    expect(b.focusListeners.size).toBe(0);
    expect(b.focused()).toBe(b.outside);
    expect(b.live.heading.focused).toBe(false);
  });

  it("[AFC-10] uninterrupted keyboard page turn keeps heading focus and releases on success", async () => {
    const b = browser();
    b.turn(2, true);
    expect(b.focusListeners.size).toBe(1);
    b.finish();
    await b.settle();
    expect(b.snapshot()).toMatchObject({ dataset: { page: "2", totalPages: "4" } });
    expect(b.history).toEqual(["/events/past?page=2"]);
    expect(b.live.heading.focused).toBe(true);
    expect(b.focused()).toBe(b.live.heading);
    expect(b.operations).toContain("focus");
    expect(b.focusListeners.size).toBe(0);
    expect(b.timers).toHaveLength(0);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    expect(b.live.feedback.textContent).toBe("");
    expect(b.requests).toHaveLength(1);
  });

  it("[AFC-11] deliberate focus on a stable control is preserved on success", async () => {
    const b = browser();
    b.turn();
    b.outside.focus();
    b.finish();
    await b.settle();
    expect(b.snapshot()).toMatchObject({ dataset: { page: "2", totalPages: "4" } });
    expect(b.history).toEqual(["/events/past?page=2"]);
    expect(b.live.feedback.textContent).toBe("");
    expect(b.live.heading.focused).toBe(false);
    expect(b.operations).not.toContain("focus");
    expect(b.focused()).toBe(b.outside);
    expect(b.focusListeners.size).toBe(0);
    expect(b.timers).toHaveLength(0);
  });

  it("[AFC-12] timed-out click stays inline while timed-out Back read reloads SSR", async () => {
    const click = browser();
    click.turn();
    const clickSnapshot = click.snapshot();
    click.fireTimers();
    await click.settle();
    expect(click.snapshot()).toEqual(clickSnapshot);
    expect(click.history).toEqual([]);
    expect(click.reloads).toEqual([]);
    expect(click.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(click.live.root.attributes.has("aria-busy")).toBe(false);

    const back = browser();
    back.location.href = `${ORIGIN}/events/past?page=2`;
    back.popstate();
    back.fireTimers();
    await back.settle();
    expect(back.history).toEqual([]);
    expect(back.reloads).toEqual([`${ORIGIN}/events/past?page=2`]);
    expect(back.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(back.live.root.attributes.has("aria-busy")).toBe(false);
  });

  it("[AFC-13] repeated failure to success keyboard regression commits once", async () => {
    const b = browser();
    b.turn();
    b.fireTimers();
    await b.settle();
    b.finish();
    await b.settle();
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    b.turn();
    b.requests[1]!.reject(new Error("offline"));
    await b.settle();
    expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    b.turn(2, true);
    b.finish(2);
    await b.settle();
    expect(b.snapshot()).toMatchObject({ dataset: { page: "2", totalPages: "4" } });
    expect(b.history).toEqual(["/events/past?page=2"]);
    expect(b.live.heading.focused).toBe(true);
    expect(b.focused()).toBe(b.live.heading);
    expect(b.live.feedback.textContent).toBe("");
    expect(b.focusListeners.size).toBe(0);
    expect(b.timers).toHaveLength(0);
    expect(b.requests).toHaveLength(3);
  });

  it("[AFC-14] shipped binder keeps a single owned deadline and focus ownership without polling", async () => {
    expect(binder).not.toMatch(/setInterval|events\.json|\/rsvp/);
    expect(binder.match(/setTimeout\(/g)).toHaveLength(1);
    expect(binder.match(/clearTimeout\(/g)).toHaveLength(1);
    expect(binder).toContain("focusin");
    expect(binder).toContain("addEventListener");
    expect(binder).toContain("removeEventListener");
    expect(binder).toContain("aria-busy");
    const b = browser();
    b.turn();
    expect(b.timers).toHaveLength(1);
    expect(b.timers[0]!.ms).toBeGreaterThan(0);
    expect(b.timers[0]!.ms).toBeLessThanOrEqual(10000);
    expect(b.requests).toHaveLength(1);
  });
});
