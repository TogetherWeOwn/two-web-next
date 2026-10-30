// Builder-owned regression: removing a standalone stale retry must not lose
// focus, or steal focus that moved away while the read was pending.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  new NodeURL("../public/islands/attendees-live.js", import.meta.url),
  "utf8",
);
const key = "spring-social";
const staleSelector = '[data-testid="event-attendees-stale"]';
const retrySelector = '[data-testid="event-attendees-retry"]';
const sectionSelector = '[data-testid="event-attendees"]';

type Listener = (event: { detail?: { eventKey: string } }) => void;

function fixture(populated = false) {
  let active: Node;
  class Node {
    children: Node[] = [];
    parentNode: Node | null = null;
    attributes = new Map<string, string>();
    listeners = new Map<string, Listener>();
    textContent = "";
    constructor(
      public selector = "",
      public tagName = "",
    ) {}
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    contains(node: Node): boolean {
      return this === node || this.children.some((child) => child.contains(node));
    }
    querySelector(selector: string): Node | null {
      for (const child of this.children) {
        const marker = /^\[data-testid="([^"]+)"\]$/.exec(selector)?.[1];
        if (
          child.selector === selector ||
          child.tagName.toLowerCase() === selector.toLowerCase() ||
          (marker && child.getAttribute("data-testid") === marker)
        )
          return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    appendChild(node: Node) {
      node.parentNode = this;
      this.children.push(node);
      return node;
    }
    insertBefore(node: Node, anchor: Node) {
      node.parentNode = this;
      this.children.splice(this.children.indexOf(anchor), 0, node);
    }
    removeChild(node: Node) {
      if (node.contains(active)) active = body;
      this.children.splice(this.children.indexOf(node), 1);
      node.parentNode = null;
    }
    replaceChild(next: Node, old: Node) {
      this.insertBefore(next, old);
      this.removeChild(old);
    }
    focus() {
      active = this;
    }
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, listener);
    }
    click() {
      this.listeners.get("click")?.({});
    }
  }
  const body = new Node("body");
  active = body;
  const main = body.appendChild(new Node("main"));
  main.setAttribute("tabindex", "-1");
  const mount = main.appendChild(new Node('[data-island="rsvp-button"]'));
  mount.setAttribute("data-event-key", key);
  const outside = main.appendChild(new Node("a"));
  function roster() {
    const section = new Node(sectionSelector);
    section.appendChild(new Node("#event-attendees-heading", "H2"));
    section.appendChild(new Node("a"));
    return section;
  }
  if (populated) main.appendChild(roster());
  main.appendChild(new Node(".event-discovery"));
  const listeners = new Map<string, Listener>();
  const requests: { resolve: (response: unknown) => void }[] = [];
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const query = (selector: string) => body.querySelector(selector);
  runInNewContext(script, {
    document: {
      documentElement: new Node(),
      body,
      get activeElement() {
        return active;
      },
      querySelector: query,
      createElement: () => new Node(),
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    },
    // Incoming documents are already-parsed boundary doubles. The existing
    // admission suite separately covers real SSR HTML and identity parsing.
    DOMParser: class {
      parseFromString(html: string) {
        const fresh = html === "populated" ? roster() : null;
        const identity = new Node();
        identity.setAttribute("data-event-key", html === "foreign" ? "other-event" : key);
        return {
          querySelector: () => fresh,
          querySelectorAll: () => [identity],
        };
      }
    },
    fetch: () => new Promise((resolve) => requests.push({ resolve })),
    AbortController,
    URLSearchParams,
    setTimeout: (callback: () => void, delay: number) => {
      const handle = {};
      timers.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout: (handle: object) => timers.delete(handle),
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const answer = async (index: number, html = "empty", ok = true) => {
    requests[index]!.resolve({ ok, text: () => Promise.resolve(html) });
    await settle();
  };
  const broadcast = () => listeners.get("going-count-updated")!({ detail: { eventKey: key } });
  const exhaust = async (first = 0, html = "empty") => {
    await answer(first, html, html === "foreign");
    const retry = [...timers.entries()].find(([, timer]) => timer.delay === 1000)!;
    expect(retry, "failed read schedules the existing retry").toBeDefined();
    timers.delete(retry[0]);
    retry[1].callback();
    await answer(first + 1, html, html === "foreign");
  };
  const stale = async () => {
    broadcast();
    await exhaust();
    expect(query(staleSelector)).not.toBeNull();
    const retry = query(retrySelector)!;
    retry.focus();
    return retry;
  };
  return {
    query,
    main,
    outside,
    active: () => active,
    requests,
    answer,
    broadcast,
    exhaust,
    stale,
  };
}

describe("attendee recovery focus ownership", () => {
  // Removing the handoff makes this fail: activeElement becomes body.
  it("hands a focused standalone retry to main after authoritative empty success", async () => {
    const b = fixture();
    (await b.stale()).click();
    await b.answer(2);
    expect(b.query(staleSelector)).toBeNull();
    expect(b.query(sectionSelector)).toBeNull();
    expect(b.active()).toBe(b.main);
    expect(b.requests).toHaveLength(3);
  });

  // An unconditional handoff would steal the member's new focus target.
  it("does not steal focus moved outside the note while retry is pending", async () => {
    const b = fixture();
    (await b.stale()).click();
    b.outside.focus();
    await b.answer(2);
    expect(b.query(staleSelector)).toBeNull();
    expect(b.active()).toBe(b.outside);
  });

  it.each([false, true])(
    "preserves heading focus on populated recovery (old roster: %s)",
    async (old) => {
      const b = fixture(old);
      (await b.stale()).click();
      await b.answer(2, "populated");
      expect(b.query(staleSelector)).toBeNull();
      expect(b.active()).toBe(b.query("#event-attendees-heading"));
    },
  );

  it("preserves main focus when recovery removes a populated roster", async () => {
    const b = fixture(true);
    (await b.stale()).click();
    await b.answer(2);
    expect(b.query(sectionSelector)).toBeNull();
    expect(b.query(staleSelector)).toBeNull();
    expect(b.active()).toBe(b.main);
  });

  it.each(["failed", "foreign"])("retains retry focus when recovery is %s", async (result) => {
    const b = fixture();
    const retry = await b.stale();
    retry.click();
    await b.exhaust(2, result === "foreign" ? "foreign" : "empty");
    expect(b.query(retrySelector)).toBe(retry);
    expect(b.active()).toBe(retry);
    expect(b.requests).toHaveLength(4);
  });

  it("does not clear or refocus from a superseded empty response", async () => {
    const b = fixture();
    const retry = await b.stale();
    retry.click();
    b.broadcast();
    await b.answer(2);
    expect(b.query(retrySelector)).toBe(retry);
    expect(b.active()).toBe(retry);
    b.outside.focus();
    await b.answer(3);
    expect(b.query(staleSelector)).toBeNull();
    expect(b.active()).toBe(b.outside);
  });
});
