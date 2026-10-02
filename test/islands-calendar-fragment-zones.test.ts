import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://calendar.example.test";
const ENTRY = "/events?q=old";
const DESTINATION = "/events?view=calendar&month=2026-10&past=1";
const NAMES = ["head", "actions", "miss", "content"];
const LIVE_IDS = [
  "events-view-status",
  "events-search-status",
  "events-past-status",
  "calendar-month-status",
];
const FAILURE = "Calendar could not be loaded. Try again.";

type Content = { text: string };
type SyntheticEvent = {
  defaultPrevented?: boolean;
  button?: number;
  ctrlKey?: boolean;
  target?: Element;
  preventDefault?: () => void;
};

// A per-test DOM surface, executing the shipped binder without routes, network,
// a database or browser globals. Imports clone children, rather than moving them.
class Element {
  childNodes: Content[] = [];
  hidden = false;
  textContent = "";
  href = "";
  content = "";
  value = "";
  hash = "";
  target = "";
  focused = false;
  isLink = false;
  form: Element | null = null;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  selectors = new Map<string, Element>();
  zones: Element[] = [];
  listeners = new Map<string, (event: SyntheticEvent) => void>();
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  querySelector(selector: string) {
    return this.selectors.get(selector) ?? null;
  }
  querySelectorAll(selector: string) {
    return selector === "[data-cal-zone]" ? this.zones : [];
  }
  replaceChildren(...children: Content[]) {
    this.childNodes = children;
  }
  closest(selector: string) {
    return selector === "form" ? this.form : this.isLink ? this : null;
  }
  contains() {
    return true;
  }
  focus() {
    this.focused = true;
  }
  addEventListener(type: string, listener: (event: SyntheticEvent) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, event: SyntheticEvent = {}) {
    this.listeners.get(type)!(event);
  }
}

function zone(name: string, text: string) {
  const node = new Element();
  node.setAttribute("data-cal-zone", name);
  node.childNodes = [{ text }];
  return node;
}

function fragment(
  options: { names?: string[]; root?: boolean; canonical?: boolean; badImport?: boolean } = {},
) {
  const root = new Element();
  root.dataset = { view: "calendar", month: "2026-10", past: "1" };
  root.zones = (options.names ?? NAMES).map((name) => zone(name, `new ${name}`));
  root.zones.forEach((node) => {
    node.hidden = node.getAttribute("data-cal-zone") === "miss";
  });
  if (options.badImport) root.zones.at(-1)!.childNodes = [{ text: "unimportable" }];
  const page = new Element();
  if (options.root !== false) page.selectors.set('[data-island="events-calendar"]', root);
  const canonical = new Element();
  canonical.href = ORIGIN + DESTINATION;
  if (options.canonical !== false) page.selectors.set('link[rel="canonical"]', canonical);
  LIVE_IDS.forEach((id) => {
    const node = new Element();
    node.textContent = `new ${id}`;
    page.selectors.set(`[data-testid="${id}"]`, node);
  });
  const input = new Element();
  input.setAttribute("value", "server search");
  page.selectors.set('[data-testid="events-search"]', input);
  return { page, root };
}

