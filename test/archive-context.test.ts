import { describe, expect, it } from "vitest";
import { archiveContext } from "../src/events/archive-context";
import { archiveEventHref } from "../src/events/attendee-paths";
import { archiveReturnHref } from "../src/events/archive-links";
import { normalizePastPage } from "../src/events/reads";

const query = 'Raid 🌌 "night" & <crew>';
const search = (page: string, q = query) =>
  `?${new URLSearchParams({ archivePage: page, archiveQuery: q })}`;

describe("structured archive context", () => {
  it("normalizes only the archive query and rebuilds a rooted destination", () => {
    const context = archiveContext(search("2", ` \0${query}\r\n `));
    expect(context).toEqual({ page: 2, q: query });
    expect(archiveReturnHref(context)).toBe(
      `/events/past?${new URLSearchParams({ page: "2", q: query })}`,
    );
    expect(archiveEventHref("event", context, 3)).toBe(
      `/e/event?${new URLSearchParams({ attendees: "3", archivePage: "2", archiveQuery: query })}`,
    );
  });

  it("keeps missing context and direct attendee links byte-identical", () => {
    expect(archiveContext("")).toBeNull();
    expect(archiveContext("?archiveQuery=raid")).toBeNull();
    expect(archiveContext("?returnTo=//evil.example")).toBeNull();
    expect(archiveReturnHref(null)).toBeNull();
    expect(archiveEventHref("event", null)).toBe("/e/event");
    expect(archiveEventHref("event", null, 2)).toBe("/e/event?attendees=2");
  });

  it("preserves unfiltered page one and strips unrelated fields from generated links", () => {
    const context = archiveContext(
      "?archivePage=1&archiveQuery=+%00+&next=//evil.example&attendees=9",
    );
    expect(context).toEqual({ page: 1, q: "" });
    expect(archiveReturnHref(context)).toBe("/events/past");
    expect(archiveEventHref("event", context)).toBe("/e/event?archivePage=1");
  });

  it.each(["2suffix", "02", "+2", "1.5", "1e2", "0", "-1", "NaN", "9007199254740991"])(
    "refuses noncanonical or unsafe archive page %s rather than normalizing to another result",
    (page) => expect(archiveContext(search(page))).toBeNull(),
  );

  it("uses the existing archive offset bound", () => {
    const page = Math.floor(Number.MAX_SAFE_INTEGER / 20) + 1;
    expect(normalizePastPage(page)).toBe(page);
    expect(archiveContext(search(String(page)))?.page).toBe(page);
    expect(archiveContext(search(String(page + 1)))).toBeNull();
  });

  it.each([
    "?archivePage=2&archive%50age=2",
    "?archivePage=2&archiveQuery=x&archive%51uery=x",
    "?archivePage=2&archiveQuery=%FF",
    "?archivePage=2&archiveQuery=%",
    "?archivePage=2&archiveQuery=%E0%A4%A",
  ])("refuses duplicate encoded keys and malformed URL input %s", (value) => {
    expect(archiveContext(value)).toBeNull();
  });

  it("admits the exact Unicode bound and literal URL-looking searches without redirecting", () => {
    for (const q of ["🌌".repeat(255), "https://evil.example/path?x=1", "x�%+_"]) {
      expect(archiveContext(search("2", q))).toEqual({ page: 2, q });
    }
    for (const q of ["🌌".repeat(256), " ".repeat(256), "\0".repeat(256)]) {
      expect(archiveContext(search("2", q))).toBeNull();
    }
  });
});
