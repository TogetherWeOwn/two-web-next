import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Execute the shipped binder, not a copied load/search implementation. The game
// select and text input live outside the swapped zones, just as in the SSR form.
// These regressions catch missing game synchronization, a shared text/game intent
// guard, and stale responses overwriting newer choices (including away-and-back).
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
type FixtureEvent = { target?: unknown; preventDefault: () => void };

class Node {
  childNodes: unknown[] = [];
  hidden = false;
  textContent = "";
  href = "";
  content = "";
  value = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: FixtureEvent) => void)[]>();
  swaps = 0;
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
  addEventListener(type: string, listener: (event: FixtureEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, preventDefault() {} });
    }
  }
  focus() {}
}

// Model the native selected option, not a non-existent select[value] attribute.
function select(selected: string) {
  const options = ["", "Chess", "Go", "Dungeons & Dragons"].map((value) => {
    const option = Object.assign(new Node(), { value, selected: value === selected });
    option.setAttribute("value", value);
    if (option.selected) option.setAttribute("selected", "");
    return option;
  });
  const node = Object.assign(new Node(), {
    name: "game",
    options,
    querySelector(selector: string) {
      return selector.includes("selected") || selector.includes(":checked")
        ? (options.find((option) => option.selected) ?? null)
        : null;
    },
    querySelectorAll: () => options,
  });
  node.setAttribute("name", "game");
  node.setAttribute("data-testid", "events-game-filter");
  Object.defineProperty(node, "value", {
    get: () => options.find((option) => option.selected)?.value ?? "",
    set: (value: string) => {
      for (const option of options) option.selected = option.value === value;
    },
  });
  Object.defineProperty(node, "selectedOptions", {
    get: () => options.filter((option) => option.selected),
  });
  return node;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Reply = { ok: boolean; text: () => Promise<string> };

function browser(entry = "/events?game=Go&q=old") {
  const initial = new NodeURL(entry, ORIGIN);
  const form = new Node();
  const input = Object.assign(new Node(), { closest: () => form });
  input.value = initial.searchParams.get("q") ?? "";
  const game = Object.assign(select(initial.searchParams.get("game") ?? ""), {
    closest: () => form,
  });
  const field = (selector: string) => {
    if (
      (selector.includes("events-search") && !selector.includes("status")) ||
      /name=["']?q["']?/.test(selector)
    )
      return input;
    if (selector.includes("events-game-filter") || /name=["']?game["']?/.test(selector))
      return game;
    return null;
  };
  Object.assign(form, { querySelector: field });
  const zones = ["head", "actions", "miss", "content"].map((name) => {
    const node = new Node();
    node.setAttribute("data-cal-zone", name);
    node.childNodes = [`initial ${name}`];
    return node;
  });
  const skeleton = Object.assign(new Node(), { hidden: true });
  const feedback = new Node();
  const live = LIVE_IDS.map(() => new Node());
  const canonical = Object.assign(new Node(), { href: initial.href });
  const og = Object.assign(new Node(), { content: initial.href });
  const root = Object.assign(new Node(), {
    dataset: { view: "list", month: "2099-07", past: "", loadError: "Calendar unavailable" },
    contains: () => true,
    querySelector(selector: string) {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-cal-zone="content"]') return zones[3];
      return (
        field(selector) ??
        live[LIVE_IDS.indexOf(/data-testid="([^"]+)"/.exec(selector)?.[1] ?? "")] ??
        null
      );
    },
    querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? zones : []),
  });
  const location = { href: initial.href, origin: ORIGIN, assign: vi.fn() };
  const history: string[] = [];
  const requests: {
    url: string;
    init: RequestInit;
    response: ReturnType<typeof deferred<Reply>>;
  }[] = [];
  const pages = new Map<string, unknown>();
  let popstate!: () => void;
  runInNewContext(binder, {
    URL: NodeURL,
    AbortController,
    setTimeout,
    clearTimeout,
    document: {
      querySelector: (selector: string) =>
        selector === '[data-island="events-calendar"]'
          ? root
          : selector.startsWith("link")
            ? canonical
            : selector.startsWith("meta")
              ? og
              : null,
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
      addEventListener(type: string, listener: () => void) {
        if (type === "popstate") popstate = listener;
      },
    },
    DOMParser: class {
      parseFromString(html: string) {
        return pages.get(html);
      }
    },
    fetch(url: string, init: RequestInit) {
      const response = deferred<Reply>();
      requests.push({ url, init, response });
      return response.promise;
    },
  });

  function responsePage(index: number, selected: string, query = "") {
    const url = new NodeURL(requests[index]!.url, ORIGIN);
    const sourceGame = select(selected);
    const sourceInput = new Node();
    sourceInput.value = query;
    sourceInput.setAttribute("value", query);
    const sourceZones = zones.map((zone) => {
      const node = new Node();
      node.setAttribute("data-cal-zone", zone.getAttribute("data-cal-zone")!);
      node.childNodes = [`response ${index}`];
      return node;
    });
    const fields = (selector: string) => {
      if (selector.includes("events-game-filter") || /name=["']?game["']?/.test(selector))
        return sourceGame;
      if (selector.includes("events-search") && !selector.includes("status")) return sourceInput;
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
      return LIVE_IDS.includes(id ?? "") ? { textContent: `response ${index} ${id}` } : null;
    };
    const next = {
      dataset: { view: "list", month: "2099-07", past: "" },
      querySelector: fields,
      querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? sourceZones : []),
    };
    const key = `page-${index}`;
    pages.set(key, {
      querySelector(selector: string) {
        if (selector === '[data-island="events-calendar"]') return next;
        if (selector.startsWith("link")) return { href: url.href };
        return fields(selector);
      },
    });
    return key;
  }

  return {
    input,
    game,
    zones,
    live,
    canonical,
    location,
    history,
    requests,
    backOrForward(path: string) {
      location.href = new NodeURL(path, ORIGIN).href;
      popstate();
    },
    type(value: string) {
      input.value = value;
      input.dispatch("input");
    },
    choose(value: string) {
      game.value = value;
      game.dispatch("input");
      game.dispatch("change");
    },
    submit() {
      form.dispatch("submit");
    },
    async respond(index: number, selected: string, query = "") {
      const html = responsePage(index, selected, query);
      requests[index]!.response.resolve({ ok: true, text: async () => html });
      await settle();
    },
    async delayBody(index: number, selected: string, query = "") {
      const html = responsePage(index, selected, query);
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

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("calendar game control history and independent intent", () => {
  it("Back then Forward synchronizes the persistent select without pushing history", async () => {
    const b = browser();
    b.backOrForward("/events?game=Chess&q=raid");
    expect(b.requests).toHaveLength(1);
    await b.respond(0, "Chess", "raid");
    expect(b.zones[3]!.childNodes).toEqual(["response 0"]);
    expect(b.live[1]!.textContent).toBe("response 0 events-search-status");
    expect(b.input.value).toBe("raid");
    expect(b.game.value).toBe("Chess");
    b.backOrForward("/events?game=Go&q=old");
    await b.respond(1, "Go", "old");
    expect(b.game.value).toBe("Go");
    expect(b.input.value).toBe("old");
    expect(b.canonical.href).toBe(ORIGIN + "/events?game=Go&q=old");
    expect(b.history).toEqual([]);
  });

  it.each([
    { path: "/events?game=%20cHeSs%20", selected: "Chess" },
    { path: "/events?game=unknown", selected: "" },
    { path: "/events?game=%20%20", selected: "" },
    { path: "/events", selected: "" },
    { path: "/events?game=Dungeons+%26+Dragons", selected: "Dungeons & Dragons" },
  ])("uses the response's selected canonical option for $path", async ({ path, selected }) => {
    const b = browser();
    b.backOrForward(path);
    await b.respond(0, selected);
    expect(b.zones.every((zone) => zone.swaps === 1)).toBe(true);
    expect(b.game.value).toBe(selected);
    expect(b.history).toEqual([]);
    expect(b.location.href).toBe(new NodeURL(path, ORIGIN).href);
  });

  it.each([false, true])(
    "newer text intent does not block safe game sync (text edits away and back=%s)",
    async (awayAndBack) => {
      const b = browser();
      b.backOrForward("/events?game=Chess&q=server");
      const finish = await b.delayBody(0, "Chess", "server");
      b.type("draft");
      if (awayAndBack) b.type("old");
      expect(b.requests[0]!.init.signal!.aborted).toBe(false);
      await finish();
      expect(b.zones[3]!.childNodes).toEqual(["response 0"]);
      expect(b.input.value).toBe(awayAndBack ? "old" : "draft");
      expect(b.game.value).toBe("Chess");
      expect(b.history).toEqual([]);
      vi.advanceTimersByTime(300);
      expect(b.requests).toHaveLength(2);
      const next = new NodeURL(b.requests[1]!.url, ORIGIN);
      expect(next.searchParams.get("game")).toBe("Chess");
      expect(next.searchParams.get("q")).toBe(awayAndBack ? "old" : "draft");
    },
  );

  it.each([false, true])(
    "CONTROL: newer game intent survives without blocking text sync (game edits away and back=%s)",
    async (awayAndBack) => {
      const b = browser("/events?game=Chess&q=old");
      b.backOrForward("/events?game=Go&q=server");
      const finishOld = await b.delayBody(0, "Go", "server");
      b.choose(awayAndBack ? "Go" : "Dungeons & Dragons");
      if (awayAndBack) b.choose("Chess");
      const latest = awayAndBack ? "Chess" : "Dungeons & Dragons";
      await finishOld();
      expect(b.zones[3]!.childNodes).toEqual(["response 0"]);
      expect(b.game.value).toBe(latest);
      expect(b.input.value).toBe("server");
      expect(b.history).toEqual([]);
      // The unsent choice still participates in the next explicit form submit.
      b.submit();
      expect(b.requests).toHaveLength(2);
      const submitted = new NodeURL(b.requests[1]!.url, ORIGIN);
      expect(submitted.searchParams.get("game")).toBe(latest);
      expect(submitted.searchParams.get("q")).toBe("server");
      await b.respond(1, latest, "server");
      expect(b.game.value).toBe(latest);
    },
  );

  it.each([false, true])(
    "CONTROL: submitted game intent supersedes older bodies (game edits away and back=%s)",
    async (awayAndBack) => {
      const b = browser("/events?game=Chess&q=old");
      b.backOrForward("/events?game=Go&q=server");
      const finishOld = await b.delayBody(0, "Go", "server");
      b.choose("Go");
      b.submit();
      if (awayAndBack) {
        b.choose("Chess");
        b.submit();
      }
      const latest = awayAndBack ? "Chess" : "Go";
      expect(b.requests).toHaveLength(awayAndBack ? 3 : 2);
      const newest = b.requests.length - 1;
      await b.respond(newest, latest, "old");
      const committed = b.zones.map((zone) => [...zone.childNodes]);
      await finishOld();
      expect(b.game.value).toBe(latest);
      expect(b.input.value).toBe("old");
      expect(b.zones.map((zone) => zone.childNodes)).toEqual(committed);
      expect(b.history).toEqual([b.requests[newest]!.url]);
      if (awayAndBack) {
        await b.respond(1, "Go", "old");
        expect(b.game.value).toBe("Chess");
        expect(b.zones.map((zone) => zone.childNodes)).toEqual(committed);
      }
    },
  );

  it("CONTROL: failed history reads leave the last-good controls and zones alone", async () => {
    const b = browser();
    b.backOrForward("/events?game=Chess&q=raid");
    b.requests[0]!.response.resolve({ ok: false, text: async () => "unavailable" });
    await settle();
    expect(b.game.value).toBe("Go");
    expect(b.input.value).toBe("old");
    expect(b.zones.every((zone) => zone.swaps === 0)).toBe(true);
    expect(b.history).toEqual([]);
  });
});
