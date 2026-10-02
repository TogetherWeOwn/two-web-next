// TOG-12615: pin reduced-motion loader behavior on the events calendar island.
//
// Legacy CalendarReducedMotionLoaderTest pins the same invariant on the blade
// surface: with reduced motion preferred the loading shimmer/animation is
// suppressed while results still render, and month navigation stays operable.
// Next pins only the theme-level `prefers-reduced-motion` rule in
// test/home-theme.test.ts — nothing asserts the calendar island honors it.
//
// Fixtures only, no DB/network/browser. SSR pins the motion-safe loader markup
// (hidden by default, no shimmer/animation hooks) and real month links; the
// shipped binder is executed in a VM under both matchMedia states to prove
// month navigation issues one GET and settles with results in both.
//
// Hot files stay untouched (open theme PRs): src/events/pages.tsx,
// public/islands/events-calendar.js, src/index.tsx, public/theme.css.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { EventsCalendarPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import {
  CALENDAR_NEXT_LABEL,
  CALENDAR_PREV_LABEL,
  EVENTS_CONTENT_TESTID,
  EVENTS_LIST_TESTID,
  EVENTS_LOADING_COPY,
  EVENTS_LOADING_ROWS,
  EVENTS_LOADING_TESTID,
  addCalendarMonth,
  calendarMonthLabel,
} from "../src/islands/contracts";

const APP_URL = "https://calendar.example.test";
const ORIGIN = "https://calendar.example.test";
const INVITE = "https://discord.gg/fixture";
const MONTH = "2030-01";
const NOW = new Date("2030-01-05T12:00:00Z");
const START = new Date(Date.UTC(2030, 0, 15, 20));
const END = new Date(Date.UTC(2030, 0, 15, 22));

const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const themeCss = readFileSync(new NodeURL("../public/theme.css", import.meta.url), "utf8");

function eventRow(): PublicEvent {
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: "reduced-motion-night",
    title: "Reduced motion game night",
    game: null,
    description: null,
    startsAt: START,
    endsAt: END,
    timezone: "UTC",
    location: null,
    capacity: null,
    status: "published",
    rsvpOpen: true,
    goingCount: 2,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: START,
    updatedAt: START,
  };
}

async function render(view: "list" | "calendar"): Promise<string> {
  const html = await EventsCalendarPage({
    state: { view, month: MONTH, q: "", past: false },
    upcoming: [eventRow()],
    past: [],
    zone: "UTC",
    now: NOW,
    emptyState: null,
    discordFailed: false,
    member: false,
    inviteUrl: INVITE,
    appUrl: APP_URL,
  })!.toString();
  return html;
}

function loaderHtml(html: string): string {
  const match = new RegExp(
    `<div[^>]*data-testid="${EVENTS_LOADING_TESTID}"[^>]*>([\\s\\S]*?)</div>`,
  ).exec(html);
  expect(match, "SSR renders the calendar loading skeleton").not.toBeNull();
  return match![0]!;
}

/* ------------------------------------------------------------------ SSR pin */

