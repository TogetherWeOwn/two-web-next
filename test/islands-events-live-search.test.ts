// EventsCalendar live-search binding (TOG-12612): port of the legacy
// EventLiveSearchBindingTest.php browser assertions to the island contract.
// Hermetic Node VM over the shipped binder with local fixtures only — no
// server, DB, browser or network. Pins: typing debounces into one settled
// ?q= read that filters the list; clearing restores the full list; an
// explicit Clear navigation shows the loader while pending; the miss and
// empty-query empty-state copy.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_EMPTY_COPY,
  EVENTS_EMPTY_NEVER_TESTID,
  EVENTS_EMPTY_SEARCH_TESTID,
  EVENTS_LOADING_COPY,
  EVENTS_SEARCH_CLEAR_EMPTY_TESTID,
  EVENTS_SEARCH_CLEAR_TESTID,
  EVENTS_SEARCH_DEBOUNCE_MS,
  EVENTS_SEARCH_STATUS_TESTID,
  eventsSearchHitCopy,
  eventsSearchMissCopy,
} from "../src/islands/contracts";

const APP_URL = "https://next.example.test";
const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const LIVE_IDS = [
  "events-view-status",
  EVENTS_SEARCH_STATUS_TESTID,
  "events-past-status",
  "calendar-month-status",
];

type Fixture = { key: string; title: string };
const FIXTURES: Fixture[] = [
  { key: "ev-chess", title: "Chess night" },
  { key: "ev-jam", title: "Jam night" },
];

const rowMarker = (f: Fixture) => `row:${f.key}:${f.title}`;
const clearMarker = () => `clear:${EVENTS_SEARCH_CLEAR_TESTID}`;
const neverMarker = () =>
  `never:${EVENTS_EMPTY_NEVER_TESTID}:${EVENTS_EMPTY_COPY.neverTitle}|${EVENTS_EMPTY_COPY.neverBody}`;
const missMarker = (q: string) =>
  `miss:${EVENTS_EMPTY_SEARCH_TESTID}:${EVENTS_EMPTY_COPY.searchMissTitle}|${eventsSearchMissCopy(q)}|${EVENTS_EMPTY_COPY.searchMissBody}|${EVENTS_SEARCH_CLEAR_EMPTY_TESTID}:${EVENTS_EMPTY_COPY.searchMissClear}`;

class Node {
  childNodes: unknown[] = [];
  hidden = false;
  textContent = "";
  href = "";
  content = "";
  value = "";
  focused = false;
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
  replaceChildren(...children: unknown[]) {
    this.childNodes = children;
  }
  focus() {
    this.focused = true;
  }
  addEventListener(t: string, fn: (e: unknown) => void) {
    this.listeners.set(t, fn);
  }
  closest(): unknown {
    return null;
  }
}

type BinderResponse = { ok: boolean; text: () => Promise<string> };

// Fixture fragment for a calendar URL: raw q filters titles case-insensitively
// (a stub, not the server LIKE), blank q restores the full list, and the miss
// / never blocks carry the exact contract copy.
function fragment(url: string, fixtures: Fixture[]) {
  const parsed = new NodeURL(url, APP_URL);
  const q = parsed.searchParams.get("q") ?? "";
  const searching = q.trim() !== "";
  const rows = searching
    ? fixtures.filter((f) => f.title.toLowerCase().includes(q.trim().toLowerCase()))
    : [...fixtures];
  const content = rows.map(rowMarker);
  if (content.length === 0 && !searching) content.push(neverMarker());
  return {
    q,
    past: parsed.searchParams.get("past") ?? "",
    content,
    miss: rows.length === 0 && searching ? [missMarker(q)] : [],
    actions: searching ? [clearMarker()] : [],
    searchStatus: !searching
      ? ""
      : rows.length > 0
        ? eventsSearchHitCopy(q)
        : eventsSearchMissCopy(q),
  };
}

