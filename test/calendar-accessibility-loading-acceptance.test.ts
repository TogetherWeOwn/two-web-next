// Calendar accessibility acceptance: member-started loading is announced.
// DB-free: shipped island binder in an isolated VM (no copied load logic) plus
// real SSR shells for host placement. Base:
// 0f8fdd17f21abe7d0f7c015001b9415b180efe99 — the skeleton is unannounced
// (src/events/pages-calendar-screen.tsx:265-271) and the binder owns only the
// aria-busy toggle (assets/islands/events-calendar.js:227-233), so the
// loading-announcement assertions below FAIL first. Busy-toggle, last-good,
// history, recovery and filter assertions PASS on the same base and must stay
// green after the build.
//
// Contract under test (TOG-42589 item U7):
// - Member-started loading is exposed through an existing suitable status host
//   outside suppressed busy content; the already-owned busy toggle is
//   preserved, not duplicated. No every-keystroke announcements. The current
//   success/failure/abort/supersession clears or replaces only its own loading
//   message.
// - Focus/retry/last-good DOM/history/filter contracts and no-JS behavior are
//   preserved (focus pins live in islands-calendar-keyboard-focus; history,
//   recovery and filter pins below are the unchanged controls).
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { EventsCalendarPage } from "../src/events/pages";
import {
  EVENTS_CALENDAR_READ_DEADLINE_MS,
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_LOADING_COPY,
  type CalendarEmptyState,
  type CalendarState,
} from "../src/islands/contracts";

const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const APP_URL = "https://calendar.example.test";
const MOUNT = '[data-island="events-calendar"]';
// Existing suitable status hosts: the four sr-only live lines plus the search
// feedback line. All render outside the swapped zones in SSR (pinned below),
// so a loading message there survives the content-zone hide. The read-status
// host is failure-only and must stay empty during loading.
const LIVE_IDS = [
  "events-view-status",
  "events-search-status",
  "events-past-status",
  "calendar-month-status",
] as const;
const READ_DEADLINE_MS = EVENTS_CALENDAR_READ_DEADLINE_MS;

