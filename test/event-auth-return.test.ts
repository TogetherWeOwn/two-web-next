import { describe, expect, it } from "vitest";
import { archiveEventHref } from "../src/events/attendee-paths";
import { authReturnHref } from "../src/events/auth-return.server";

describe("event auth return byte limit", () => {
  it.each([0, 1])("handles an archive return %i bytes over the cap", (over) => {
    const key = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const archive = { page: 2, q: `${"棋".repeat(48)}${"x".repeat(11 + over)}` };
    const withArchive = archiveEventHref(key, archive, 2);
    expect(Buffer.byteLength(withArchive)).toBe(512 + over);
    expect(authReturnHref(key, archive, 2, 512)).toBe(over ? `/e/${key}?attendees=2` : withArchive);
  });

  it("keeps the encoded attendee page at the cap and uses the bare path one byte over", () => {
    const key = "棋";
    const archive = { page: 2, q: "棋" };
    const pageOnly = "/e/%E6%A3%8B?attendees=2";
    const bytes = Buffer.byteLength(pageOnly);
    expect(authReturnHref(key, archive, 2, bytes)).toBe(pageOnly);
    expect(authReturnHref(key, archive, 2, bytes - 1)).toBe(`/e/${key}`);
  });
});
