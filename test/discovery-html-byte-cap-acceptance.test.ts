// Test Author owned: build on these fail-first tests without editing them.
//
// Discovery reads byte cap: the events-calendar and past-events islands fetch
// a same-origin HTML page and hand it to DOMParser. Today both buffer the
// complete body with response.text() before parsing, so nothing bounds how
// much HTML one read can allocate or parse. The builder adds ONE finite,
// documented HTML byte cap shared by both islands:
//
//   - actual consumed bytes are enforced while the body streams in, and the
//     read is cancelled (reader cancel or fetch abort) the moment the cap is
//     crossed — Content-Length is advisory only, never proof of size;
//   - a body-less compatibility path (no readable body stream, as the older
//     island suites feed) measures UTF-8 bytes and rejects before parsing —
//     that is a parse bound, not a download-allocation bound;
//   - a rejected body never reaches DOMParser and never mutates zones,
//     history or canonical/og metadata: existing failure recovery shows, busy
//     state releases, last-good content stays, nothing retries on its own,
//     and a superseded or late oversize settlement cannot disturb the
//     current view;
//   - multibyte UTF-8 counts as bytes, not characters, and characters split
//     across chunk boundaries still decode exactly under the cap.
//
// The cap value is the builder's measured choice, so this suite discovers it
// behaviorally (binary search on padded valid pages) instead of importing a
// constant name: CAP below is the largest byte length each island accepts.
// Any single shared cap that fits the largest real fixture pages measured in
// CAP-09 and stays at or under CAP_CEILING satisfies the numeric contract.
// Tests execute the shipped minified binders from public/islands/, so the
// builder regenerates assets (npm run build:assets) after editing sources.
//
// Case map: CTRL-* already pass and must keep passing; CAP-* fail today
// because response.text() imposes no bound at all.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { DiscordEventsSource } from "../src/events/discord-transients";

const ORIGIN = "https://cap.example.test";
const LOAD_ERROR = "Read failed; your last view is unchanged.";
const CAP_CEILING = 4_194_304; // 4 MiB: a finite cap must land at or under this.
const CHUNK = 65_536;
const encoder = new TextEncoder();
const bytesOf = (s: string) => encoder.encode(s).byteLength;

const binders: Record<Island, string> = {
  "events-calendar": readFileSync(
    new NodeURL("../public/islands/events-calendar.js", import.meta.url),
    "utf8",
  ),
  "past-events": readFileSync(
    new NodeURL("../public/islands/past-events.js", import.meta.url),
    "utf8",
  ),
};
type Island = "events-calendar" | "past-events";
const ISLANDS: Island[] = ["events-calendar", "past-events"];

// ---------------------------------------------------------------------------
// Fake DOM node shared by both island harnesses (mirrors sibling suites).
// ---------------------------------------------------------------------------
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
  focused = false;
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
  focus() {
    this.focused = true;
  }
  closest(selector: string): unknown {
    return selector === "a" && this.tag === "a" ? this : null;
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

// ---------------------------------------------------------------------------
// Response fakes: a real ReadableStream body so getReader, async iteration,
// body.cancel() and a draining text()/arrayBuffer() all observe the same
// pull/cancel accounting, exactly like a browser fetch body.
// ---------------------------------------------------------------------------
type StreamStats = { pulledBytes: number; cancelled: boolean };

function streamOf(chunks: Uint8Array[], hangAtEnd: boolean) {
  const stats: StreamStats = { pulledBytes: 0, cancelled: false };
  let index = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    pull(c) {
      const chunk = chunks[index++];
      if (chunk) {
        stats.pulledBytes += chunk.byteLength;
        c.enqueue(chunk);
      } else if (!hangAtEnd) {
        c.close();
      }
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return {
    stream,
    stats,
    close() {
      try {
        controller.close();
      } catch {
        // Already closed; this fixture close is best-effort.
      }
    },
  };
}

function chunked(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += chunkSize)
    out.push(bytes.subarray(at, at + chunkSize));
  return out;
}

type FakeResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function streamedResponse(
  bytes: Uint8Array,
  opts: { chunkSize?: number; contentLength?: string | null; hangAtEnd?: boolean } = {},
) {
  const source = streamOf(chunked(bytes, opts.chunkSize ?? CHUNK), opts.hangAtEnd ?? false);
  const drain = async () => {
    const reader = source.stream.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.byteLength;
    }
    return all;
  };
  const response: FakeResponse = {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-length" ? (opts.contentLength ?? null) : null,
    },
    body: source.stream,
    text: async () => new TextDecoder().decode(await drain()),
    arrayBuffer: async () => (await drain()).buffer as ArrayBuffer,
  };
  return { response, stats: source.stats, close: source.close };
}