class Node {
  tag = "div";
  hidden = false;
  disabled = false;
  textContent = "";
  value = "";
  href = "";
  focused = false;
  childNodes: unknown[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: any) => void>();
  constructor(tag = "div") {
    this.tag = tag;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
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
  focus() {
    this.focused = true;
  }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, listener);
  }
  closest(selector: string): unknown {
    if (selector === "a") return this.tag === "a" ? this : null;
    if (selector === "form") return this.tag === "form" ? this : null;
    return null;
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

type IslandResponse = { ok: boolean; text(): Promise<string> };

function gameSelect(initial = "") {
  const options = ["", "Chess", "Factorio"].map((value) => ({ value }));
  const node = new Node("select");
  node.setAttribute("name", "game");
  let current = initial;
  Object.defineProperty(node, "value", {
    get: () => current,
    set: (v: string) => {
      current = v;
    },
  });
  (node as unknown as { options: { value: string }[] }).options = options;
  return node;
}

function createZones(content: string) {
  return ["head", "actions", "miss", "content"].map((name) => {
    const zone = new Node();
    zone.setAttribute("data-cal-zone", name);
    zone.childNodes = [name === "content" ? content : name];
    return zone;
  });
}

// Shipped-binder VM: fetches ignore abort so obsolete completions exercise
// ownership, not transport luck. Initial live texts mirror list-view SSR.
function browser() {
  const zones = createZones("last-good content");
  const content = zones[3]!;
  const skeleton = new Node();
  skeleton.hidden = true;
  skeleton.textContent = EVENTS_LOADING_COPY;
  const feedback = new Node();
  const form = new Node("form");
  const input = Object.assign(new Node("input"), { closest: () => form });
  const gameField = gameSelect("");
  const live = Object.fromEntries(LIVE_IDS.map((id) => [id, new Node()])) as Record<string, Node>;
  live["events-view-status"]!.textContent = "Showing events as a list.";
  const retry = new Node("button");
  retry.hidden = true;
  const clearRead = new Node("button");
  clearRead.hidden = true;
  const readStatus = new Node();
  const root = Object.assign(new Node("section"), {
    querySelector(selector: string) {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === '[data-testid="events-search"]') return input;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-cal-zone="content"]') return content;
      if (selector === '[data-testid="events-read-retry"]') return retry;
      if (selector === '[data-testid="events-read-clear"]') return clearRead;
      if (selector === '[data-testid="events-read-status"]') return readStatus;
      if (selector === 'select[name="game"]') return gameField;
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
      return id ? (live[id] ?? null) : null;
    },
    querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? zones : []),
    contains: () => true,
  });
  root.dataset = {
    view: "list",
    month: "2026-10",
    past: "",
    loadError: EVENTS_CALENDAR_FETCH_FAILED,
    searchMaxLength: "255",
    searchTooLong: "Search query must be 255 characters or fewer.",
  };
  const canonical = { href: `${APP_URL}/events` };
  const og = { content: canonical.href };
  const history: string[] = [];
  const reloads: string[] = [];
  const location = {
    href: canonical.href,
    origin: APP_URL,
    assign: (href: string) => reloads.push(href),
  };
  const requests: {
    url: string;
    signal: AbortSignal;
    read: ReturnType<typeof deferred<IslandResponse>>;
  }[] = [];
  const pages = new Map<string, unknown>();
  const timers = new Map<number, { ms: number; callback: () => void }>();
  let nextTimer = 0;
  runInNewContext(
    binder,
    {
      URL,
      AbortController,
      setTimeout(callback: () => void, ms: number) {
        expect([300, READ_DEADLINE_MS]).toContain(ms);
        timers.set(++nextTimer, { ms, callback });
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
      document: {
        querySelector: (selector: string) =>
          selector === MOUNT
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
          pushState(_s: unknown, _t: string, url: string) {
            history.push(url);
            location.href = APP_URL + url;
          },
        },
        addEventListener() {},
      },
      DOMParser: class {
        parseFromString(html: string) {
          return pages.get(html);
        }
      },
      fetch(url: string, init: { signal: AbortSignal }) {
        const read = deferred<IslandResponse>();
        requests.push({ url, signal: init.signal, read });
        return read.promise;
      },
    },
    { filename: "public/islands/events-calendar.js" },
  );

  function navigate(url = "/events?view=calendar&month=2026-11") {
    const link = Object.assign(new Node("a"), {
      href: APP_URL + url,
      target: "",
      hasAttribute: () => false,
    });
    root.listeners.get("click")!({
      preventDefault() {},
      defaultPrevented: false,
      button: 0,
      detail: 1,
      target: { closest: () => link },
    });
  }

  function typeSearch(value: string) {
    input.value = value;
    input.listeners.get("input")!({ preventDefault() {} });
  }

  function fireSearch() {
    const due = [...timers.entries()].filter(([, t]) => t.ms === 300);
    due.forEach(([id]) => timers.delete(id));
    due.forEach(([, t]) => t.callback());
  }

  function fireDeadline() {
    const next = [...timers.entries()].find(([, t]) => t.ms === READ_DEADLINE_MS);
    if (!next) return false;
    timers.delete(next[0]);
    next[1].callback();
    return true;
  }

  function page(index: number) {
    const token = `page-${index}`;
    const sourceZones = createZones(`response-${index}`);
    const next = {
      dataset: root.dataset,
      querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? sourceZones : []),
    };
    pages.set(token, {
      querySelector: (selector: string) =>
        selector === MOUNT
          ? next
          : selector.startsWith("link")
            ? { href: APP_URL + requests[index]!.url }
            : null,
    });
    return token;
  }

  function complete(index: number, outcome: "success" | "failure" | "abort") {
    const read = requests[index]!.read;
    if (outcome === "success") read.resolve({ ok: true, text: async () => page(index) });
    else
      read.reject(
        Object.assign(new Error("offline"), { name: outcome === "abort" ? "AbortError" : "Error" }),
      );
  }

  return {
    root,
    skeleton,
    content,
    feedback,
    live,
    input,
    gameField,
    retry,
    clearRead,
    readStatus,
    history,
    reloads,
    requests,
    location,
    navigate,
    typeSearch,
    fireSearch,
    fireDeadline,
    complete,
  };
}

