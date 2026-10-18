// Acceptance: the attendees-live island must parse ?attendees= as strictly
// as the server. The server (parseAttendeePageParam in src/events/reads.ts)
// accepts only a plain positive integer whose offset arithmetic stays exact,
// and falls back to page 1 for every other raw value: suffixed ("2x"),
// fractional ("2.9"), zero-padded ("02"), or beyond the safe-integer range.
// When the island refreshes the roster after a going-count-updated
// broadcast, its fragment fetch must therefore go to the bare page-one URL
// for those raw values, not to a page the server would never have rendered.
//
// Hermetic fixture contract (no browser, network or database):
// - Each case evaluates the island source in a fresh VM with only the DOM
//   surface it needs before its first fetch: a documentElement guard, an
//   rsvp-button mount carrying the event key, the broadcast listener, a
//   location with the case's search string, and a fetch stub that records
//   the request and never resolves (timers are manual and never fired, so
//   no deadline or retry path runs).
// - Assertions read only the recorded fetch URL, cross-checked against the
//   real server parser imported above. The malformed cases are the
//   failing-first proof; the plain-page, page-one, missing-query and
//   unreadable-query cases are positive controls that already pass.
// - Both the island source under assets/ and the built copy under public/
//   must satisfy the suite, so a fix is only complete once the built
//   assets are regenerated from the corrected source.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parseAttendeePageParam } from "../src/events/reads";

const EVENT_KEY = "evt-1";
const PAGE_ONE_URL = `/e/${EVENT_KEY}`;

const SOURCES = [
  { label: "assets source", rel: "../assets/islands/attendees-live.js" },
  { label: "built public copy", rel: "../public/islands/attendees-live.js" },
] as const;

class StubElement {
  private attributes = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
}

type Search = string | "unreadable";

function locationFor(search: Search) {
  const location: Record<string, unknown> = {
    pathname: PAGE_ONE_URL,
    href: `https://example.test${PAGE_ONE_URL}`,
  };
  if (search === "unreadable") {
    Object.defineProperty(location, "search", {
      get() {
        throw new Error("search is unreadable");
      },
    });
  } else {
    location.search = search;
  }
  return location;
}

// Loads one island copy against one search string and returns the recorded
// fragment fetches plus a way to fire the refresh broadcast.
function browser(source: string, filename: string, search: Search) {
  const requests: { url: string; init: unknown }[] = [];
  const listeners: ((event: { detail: { eventKey: string } }) => void)[] = [];
  const mount = new StubElement({ "data-event-key": EVENT_KEY });
  const timers = new Map<number, () => void>();
  let nextTimer = 0;

  runInContext(
    source,
    createContext({
      AbortController,
      URLSearchParams,
      setTimeout: (fn: () => void) => {
        const id = ++nextTimer;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => {
        timers.delete(id);
      },
      location: locationFor(search),
      document: {
        documentElement: new StubElement(),
        body: null,
        activeElement: null,
        addEventListener(
          type: string,
          listener: (event: { detail: { eventKey: string } }) => void,
        ) {
          expect(type).toBe("going-count-updated");
          listeners.push(listener);
        },
        querySelector(selector: string) {
          return selector === '[data-island="rsvp-button"]' ? mount : null;
        },
      },
      fetch(url: string, init: unknown) {
        requests.push({ url, init });
        // Never resolves: the requested URL is the behavior under test, and
        // an unresolved read keeps every later DOM path out of the fixture.
        return new Promise(() => {});
      },
    }),
    { filename },
  );

  return {
    requests,
    broadcast() {
      expect(listeners).toHaveLength(1);
      for (const listener of listeners) listener({ detail: { eventKey: EVENT_KEY } });
    },
  };
}

function refreshedUrl(source: string, filename: string, search: Search): string {
  const b = browser(source, filename, search);
  expect(b.requests, "mounting alone must not fetch").toHaveLength(0);
  b.broadcast();
  expect(b.requests, "one fragment fetch per answered broadcast").toHaveLength(1);
  return b.requests[0]!.url;
}

// Raw values the server falls back to page 1 for. The island refreshes a
// page for each of them today, which is the divergence under test.
// "9007199254740993" is 2**53 + 1; "90071992547411" is itself a safe
// integer but its (page - 1) * page-size offset is not, so the server's
// exact-arithmetic guard falls back for it as well.
const SERVER_PAGE_ONE_RAW = ["2x", "2.9", "02", "9007199254740993", "90071992547411"];

describe.each(SOURCES)("attendees-live ?attendees= parsing ($label)", ({ rel }) => {
  const source = readFileSync(new NodeURL(rel, import.meta.url), "utf8");
  const filename = rel.replace(/^\.\.\//, "");

  it.each(SERVER_PAGE_ONE_RAW)(
    "refreshes page one for ?attendees=%s, matching the server fallback",
    (raw) => {
      expect(parseAttendeePageParam(raw), "server truth for this raw value").toBe(1);
      expect(refreshedUrl(source, filename, `?attendees=${raw}`)).toBe(PAGE_ONE_URL);
    },
  );

  it("still refreshes page 3 for plain ?attendees=3", () => {
    expect(parseAttendeePageParam("3")).toBe(3);
    expect(refreshedUrl(source, filename, "?attendees=3")).toBe(`${PAGE_ONE_URL}?attendees=3`);
  });

  it("keeps the page-one refresh for explicit ?attendees=1", () => {
    expect(parseAttendeePageParam("1")).toBe(1);
    expect(refreshedUrl(source, filename, "?attendees=1")).toBe(PAGE_ONE_URL);
  });

  it.each(["", "?other=2"])("keeps the page-one refresh when search is %j", (search) => {
    expect(parseAttendeePageParam(new URLSearchParams(search).get("attendees"))).toBe(1);
    expect(refreshedUrl(source, filename, search)).toBe(PAGE_ONE_URL);
  });

  it("keeps the page-one refresh when the query is unreadable", () => {
    expect(refreshedUrl(source, filename, "unreadable")).toBe(PAGE_ONE_URL);
  });
});