function bufferedResponse(html: string): FakeResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () => html,
    arrayBuffer: async () => encoder.encode(html).buffer as ArrayBuffer,
  };
}

// ---------------------------------------------------------------------------
// One harness per island behind a shared adapter shape.
// ---------------------------------------------------------------------------
type ParseCall = { bytes: number; html: string | null; pageIndex: number };
type Req = {
  url: string;
  signal: AbortSignal;
  response: ReturnType<typeof deferred<FakeResponse>>;
};
type Harness = {
  requests: Req[];
  parseCalls: ParseCall[];
  history: string[];
  navigate(): void;
  respond(i: number, r: FakeResponse): void;
  committed(): boolean;
  rejected(): boolean;
  busy(): boolean;
  zoneChildren(): unknown[];
  canonicalNow(): string;
};

const markerFor = (i: number) => `[[PG${i}]]`;
const htmlFor = (i: number, totalBytes: number) =>
  markerFor(i) + "x".repeat(totalBytes - bytesOf(markerFor(i)));

function vmGlobals(extra: Record<string, unknown>) {
  return {
    URL: NodeURL,
    AbortController,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    ReadableStream,
    ...(typeof TextDecoderStream !== "undefined" ? { TextDecoderStream } : {}),
    fetch: extra.fetch,
    DOMParser: extra.DOMParser,
    document: extra.document,
    window: extra.window,
  };
}

