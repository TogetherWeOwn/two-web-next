// route-inventory: GET /events/past, GET /events
// Builder-owned unit pins for the archive game facet's shared authorities.
// The Test Author's acceptance suite proves end-to-end behavior; these pin the
// pure normalization, URL grammar and admission helpers both twins share.
import { describe, expect, it } from "vitest";
import { archiveReturnHref, archiveReturnLink } from "../src/events/archive-links";
import { archiveContext } from "../src/events/archive-context";
import { archiveEventHref } from "../src/events/attendee-paths";
import { resolveCalendarInput } from "../src/events/page-models.server";
import { matchGame, resolveArchiveGameFilter } from "../src/events/search-log";
import { pastEventsUrl } from "../src/islands/contracts-past-events";

describe("archive game matching authority", () => {
  it("trims outer whitespace but preserves case and internal spacing", () => {
    expect(matchGame("  gO  ")).toBe("gO");
    expect(matchGame("Raid  night")).toBe("Raid  night");
    expect(matchGame("Échecs & <club> %_\\🎲")).toBe("Échecs & <club> %_\\🎲");
  });

  it("treats blank input as no filter", () => {
    expect(matchGame(null)).toBeNull();
    expect(matchGame(undefined)).toBeNull();
    expect(matchGame("")).toBeNull();
    expect(matchGame("   ")).toBeNull();
  });

  it("normalizes newlines so data attributes and canonical agree, without dropping NUL", () => {
    expect(matchGame("alpha\r\nbeta")).toBe("alpha\nbeta");
    expect(matchGame("Go\0")).toBe("Go\0");
  });

  it("resolves case-insensitively to the canonical suggestion, retaining valid unknowns", () => {
    const games = ["Chess", "Go"];
    expect(resolveArchiveGameFilter(games, "  gO  ")).toBe("Go");
    expect(resolveArchiveGameFilter(games, "CHESS")).toBe("Chess");
    expect(resolveArchiveGameFilter(games, "  Never played  ")).toBe("Never played");
    expect(resolveArchiveGameFilter(games, "   ")).toBeNull();
    expect(resolveArchiveGameFilter(games, null)).toBeNull();
  });
});

describe("archive game URL grammar", () => {
  it("carries game after page and query, omitting blanks", () => {
    expect(pastEventsUrl(1)).toBe("/events/past");
    expect(pastEventsUrl(2, "Table night", "Go")).toBe("/events/past?page=2&q=Table+night&game=Go");
    expect(pastEventsUrl(1, "", "Go")).toBe("/events/past?game=Go");
    expect(pastEventsUrl(1, "Table night")).toBe("/events/past?q=Table+night");
    expect(pastEventsUrl(1, "", "   ")).toBe("/events/past");
  });

  it("extends structured detail context with game, never a return URL", () => {
    const href = archiveEventHref("event-key", { page: 2, q: "Table night", game: "Go" });
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.get("archivePage")).toBe("2");
    expect(url.searchParams.get("archiveQuery")).toBe("Table night");
    expect(url.searchParams.get("archiveGame")).toBe("Go");
    for (const arbitrary of ["returnTo", "return", "next"])
      expect(url.searchParams.has(arbitrary)).toBe(false);
    expect(archiveEventHref("event-key", { page: 1, q: "" })).toBe("/e/event-key?archivePage=1");
  });

  it("parses archive game context and refuses malformed game fields", () => {
    expect(archiveContext("?archivePage=2&archiveQuery=q&archiveGame=Go")).toEqual({
      page: 2,
      q: "q",
      game: "Go",
    });
    expect(archiveContext("?archivePage=2")).toEqual({ page: 2, q: "" });
    expect(archiveContext("?archivePage=2&archiveGame=%20%20")).toEqual({ page: 2, q: "" });
    expect(archiveContext("?archivePage=2&archiveGame=Go&archiveGame=Chess")).toBeNull();
    expect(archiveContext(`?archivePage=2&archiveGame=${"x".repeat(256)}`)).toBeNull();
    expect(archiveContext("?archivePage=2&archiveGame=Go%00")).toBeNull();
  });

  it("returns to the filtered archive with the established filtered label", () => {
    expect(archiveReturnHref({ page: 2, q: "Table night", game: "Go" })).toBe(
      "/events/past?page=2&q=Table+night&game=Go",
    );
    expect(archiveReturnLink({ page: 2, q: "", game: "Go" })).toEqual({
      href: "/events/past?page=2&game=Go",
      label: "← Back to search results",
    });
    expect(archiveReturnLink({ page: 1, q: "" })).toEqual({
      href: "/events/past",
      label: "← Back to past events",
    });
    expect(archiveReturnHref(null)).toBeNull();
  });
});

describe("archive game admission", () => {
  it("bounds raw game length before normalization", () => {
    expect(resolveCalendarInput({ game: "x".repeat(256) }).gameTooLong).toBe(true);
    expect(resolveCalendarInput({ game: " ".repeat(256) }).gameTooLong).toBe(true);
    expect(resolveCalendarInput({ game: "x".repeat(255) }).gameTooLong).toBe(false);
    expect(resolveCalendarInput({}).gameTooLong).toBe(false);
  });

  it("refuses NUL and conflicting duplicate games, tolerating identical repeats", () => {
    expect(resolveCalendarInput({ game: "Go\0" }).gameRefused).toBe(true);
    expect(resolveCalendarInput({ game: "Go", games: ["Go", "Chess"] }).gameRefused).toBe(true);
    expect(resolveCalendarInput({ game: "Go", games: ["Go", "Go"] }).gameRefused).toBe(false);
    expect(resolveCalendarInput({ game: "Go" }).gameRefused).toBe(false);
    expect(resolveCalendarInput({}).gameRefused).toBe(false);
  });

  it("refuses conflicting duplicate queries only when duplicates are supplied", () => {
    expect(resolveCalendarInput({ q: "Table", qs: ["Table", "other"] }).queryConflicting).toBe(
      true,
    );
    expect(resolveCalendarInput({ q: "Table", qs: ["Table", "Table"] }).queryConflicting).toBe(
      false,
    );
    expect(resolveCalendarInput({ q: "Table" }).queryConflicting).toBe(false);
  });
});
