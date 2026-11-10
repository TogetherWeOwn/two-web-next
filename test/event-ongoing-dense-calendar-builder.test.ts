// Builder regression for the dense-calendar review finding: a supported
// month (85 long published events, under the 200-row read cap) renders an
// October grid whose per-cell "Happening now" badges take the page past the
// events-calendar island's finite HTML byte cap. The bounded reader must
// still reject that body before DOMParser, but an explicit month navigation
// falls back to the full document its real anchor would have loaded without
// the island, instead of stranding the member on the previous month with a
// retry that can never succeed. A settled search keeps the last-good view
// (typing never loses focus to a full navigation).
//
// Run: env -u DATABASE_URL npx vitest run test/event-ongoing-dense-calendar-builder.test.ts
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { DISCOVERY_HTML_MAX_BYTES } from "../src/islands/contracts";
import { KEY, event, model, render } from "./fixtures/schedule-availability";

const ORIGIN = "https://dense.example.test";
const LOAD_ERROR = "Read failed; your last view is unchanged.";
const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const encoder = new TextEncoder();
const bytesOf = (s: string) => encoder.encode(s).byteLength;

// 85 published UTC events spanning 2035-09-15 to 2035-12-15: every one is
// ongoing at the fixture clock (2035-10-20T12:00Z), so every October cell
// repeats the badge in visible text and in the accessible name.
function denseRows() {
  return Array.from({ length: 85 }, (_, i) =>
    event({
      id: i + 1,
      eventKey: `${KEY.slice(0, 20)}${String(i).padStart(6, "0")}`,
      title: `Season expedition night ${i + 1}`,
      startsAt: new Date("2035-09-15T18:00:00Z"),
      endsAt: new Date("2035-12-15T20:00:00Z"),
    }),
  );
}

// --- Fake DOM + streamed responses, mirroring the sibling island suites. ---
class FNode {
  tag: string;
  childNodes: unknown[] = [];
  hidden = false;
  textContent = "";
  href = "";
  hash = "";
  target = "";
  content = "";
  value = "";
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: any) => void)[]>();
  constructor(tag = "div") {
    this.tag = tag;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    if (name === "href") return this.href || (this.attributes.get(name) ?? null);
    if (name === "content") return this.content || (this.attributes.get(name) ?? null);
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  replaceChildren(...children: unknown[]) {
    this.childNodes = children;
  }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((fn) => fn !== listener),
    );
  }
  contains(other: unknown) {
    return this === other;
  }
  focus() {}
  closest(selector: string): unknown {
    return selector === "a" && this.tag === "a" ? this : null;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(pred: () => boolean, turns = 300): Promise<boolean> {
  for (let i = 0; i < turns; i++) {
    if (pred()) return true;
    await tick();
  }
  return pred();
}
async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await tick();
}

type FakeResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
};

function streamedResponse(bytes: Uint8Array): FakeResponse {
  let index = 0;
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += 65_536)
    chunks.push(bytes.subarray(at, at + 65_536));
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      const chunk = chunks[index++];
      if (chunk) c.enqueue(chunk);
      else c.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: stream,
    text: async () => new TextDecoder().decode(bytes),
  };
}

const LIVE_IDS = [
  "events-view-status",
  "events-search-status",
  "events-past-status",
  "calendar-month-status",
];