function calendarBrowser(): Harness {
  const LIVE_IDS = [
    "events-view-status",
    "events-search-status",
    "events-past-status",
    "calendar-month-status",
  ];
  const form = new FNode("form");
  const input = Object.assign(new FNode("input"), { closest: () => form });
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
    dataset: { view: "list", month: "2026-10", past: "", loadError: LOAD_ERROR },
    querySelector(selector: string) {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-testid="events-search"]') return input;
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
  const location = {
    href: `${ORIGIN}/events`,
    origin: ORIGIN,
    assign: (_href: string) => {},
  };
  const requests: Req[] = [];
  const parseCalls: ParseCall[] = [];
  const makePage = (reqIndex: number) => {
    const url = new NodeURL(requests[reqIndex]!.url, ORIGIN);
    const sourceZones = zones.map((target) => {
      const node = new FNode();
      const name = target.getAttribute("data-cal-zone")!;
      node.setAttribute("data-cal-zone", name);
      node.childNodes = [`pg${reqIndex} ${name}`];
      return node;
    });
    const next = {
      dataset: {
        view: url.searchParams.get("view") ?? "list",
        month: url.searchParams.get("month") ?? "2026-10",
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
        if (LIVE_IDS.includes(id ?? "")) return { textContent: `live ${id}` };
        return null;
      },
    };
  };
  runInNewContext(
    binders["events-calendar"],
    vmGlobals({
      fetch(url: string, init: { signal: AbortSignal }) {
        const response = deferred<FakeResponse>();
        requests.push({ url, signal: init.signal, response });
        return response.promise;
      },
      DOMParser: class {
        parseFromString(html: string) {
          const m = /^\[\[PG(\d+)\]\]/.exec(html.slice(0, 32));
          const pageIndex = m ? Number(m[1]) : -1;
          parseCalls.push({
            bytes: bytesOf(html),
            html: html.length <= 100_000 ? html : null,
            pageIndex,
          });
          return makePage(pageIndex < 0 ? 0 : pageIndex);
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
          return input;
        },
        body: new FNode("body"),
      },
      window: {
        location,
        history: {
          pushState(_s: unknown, _t: string, path: string) {
            history.push(path);
            location.href = ORIGIN + path;
          },
        },
        addEventListener: () => {},
        TextDecoder,
        TextEncoder,
      },
    }),
    { filename: "public/islands/events-calendar.js" },
  );
  return {
    requests,
    parseCalls,
    history,
    navigate() {
      const link = new FNode("a");
      link.href = `${ORIGIN}/events?view=calendar&month=2026-11`;
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
    respond: (i, r) => requests[i]!.response.resolve(r),
    committed: () => history.length > 0,
    rejected: () => feedback.textContent === LOAD_ERROR,
    busy: () => root.attributes.has("aria-busy"),
    zoneChildren: () => zones.map((z) => [...z.childNodes]),
    canonicalNow: () => canonical.href,
  };
}

function pastBrowser(): Harness {
  const selectors = ["[data-archive-state]", "[data-archive-list]", "[data-archive-pager]"];
  const targets = selectors.map(() => new FNode());
  targets[1]!.childNodes = ["original cards"];
  const heading = new FNode("h1");
  const feedback = new FNode("p");
  const canonical = Object.assign(new FNode("link"), { href: `${ORIGIN}/events/past` });
  const og = Object.assign(new FNode("meta"), { content: canonical.href });
  const root = new FNode("section");
  root.dataset = { page: "1", totalPages: "2", query: "", loadError: LOAD_ERROR };
  let click!: (event: any) => void;
  const liveNode = (selector: string) =>
    selector === "h1"
      ? heading
      : selector === "[data-archive-feedback]"
        ? feedback
        : (targets[selectors.indexOf(selector)] ?? null);
  const mount = Object.assign(root, {
    querySelector: liveNode,
    querySelectorAll: (selector: string) => {
      const node = liveNode(selector);
      return node ? [node] : [];
    },
    addEventListener: (_type: string, listener: (event: any) => void) => {
      click = listener;
    },
    contains: () => true,
  });
  const history: string[] = [];
  const location = {
    href: `${ORIGIN}/events/past`,
    origin: ORIGIN,
    assign: (_href: string) => {},
  };
  const requests: Req[] = [];
  const parseCalls: ParseCall[] = [];
  const makePage = (reqIndex: number) => {
    const url = new NodeURL(requests[reqIndex]!.url, ORIGIN);
    const sources = selectors.map((sel) => {
      const node = new FNode();
      node.childNodes = [`pg${reqIndex} ${sel}`];
      return node;
    });
    const next = {
      dataset: { page: url.searchParams.get("page") ?? "1", totalPages: "2", query: "" },
      querySelectorAll: (selector: string) => [sources[selectors.indexOf(selector)]],
    };
    const nextCanonical = Object.assign(new FNode("link"), { href: url.href });
    const nextOg = Object.assign(new FNode("meta"), { content: url.href });
    const pageNode = (selector: string) =>
      selector.startsWith("link") ? nextCanonical : selector.startsWith("meta") ? nextOg : next;
    return {
      querySelector: pageNode,
      querySelectorAll: (selector: string) => [pageNode(selector)],
    };
  };
  runInNewContext(
    binders["past-events"],
    vmGlobals({
      fetch(url: string, init: { signal: AbortSignal }) {
        const response = deferred<FakeResponse>();
        requests.push({ url, signal: init.signal, response });
        return response.promise;
      },
      DOMParser: class {
        parseFromString(html: string) {
          const m = /^\[\[PG(\d+)\]\]/.exec(html.slice(0, 32));
          const pageIndex = m ? Number(m[1]) : -1;
          parseCalls.push({
            bytes: bytesOf(html),
            html: html.length <= 100_000 ? html : null,
            pageIndex,
          });
          return makePage(pageIndex < 0 ? 0 : pageIndex);
        }
      },
      document: {
        get activeElement() {
          return null;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: (selector: string) =>
          selector === '[data-island="past-events"]'
            ? mount
            : selector.startsWith("link")
              ? canonical
              : og,
        querySelectorAll: (selector: string) => [
          selector === '[data-island="past-events"]'
            ? mount
            : selector.startsWith("link")
              ? canonical
              : og,
        ],
        importNode: (node: unknown) => node,
      },
      window: {
        location,
        history: {
          pushState(_s: unknown, _t: string, path: string) {
            history.push(path);
            location.href = ORIGIN + path;
          },
        },
        addEventListener: () => {},
        TextDecoder,
        TextEncoder,
      },
    }),
    { filename: "public/islands/past-events.js" },
  );
  return {
    requests,
    parseCalls,
    history,
    navigate() {
      const link = {
        href: `${ORIGIN}/events/past?page=2`,
        target: "",
        hasAttribute: () => false,
      };
      click({
        defaultPrevented: false,
        button: 0,
        target: { closest: () => link },
        preventDefault() {},
      });
    },
    respond: (i, r) => requests[i]!.response.resolve(r),
    committed: () => history.length > 0,
    rejected: () => feedback.textContent === LOAD_ERROR,
    busy: () => root.attributes.has("aria-busy"),
    zoneChildren: () => targets.map((z) => [...z.childNodes]),
    canonicalNow: () => canonical.href,
  };
}

const browserFor = (island: Island): Harness =>
  island === "events-calendar" ? calendarBrowser() : pastBrowser();

async function expectRejectedClean(b: Harness, before: unknown, canonicalBefore: string) {
  expect(await until(() => b.rejected())).toBe(true);
  await settle();
  expect(b.parseCalls).toEqual([]);
  expect(b.zoneChildren()).toEqual(before);
  expect(b.history).toEqual([]);
  expect(b.canonicalNow()).toBe(canonicalBefore);
  expect(b.busy()).toBe(false);
}

async function expectCommitted(b: Harness) {
  expect(await until(() => b.committed())).toBe(true);
  await settle();
  expect(b.rejected()).toBe(false);
  expect(b.busy()).toBe(false);
  expect(b.parseCalls).toHaveLength(1);
}

// Behavioral cap discovery: largest accepted byte length per island.
async function probe(island: Island, totalBytes: number): Promise<"commit" | "reject"> {
  const b = browserFor(island);
  b.navigate();
  const { response } = streamedResponse(encoder.encode(htmlFor(0, totalBytes)), {
    chunkSize: 262_144,
  });
  b.respond(0, response);
  const done = await until(() => b.committed() || b.rejected());
  expect(done).toBe(true);
  return b.committed() ? "commit" : "reject";
}

const capCache = new Map<Island, Promise<number>>();
function discoverCap(island: Island): Promise<number> {
  const cached = capCache.get(island);
  if (cached) return cached;
  const found = (async () => {
    expect(await probe(island, 1024)).toBe("commit");
    let lo = 1024;
    let hi: number | null = null;
    for (const size of [16_384, 65_536, 262_144, 1_048_576, CAP_CEILING]) {
      if ((await probe(island, size)) === "commit") lo = size;
      else {
        hi = size;
        break;
      }
    }
    if (hi === null) {
      throw new Error(`${island}: no finite HTML byte cap at or under ${CAP_CEILING} bytes`);
    }
    let upper: number = hi;
    while (upper - lo > 1) {
      const mid = (lo + upper) >> 1;
      if ((await probe(island, mid)) === "commit") lo = mid;
      else upper = mid;
    }
    return lo;
  })();
  capCache.set(island, found);
  return found;
}

describe.each(ISLANDS)("%s discovery read byte cap", (island) => {
  it("CTRL-01 a small streamed page still commits", async () => {
    const b = browserFor(island);
    b.navigate();
    b.respond(0, streamedResponse(encoder.encode(htmlFor(0, 2048))).response);
    await expectCommitted(b);
  });

  it("CTRL-02 multibyte characters split across 1-byte chunks decode exactly", async () => {
    const b = browserFor(island);
    const html = `${markerFor(0)}café 🎲 naïve — “quoted”`;
    b.navigate();
    b.respond(0, streamedResponse(encoder.encode(html), { chunkSize: 1 }).response);
    await expectCommitted(b);
    expect(b.parseCalls[0]!.html).toBe(html);
  });

  it("CTRL-03 a superseded late oversize settlement cannot displace the current commit", async () => {
    const b = browserFor(island);
    b.navigate();
    b.navigate();
    expect(b.requests).toHaveLength(2);
    b.respond(1, streamedResponse(encoder.encode(htmlFor(1, 2048))).response);
    expect(await until(() => b.committed())).toBe(true);
    await settle();
    const zonesAfterCommit = b.zoneChildren();
    const historyAfterCommit = [...b.history];
    b.respond(0, streamedResponse(encoder.encode(htmlFor(0, CAP_CEILING + 1))).response);
    await settle(12);
    expect(b.zoneChildren()).toEqual(zonesAfterCommit);
    expect(b.history).toEqual(historyAfterCommit);
    expect(b.rejected()).toBe(false);
    expect(b.parseCalls.map((c) => c.pageIndex)).toEqual([1]);
  });

  it("CAP-01 exposes one finite byte cap at or under the ceiling", async () => {
    const cap = await discoverCap(island);
    expect(cap).toBeGreaterThan(1024);
    expect(cap).toBeLessThanOrEqual(CAP_CEILING);
  });

  it("CAP-02 accepts exactly the cap and rejects one byte over, before parsing", async () => {
    const cap = await discoverCap(island);
    const exact = browserFor(island);
    exact.navigate();
    exact.respond(0, streamedResponse(encoder.encode(htmlFor(0, cap))).response);
    await expectCommitted(exact);
    expect(exact.parseCalls[0]!.bytes).toBe(cap);

    const over = browserFor(island);
    const before = over.zoneChildren();
    const canonicalBefore = over.canonicalNow();
    over.navigate();
    over.respond(0, streamedResponse(encoder.encode(htmlFor(0, cap + 1))).response);
    await expectRejectedClean(over, before, canonicalBefore);
    expect(over.requests).toHaveLength(1); // no automatic retry
  });

  it("CAP-03 rejects a body over the ceiling without touching zones, history or canonical", async () => {
    const b = browserFor(island);
    const before = b.zoneChildren();
    const canonicalBefore = b.canonicalNow();
    b.navigate();
    b.respond(0, streamedResponse(encoder.encode(htmlFor(0, CAP_CEILING + 1))).response);
    await expectRejectedClean(b, before, canonicalBefore);
    await settle(12);
    expect(b.requests).toHaveLength(1);
  });

  it("CAP-04 counts UTF-8 bytes, not characters, at the boundary", async () => {
    const cap = await discoverCap(island);
    // Byte length exactly at the cap, rich in 2-byte characters, odd chunking.
    const head = `${markerFor(0)}${"é".repeat(1000)}`;
    const exactBytes = head + "x".repeat(cap - bytesOf(head));
    expect(bytesOf(exactBytes)).toBe(cap);
    const under = browserFor(island);
    under.navigate();
    under.respond(0, streamedResponse(encoder.encode(exactBytes), { chunkSize: 8191 }).response);
    await expectCommitted(under);

    // Character length at or under the cap, byte length over it: must reject.
    const m = Math.floor((cap - bytesOf(markerFor(0))) / 2) + 1;
    const wide = markerFor(0) + "é".repeat(m);
    expect(wide.length).toBeLessThanOrEqual(cap);
    expect(bytesOf(wide)).toBeGreaterThan(cap);
    const over = browserFor(island);
    const before = over.zoneChildren();
    const canonicalBefore = over.canonicalNow();
    over.navigate();
    over.respond(0, streamedResponse(encoder.encode(wide)).response);
    await expectRejectedClean(over, before, canonicalBefore);
  });

  it("CAP-05 ignores a lying or missing Content-Length and enforces actual bytes", async () => {
    for (const contentLength of ["10", null, "99999999"]) {
      const b = browserFor(island);
      const before = b.zoneChildren();
      const canonicalBefore = b.canonicalNow();
      b.navigate();
      b.respond(
        0,
        streamedResponse(encoder.encode(htmlFor(0, CAP_CEILING + 1)), { contentLength }).response,
      );
      await expectRejectedClean(b, before, canonicalBefore);
    }
  });

  it("CAP-06 cancels an overflowing stream promptly instead of draining or waiting", async () => {
    const cap = await discoverCap(island);
    const b = browserFor(island);
    const before = b.zoneChildren();
    b.navigate();
    const { response, stats, close } = streamedResponse(encoder.encode(htmlFor(0, cap + 262_144)), {
      chunkSize: CHUNK,
      hangAtEnd: true,
    });
    b.respond(0, response);
    // No clock advance: overflow must settle from the bytes alone, long
    // before the owned 10s read deadline could fire.
    const settledPromptly = await until(() => b.rejected(), 60);
    const pulled = stats.pulledBytes;
    const cancelled = stats.cancelled;
    const aborted = b.requests[0]!.signal.aborted;
    const parsed = b.parseCalls.length;
    close();
    await settle();
    expect(settledPromptly).toBe(true);
    expect(cancelled || aborted).toBe(true);
    expect(pulled).toBeLessThanOrEqual(cap + 2 * CHUNK);
    expect(pulled).toBeLessThan(cap + 262_144);
    expect(parsed).toBe(0);
    expect(b.zoneChildren()).toEqual(before);
    expect(b.history).toEqual([]);
    expect(b.busy()).toBe(false);
  });

  it("CAP-07 rejects an oversize body on the body-less buffered path before parsing", async () => {
    const b = browserFor(island);
    const before = b.zoneChildren();
    const canonicalBefore = b.canonicalNow();
    b.navigate();
    b.respond(0, bufferedResponse(htmlFor(0, CAP_CEILING + 1)));
    await expectRejectedClean(b, before, canonicalBefore);
  });

  it("CAP-07b still commits a small body on the body-less buffered path", async () => {
    const b = browserFor(island);
    b.navigate();
    b.respond(0, bufferedResponse(htmlFor(0, 2048)));
    await expectCommitted(b);
  });

  it("CAP-08 releases ownership after an oversize rejection so an explicit next read works", async () => {
    const b = browserFor(island);
    b.navigate();
    b.respond(0, streamedResponse(encoder.encode(htmlFor(0, CAP_CEILING + 1))).response);
    expect(await until(() => b.rejected())).toBe(true);
    await settle();
    expect(b.busy()).toBe(false);
    b.navigate();
    expect(b.requests).toHaveLength(2);
    b.respond(1, streamedResponse(encoder.encode(htmlFor(1, 2048))).response);
    expect(await until(() => b.committed())).toBe(true);
    expect(b.parseCalls.map((c) => c.pageIndex)).toEqual([1]);
  });
});

describe("shared cap and real fixture fit", () => {
  it("CAP-09 uses the same cap on both islands and fits the largest real Hono pages", async () => {
    const [calendarCap, pastCap] = await Promise.all(ISLANDS.map((i) => discoverCap(i)));
    expect(calendarCap).toBe(pastCap);

    const measured = await measureLargestRealPages();
    // The fixtures must be the real island pages, not error documents.
    expect(measured.eventsHtml).toContain('data-island="events-calendar"');
    expect(measured.pastHtml).toContain('data-island="past-events"');
    expect(calendarCap).toBeGreaterThanOrEqual(bytesOf(measured.eventsHtml));
    expect(pastCap).toBeGreaterThanOrEqual(bytesOf(measured.pastHtml));
    // And behaviorally: a body the size of the largest measured page commits.
    const largest = Math.max(bytesOf(measured.eventsHtml), bytesOf(measured.pastHtml));
    for (const island of ISLANDS) {
      expect(await probe(island, largest)).toBe("commit");
    }
  });
});

// ---------------------------------------------------------------------------
// Largest representative real Hono pages: maximal-length event fields (title
// 100, game 100, description 1000, location 255 chars, per the admin form
// caps) in 2-byte UTF-8, rendered by the real routes on a pg-proxy fake.
// The Kit /events surface renders this same Hono screen (renderEventsHtml)
// and both Kit pages load these same island files, so the Hono byte counts
// are the representative fit floor for both deployments.
// ---------------------------------------------------------------------------
const ACCENT = "é";
function maximalRow(n: number, start: Date, status = "published"): typeof events.$inferSelect {
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `ev-${n}`,
    title: `${ACCENT.repeat(96)}${n}`.slice(0, 100),
    game: ACCENT.repeat(100),
    description: ACCENT.repeat(1000),
    startsAt: start,
    endsAt: new Date(start.getTime() + 7200_000),
    timezone: "Europe/London",
    location: ACCENT.repeat(255),
    capacity: 10,
    status,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
  };
}

function fixtureDb(rows: (typeof events.$inferSelect)[]): Db {
  const cols = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: typeof events.$inferSelect) =>
    cols.map((k) => {
      const v = row[k];
      return v instanceof Date ? v.toISOString() : v;
    });
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select distinct trim("game") from "events"')) {
      return { rows: [[ACCENT.repeat(100)]] };
    }
    if (sql.startsWith('select "discord_event_id" from "events"')) return { rows: [] };
    if (/^select count/i.test(sql)) return { rows: [[rows.length]] };
    const hasOffset = sql.includes(" offset ");
    const offset = hasOffset ? Number(params.at(-1)) : 0;
    const limit = Number(params.at(hasOffset ? -2 : -1));
    const slice = Number.isFinite(limit) && limit > 0 ? rows.slice(offset, offset + limit) : rows;
    return { rows: slice.map(encode) };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) =>
      fn({
        execute: async () => {},
        insert: () => ({ values: async () => {} }),
      } as unknown as Db),
  });
  return db as unknown as Db;
}

