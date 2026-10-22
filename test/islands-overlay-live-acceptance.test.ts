// Acceptance: the overlay-live island polls GET /o/:token/data every 20s
// with one bounded retry and renders the allowlisted payload as text.
//
// Contract under test (the Builder implements to this file):
// - Mount: [data-island="overlay-live"] carrying data-token. Without a token
//   the island schedules nothing and fetches nothing.
// - Cadence: one immediate fetch on mount, then one fetch every 20s. No
//   polling timer may run faster than 20s (bandwidth cap); evaluating the
//   script twice must not double-schedule.
// - Validators: the island stores the 200's ETag and sends it back as
//   If-None-Match. A 304 writes nothing to the DOM.
// - Render targets: [data-overlay-field="display-name"] and
//   [data-overlay-field="live-line"] take textContent from
//   identity.display_name and live_line.text; [data-overlay-field="avatar"]
//   takes src from identity.avatar_url. Member text is never parsed as HTML:
//   no innerHTML write may ever happen. Fields the config turns off (or a
//   null avatar URL) hide via the hidden attribute.
// - Retry: a transport failure or 500 gets exactly one retry on a bounded
//   timer (0 < delay <= 20s), then silence until the next 20s tick. 404/429
//   get at most one retry per tick: never a retry storm.
//
// Hermetic fixture contract (no browser, network or database):
// - Each case evaluates one island copy in a fresh VM with a pumped fake
//   clock (timers fire only via advance()), a scripted fetch stub, and the
//   DOM surface above plus standard globals (URL, Headers, AbortController,
//   TextEncoder...). DOMContentLoaded listeners the island registers fire
//   synchronously right after evaluation.
// - Both the island source under assets/ and the built copy under public/
//   must satisfy the suite, so the slice is only complete once the built
//   assets are regenerated from the source (npm run build:assets).
import { existsSync, readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { POLLING } from "../src/islands/contracts-shared";

const SOURCES = [
  { label: "assets source", rel: "../assets/islands/overlay-live.js" },
  { label: "built public copy", rel: "../public/islands/overlay-live.js" },
] as const;

const TOKEN = `two_ov_${"a".repeat(43)}`;

function requireIslandSource(rel: string): { source: string; filename: string } {
  const url = new NodeURL(rel, import.meta.url);
  expect(
    existsSync(url),
    `overlay-live island is not implemented yet (slice 3): missing ${rel}`,
  ).toBe(true);
  return { source: readFileSync(url, "utf8"), filename: rel.replace(/^\.\.\//, "") };
}

type Payload = {
  identity: { display_name: string; avatar_url: string | null };
  live_line: { source: string; text: string };
  event: { title: string; starts_at: string } | null;
  config: { elements: Record<string, unknown>; theme: Record<string, unknown> };
};

function makePayload(overrides: Partial<Payload> = {}): Payload {
  return {
    identity: {
      display_name: "Overlay Streamer",
      avatar_url: "https://cdn.discordapp.com/avatars/1/a.png",
    },
    live_line: { source: "event", text: "Next: Game Night" },
    event: { title: "Game Night", starts_at: "2099-03-10T20:00:00Z" },
    config: {
      elements: {
        show_identity: true,
        show_avatar: true,
        show_live_line: true,
        live_line_mode: "event",
        custom_text: null,
        layout: "compact",
      },
      theme: { preset: "dark-translucent", accent: "gold" },
    },
    ...overrides,
  };
}

type FetchScript =
  | { status: number; etag?: string; json?: unknown }
  | { transportError: true }
  | { never: true };

type RecordedRequest = { url: string; init: unknown };

class StubElement {
  attributes = new Map<string, string>();
  children: StubElement[] = [];
  innerHtmlWrites: string[] = [];
  writeCount = 0;
  listeners = new Map<string, ((event: unknown) => void)[]>();
  #text = "";
  #hidden = false;
  #src = "";

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) this.attributes.set(name, value);
  }

  get textContent() {
    return this.#text;
  }
  set textContent(value: string) {
    this.writeCount += 1;
    this.#text = String(value);
  }
  get hidden() {
    return this.#hidden;
  }
  set hidden(value: boolean) {
    this.writeCount += 1;
    this.#hidden = Boolean(value);
  }
  get src() {
    return this.#src;
  }
  set src(value: string) {
    this.writeCount += 1;
    this.#src = String(value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  get innerHTML() {
    return "";
  }
  set innerHTML(value: string) {
    this.innerHtmlWrites.push(String(value));
  }
  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): StubElement[] {
    const out: StubElement[] = [];
    const match = /^\[data-overlay-field="([^"]+)"\]$/.exec(selector);
    const walk = (el: StubElement) => {
      for (const child of el.children) {
        if (match && child.getAttribute("data-overlay-field") === match[1]) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
}

type BrowserOpts = {
  token?: string | null;
  script?: (call: number, url: string, init: unknown) => FetchScript;
  evalTwice?: boolean;
};

function headerOf(init: unknown, name: string): string | null {
  const headers = (init as { headers?: unknown } | null)?.headers;
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function")
    return (headers as { get: (n: string) => string | null }).get(name);
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) return String(value);
    }
  }
  return null;
}