function browser() {
  const form = new FNode("form");
  const input = Object.assign(new FNode("input"), { closest: () => form });
  const game = Object.assign(new FNode("select"), {
    options: [{ value: "" }, { value: "co-op" }],
  });
  let focused = input as FNode;
  input.focus = () => {
    focused = input;
  };
  let clock = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  function advance(ms: number) {
    clock += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > clock || !timers.delete(id)) continue;
      timer.run();
    }
  }
  const zones = ["head", "actions", "miss", "content"].map((name) => {
    const node = new FNode();
    node.setAttribute("data-cal-zone", name);
    node.childNodes = [`initial ${name}`];
    return node;
  });
  const skeleton = new FNode();
  skeleton.hidden = true;
  const feedback = new FNode("p");
  const live = LIVE_IDS.map(() => new FNode("p"));
  const heading = new FNode("h1");
  const canonical = Object.assign(new FNode("link"), { href: `${ORIGIN}/events` });
  const og = Object.assign(new FNode("meta"), { content: canonical.href });
  const links: FNode[] = [];
  let click!: (event: any) => void;
  const root = Object.assign(new FNode("section"), {
    dataset: { view: "calendar", month: "2035-10", past: "", loadError: LOAD_ERROR },
    querySelector(selector: string) {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-testid="events-search"]') return input;
      if (selector === 'select[name="game"]') return game;
      if (selector === '[data-cal-zone="content"]') return zones[3];
      if (selector === "#events-heading") return heading;
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
      return live[LIVE_IDS.indexOf(id ?? "")] ?? null;
    },
    querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? zones : []),
    addEventListener(_type: string, listener: (event: any) => void) {
      click = listener;
    },
    contains: (node: unknown) => node === root || links.includes(node as FNode),
  });
  const history: string[] = [];
  const assigns: string[] = [];
  const location = {
    href: `${ORIGIN}/events?view=calendar&month=2035-10`,
    origin: ORIGIN,
    assign: (href: string) => {
      assigns.push(href);
    },
  };
  const requests: { url: string; response: ReturnType<typeof deferred<FakeResponse>> }[] = [];
  const parseCalls: number[] = [];
  const windowListeners = new Map<string, () => void>();
  const makePage = (reqIndex: number) => {
    const url = new NodeURL(requests[reqIndex]!.url, ORIGIN);
    const sourceZones = zones.map((target) => {
      const node = new FNode();
      node.setAttribute("data-cal-zone", target.getAttribute("data-cal-zone")!);
      node.childNodes = [`pg${reqIndex} ${target.getAttribute("data-cal-zone")}`];
      return node;
    });
    const next = {
      dataset: {
        view: url.searchParams.get("view") ?? "calendar",
        month: url.searchParams.get("month") ?? "2035-10",
        past: url.searchParams.get("past") ?? "",
      },
      querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? sourceZones : []),
    };
    return {
      querySelector(selector: string) {
        if (selector === '[data-island="events-calendar"]') return next;
        if (selector.startsWith("link")) return { href: url.href };
        const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
        if (id === "events-search") return { getAttribute: () => "" };
        if (selector === 'select[name="game"]')
          return { value: url.searchParams.get("game") ?? "" };
        if (LIVE_IDS.includes(id ?? "")) return { textContent: `live ${id}` };
        return null;
      },
    };
  };
  runInNewContext(
    binder,
    {
      URL: NodeURL,
      AbortController,
      setTimeout(run: () => void, delay: number) {
        const id = ++timerId;
        timers.set(id, { at: clock + delay, run });
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
      TextDecoder,
      TextEncoder,
      ReadableStream,
      fetch(url: string) {
        const response = deferred<FakeResponse>();
        requests.push({ url, response });
        return response.promise;
      },
      DOMParser: class {
        parseFromString(html: string) {
          parseCalls.push(bytesOf(html));
          return makePage(requests.length - 1);
        }
      },
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
        addEventListener: () => {},
        removeEventListener: () => {},
        get activeElement() {
          return focused;
        },
        body: new FNode("body"),
      },
      window: {
        location,
        history: {
          pushState(_s: unknown, _t: string, path: string) {
            history.push(path);
          },
        },
        addEventListener: (name: string, listener: () => void) =>
          windowListeners.set(name, listener),
      },
    },
    { filename: "public/islands/events-calendar.js" },
  );
  return {
    input,
    requests,
    parseCalls,
    history,
    assigns,
    navigate() {
      const link = new FNode("a");
      link.href = `${ORIGIN}/events?view=calendar&month=2035-11`;
      link.hash = "";
      link.hasAttribute = (name: string) => name === "href";
      link.closest = (selector: string) =>
        selector === "a" ? link : selector === '[data-cal-zone="content"]' ? zones[3] : null;
      links.push(link);
      click({
        defaultPrevented: false,
        button: 0,
        target: { closest: (s: string) => link.closest(s) },
        preventDefault() {},
      });
    },
    advance,
    focused: () => focused,
    typeSearch(value: string, isComposing = false) {
      input.focus();
      input.value = value;
      for (const fn of input.listeners.get("input") ?? []) fn({ isComposing });
    },
    composition(type: "compositionstart" | "compositionend") {
      input.focus();
      for (const fn of input.listeners.get(type) ?? []) fn({});
    },
    selectGame(value: string) {
      focused = game;
      game.value = value;
      for (const fn of game.listeners.get("change") ?? []) fn({});
    },
    back() {
      location.href = `${ORIGIN}/events?view=calendar&month=2035-09`;
      windowListeners.get("popstate")!();
    },
    respond: (i: number, r: FakeResponse) => requests[i]!.response.resolve(r),
    feedback: () => feedback.textContent,
    busy: () => root.attributes.has("aria-busy"),
    zoneChildren: () => zones.map((z) => [...z.childNodes]),
    canonicalNow: () => canonical.href,
  };
}