type Browser = ReturnType<typeof browser>;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// The already-owned busy toggle: skeleton + content hide + aria-busy. This is
// the preserved control — it passes on the base and must not change.
function expectBusy(b: Browser, on: boolean) {
  expect(b.skeleton.hidden).toBe(!on);
  expect(b.content.hidden).toBe(on);
  expect(b.root.getAttribute("aria-busy")).toBe(on ? "true" : null);
  expect(b.skeleton.textContent).toBe(EVENTS_LOADING_COPY);
}

// Loading announcement: some existing suitable host (live line or feedback)
// carries loading words while a member-started read is pending. The read-status
// host is failure-only and must stay empty during loading.
function loadingHosts(b: Browser): string[] {
  const hosts: string[] = [];
  for (const id of LIVE_IDS) {
    if (/loading/i.test(b.live[id]!.textContent)) hosts.push(id);
  }
  if (/loading/i.test(b.feedback.textContent)) hosts.push("feedback");
  return hosts;
}

function snapshotLive(b: Browser): Record<string, string> {
  return Object.fromEntries([
    ...LIVE_IDS.map((id) => [id, b.live[id]!.textContent] as const),
    ["feedback", b.feedback.textContent] as const,
    ["readStatus", b.readStatus.textContent] as const,
  ]);
}

describe("member-started loading is announced in an existing status host", () => {
  it("announces a month-step navigation outside the hidden content, keeping the busy toggle", async () => {
    const b = browser();
    b.navigate();
    expectBusy(b, true);
    expect(b.readStatus.textContent).toBe("");
    expect(loadingHosts(b).length).toBeGreaterThanOrEqual(1);
    b.complete(0, "success");
    await settle();
    expectBusy(b, false);
    expect(loadingHosts(b)).toEqual([]);
    expect(b.feedback.textContent).toBe("");
    expect(b.content.childNodes).toEqual(["response-0"]);
    expect(b.history).toEqual([b.requests[0]!.url]);
  });

  it("clears only its own loading message on failure, keeping last-good zones and history", async () => {
    const b = browser();
    b.navigate();
    expectBusy(b, true);
    expect(loadingHosts(b).length).toBeGreaterThanOrEqual(1);
    b.complete(0, "failure");
    await settle();
    expectBusy(b, false);
    expect(loadingHosts(b)).toEqual([]);
    expect(b.feedback.textContent).toBe(EVENTS_CALENDAR_FETCH_FAILED);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.history).toEqual([]);
  });

  it("keeps the current loading message when a superseded read settles late", async () => {
    const b = browser();
    b.navigate("/events?view=calendar&month=2026-11");
    b.navigate("/events?view=calendar&month=2026-12");
    expect(b.requests[0]!.signal.aborted).toBe(true);
    expectBusy(b, true);
    const current = loadingHosts(b);
    expect(current.length).toBeGreaterThanOrEqual(1);
    // Obsolete success, failure and abort alike stay silent.
    for (const outcome of ["success", "failure", "abort"] as const) {
      const before = snapshotLive(b);
      b.complete(0, outcome);
      await settle();
      expect(snapshotLive(b)).toEqual(before);
      expect(loadingHosts(b)).toEqual(current);
      expectBusy(b, true);
      expect(b.content.childNodes).toEqual(["last-good content"]);
      expect(b.history).toEqual([]);
    }
    b.complete(1, "success");
    await settle();
    expectBusy(b, false);
    expect(loadingHosts(b)).toEqual([]);
    expect(b.content.childNodes).toEqual(["response-1"]);
    expect(b.history).toEqual([b.requests[1]!.url]);
  });

  it("releases loading on the owned deadline and keeps a superseded deadline silent", async () => {
    const b = browser();
    b.navigate();
    expectBusy(b, true);
    expect(loadingHosts(b).length).toBeGreaterThanOrEqual(1);
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expectBusy(b, false);
    expect(loadingHosts(b)).toEqual([]);
    expect(b.feedback.textContent).toBe(EVENTS_CALENDAR_FETCH_FAILED);
    // A late body after the timeout cannot re-announce loading or commit.
    b.complete(0, "success");
    await settle();
    expect(loadingHosts(b)).toEqual([]);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.history).toEqual([]);
  });
});