// Loads one island copy against a stub overlay mount and returns the recorded
// requests, a pumped clock, and the field nodes.
function browser(source: string, filename: string, opts: BrowserOpts = {}) {
  const requests: RecordedRequest[] = [];
  const consoleNoise: string[] = [];
  const mount = new StubElement({
    "data-island": "overlay-live",
    ...(opts.token === null ? {} : { "data-token": opts.token ?? TOKEN }),
  });
  const displayName = new StubElement({ "data-overlay-field": "display-name" });
  const liveLine = new StubElement({ "data-overlay-field": "live-line" });
  const avatar = new StubElement({ "data-overlay-field": "avatar" });
  mount.children.push(displayName, liveLine, avatar);

  type Timer = { id: number; due: number; fn: (...args: unknown[]) => void; repeat: number | null };
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, Timer>();
  const delaysSeen: { kind: "timeout" | "interval"; delay: number }[] = [];
  const schedule = (
    kind: "timeout" | "interval",
    fn: (...args: unknown[]) => void,
    delay: number,
  ) => {
    const id = ++nextTimer;
    timers.set(id, { id, due: now + delay, fn, repeat: kind === "interval" ? delay : null });
    delaysSeen.push({ kind, delay });
    return id;
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let next: Timer | null = null;
      for (const timer of timers.values()) {
        if (timer.due <= target && (!next || timer.due < next.due)) next = timer;
      }
      if (!next) break;
      const fired: Timer = next;
      timers.delete(fired.id);
      now = fired.due;
      if (fired.repeat !== null) timers.set(fired.id, { ...fired, due: now + fired.repeat });
      fired.fn();
    }
    now = target;
  };

  const script =
    opts.script ?? (() => ({ status: 200, etag: '"island-etag-1"', json: makePayload() }));
  let calls = 0;
  const fetchStub = (url: string, init: unknown) => {
    calls += 1;
    requests.push({ url: String(url), init });
    const spec = script(calls, String(url), init);
    if ("transportError" in spec) return Promise.reject(new Error("transport down"));
    if ("never" in spec) return new Promise(() => {});
    const headers = new Map<string, string>();
    if (spec.etag) headers.set("etag", spec.etag);
    headers.set("content-type", "application/json");
    return Promise.resolve({
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => spec.json ?? {},
      text: async () => JSON.stringify(spec.json ?? {}),
    });
  };

  const documentListeners = new Map<string, ((event: unknown) => void)[]>();
  const sandbox: Record<string, unknown> = {
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    Headers,
    TextEncoder,
    TextDecoder,
    queueMicrotask,
    console: {
      log: () => {},
      info: () => {},
      warn: (message?: unknown) => {
        consoleNoise.push(`warn: ${String(message)}`);
      },
      error: (message?: unknown) => {
        consoleNoise.push(`error: ${String(message)}`);
      },
    },
    setTimeout: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      schedule("timeout", () => fn(...args), delay ?? 0),
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    setInterval: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      schedule("interval", () => fn(...args), delay ?? 0),
    clearInterval: (id: number) => {
      timers.delete(id);
    },
    location: {
      origin: "https://overlay.example.test",
      pathname: `/o/${TOKEN}`,
      href: `https://overlay.example.test/o/${TOKEN}`,
    },
    document: {
      readyState: "complete",
      documentElement: new StubElement(),
      querySelector: (selector: string) =>
        selector === '[data-island="overlay-live"]' ? mount : mount.querySelector(selector),
      querySelectorAll: (selector: string) =>
        selector === '[data-island="overlay-live"]' ? [mount] : mount.querySelectorAll(selector),
      getElementById: (_id: string) => null,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const list = documentListeners.get(type) ?? [];
        list.push(listener);
        documentListeners.set(type, list);
      },
    },
    fetch: fetchStub,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(source, context, { filename });
  if (opts.evalTwice) runInContext(source, context, { filename });
  // A readyState-complete document fires DOMContentLoaded listeners the
  // island registered during evaluation, synchronously.
  for (const listener of documentListeners.get("DOMContentLoaded") ?? []) listener({});

  const flush = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };

  return {
    requests,
    delaysSeen,
    consoleNoise,
    nodes: { mount, displayName, liveLine, avatar },
    headerOfRequest: (index: number, name: string) => headerOf(requests[index]?.init, name),
    requestPath: (index: number) =>
      new URL(requests[index]!.url, "https://overlay.example.test").pathname,
    advance,
    flush,
    domWrites: () =>
      [displayName, liveLine, avatar].reduce(
        (sum, node) => sum + node.writeCount + node.innerHtmlWrites.length,
        0,
      ),
    innerHtmlWrites: () => [displayName, liveLine, avatar].flatMap((node) => node.innerHtmlWrites),
  };
}

