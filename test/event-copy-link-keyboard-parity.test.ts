import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

// Acceptance suite (Test Author; the builder must not edit this file).
//
// Keyboard-oracle for the event copy-link control. The pinned contract is
// ONE consistent announced semantics — either a button or a link — whose
// keyboard and click behavior matches what assistive technology announces:
//   * both Enter and Space activate the copy exactly once per press,
//   * held-key repeats never re-copy,
//   * plain click copies and never navigates,
//   * modifier / non-primary clicks follow the ANNOUNCED semantics
//     (a button never navigates; a link keeps native open-in-new-tab etc.),
//   * the toast still announces copy success and failure,
//   * the announced semantics do not change when the island loads.
// The oracle models native browser activation from the element the page
// actually renders (tag, href, role, tabindex) combined with the shipped
// island handlers, so either consistent resolution (real button, or link
// announced as a link) can pass. Local fixtures only; no live event writes.
const binder = readFileSync(new NodeURL("../public/islands/copy-link.js", import.meta.url), "utf8");

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const CANONICAL = `${APP_URL}${PATH}`;
const COPIED_TEXT = "Event link copied.";
const FAILED_TEXT = "That link didn't copy — copy it from the address bar.";

// Real Drizzle queries and Hono rendering; all data is local, no DB connection.
function fixture() {
  const start = new Date("2030-01-10T20:00:00Z");
  const row: typeof events.$inferSelect = {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
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
    syncRevision: 1,
    syncedRevision: 0,
    createdAt: start,
    updatedAt: start,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    if (sql.includes('from "rsvps"'))
      return sql.includes("count(*)") ? { rows: [[row.id, 3]] } : { rows: [] };
    if (sql.includes('"event_key" =')) {
      return {
        rows: [
          columns.map((key) =>
            row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
          ),
        ],
      };
    }
    return { rows: [] };
  });
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return { env };
}

type RenderedControl = { tag: string; attributes: Map<string, string> };

async function renderedControl(): Promise<RenderedControl> {
  const { env } = fixture();
  const response = await app.request(PATH, {}, env);
  expect(response.status).toBe(200);
  const html = await response.text();
  const match = html.match(/<([a-z][a-z0-9-]*)([^>]*\bdata-testid="event-copy-link"[^>]*)>/);
  expect(match, "event page renders the copy-link control").not.toBeNull();
  const attributes = new Map<string, string>();
  for (const attr of match![2]!.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g)) {
    if (attr[1]) attributes.set(attr[1], attr[2] ?? "");
  }
  expect(attributes.get("data-copy-link")).toBe(CANONICAL);
  return { tag: match![1]!.toLowerCase(), attributes };
}

// What assistive technology announces for an element with these attributes:
// an explicit role wins, otherwise the implicit role of the tag.
function announcedSemantics(control: RenderedControl): string {
  const role = control.attributes.get("role");
  if (role) return role;
  if (control.tag === "a") return control.attributes.has("href") ? "link" : "generic";
  if (control.tag === "button") return "button";
  return "generic";
}

function isFocusable(control: RenderedControl): boolean {
  if (control.tag === "button") return true;
  if (control.tag === "a" && control.attributes.has("href")) return true;
  const tabindex = control.attributes.get("tabindex");
  return tabindex !== undefined && Number(tabindex) >= 0;
}

type ClipboardMode = "ok" | "denied-fallback-fails";
type ClickGesture = {
  button?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

// Runs the shipped island against a DOM double seeded with the exact
// attributes the page rendered, then replays user gestures including the
// native activation a browser derives from the rendered element. An
// unprevented click on a rendered anchor records a navigation — that is
// what a real browser would do with the href.
function oracle(rendered: RenderedControl, mode: ClipboardMode = "ok") {
  const attributes = new Map(rendered.attributes);
  const control = Object.assign(new EventTarget(), {
    tagName: rendered.tag.toUpperCase(),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    hasAttribute: (name: string) => attributes.has(name),
    removeAttribute: (name: string) => attributes.delete(name),
  });
  const toast = { textContent: "" };
  const field = {
    value: "",
    className: "",
    tabIndex: 0,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  const active = { focus: vi.fn() };
  const append = vi.fn();
  const exec = vi.fn(() => mode === "ok");
  const writeText = vi.fn(async (_text: string) => {
    if (mode !== "ok") throw new Error("Clipboard permission denied");
  });
  let timerId = 0;
  const timers = new Map<number, () => void>();
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) => (selector === "[data-copy-link]" ? control : toast),
      activeElement: active,
      createElement: () => field,
      body: { appendChild: append },
      execCommand: exec,
    },
    window: { getSelection: () => null },
    navigator: { clipboard: { writeText } },
    setTimeout: vi.fn((fn: () => void, _ms: number) => {
      timers.set(++timerId, fn);
      return timerId;
    }),
    clearTimeout: vi.fn((id: number) => timers.delete(id)),
  });

  const navigations: ClickGesture[] = [];
  const navigableHref =
    rendered.tag === "a" && rendered.attributes.has("href")
      ? rendered.attributes.get("href")
      : undefined;

  async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  async function dispatch(type: string, extra: Record<string, unknown> = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      button: 0,
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...extra,
    });
    control.dispatchEvent(event);
    await flush();
    return event;
  }

  // A click as a browser delivers it, plus the navigation default that
  // follows when script did not prevent it on a real anchor.
  async function click(gesture: ClickGesture = {}) {
    const event = await dispatch("click", { ...gesture });
    if (!event.defaultPrevented && navigableHref !== undefined) navigations.push({ ...gesture });
    return event;
  }

  // Native activation keys. Enter fires a native click from keydown on
  // links and buttons; Space fires it from keyup on buttons only. Script
  // may take over either key, but then it owns the whole gesture.
  async function pressEnter(repeat = false) {
    const keydown = await dispatch("keydown", { key: "Enter", repeat });
    if (!keydown.defaultPrevented && (rendered.tag === "button" || navigableHref !== undefined)) {
      await click();
    }
    await dispatch("keyup", { key: "Enter", repeat });
  }

  async function pressSpace(repeat = false) {
    const keydown = await dispatch("keydown", { key: " ", repeat });
    const keyup = await dispatch("keyup", { key: " ", repeat });
    if (!keydown.defaultPrevented && !keyup.defaultPrevented && rendered.tag === "button") {
      await click();
    }
  }

  return {
    attributes,
    toast,
    navigations,
    navigableHref,
    announced: () => announcedSemantics({ tag: rendered.tag, attributes }),
    copies: () => writeText.mock.calls.length,
    copiedUrls: () => writeText.mock.calls.map((call) => call[0]),
    click,
    pressEnter,
    pressSpace,
  };
}