describe("calendar reduced-motion loader SSR", () => {
  it("renders results with a motion-safe loader: hidden, static copy, no animation hooks", async () => {
    for (const view of ["list", "calendar"] as const) {
      const html = await render(view);
      // Results still render under either motion preference (SSR is motion-agnostic).
      // List shows the full card; the month grid shows the truncated day link.
      if (view === "list") {
        expect(html).toContain("Reduced motion game night");
        expect(html).toContain('data-event-key="reduced-motion-night"');
        expect(html).toContain(`data-testid="${EVENTS_LIST_TESTID}"`);
      } else {
        expect(html).toContain("data-cal-jump");
        expect(html).toContain("20:00 Reduced motion gam…");
      }
      expect(html).toContain(`data-testid="${EVENTS_CONTENT_TESTID}"`);

      const loader = loaderHtml(html);
      // Hidden by default; revealed only via the `hidden` attribute (no CSS animation).
      expect(loader).toContain("hidden");
      expect(loader).toContain(EVENTS_LOADING_COPY);
      const placeholders = loader.match(/aria-hidden="true"/g) ?? [];
      expect(placeholders).toHaveLength(EVENTS_LOADING_ROWS);
      // No shimmer/animation hooks on the loader: no classes, no inline motion styles.
      expect(loader).not.toMatch(/class\s*=/i);
      expect(loader).not.toMatch(/style\s*=/i);
      expect(loader).not.toMatch(
        /shimmer|animate|animation|transition|keyframe|spin|pulse|fade|slide/i,
      );
      // No inline event handlers anywhere on the island surface.
      expect(html).not.toMatch(/\son(?:click|keydown|mousedown|touchstart)=/i);
    }
  });

  it("keeps the no-preference loader byte-identical (existing loader unchanged)", async () => {
    // SSR emits one loader for both motion preferences; the no-preference
    // baseline must not drift (copy, placeholder count, hidden default).
    const list = loaderHtml(await render("list"));
    const calendar = loaderHtml(await render("calendar"));
    expect(list).toBe(calendar);
    expect(list).toContain(`data-testid="${EVENTS_LOADING_TESTID}"`);
  });

  it("gates motion in CSS and ships no loader shimmer", () => {
    // The only motion rule stays gated: transitions run under no-preference,
    // so reduced-motion gets none. No calendar loader keyframes/shimmer exist to gate.
    expect(themeCss).toContain("prefers-reduced-motion: no-preference");
    expect(themeCss).not.toContain("@keyframes");
    expect(themeCss).not.toMatch(/shimmer/i);
    expect(themeCss).not.toContain(EVENTS_LOADING_TESTID);
  });

  it.each(["list", "calendar"] as const)(
    "keeps month navigation as real operable links in %s view",
    async (view) => {
      const html = await render(view);
      if (view === "calendar") {
        expect(html).toContain(calendarMonthLabel(MONTH));
        const prevMonth = addCalendarMonth(MONTH, -1);
        const nextMonth = addCalendarMonth(MONTH, 1);
        expect(html).toContain(`aria-label="${CALENDAR_PREV_LABEL}"`);
        expect(html).toContain(`aria-label="${CALENDAR_NEXT_LABEL}"`);
        expect(html).toContain(`month=${prevMonth}`);
        expect(html).toContain(`month=${nextMonth}`);
        // Real anchors, operable without JavaScript: no disabled/aria-disabled, no JS-only hooks.
        const navLinks = html.match(/<a\b[^>]*aria-label="(Previous|Next) month"[^>]*>/g) ?? [];
        expect(navLinks).toHaveLength(2);
        for (const link of navLinks) {
          expect(link).toMatch(/href="\/events\?[^"]*month=\d{4}-\d{2}[^"]*"/);
          expect(link).not.toMatch(/disabled|aria-disabled/i);
          expect(link).not.toMatch(/\son\w+=|data-cal-jump/);
        }
      } else {
        // List view reaches the month grid through the real calendar toggle.
        expect(html).toContain('data-testid="events-view-calendar"');
        expect(html).toContain(`view=calendar`);
        expect(html).toContain(`month=${MONTH}`);
      }
    },
  );
});

/* ------------------------------------------------------- binder operability */

const NAMES = ["head", "actions", "miss", "content"];
const LIVE_IDS = [
  "events-view-status",
  "events-search-status",
  "events-past-status",
  "calendar-month-status",
];
const FAILURE = "Calendar could not be loaded. Try again.";

class Element {
  childNodes: { text: string }[] = [];
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
  listeners = new Map<string, (event: Record<string, unknown>) => void>();
  activeElement: unknown = null;
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
    if (selector === "[data-cal-zone]") return this.zones;
    if (selector === "a") return [];
    return [];
  }
  replaceChildren(...children: { text: string }[]) {
    this.childNodes = children;
  }
  closest(selector: string) {
    if (selector === "form") return this.form;
    return this.isLink ? this : null;
  }
  contains() {
    return true;
  }
  focus() {
    this.focused = true;
  }
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  emit(type: string, event: Record<string, unknown> = {}) {
    this.listeners.get(type)!(event);
  }
}

function zone(name: string, text: string) {
  const node = new Element();
  node.setAttribute("data-cal-zone", name);
  node.childNodes = [{ text }];
  return node;
}