describe("dense ongoing calendar route-to-island regression", () => {
  it("the dense October grid itself exceeds the island cap", async () => {
    const html = await render(model(denseRows(), { view: "calendar" }), "Hono");
    expect(html.match(/data-testid="event-ongoing"/g)?.length ?? 0).toBeGreaterThan(2000);
    expect(bytesOf(html)).toBeGreaterThan(DISCOVERY_HTML_MAX_BYTES);
  });

  it("an explicit month switch past the cap loads the full document instead of stranding", async () => {
    const html = await render(model(denseRows(), { view: "calendar" }), "Hono");
    const b = browser();
    const before = b.zoneChildren();
    const canonicalBefore = b.canonicalNow();
    b.navigate();
    expect(b.requests).toHaveLength(1);
    b.respond(0, streamedResponse(encoder.encode(html)));
    expect(await until(() => b.assigns.length > 0)).toBe(true);
    await settle();
    // The destination the real anchor named, fetched as a document by the
    // browser (no island cap on a top-level navigation).
    expect(b.assigns).toEqual(["/events?view=calendar&month=2035-11"]);
    // The bounded reader still held: nothing oversize reached the parser,
    // and this document's zones/history/canonical were never mutated.
    expect(b.parseCalls).toEqual([]);
    expect(b.zoneChildren()).toEqual(before);
    expect(b.history).toEqual([]);
    expect(b.canonicalNow()).toBe(canonicalBefore);
    expect(b.busy()).toBe(false);
    expect(b.feedback()).toBe(LOAD_ERROR);
  });

  it("CONTROL: a small month switch still swaps in place with no full navigation", async () => {
    const b = browser();
    b.navigate();
    b.respond(0, streamedResponse(encoder.encode("x".repeat(2048))));
    expect(await until(() => b.history.length > 0)).toBe(true);
    await settle();
    expect(b.history).toEqual(["/events?view=calendar&month=2035-11"]);
    expect(b.assigns).toEqual([]);
    expect(b.parseCalls).toHaveLength(1);
    expect(b.feedback()).toBe("");
  });

  // Removing either revision comparison from the document fallback loses a
  // newer draft before another request can supersede the month navigation.
  it.each(["typing", "same-value edit", "composition", "game", "same-value game"] as const)(
    "an oversized month response preserves newer %s intent",
    async (intent) => {
      const html = await render(model(denseRows(), { view: "calendar" }), "Hono");
      const b = browser();
      const before = b.zoneChildren();
      const canonicalBefore = b.canonicalNow();
      b.navigate();
      if (intent === "composition") b.composition("compositionstart");
      if (intent === "game" || intent === "same-value game") {
        b.selectGame("co-op");
        if (intent === "same-value game") b.selectGame("");
      } else {
        b.typeSearch("new draft", intent === "composition");
        if (intent === "same-value edit") b.typeSearch("");
      }
      const focusBefore = b.focused();
      const draftBefore = b.input.value;
      expect(b.requests).toHaveLength(1);
      b.respond(0, streamedResponse(encoder.encode(html)));
      expect(await until(() => b.feedback() === LOAD_ERROR)).toBe(true);
      await settle();
      expect(b.assigns).toEqual([]);
      expect(b.parseCalls).toEqual([]);
      expect(b.zoneChildren()).toEqual(before);
      expect(b.history).toEqual([]);
      expect(b.canonicalNow()).toBe(canonicalBefore);
      expect(b.input.value).toBe(draftBefore);
      expect(b.focused()).toBe(focusBefore);
      expect(b.busy()).toBe(false);
      b.advance(299);
      expect(b.requests).toHaveLength(1);
      b.advance(1);
      if (intent === "typing" || intent === "same-value edit") {
        expect(b.requests).toHaveLength(2);
        expect(b.requests[1]!.url).toBe(intent === "typing" ? "/events?q=new+draft" : "/events");
        b.respond(1, streamedResponse(encoder.encode("small search")));
        await settle();
        expect(b.assigns).toEqual([]);
      } else {
        // Composition and unsent facet changes schedule no replacement read.
        expect(b.requests).toHaveLength(1);
      }
    },
  );

  it("CONTROL: an oversized Back read still reconciles the address despite a newer draft", async () => {
    const html = await render(model(denseRows(), { view: "calendar" }), "Hono");
    const b = browser();
    const before = b.zoneChildren();
    b.back();
    b.composition("compositionstart");
    b.typeSearch("new draft", true);
    b.respond(0, streamedResponse(encoder.encode(html)));
    expect(await until(() => b.assigns.length > 0)).toBe(true);
    await settle();
    expect(b.assigns.map((href) => new NodeURL(href, ORIGIN).href)).toEqual([
      `${ORIGIN}/events?view=calendar&month=2035-09`,
    ]);
    expect(b.parseCalls).toEqual([]);
    expect(b.zoneChildren()).toEqual(before);
    expect(b.history).toEqual([]);
    expect(b.busy()).toBe(false);
  });

  it("a settled search past the cap keeps the last-good view and never navigates the document", async () => {
    const html = await render(model(denseRows(), { view: "calendar" }), "Hono");
    const b = browser();
    const before = b.zoneChildren();
    b.typeSearch("season");
    // The island debounces a settled search by 300 ms.
    b.advance(300);
    expect(b.requests).toHaveLength(1);
    b.respond(0, streamedResponse(encoder.encode(html)));
    expect(await until(() => b.feedback() === LOAD_ERROR)).toBe(true);
    await settle();
    expect(b.assigns).toEqual([]);
    expect(b.parseCalls).toEqual([]);
    expect(b.zoneChildren()).toEqual(before);
    expect(b.busy()).toBe(false);
  });
});
