import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";

// Legacy EventClipboardFallbackTest pins clipboard-denial fallback on the
// event page. The island unit (islands-copy-link) and races (copy-link-races)
// cover the binder alone; this suite pins the page integration: the mounted
// event page renders the copy control with the canonical /e/{key} URL, and
// the shipped binder copies that exact URL — via Clipboard API on success,
// via the selectable-text fallback on denial — without leaking to console.
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

async function pageHtml(): Promise<string> {
  const { env } = fixture();
  const response = await app.request(PATH, {}, env);
  expect(response.status).toBe(200);
  return response.text();
}

function pageCanonical(html: string): string {
  const match = html.match(/data-copy-link="([^"]+)"/);
  expect(match?.[1]).toBe(CANONICAL);
  return match![1]!;
}

type ClipboardMode = "ok" | "denied" | "absent";

function island(canonical: string, mode: ClipboardMode = "ok", copied = true) {
  const toast = { textContent: "" };
  const active = { focus: vi.fn() };
  const range = {};
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  const field = {
    value: "",
    className: "",
    tabIndex: 0,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  const append = vi.fn();
  const attributes = new Map([["data-copy-link", canonical]]);
  let click: (e: { button: number; preventDefault: () => void }) => void = () => {};
  const link = {
    getAttribute: (key: string) => attributes.get(key),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    addEventListener: (
      kind: string,
      fn: (e: { button: number; preventDefault: () => void }) => void,
    ) => {
      if (kind === "click") click = fn;
    },
  };
  const writeText = vi.fn(async (_text: string) => {
    if (mode === "denied") throw new Error("Clipboard permission denied");
  });
  const exec = vi.fn(() => copied);
  const setTimeoutFn = vi.fn((_fn: () => void, _ms: number) => 0);
  const clearTimeoutFn = vi.fn((_id: number) => {});
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) => (selector === "[data-copy-link]" ? link : toast),
      activeElement: active,
      createElement: () => field,
      body: { appendChild: append },
      execCommand: exec,
    },
    window: { getSelection: () => selection },
    navigator: mode === "absent" ? {} : { clipboard: { writeText } },
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  });
  return {
    toast,
    active,
    field,
    append,
    exec,
    writeText,
    async click() {
      const event = { button: 0, preventDefault: vi.fn() };
      click(event);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return event;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Event copy-link clipboard fallback (fixture-only)", () => {
  it("renders the copy control with the canonical event URL", async () => {
    const html = await pageHtml();
    expect(html).toContain(
      `<a href="${CANONICAL}" data-copy-link="${CANONICAL}" data-testid="event-copy-link">Copy link</a>`,
    );
    expect(html).toContain('role="status" aria-live="polite" data-testid="event-copy-toast"');
    expect(html).toContain('src="/islands/copy-link.js" defer');
  });

  it("falls back to selectable-text copy on clipboard denial with no console noise", async () => {
    const canonical = pageCanonical(await pageHtml());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const b = island(canonical, "denied");
      await b.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(b.writeText).toHaveBeenCalledExactlyOnceWith(canonical);
      // The fallback carries the page canonical as selectable text.
      expect(b.field.value).toBe(canonical);
      expect(b.field.select).toHaveBeenCalledOnce();
      expect(b.exec).toHaveBeenCalledExactlyOnceWith("copy");
      expect(b.field.remove).toHaveBeenCalledOnce();
      expect(b.active.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(b.toast.textContent).toBe(COPIED_TEXT);
      expect(err).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("copies the page canonical via Clipboard API on success without the fallback", async () => {
    const canonical = pageCanonical(await pageHtml());
    const b = island(canonical, "ok");
    await b.click();
    expect(b.writeText).toHaveBeenCalledExactlyOnceWith(canonical);
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.append).not.toHaveBeenCalled();
    expect(b.toast.textContent).toBe(COPIED_TEXT);
  });

  it("reports a failed fallback honestly as a manual-copy hint with no console noise", async () => {
    const canonical = pageCanonical(await pageHtml());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const b = island(canonical, "denied", false);
      await b.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(b.field.value).toBe(canonical);
      expect(b.field.remove).toHaveBeenCalledOnce();
      expect(b.active.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(b.toast.textContent).toBe(FAILED_TEXT);
      expect(err).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
