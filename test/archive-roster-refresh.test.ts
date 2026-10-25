import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { archiveContext } from "../src/events/archive-context";

function refresh(source: string, search: string): string {
  const requests: string[] = [];
  let broadcast: (event: unknown) => void = () => {};
  const root = { getAttribute: () => null, setAttribute() {} };
  runInContext(
    source,
    createContext({
      AbortController,
      URLSearchParams,
      location: { pathname: "/e/evt-1", search },
      setTimeout: () => 1,
      clearTimeout() {},
      document: {
        documentElement: root,
        body: null,
        activeElement: null,
        querySelector: (selector: string) =>
          selector === '[data-island="rsvp-button"]' ? { getAttribute: () => "evt-1" } : null,
        addEventListener: (_: string, listener: typeof broadcast) => {
          broadcast = listener;
        },
      },
      fetch: (url: string) => {
        requests.push(url);
        return new Promise(() => {});
      },
    }),
  );
  broadcast({ detail: { eventKey: "evt-1" } });
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe.each(["assets", "public"])("%s roster refresh archive continuity", (directory) => {
  const source = readFileSync(`${directory}/islands/attendees-live.js`, "utf8");
  it.each(["", "attendees=2&", "attendees=2x&"])(
    "retains bounded context independent of attendee page %s",
    (attendees) => {
      const q = 'Raid 🌌 "night" & <crew>';
      const search = `?${attendees}${new URLSearchParams({ archivePage: "2", archiveQuery: q, next: "//evil.example" })}`;
      const url = new URL(refresh(source, search), "https://example.test");
      expect(url.pathname).toBe("/e/evt-1");
      expect(url.searchParams.get("attendees")).toBe(attendees === "attendees=2&" ? "2" : null);
      expect(archiveContext(url.search)).toEqual({ page: 2, q });
      expect(url.searchParams.has("next")).toBe(false);
    },
  );

  describe.each(["1", "2"])("unfiltered archive page %s", (archivePage) => {
    it.each(["", "attendees=2&", "attendees=2x&"])(
      "retains context independent of attendee page %s",
      (attendees) => {
        const url = new URL(
          refresh(source, `?${attendees}archivePage=${archivePage}&next=//evil.example`),
          "https://example.test",
        );
        expect(url.pathname).toBe("/e/evt-1");
        expect([...url.searchParams]).toEqual([
          ...(attendees === "attendees=2&" ? [["attendees", "2"]] : []),
          ["archivePage", archivePage],
        ]);
      },
    );
  });

  describe.each(["x", "🌌"])("query admission counted in %s code points", (character) => {
    it.each([254, 255, 256])("checks the outbound URL at %i code points", (length) => {
      const q = character.repeat(length);
      const search = new URLSearchParams({ attendees: "2", archivePage: "2", archiveQuery: q });
      const url = new URL(refresh(source, `?${search}`), "https://example.test");
      expect(url.pathname).toBe("/e/evt-1");
      expect([...url.searchParams]).toEqual([
        ["attendees", "2"],
        ...(length <= 255
          ? [
              ["archivePage", "2"],
              ["archiveQuery", q],
            ]
          : []),
      ]);
    });
  });

  it.each([
    "archivePage=2&archivePage=2&archiveQuery=x",
    "archivePage=2&archiveQuery=x&archiveQuery=x",
    "archivePage=2&archiveQuery=%E0%A4%A",
    `archivePage=2&archiveQuery=${"x".repeat(256)}`,
  ])("does not repair invalid archive state during refresh %s", (archive) => {
    const url = new URL(refresh(source, `?attendees=2&${archive}`), "https://example.test");
    expect(url.searchParams.get("attendees")).toBe("2");
    expect(archiveContext(url.search)).toBeNull();
    expect(url.searchParams.has("archivePage")).toBe(false);
    expect(url.searchParams.has("archiveQuery")).toBe(false);
  });

  // The live roster refresh re-reads the detail page; dropping archiveGame
  // there silently returns the member to the unfiltered archive afterwards.
  it("propagates the archive game with page, query and attendee paging", () => {
    const url = new URL(
      refresh(source, "?attendees=2&archivePage=2&archiveQuery=Table&archiveGame=Go"),
      "https://example.test",
    );
    expect(url.pathname).toBe("/e/evt-1");
    expect(url.searchParams.get("attendees")).toBe("2");
    expect(url.searchParams.getAll("archiveGame")).toEqual(["Go"]);
    expect(archiveContext(url.search)).toEqual({ page: 2, q: "Table", game: "Go" });
  });

  it("does not invent archive context from a game without an archive page", () => {
    const url = new URL(refresh(source, "?attendees=2&archiveGame=Go"), "https://example.test");
    expect([...url.searchParams]).toEqual([["attendees", "2"]]);
  });

  describe.each(["x", "🌌"])("game admission counted in %s code points", (character) => {
    it.each([255, 256])("checks the outbound URL at %i code points", (length) => {
      const game = character.repeat(length);
      const search = new URLSearchParams({
        attendees: "2",
        archivePage: "2",
        archiveQuery: "Table",
        archiveGame: game,
      });
      const url = new URL(refresh(source, `?${search}`), "https://example.test");
      expect(url.pathname).toBe("/e/evt-1");
      expect(url.searchParams.get("attendees")).toBe("2");
      if (length <= 255) {
        expect(url.searchParams.getAll("archiveGame")).toEqual([game]);
        expect(archiveContext(url.search)).toEqual({ page: 2, q: "Table", game });
      } else {
        // Over-bound game rejects the entire archive context, never just the
        // game: a partial context would return to a different search.
        expect(archiveContext(url.search)).toBeNull();
        expect(url.searchParams.has("archivePage")).toBe(false);
        expect(url.searchParams.has("archiveQuery")).toBe(false);
        expect(url.searchParams.has("archiveGame")).toBe(false);
      }
    });
  });

  it.each([
    "archivePage=2&archiveQuery=Table&archiveGame=Go&archiveGame=Go",
    "archivePage=2&archiveQuery=Table&archiveGame=Go&archiveGame=Chess",
    "archivePage=2&archiveQuery=Table&archiveGame=Go%00",
    "archivePage=2&archiveQuery=Table&archiveGame=%E0%A4%A",
  ])("rejects the entire archive context for an invalid game during refresh %s", (archive) => {
    const url = new URL(refresh(source, `?attendees=2&${archive}`), "https://example.test");
    expect(url.searchParams.get("attendees")).toBe("2");
    expect(archiveContext(url.search)).toBeNull();
    expect(url.searchParams.has("archivePage")).toBe(false);
    expect(url.searchParams.has("archiveQuery")).toBe(false);
    expect(url.searchParams.has("archiveGame")).toBe(false);
  });
});