describe("overlay-live island contract", () => {
  it("documents the 20s poll carve-out in the shared island contracts", () => {
    const entry = (
      POLLING as Record<string, { pollMs: number | null; reason: string } | undefined>
    )["overlay-live"];
    expect(
      entry,
      "overlay-live must add its pollMs carve-out to POLLING in src/islands/contracts-shared.ts",
    ).toBeDefined();
    expect(entry!.pollMs).toBe(20_000);
    expect(entry!.reason.length).toBeGreaterThan(20);
  });

  it("covers the built island with a bundle budget", () => {
    const budget = JSON.parse(
      readFileSync(new NodeURL("../ci/bundle-budget.json", import.meta.url), "utf8"),
    ) as { budgets: Record<string, { maxRawBytes: number; maxGzipBytes: number } | undefined> };
    const entry = budget.budgets["public/islands/overlay-live.js"];
    expect(
      entry,
      "ci/bundle-budget.json must budget public/islands/overlay-live.js (every served island needs a ceiling)",
    ).toBeDefined();
    expect(entry!.maxRawBytes).toBeGreaterThan(0);
    expect(entry!.maxGzipBytes).toBeGreaterThan(0);
  });
});

describe.each(SOURCES)("overlay-live polling ($label)", ({ rel }) => {
  const load = () => requireIslandSource(rel);

  it("fetches the token data URL immediately on mount", async () => {
    const { source, filename } = load();
    const page = browser(source, filename);
    await page.flush();
    expect(page.requests).toHaveLength(1);
    expect(page.requestPath(0)).toBe(`/o/${TOKEN}/data`);
    expect(page.consoleNoise).toEqual([]);
  });

  it("polls again exactly 20s later, never sooner", async () => {
    const { source, filename } = load();
    const page = browser(source, filename);
    await page.flush();
    expect(page.requests).toHaveLength(1);
    page.advance(19_999);
    await page.flush();
    expect(page.requests).toHaveLength(1);
    page.advance(1);
    await page.flush();
    expect(page.requests).toHaveLength(2);
    expect(page.requestPath(1)).toBe(`/o/${TOKEN}/data`);
    // Mechanism-agnostic: setInterval or chained setTimeout both schedule a
    // 20s step, and no repeat timer may run faster (bandwidth cap).
    expect(page.delaysSeen.map((timer) => timer.delay)).toContain(20_000);
    for (const timer of page.delaysSeen) {
      if (timer.kind === "interval") expect(timer.delay).toBeGreaterThanOrEqual(20_000);
    }
  });

  it("keeps polling on the 20s cadence across ticks", async () => {
    const { source, filename } = load();
    const page = browser(source, filename);
    await page.flush();
    page.advance(60_000);
    await page.flush();
    expect(page.requests).toHaveLength(4);
    for (const index of [0, 1, 2, 3]) expect(page.requestPath(index)).toBe(`/o/${TOKEN}/data`);
  });

  it("sends If-None-Match from the last ETag and writes nothing on 304", async () => {
    const { source, filename } = load();
    const page = browser(source, filename, {
      script: (call) =>
        call === 1
          ? { status: 200, etag: '"overlay-etag-a"', json: makePayload() }
          : { status: 304 },
    });
    await page.flush();
    page.advance(20_000);
    await page.flush();
    expect(page.requests).toHaveLength(2);
    expect(page.headerOfRequest(1, "if-none-match")).toBe('"overlay-etag-a"');
    const writesAfter200 = page.domWrites();
    expect(writesAfter200).toBeGreaterThan(0);
    page.advance(20_000);
    await page.flush();
    expect(page.requests).toHaveLength(3);
    expect(page.headerOfRequest(2, "if-none-match")).toBe('"overlay-etag-a"');
    expect(page.domWrites()).toBe(writesAfter200);
  });

  it("renders identity and live-line text plus the avatar from a 200", async () => {
    const { source, filename } = load();
    const payload = makePayload({
      identity: {
        display_name: "Night Streamer",
        avatar_url: "https://cdn.discordapp.com/avatars/9/zzz.png",
      },
      live_line: { source: "custom", text: "custom line renders here" },
    });
    const page = browser(source, filename, {
      script: () => ({ status: 200, etag: '"overlay-etag-b"', json: payload }),
    });
    await page.flush();
    expect(page.nodes.displayName.textContent).toBe("Night Streamer");
    expect(page.nodes.liveLine.textContent).toBe("custom line renders here");
    expect(page.nodes.avatar.src).toBe("https://cdn.discordapp.com/avatars/9/zzz.png");
    expect(page.innerHtmlWrites()).toEqual([]);
  });

  it("updates the DOM when a later poll carries changed bytes", async () => {
    const { source, filename } = load();
    const page = browser(source, filename, {
      script: (call) =>
        call === 1
          ? {
              status: 200,
              etag: '"overlay-etag-old"',
              json: makePayload({ live_line: { source: "custom", text: "old line" } }),
            }
          : {
              status: 200,
              etag: '"overlay-etag-new"',
              json: makePayload({ live_line: { source: "custom", text: "new line" } }),
            },
    });
    await page.flush();
    expect(page.nodes.liveLine.textContent).toBe("old line");
    page.advance(20_000);
    await page.flush();
    expect(page.nodes.liveLine.textContent).toBe("new line");
  });

  it("renders member text as text even when it carries markup", async () => {
    const { source, filename } = load();
    const evil = `<img src=x onerror="alert(1)">live & loud`;
    const page = browser(source, filename, {
      script: () =>
        ({
          status: 200,
          etag: '"overlay-etag-evil"',
          json: makePayload({ live_line: { source: "custom", text: evil } }),
        }) as FetchScript,
    });
    await page.flush();
    expect(page.nodes.liveLine.textContent).toBe(evil);
    expect(page.innerHtmlWrites()).toEqual([]);
  });

  it("retries exactly once after a transport failure, then waits for the tick", async () => {
    const { source, filename } = load();
    const page = browser(source, filename, {
      script: (call) =>
        call <= 2
          ? { transportError: true }
          : { status: 200, etag: '"overlay-etag-r"', json: makePayload() },
    });
    await page.flush();
    expect(page.requests).toHaveLength(1);
    // Exactly one retry strictly before the tick: the failed retry schedules
    // no second retry, and the cadence resumes at 20s.
    page.advance(19_999);
    await page.flush();
    expect(page.requests).toHaveLength(2);
    const retryDelay = page.delaysSeen.find((timer) => timer.delay > 0 && timer.delay < 20_000);
    expect(retryDelay, "the retry must fire strictly before the next tick").toBeDefined();
    page.advance(1);
    await page.flush();
    expect(page.requests).toHaveLength(3);
    expect(page.requestPath(2)).toBe(`/o/${TOKEN}/data`);
  });

  it("retries exactly once after a 500", async () => {
    const { source, filename } = load();
    const page = browser(source, filename, {
      script: (call) =>
        call === 1
          ? { status: 500 }
          : { status: 200, etag: '"overlay-etag-500"', json: makePayload() },
    });
    await page.flush();
    expect(page.requests).toHaveLength(1);
    page.advance(19_999);
    await page.flush();
    expect(page.requests).toHaveLength(2);
    expect(page.headerOfRequest(1, "if-none-match")).toBeNull();
    page.advance(1);
    await page.flush();
    expect(page.requests).toHaveLength(3);
  });

  it.each([404, 429])("fires at most two fetches per tick on %s", async (status) => {
    const { source, filename } = load();
    const page = browser(source, filename, { script: () => ({ status }) });
    await page.flush();
    expect(page.requests.length).toBeLessThanOrEqual(2);
    page.advance(20_000);
    await page.flush();
    // One tick later: at most two more fetches, never a retry storm.
    expect(page.requests.length).toBeLessThanOrEqual(4);
    page.advance(20_000);
    await page.flush();
    expect(page.requests.length).toBeLessThanOrEqual(6);
  });

  it("hides fields the config turns off and a null avatar", async () => {
    const { source, filename } = load();
    const page = browser(source, filename, {
      script: () => ({
        status: 200,
        etag: '"overlay-etag-hide"',
        json: makePayload({
          identity: { display_name: "Hidden Streamer", avatar_url: null },
          config: {
            elements: {
              show_identity: false,
              show_avatar: true,
              show_live_line: true,
              live_line_mode: "event",
              custom_text: null,
              layout: "compact",
            },
            theme: { preset: "dark-translucent", accent: "gold" },
          },
        }),
      }),
    });
    await page.flush();
    expect(page.nodes.displayName.hidden).toBe(true);
    expect(page.nodes.liveLine.hidden).toBe(false);
    expect(page.nodes.avatar.hidden).toBe(true);
  });

  it("schedules nothing and fetches nothing without a token", async () => {
    const { source, filename } = load();
    const page = browser(source, filename, { token: null });
    await page.flush();
    page.advance(60_000);
    await page.flush();
    expect(page.requests).toHaveLength(0);
    expect(page.delaysSeen).toHaveLength(0);
  });

  it("does not double-schedule when evaluated twice", async () => {
    const { source, filename } = load();
    const page = browser(source, filename, { evalTwice: true });
    await page.flush();
    page.advance(20_000);
    await page.flush();
    expect(page.requests).toHaveLength(2);
  });
});
