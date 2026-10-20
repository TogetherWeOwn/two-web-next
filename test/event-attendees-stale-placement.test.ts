// Builder-owned pin: a failed roster refresh must surface its stale/retry
// signal where the roster lives — inside the existing section when one is
// rendered, otherwise slotted before the discovery content inside <main> —
// and never after the site footer. Regression for the #1059 review nits:
// the first-RSVP case renders no section, so a body-level fallback would
// land the note below the footer, outside the main landmark.
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
const sectionSelector = '[data-testid="event-attendees"]';

type Listener = (event: { detail?: { eventKey: string } }) => void;

class Node {
  children: Node[] = [];
  parentNode: Node | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener>();
  textContent = "";
  constructor(public selector = "") {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector: string): Node | null {
    for (const child of this.children) {
      const marker = /^\[data-testid="([^"]+)"\]$/.exec(selector)?.[1];
      if (child.selector === selector || (marker && child.getAttribute("data-testid") === marker))
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
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }
}

function fixture(options: { section: boolean; discovery: boolean }) {
  // Mirrors EventDetailShell order: <main> content first, site footer after.
  const body = new Node("body");
  const main = body.appendChild(new Node("main"));
  const mount = main.appendChild(new Node('[data-island="rsvp-button"]'));
  mount.setAttribute("data-event-key", key);
  const section = options.section ? main.appendChild(new Node(sectionSelector)) : null;
  const discovery = options.discovery ? main.appendChild(new Node(".event-discovery")) : null;
  const footer = body.appendChild(new Node("footer"));
  const listeners = new Map<string, Listener>();
  const requests: { resolve: (response: unknown) => void }[] = [];
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const query = (selector: string) => body.querySelector(selector);
  runInNewContext(script, {
    document: {
      documentElement: new Node(),
      body,
      activeElement: null,
      querySelector: query,
      createElement: () => new Node(),
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
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
  const failRead = async (index: number) => {
    requests[index]!.resolve({ ok: false });
    await settle();
  };
  return {
    body,
    main,
    footer,
    discovery,
    section,
    query,
    // Drive the broadcast through both failed reads (initial + the one
    // bounded retry) so showStale runs.
    failRefresh: async () => {
      listeners.get("going-count-updated")!({ detail: { eventKey: key } });
      await failRead(0);
      const retry = [...timers.entries()].find(([, timer]) => timer.delay === 1000)!;
      expect(retry, "failed read schedules the existing retry").toBeDefined();
      timers.delete(retry[0]);
      retry[1].callback();
      await failRead(1);
    },
  };
}

function ancestors(node: Node): Node[] {
  const chain: Node[] = [];
  for (let n = node.parentNode; n; n = n.parentNode) chain.push(n);
  return chain;
}

describe("attendee stale-note placement", () => {
  it("slots the note before discovery content inside main when no roster section exists", async () => {
    const b = fixture({ section: false, discovery: true });
    await b.failRefresh();
    const note = b.query(staleSelector);
    expect(note, "failed refresh surfaces the stale signal").not.toBeNull();
    expect(note!.parentNode).toBe(b.main);
    expect(ancestors(note!)).toContain(b.main);
    expect(note!.parentNode, "note stays inside main, never after the footer").not.toBe(b.body);
    expect(b.body.children.at(-1), "footer keeps its shell position").toBe(b.footer);
    expect(b.main.children.indexOf(note!)).toBeLessThan(b.main.children.indexOf(b.discovery!));
  });

  it("appends the note to the existing roster section when one is rendered", async () => {
    const b = fixture({ section: true, discovery: true });
    await b.failRefresh();
    const note = b.query(staleSelector);
    expect(note, "failed refresh surfaces the stale signal").not.toBeNull();
    expect(note!.parentNode).toBe(b.section);
  });

  it("falls back to main when the discovery anchor is missing", async () => {
    const b = fixture({ section: false, discovery: false });
    await b.failRefresh();
    const note = b.query(staleSelector);
    expect(note, "failed refresh surfaces the stale signal").not.toBeNull();
    expect(note!.parentNode).toBe(b.main);
    expect(ancestors(note!)).toContain(b.main);
    expect(note!.parentNode, "note stays inside main, never after the footer").not.toBe(b.body);
  });
});