async function measureLargestRealPages() {
  const pastRows = Array.from({ length: 60 }, (_, i) =>
    maximalRow(i + 1, new Date(Date.UTC(2020, 0, i + 1)), "past"),
  );
  const pastEnv = {
    APP_URL: "https://next.example.test",
    ADMIN_DB: fixtureDb(pastRows),
  } as unknown as Env;
  const pastRes = await app.request("/events/past?page=1", {}, pastEnv);
  expect(pastRes.status).toBe(200);
  const pastHtml = await pastRes.text();

  const upcomingRows = Array.from({ length: 60 }, (_, i) =>
    maximalRow(i + 1, new Date(Date.UTC(2030, 0, (i % 28) + 1, 20))),
  );
  const okSource: DiscordEventsSource = {
    upcoming: async () => [],
    lastReadFailed: () => false,
  };
  const eventsEnv = {
    APP_URL: "https://next.example.test",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    ADMIN_DB: fixtureDb(upcomingRows),
    DISCORD_EVENTS: okSource,
  } as unknown as Env;
  let eventsHtml = "";
  for (const path of ["/events", "/events?view=calendar&month=2030-01", "/events?past=1"]) {
    const res = await app.request(path, {}, eventsEnv);
    expect(res.status).toBe(200);
    const html = await res.text();
    if (bytesOf(html) > bytesOf(eventsHtml)) eventsHtml = html;
  }
  return { eventsHtml, pastHtml };
}