describe("loading controls stay unchanged", () => {
  it("announces nothing on every keystroke: typing alone touches no live host", async () => {
    const b = browser();
    const before = snapshotLive(b);
    b.typeSearch("c");
    b.typeSearch("ch");
    b.typeSearch("chess");
    expect(b.requests).toHaveLength(0);
    expectBusy(b, false);
    expect(snapshotLive(b)).toEqual(before);
    expect(loadingHosts(b)).toEqual([]);
  });

  it("keeps settled search untargeted: no skeleton while the search read is pending", async () => {
    const b = browser();
    b.typeSearch("chess");
    b.fireSearch();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.url).toBe("/events?q=chess");
    expectBusy(b, false);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    b.complete(0, "success");
    await settle();
    expectBusy(b, false);
    expect(b.content.childNodes).toEqual(["response-0"]);
  });

  it("keeps the game facet and recovery hosts stable across a failed read", async () => {
    const b = browser();
    b.gameField.value = "Chess";
    b.navigate();
    expectBusy(b, true);
    b.complete(0, "failure");
    await settle();
    expectBusy(b, false);
    // Filter intent survives the failure; recovery names the missed turn.
    expect(b.gameField.value).toBe("Chess");
    expect(b.retry.hidden).toBe(false);
    expect(b.clearRead.hidden).toBe(false);
    expect(b.readStatus.textContent).toContain("Couldn't load");
    expect(b.history).toEqual([]);
  });

  it("renders every suitable host outside the swapped zones and the skeleton in real SSR", async () => {
    const state: CalendarState = {
      view: "calendar",
      month: "2026-10",
      q: "",
      game: "",
      past: false,
      page: 1,
    };
    const html = (await jsx(EventsCalendarPage, {
      state,
      upcoming: [],
      past: [],
      zone: "Europe/London",
      now: new Date("2026-10-13T12:00:00Z"),
      totalPages: 1,
      emptyState: null as CalendarEmptyState,
      discordFailed: false,
      games: [],
      gameFilter: null,
      member: false,
      inviteUrl: "https://discord.gg/fixture",
      appUrl: APP_URL,
    }).toString()) as unknown as string;
    // Each live line and the feedback host carry role=status outside content.
    for (const id of LIVE_IDS) {
      const re = new RegExp(`<p[^>]*data-testid="${id}"[^>]*>`);
      const tag = re.exec(html)?.[0] ?? "";
      expect(tag).toContain('role="status"');
    }
    expect(html).toContain('role="status" data-cal-feedback');
    const contentStart = html.indexOf('data-cal-zone="content"');
    const skeletonStart = html.indexOf('data-testid="events-loading"');
    for (const id of LIVE_IDS) {
      const at = html.indexOf(`data-testid="${id}"`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(contentStart);
      expect(at).toBeLessThan(skeletonStart);
    }
    const feedbackAt = html.indexOf("data-cal-feedback");
    expect(feedbackAt).toBeLessThan(contentStart);
    // One skeleton, hidden at rest; the busy toggle owns it (no duplicate host).
    expect(html.match(/data-testid="events-loading"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="events-loading" hidden');
  });
});