function fragment(month: string) {
  const root = new Element();
  root.dataset = { view: "calendar", month, past: "" };
  root.zones = NAMES.map((name) => zone(name, `new ${name} ${month}`));
  const page = new Element();
  page.selectors.set('[data-island="events-calendar"]', root);
  const canonical = new Element();
  canonical.href = `${ORIGIN}/events?view=calendar&month=${month}`;
  page.selectors.set('link[rel="canonical"]', canonical);
  for (const id of LIVE_IDS) {
    const node = new Element();
    node.textContent = `new ${id}`;
    page.selectors.set(`[data-testid="${id}"]`, node);
  }
  const input = new Element();
  input.setAttribute("value", "");
  page.selectors.set('[data-testid="events-search"]', input);
  return { page, root };
}

function browser(reducedMotion: boolean) {
  const root = new Element();
  root.dataset = { view: "calendar", month: MONTH, past: "", loadError: FAILURE };
  root.zones = NAMES.map((name) => zone(name, `old ${name}`));
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
  input.value = "";
  root.selectors.set('[data-testid="events-search"]', input);
  const live = LIVE_IDS.map((id) => {
    const node = new Element();
    node.textContent = `old ${id}`;
    root.selectors.set(`[data-testid="${id}"]`, node);
    return node;
  });
  const document = new Element();
  document.selectors.set('[data-island="events-calendar"]', root);
  document.activeElement = null;
  const canonical = new Element();
  canonical.href = `${ORIGIN}/events?view=calendar&month=${MONTH}`;
  document.selectors.set('link[rel="canonical"]', canonical);
  const og = new Element();
  og.content = canonical.href;
  document.selectors.set('meta[property="og:url"]', og);
  const history: string[] = [];
  const requests: {
    signal: AbortSignal;
    resolve: (response: { ok: boolean; text: () => Promise<string> }) => void;
  }[] = [];
  const pages = new Map<string, Element>();
  const importNode = vi.fn((child: { text: string }) => ({ ...child }));
  runInNewContext(binder, {
    URL,
    AbortController,
    matchMedia: (query: string) => ({
      matches: reducedMotion,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    document: Object.assign(document, { importNode }),
    window: {
      location: { origin: ORIGIN, href: `${ORIGIN}/events?view=calendar&month=${MONTH}` },
      history: {
        pushState: (_state: unknown, _title: string, path: string) => {
          history.push(path);
        },
      },
      addEventListener: () => {},
    },
    DOMParser: class {
      parseFromString(html: string) {
        return pages.get(html);
      }
    },
    fetch: (_path: string, init: { signal: AbortSignal }) =>
      new Promise((resolve) => requests.push({ signal: init.signal, resolve })),
    setTimeout: (callback: () => void) => 0,
    clearTimeout: () => {},
  });
  function clickMonth(month: string) {
    const link = new Element();
    link.isLink = true;
    link.href = `${ORIGIN}/events?view=calendar&month=${month}`;
    link.hash = "";
    link.target = "";
    let prevented = false;
    root.emit("click", {
      button: 0,
      target: { closest: () => link },
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
  return { root, skeleton, feedback, input, live, history, requests, clickMonth, finish };
}

describe("calendar month navigation under reduced motion", () => {
  it.each([true, false])(
    "month step issues one GET and settles with results (reduced-motion=%s)",
    async (reducedMotion) => {
      const b = browser(reducedMotion);
      const nextMonth = addCalendarMonth(MONTH, 1);
      expect(b.clickMonth(nextMonth)).toBe(true);
      expect(b.requests).toHaveLength(1);
      // Loading is exposed through hidden/aria-busy only — no animation classes.
      expect(b.skeleton.hidden).toBe(false);
      expect(b.root.getAttribute("aria-busy")).toBe("true");
      expect(b.skeleton.getAttribute("class")).toBeNull();
      expect(b.skeleton.getAttribute("style")).toBeNull();
      await b.finish(0, fragment(nextMonth));
      expect(b.skeleton.hidden).toBe(true);
      expect(b.root.hasAttribute("aria-busy")).toBe(false);
      expect(b.root.dataset.month).toBe(nextMonth);
      expect(b.history).toEqual([`/events?view=calendar&month=${nextMonth}`]);
      expect(b.feedback.textContent).toBe("");
      const content = b.root.zones.find(
        (node) => node.getAttribute("data-cal-zone") === "content",
      )!;
      expect(content.childNodes).toEqual([{ text: `new content ${nextMonth}` }]);
      expect(b.live.map((node) => node.textContent)).toEqual(LIVE_IDS.map((id) => `new ${id}`));
    },
  );
});