describe("Event copy-link role/keyboard parity (acceptance)", () => {
  it("announces one focusable semantics that does not change when the island loads", async () => {
    const rendered = await renderedControl();
    const ssrAnnounced = announcedSemantics(rendered);
    expect(["button", "link"]).toContain(ssrAnnounced);
    expect(isFocusable(rendered)).toBe(true);
    const o = oracle(rendered);
    expect(o.announced()).toBe(ssrAnnounced);
  });

  it("exposes no navigable href when the announced semantics is button", async () => {
    const rendered = await renderedControl();
    const o = oracle(rendered);
    if (o.announced() === "button") {
      expect(o.navigableHref).toBeUndefined();
    } else {
      expect(o.announced()).toBe("link");
      expect(o.navigableHref).toBe(CANONICAL);
    }
  });

  it("copies the canonical URL exactly once on Enter and announces success", async () => {
    const o = oracle(await renderedControl());
    await o.pressEnter();
    expect(o.copiedUrls()).toEqual([CANONICAL]);
    expect(o.navigations).toEqual([]);
    expect(o.toast.textContent).toBe(COPIED_TEXT);
  });

  it("copies the canonical URL exactly once on Space and announces success", async () => {
    const o = oracle(await renderedControl());
    await o.pressSpace();
    expect(o.copiedUrls()).toEqual([CANONICAL]);
    expect(o.navigations).toEqual([]);
    expect(o.toast.textContent).toBe(COPIED_TEXT);
  });

  it.each(["Enter", "Space"] as const)(
    "ignores held-%s repeats and still accepts the next fresh press",
    async (key) => {
      const o = oracle(await renderedControl());
      const press = key === "Enter" ? o.pressEnter : o.pressSpace;
      await press();
      expect(o.copies()).toBe(1);
      await press(true);
      await press(true);
      expect(o.copies()).toBe(1);
      await press();
      expect(o.copies()).toBe(2);
      expect(o.navigations).toEqual([]);
    },
  );

  it("copies on a plain click and never navigates", async () => {
    const o = oracle(await renderedControl());
    await o.click();
    expect(o.copiedUrls()).toEqual([CANONICAL]);
    expect(o.navigations).toEqual([]);
    expect(o.toast.textContent).toBe(COPIED_TEXT);
  });

  it("makes modifier and non-primary clicks follow the announced semantics", async () => {
    const o = oracle(await renderedControl());
    const gestures: ClickGesture[] = [
      { button: 1 },
      { button: 2 },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
    ];
    for (const gesture of gestures) await o.click(gesture);
    if (o.announced() === "button") {
      // A button has no navigation default for any click flavour.
      expect(o.navigations).toEqual([]);
    } else {
      // A link keeps the native modified-click behaviour and does not copy.
      expect(o.announced()).toBe("link");
      expect(o.navigations).toHaveLength(gestures.length);
      expect(o.copies()).toBe(0);
    }
  });

  it.each(["Enter", "Space"] as const)(
    "announces failure through the toast when copying via %s fails",
    async (key) => {
      const o = oracle(await renderedControl(), "denied-fallback-fails");
      await (key === "Enter" ? o.pressEnter() : o.pressSpace());
      expect(o.toast.textContent).toBe(FAILED_TEXT);
      expect(o.navigations).toEqual([]);
    },
  );
});