function browser(entry = "/events", fixtures: Fixture[] = FIXTURES) {
  const zones = ["head", "actions", "miss", "content"].map((name) => {
    const zone = new Node();
    zone.attributes.set("data-cal-zone", name);
    return zone;
  });
  const content = zones[3]!;
  const miss = zones[2]!;
  const actions = zones[1]!;
  const skeleton = new Node();
  skeleton.hidden = true;
  skeleton.textContent = EVENTS_LOADING_COPY;
  const feedback = new Node();
  const form = new Node();
  const input = new Node();
  input.closest = () => form;
  input.focus();
  const live = Object.fromEntries(LIVE_IDS.map((id) => [id, new Node()])) as Record<string, Node>;
  const canonical = new Node();
  const og = new Node();
  const history: string[] = [];
  const reloads: string[] = [];
  const location = {
    href: new NodeURL(entry, APP_URL).href,
    origin: APP_URL,
    assign: (href: string) => reloads.push(href),
  };
  canonical.href = location.href;
  og.content = location.href;
  let onClick: ((e: unknown) => void) | null = null;
  const root = Object.assign(new Node(), {
    querySelector: (selector: string): unknown => {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-testid="events-search"]') return input;
      if (selector === '[data-cal-zone="content"]') return content;
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
      return (id && live[id]) || null;
    },
    querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? zones : []),
    contains: () => true,
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      if (t === "click") onClick = fn;
    },
  });
  root.dataset = {
    view: "list",
    month: "2026-10",
    past: "",
    loadError: EVENTS_CALENDAR_FETCH_FAILED,
  };
  const requests: {
    url: string;
    init: { signal: AbortSignal };
    resolve: (v: BinderResponse) => void;
    reject: (e: Error) => void;
  }[] = [];
  const pages = new Map<string, unknown>();
  runInNewContext(
    binder,
    {
      URL: NodeURL,
      AbortController,
      setTimeout: (fn: () => void, ms: number) => {
        expect(ms).toBe(EVENTS_SEARCH_DEBOUNCE_MS);
        return setTimeout(fn, ms);
      },
      clearTimeout,
      document: {
        querySelector: (selector: string): unknown =>
          selector === '[data-island="events-calendar"]'
            ? root
            : selector.startsWith("link")
              ? canonical
              : selector.startsWith("meta")
                ? og
                : null,
        importNode: (node: unknown) => node,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      window: {
        location,
        history: {
          pushState: (_state: unknown, _title: string, url: string) => {
            history.push(url);
            location.href = APP_URL + url;
          },
        },
        addEventListener: () => {},
      },
      DOMParser: class {
        parseFromString(html: string) {
          return pages.get(html);
        }
      },
      fetch: (url: string, init: { signal: AbortSignal }) =>
        new Promise<BinderResponse>((resolve, reject) => {
          requests.push({ url, init, resolve, reject });
        }),
    },
    { filename: "public/islands/events-calendar.js" },
  );

  // Seed the zones from the entry SSR page, as the server would render it.
  const initial = fragment(entry, fixtures);
  content.childNodes = initial.content;
  miss.childNodes = initial.miss;
  actions.childNodes = initial.actions;
  live[EVENTS_SEARCH_STATUS_TESTID]!.textContent = initial.searchStatus;
  input.value = initial.q;

  return {
    root,
    content,
    miss,
    actions,
    skeleton,
    feedback,
    input,
    live,
    history,
    reloads,
    requests,
    type(value: string) {
      input.value = value;
      input.listeners.get("input")!({});
    },
    fire() {
      vi.advanceTimersByTime(EVENTS_SEARCH_DEBOUNCE_MS);
    },
    clickLink(path: string) {
      const url = new NodeURL(path, APP_URL);
      const link = {
        href: url.href,
        hash: url.hash,
        target: "",
        hasAttribute: () => false,
      };
      let prevented = false;
      onClick!({
        defaultPrevented: false,
        button: 0,
        target: { closest: () => link },
        preventDefault: () => {
          prevented = true;
        },
      });
      return prevented;
    },
    finish(index: number) {
      const entryUrl = requests[index]!.url;
      const frag = fragment(entryUrl, fixtures);
      const key = `page-${index}`;
      const sourceZones = ["head", "actions", "miss", "content"].map((name) => {
        const zone = new Node();
        zone.attributes.set("data-cal-zone", name);
        zone.childNodes =
          name === "content"
            ? frag.content
            : name === "miss"
              ? frag.miss
              : name === "actions"
                ? frag.actions
                : [`${name}-fresh`];
        return zone;
      });
      const next = {
        dataset: { view: "list", month: "2026-10", past: frag.past },
        querySelectorAll: (s: string) => (s === "[data-cal-zone]" ? sourceZones : []),
      };
      const statuses = ["", frag.searchStatus, "", ""].map((text) => {
        const node = new Node();
        node.textContent = text;
        return node;
      });
      const srcInput = { getAttribute: (name: string) => (name === "value" ? frag.q : null) };
      pages.set(key, {
        querySelector: (selector: string): unknown => {
          if (selector === '[data-island="events-calendar"]') return next;
          if (selector.startsWith("link")) return { href: APP_URL + entryUrl };
          if (selector.startsWith("meta")) return { content: APP_URL + entryUrl };
          const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
          if (id === "events-search") return srcInput;
          const liveIdx = LIVE_IDS.indexOf(id ?? "");
          return liveIdx >= 0 ? statuses[liveIdx] : null;
        },
      });
      requests[index]!.resolve({ ok: true, text: async () => key });
    },
    flush: () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve))),
  };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("EventsCalendar live-search binding", () => {
  it("debounces typing into one settled search that filters the rendered list", async () => {
    const b = browser();
    const input = b.input;
    expect(b.requests).toHaveLength(0);
    b.type("c");
    b.type("ch");
    b.type("chess");
    expect(b.requests).toHaveLength(0);
    b.fire();
    expect(b.requests.map((r) => r.url)).toEqual(["/events?q=chess"]);
    // Settled searches are untargeted: no skeleton while pending.
    expect(b.skeleton.hidden).toBe(true);
    expect(b.content.hidden).toBe(false);
    b.finish(0);
    await b.flush();
    expect(b.content.childNodes).toEqual([rowMarker(FIXTURES[0]!)]);
    expect(b.miss.childNodes).toEqual([]);
    expect(b.live[EVENTS_SEARCH_STATUS_TESTID]!.textContent).toBe(eventsSearchHitCopy("chess"));
    expect(b.actions.childNodes).toEqual([clearMarker()]);
    expect(b.input).toBe(input);
    expect(b.input.value).toBe("chess");
    expect(b.input.focused).toBe(true);
    expect(b.history).toEqual(["/events?q=chess"]);
  });

  it("clearing the box restores the full list without a loader", async () => {
    const b = browser("/events?q=chess");
    expect(b.content.childNodes).toEqual([rowMarker(FIXTURES[0]!)]);
    b.type("");
    b.fire();
    expect(b.requests.map((r) => r.url)).toEqual(["/events"]);
    expect(b.skeleton.hidden).toBe(true);
    b.finish(0);
    await b.flush();
    expect(b.content.childNodes).toEqual(FIXTURES.map(rowMarker));
    expect(b.miss.childNodes).toEqual([]);
    expect(b.live[EVENTS_SEARCH_STATUS_TESTID]!.textContent).toBe("");
    expect(b.actions.childNodes).toEqual([]);
    expect(b.input.value).toBe("");
    expect(b.history).toEqual(["/events"]);
  });

  it("activating Clear shows the loader while pending, then restores the list and syncs the box", async () => {
    const b = browser("/events?q=chess");
    const input = b.input;
    expect(b.clickLink("/events")).toBe(true);
    expect(b.requests.map((r) => r.url)).toEqual(["/events"]);
    expect(b.skeleton.hidden).toBe(false);
    expect(b.content.hidden).toBe(true);
    expect(b.root.getAttribute("aria-busy")).toBe("true");
    expect(b.skeleton.textContent).toContain(EVENTS_LOADING_COPY);
    // Last-good rows stay mounted until the full list commits.
    expect(b.content.childNodes).toEqual([rowMarker(FIXTURES[0]!)]);
    b.finish(0);
    await b.flush();
    expect(b.skeleton.hidden).toBe(true);
    expect(b.content.hidden).toBe(false);
    expect(b.root.getAttribute("aria-busy")).toBeNull();
    expect(b.content.childNodes).toEqual(FIXTURES.map(rowMarker));
    expect(b.miss.childNodes).toEqual([]);
    expect(b.input).toBe(input);
    expect(b.input.value).toBe("");
    expect(b.history).toEqual(["/events"]);
  });

  it("a search with no matches swaps in the miss block copy and keeps the query", async () => {
    const b = browser();
    b.type("valorant");
    b.fire();
    expect(b.requests.map((r) => r.url)).toEqual(["/events?q=valorant"]);
    b.finish(0);
    await b.flush();
    expect(b.content.childNodes).toEqual([]);
    const [missBlock] = b.miss.childNodes;
    expect(String(missBlock)).toContain(EVENTS_EMPTY_SEARCH_TESTID);
    expect(String(missBlock)).toContain(EVENTS_EMPTY_COPY.searchMissTitle);
    expect(String(missBlock)).toContain(eventsSearchMissCopy("valorant"));
    expect(String(missBlock)).toContain(EVENTS_EMPTY_COPY.searchMissBody);
    expect(String(missBlock)).toContain(EVENTS_SEARCH_CLEAR_EMPTY_TESTID);
    expect(String(missBlock)).toContain(EVENTS_EMPTY_COPY.searchMissClear);
    expect(b.live[EVENTS_SEARCH_STATUS_TESTID]!.textContent).toBe(eventsSearchMissCopy("valorant"));
    expect(b.input.value).toBe("valorant");
    expect(b.input.focused).toBe(true);
    expect(b.history).toEqual(["/events?q=valorant"]);
  });

  it("an empty query on an empty calendar restores the never-scheduled empty-state copy", async () => {
    const b = browser("/events?q=valorant", []);
    expect(b.content.childNodes).toEqual([]);
    expect(b.miss.childNodes).toHaveLength(1);
    b.type("");
    b.fire();
    expect(b.requests.map((r) => r.url)).toEqual(["/events"]);
    b.finish(0);
    await b.flush();
    const [emptyBlock] = b.content.childNodes;
    expect(String(emptyBlock)).toContain(EVENTS_EMPTY_NEVER_TESTID);
    expect(String(emptyBlock)).toContain(EVENTS_EMPTY_COPY.neverTitle);
    expect(String(emptyBlock)).toContain(EVENTS_EMPTY_COPY.neverBody);
    expect(b.miss.childNodes).toEqual([]);
    expect(b.live[EVENTS_SEARCH_STATUS_TESTID]!.textContent).toBe("");
    expect(b.history).toEqual(["/events"]);
  });
});
