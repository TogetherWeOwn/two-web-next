// Execute the shipped binder against a focus-aware DOM fixture: replaced nodes
// detach, the active element falls back to body, and hidden targets cannot focus.
// No browser, database, network or new test dependency.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const binder = readFileSync(new NodeURL("../public/islands/events-calendar.js", import.meta.url), "utf8");
const ORIGIN = "https://calendar.example.test";
const LIVE_IDS = ["events-view-status", "events-search-status", "events-past-status", "calendar-month-status"];

function browser() {
  let activeElement: Element;
  const focusListeners = new Set<(event: { target: Element }) => void>();
  class Element {
    parent: Element | null = null;
    childNodes: Element[] = [];
    hidden = false;
    textContent = "";
    value = "";
    content = "";
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    listeners = new Map<string, ((event: any) => void)[]>();
    constructor(readonly tag = "div", attrs: Record<string, string> = {}) {
      for (const [key, value] of Object.entries(attrs)) this.attributes.set(key, value);
    }
    get href() { return new URL(this.getAttribute("href") || "/events", ORIGIN).href; }
    set href(value: string) { this.setAttribute("href", value); }
    get hash() { return new URL(this.href).hash; }
    get target() { return this.getAttribute("target") || ""; }
    getAttribute(key: string) { return this.attributes.get(key) ?? null; }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    removeAttribute(key: string) { this.attributes.delete(key); }
    hasAttribute(key: string) { return this.attributes.has(key); }
    matches(selector: string): boolean {
      if (selector.startsWith("#")) return this.getAttribute("id") === selector.slice(1);
      if (selector === "[hidden]") return this.hidden;
      const attr = /^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      return attr ? (!attr[1] || this.tag === attr[1]) && this.hasAttribute(attr[2]!) && (attr[3] === undefined || this.getAttribute(attr[2]!) === attr[3]) : this.tag === selector;
    }
    closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
    contains(node: Element | undefined): boolean { return node === this || this.childNodes.some((child) => child.contains(node)); }
    querySelectorAll(selector: string): Element[] {
      return this.childNodes.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    replaceChildren(...children: Element[]) {
      if (this.childNodes.some((child) => child.contains(activeElement))) activeElement = body;
      this.childNodes.forEach((child) => { child.parent = null; });
      this.childNodes = children;
      children.forEach((child) => { child.parent = this; });
    }
    focus() {
      if (body.contains(this) && !this.closest("[hidden]") && activeElement !== this) {
        activeElement = this;
        focusListeners.forEach((fn) => fn({ target: this }));
      }
    }
    addEventListener(type: string, fn: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    fire(type: string, event: any = {}) { this.listeners.get(type)?.forEach((fn) => fn(event)); }
    clone(): Element {
      const node = new Element(this.tag, Object.fromEntries(this.attributes));
      node.hidden = this.hidden;
      node.replaceChildren(...this.childNodes.map((child) => child.clone()));
      return node;
    }
  }
  const node = (tag: string, attrs: Record<string, string> = {}) => new Element(tag, attrs);
  const body = node("body");
  activeElement = body;
  const root = node("section", { "data-island": "events-calendar" });
  root.dataset.loadError = "Calendar unavailable";
  const heading = node("h1", { id: "events-heading", tabindex: "-1" });
  const input = node("input", { "data-testid": "events-search" });
  const form = node("form");
  const zones = Object.fromEntries(["head", "actions", "miss", "content"].map((name) => [name, node("div", { "data-cal-zone": name })]));
  form.replaceChildren(input, zones.actions!);
  const skeleton = node("div", { "data-testid": "events-loading" });
  skeleton.hidden = true;
  const feedback = node("p", { "data-cal-feedback": "" });
  const canonical = node("link", { rel: "canonical", href: ORIGIN + "/events" });
  const outside = node("button");
  root.replaceChildren(heading, ...LIVE_IDS.map((id) => node("p", { "data-testid": id })), zones.head!, form, zones.miss!, skeleton, zones.content!, feedback);
  body.replaceChildren(root, outside);
  const requests: { signal: AbortSignal; resolve: (response: any) => void; reject: (error: Error) => void }[] = [];
  const pages = new Map<string, Element>();
  const timers = new Map<number, () => void>();
  let timer = 0;
  runInNewContext(binder, {
    URL, AbortController,
    document: {
      get activeElement() { return activeElement; }, body,
      querySelector: (selector: string) => selector.startsWith("link") ? canonical : body.querySelector(selector),
      importNode: (source: Element) => source.clone(),
      addEventListener: (_type: string, fn: (event: { target: Element }) => void, opts: { signal: AbortSignal }) => {
        focusListeners.add(fn);
        opts.signal.addEventListener("abort", () => focusListeners.delete(fn), { once: true });
      },
      removeEventListener: (_type: string, fn: (event: { target: Element }) => void) => focusListeners.delete(fn),
    },
    window: { location: { href: ORIGIN + "/events", origin: ORIGIN }, history: { pushState() {} }, addEventListener() {} },
    DOMParser: class { parseFromString(html: string) { return pages.get(html); } },
    fetch: (_url: string, init: RequestInit) => new Promise((resolve, reject) => requests.push({ signal: init.signal!, resolve, reject })),
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const link = (id: string, href = "/events?view=calendar", extra: Record<string, string> = {}) => node("a", { "data-testid": id, href, ...extra });
  const click = (control: Element, keyboard = true) => {
    if (keyboard) control.focus();
    let prevented = false;
    root.fire("click", { target: control, detail: keyboard ? 0 : 1, button: 0, preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function finish(index: number, children: Partial<Record<string, Element[]>> = {}) {
    const page = node("html");
    const next = node("section", { "data-island": "events-calendar" });
    next.replaceChildren(...Object.keys(zones).map((name) => {
      const zone = node("div", { "data-cal-zone": name });
      zone.replaceChildren(...(children[name] ?? []));
      return zone;
    }));
    page.replaceChildren(node("link", { rel: "canonical", href: ORIGIN + "/events" }), next);
    pages.set(String(index), page);
    requests[index]!.resolve({ ok: true, text: async () => String(index) });
    await settle();
  }
  function type(value: string) { input.value = value; input.fire("input"); }
  function tick() { for (const [id, fn] of timers) { timers.delete(id); fn(); } }
  function paint() { if (activeElement.closest("[hidden]")) activeElement = body; }
  return { root, body, heading, input, outside, zones, skeleton, feedback, requests, node, link, click, finish, settle, type, tick, paint, focusListeners, focused: () => activeElement };
}

describe("calendar keyboard focus continuity", () => {
  it("restores the replacement view control rather than body or a detached node", async () => {
    const b = browser();
    const control = b.link("events-view-calendar");
    b.zones.head!.replaceChildren(control);
    b.click(control);
    await b.finish(0, { head: [b.link("events-view-calendar", "/events?view=calendar&month=2030-02")] });
    expect(b.root.contains(control)).toBe(false);
    expect(b.focused()).toBe(b.root.querySelector('[data-testid="events-view-calendar"]'));
  });

  it("restores the month action by label even though its next URL changes", async () => {
    const b = browser();
    const control = b.node("a", { href: "/events?month=2030-02", "aria-label": "Next month" });
    b.zones.content!.replaceChildren(control);
    b.click(control);
    await b.finish(0, { content: [b.node("a", { href: "/events?month=2030-03", "aria-label": "Next month" })] });
    expect(b.focused()).toBe(b.root.querySelector('[aria-label="Next month"]'));
    expect(b.zones.content!.hidden).toBe(false);
  });

  it.each(["month", "grid"])("restores %s focus after the skeleton blurs its hidden origin to body", async (kind) => {
    const b = browser();
    const control = kind === "month" ? b.node("a", { href: "/events?month=2030-02", "aria-label": "Next month" })
      : b.link("calendar-day", "/events#event-night", { "data-cal-jump": "" });
    b.zones.content!.replaceChildren(control);
    b.click(control);
    b.paint();
    expect(b.focused()).toBe(b.body);
    await b.finish(0, { content: kind === "month" ? [b.node("a", { href: "/events?month=2030-03", "aria-label": "Next month" })]
      : [b.node("article", { id: "event-night", tabindex: "-1" })] });
    expect(b.focused()).toBe(b.root.querySelector(kind === "month" ? '[aria-label="Next month"]' : "#event-night"));
    expect(b.focusListeners.size).toBe(0);
  });

  it("does not mistake outside focus followed by body for a skeleton blur", async () => {
    const b = browser();
    const control = b.link("calendar-day", "/events#event-night", { "data-cal-jump": "" });
    b.zones.content!.replaceChildren(control);
    b.click(control);
    b.paint();
    b.outside.focus();
    b.outside.hidden = true;
    b.paint();
    await b.finish(0, { content: [b.node("article", { id: "event-night", tabindex: "-1" })] });
    expect(b.focused()).toBe(b.body);
    expect(b.focusListeners.size).toBe(0);
  });

  it.each(["events-search-clear", "events-search-clear-empty", "events-past-toggle", "events-retry"])("uses the stable heading when %s disappears", async (id) => {
    const b = browser();
    const control = b.link(id, "/events");
    b.zones.actions!.replaceChildren(control);
    b.click(control);
    await b.finish(0);
    expect(b.focused()).toBe(b.heading);
  });

  it("retains a surviving control", async () => {
    const b = browser();
    const control = b.link("stable");
    b.root.replaceChildren(...b.root.childNodes, control);
    b.click(control);
    await b.finish(0);
    expect(b.focused()).toBe(control);
  });

  it.each([true, false])("retains explicit grid-card focus, including pointer jumps (keyboard=%s)", async (keyboard) => {
    const b = browser();
    const control = b.link("calendar-day", "/events#event-night", { "data-cal-jump": "" });
    b.zones.content!.replaceChildren(control);
    b.click(control, keyboard);
    await b.finish(0, { content: [b.node("article", { id: "event-night", tabindex: "-1" })] });
    expect(b.focused()).toBe(b.root.querySelector("#event-night"));
  });

  it("falls back to the heading when a keyboard grid destination disappears", async () => {
    const b = browser();
    const control = b.link("calendar-day", "/events#event-gone", { "data-cal-jump": "" });
    b.zones.content!.replaceChildren(control);
    b.click(control);
    await b.finish(0);
    expect(b.focused()).toBe(b.heading);
  });

  it.each(["outside", "input"])("does not steal focus moved to %s while a grid request is pending", async (destination) => {
    const b = browser();
    const control = b.link("calendar-day", "/events#event-night", { "data-cal-jump": "" });
    b.zones.content!.replaceChildren(control);
    b.click(control);
    const focused = destination === "outside" ? b.outside : b.input;
    focused.focus();
    if (destination === "input") b.type("new search");
    await b.finish(0, { content: [b.node("article", { id: "event-night", tabindex: "-1" })] });
    expect(b.focused()).toBe(focused);
    expect(b.input.value).toBe(destination === "input" ? "new search" : "");
  });

  it("does not restore an ordinary control after the user moves focus elsewhere", async () => {
    const b = browser();
    const control = b.link("events-view-calendar");
    b.zones.head!.replaceChildren(control);
    b.click(control);
    b.outside.focus();
    await b.finish(0, { head: [b.link("events-view-calendar")] });
    expect(b.focused()).toBe(b.outside);
  });

  it("does not restore after newer input events even if the text returns to its starting value", async () => {
    const b = browser();
    const control = b.link("events-view-calendar");
    b.zones.head!.replaceChildren(control);
    b.click(control);
    b.type("x");
    b.type("");
    await b.finish(0, { head: [b.link("events-view-calendar")] });
    expect(b.focused()).toBe(b.body);
  });

  it("never adds ordinary-control focus for pointer activation", async () => {
    const b = browser();
    const control = b.link("events-view-calendar");
    b.zones.head!.replaceChildren(control);
    control.focus(); // Some browsers focus an anchor on pointer down.
    b.click(control, false);
    await b.finish(0, { head: [b.link("events-view-calendar")] });
    expect(b.focused()).toBe(b.body);
  });

  it.each(["transport", "http", "invalid"])("preserves the original focus on %s failure", async (failure) => {
    const b = browser();
    const control = b.link("events-view-calendar");
    b.zones.head!.replaceChildren(control);
    b.click(control);
    if (failure === "transport") b.requests[0]!.reject(new Error("offline"));
    else b.requests[0]!.resolve({ ok: failure !== "http", text: async () => "invalid" });
    await b.settle();
    expect(b.focused()).toBe(control);
    expect(b.feedback.textContent).toBe("Calendar unavailable");
    expect(b.skeleton.hidden).toBe(true);
  });

  it("only lets the latest keyboard request own focus, ignoring a late aborted success", async () => {
    const b = browser();
    const first = b.link("events-view-calendar");
    const second = b.link("events-view-list", "/events");
    b.zones.head!.replaceChildren(first, second);
    b.click(first);
    b.click(second);
    expect(b.requests[0]!.signal.aborted).toBe(true);
    await b.finish(1, { head: [b.link("events-view-list", "/events")] });
    const focused = b.focused();
    await b.finish(0, { head: [b.link("events-view-calendar")] });
    expect(b.focused()).toBe(focused);
    expect(focused).toBe(b.root.querySelector('[data-testid="events-view-list"]'));
  });

  it("does not focus a late aborted grid response after a settled search", async () => {
    const b = browser();
    const control = b.link("calendar-day", "/events#event-night", { "data-cal-jump": "" });
    b.zones.content!.replaceChildren(control);
    b.click(control);
    b.input.focus();
    b.type("night");
    b.tick();
    expect(b.requests[0]!.signal.aborted).toBe(true);
    await b.finish(1);
    await b.finish(0, { content: [b.node("article", { id: "event-night", tabindex: "-1" })] });
    expect(b.focused()).toBe(b.input);
  });
});