function browser() {
  const root = new Element();
  root.dataset = { view: "list", month: "2026-09", past: "", loadError: FAILURE };
  root.zones = NAMES.map((name) => zone(name, `old ${name}`));
  root.zones[2]!.hidden = true;
  root.zones.forEach((node) =>
    root.selectors.set(`[data-cal-zone="${node.getAttribute("data-cal-zone")}"]`, node),
  );
  const skeleton = new Element();
  skeleton.hidden = true;
  root.selectors.set('[data-testid="events-loading"]', skeleton);
  const feedback = new Element();
  root.selectors.set("[data-cal-feedback]", feedback);
  const form = new Element();
  const input = new Element();
  input.form = form;
  input.value = "old";
  input.focus();
  root.selectors.set('[data-testid="events-search"]', input);
  const live = LIVE_IDS.map((id) => {
    const node = new Element();
    node.textContent = `old ${id}`;
    root.selectors.set(`[data-testid="${id}"]`, node);
    return node;
  });
  const document = new Element();
  document.selectors.set('[data-island="events-calendar"]', root);
  const canonical = new Element();
  canonical.href = ORIGIN + ENTRY;
  document.selectors.set('link[rel="canonical"]', canonical);
  const og = new Element();
  og.content = canonical.href;
  document.selectors.set('meta[property="og:url"]', og);
  const history: string[] = [];
  const reloads: string[] = [];
  const location = {
    origin: ORIGIN,
    href: ORIGIN + ENTRY,
    assign: (href: string) => reloads.push(href),
  };
  const requests: {
    signal: AbortSignal;
    resolve: (response: { ok: boolean; text: () => Promise<string> }) => void;
  }[] = [];
  const pages = new Map<string, Element>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let popstate = () => {};
  const importNode = vi.fn((child: Content) => {
    if (child.text === "unimportable") throw new Error("Import failed");
    return { ...child };
  });
  runInNewContext(binder, {
    URL,
    AbortController,
    document: Object.assign(document, { importNode }),
    window: {
      location,
      history: {
        pushState: (_state: unknown, _title: string, path: string) => {
          history.push(path);
          location.href = ORIGIN + path;
        },
      },
      addEventListener: (_type: string, listener: () => void) => {
        popstate = listener;
      },
    },
    DOMParser: class {
      parseFromString(html: string) {
        return pages.get(html);
      }
    },
    fetch: (_path: string, init: { signal: AbortSignal }) =>
      new Promise((resolve) => requests.push({ signal: init.signal, resolve })),
    setTimeout: (callback: () => void) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  function click(
    path = DESTINATION,
    options: { ctrlKey?: boolean; download?: boolean; target?: string } = {},
  ) {
    const link = new Element();
    link.isLink = true;
    const url = new URL(path, ORIGIN);
    link.href = url.href;
    link.hash = url.hash;
    link.target = options.target ?? "";
    if (options.download) link.setAttribute("download", "");
    let prevented = false;
    root.emit("click", {
      button: 0,
      target: link,
      ctrlKey: options.ctrlKey,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  }
  async function finish(index: number, next: ReturnType<typeof fragment>) {
    const key = `response-${index}`;
    pages.set(key, next.page);
    requests[index]!.resolve({ ok: true, text: async () => key });
    await new Promise((resolve) => setImmediate(resolve));
  }
  function snapshot() {
    return {
      zones: root.zones.map((node) => ({ children: node.childNodes, hidden: node.hidden })),
      dataset: { ...root.dataset },
      statuses: live.map((node) => node.textContent),
      input: input.value,
      canonical: canonical.href,
      og: og.content,
      address: location.href,
      history: [...history],
    };
  }
  return {
    root,
    skeleton,
    feedback,
    form,
    input,
    live,
    canonical,
    og,
    history,
    reloads,
    location,
    requests,
    importNode,
    timers,
    click,
    finish,
    snapshot,
    popstate: () => popstate(),
  };
}

function expectLastGood(
  b: ReturnType<typeof browser>,
  before: ReturnType<ReturnType<typeof browser>["snapshot"]>,
) {
  expect(b.snapshot()).toEqual(before);
  b.root.zones.forEach((node, i) => expect(node.childNodes).toBe(before.zones[i]!.children));
  expect(b.feedback.textContent).toBe(FAILURE);
  expect(b.skeleton.hidden).toBe(true);
  expect(b.root.hasAttribute("aria-busy")).toBe(false);
  expect(b.input.focused).toBe(true);
}

describe("calendar fragment zone admission", () => {
  it("refuses an equal-count duplicate/missing zone fragment without any partial swap", async () => {
    const b = browser();
    const before = b.snapshot();
    b.click();
    await b.finish(0, fragment({ names: ["head", "actions", "miss", "head"] }));
    expectLastGood(b, before);
    expect(b.importNode).not.toHaveBeenCalled();
    expect(b.reloads).toEqual([]);
  });

  it.each([
    { names: ["head", "actions", "miss", "unknown"] },
    { names: ["head", "actions", "miss", "__proto__"] },
    { names: ["head", "actions", "miss", ""] },
    { names: ["head", "actions", "miss"] },
    { names: [...NAMES, "unknown"] },
    { root: false },
    { canonical: false },
  ])("refuses malformed fragment %j", async (options) => {
    const b = browser();
    const before = b.snapshot();
    b.click();
    await b.finish(0, fragment(options));
    expectLastGood(b, before);
    expect(b.importNode).not.toHaveBeenCalled();
    expect(b.reloads).toEqual([]);
  });

  it("stages every import before mutating any last-good zone", async () => {
    const b = browser();
    const before = b.snapshot();
    b.click();
    await b.finish(0, fragment({ badImport: true }));
    expectLastGood(b, before);
    expect(b.importNode).toHaveBeenCalledTimes(4);
  });

  it("swaps a reordered complete set, including empty zones, and preserves bound node identities", async () => {
    const b = browser();
    const targets = [...b.root.zones];
    const statuses = [...b.live];
    const input = b.input;
    const next = fragment({ names: [...NAMES].reverse() });
    next.root.zones.find((node) => node.getAttribute("data-cal-zone") === "actions")!.childNodes =
      [];
    b.click();
    await b.finish(0, next);
    expect(b.root.zones).toEqual(targets);
    b.root.zones.forEach((node, i) => {
      expect(node).toBe(targets[i]);
      const source = next.root.zones.find(
        (source) => source.getAttribute("data-cal-zone") === NAMES[i],
      )!;
      expect(node.childNodes).toEqual(source.childNodes);
      if (source.childNodes.length) expect(node.childNodes[0]).not.toBe(source.childNodes[0]);
      expect(node.hidden).toBe(source.hidden);
    });
    b.live.forEach((node, i) => {
      expect(node).toBe(statuses[i]);
      expect(node.textContent).toBe(`new ${LIVE_IDS[i]}`);
    });
    expect(b.input).toBe(input);
    expect(b.input.value).toBe("server search");
    expect(b.input.focused).toBe(true);
    expect(b.root.dataset).toMatchObject(next.root.dataset);
    expect(b.canonical.href).toBe(ORIGIN + DESTINATION);
    expect(b.og.content).toBe(ORIGIN + DESTINATION);
    expect(b.location.href).toBe(ORIGIN + DESTINATION);
    expect(b.history).toEqual([DESTINATION]);
    expect(b.feedback.textContent).toBe("");
  });

  it("does not overwrite newer typing during an explicit healthy swap", async () => {
    const b = browser();
    b.click();
    b.input.value = "newer typing";
    b.input.emit("input");
    await b.finish(0, fragment());
    expect(b.input.value).toBe("newer typing");
    expect(b.input.focused).toBe(true);
  });

  it("does not synchronize the input during a form search swap", async () => {
    const b = browser();
    b.input.value = "raw search";
    b.form.emit("submit", { preventDefault: () => {} });
    await b.finish(0, fragment());
    expect(b.input.value).toBe("raw search");
    expect(b.history).toEqual(["/events?q=raw+search"]);
  });

  it("ignores an aborted response without stealing feedback or cleanup from its successor", async () => {
    const b = browser();
    const before = b.snapshot();
    b.click();
    b.click("/events?past=1");
    expect(b.requests[0]!.signal.aborted).toBe(true);
    await b.finish(0, fragment());
    expect(b.snapshot().dataset).toEqual(before.dataset);
    expect(b.importNode).not.toHaveBeenCalled();
    expect(b.feedback.textContent).toBe("");
    expect(b.skeleton.hidden).toBe(false);
    await b.finish(1, fragment({ names: ["head", "actions", "miss", "head"] }));
    expectLastGood(b, before);
  });

  it("retains history behavior for healthy Back and native restoration for malformed Back", async () => {
    const b = browser();
    b.location.href = ORIGIN + DESTINATION;
    b.popstate();
    await b.finish(0, fragment());
    expect(b.history).toEqual([]);
    expect(b.canonical.href).toBe(ORIGIN + DESTINATION);
    const before = b.snapshot();
    b.location.href = ORIGIN + ENTRY;
    before.address = b.location.href;
    b.popstate();
    await b.finish(1, fragment({ canonical: false }));
    expectLastGood(b, before);
    expect(b.reloads).toEqual([ORIGIN + ENTRY]);
  });

  it("leaves modified clicks, downloads, other targets, archives and external links native", () => {
    const b = browser();
    expect(b.click(DESTINATION, { ctrlKey: true })).toBe(false);
    expect(b.click(DESTINATION, { download: true })).toBe(false);
    expect(b.click(DESTINATION, { target: "_blank" })).toBe(false);
    expect(b.click("/events/archive")).toBe(false);
    expect(b.click("https://other.example.test/events")).toBe(false);
    expect(b.requests).toHaveLength(0);
  });
});
