// Builder suite for the S1 link-in-bio slice (spec section 9, S1): the unit
// seams the acceptance file does not own — validator edges, store round-trip,
// crossed save shapes and page edge states. The acceptance file
// (test/member-links-acceptance.test.ts) owns the locked contract and is never
// edited here.
// route-inventory: GET /members/:user/links
// route-inventory: GET /profile/links
// route-inventory: POST /profile/links
// route-inventory: PATCH /profile/links
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db } from "../src/db/index";
import {
  MEMBER_LINK_DENYLIST,
  MEMBER_LINK_LABEL_MAX,
  MEMBER_LINK_URL_MAX,
  MEMBER_LINKS_MAX,
  parseLinksFormText,
  validateLinksJson,
  validateLinksList,
} from "../src/profiles/links-validation";
import { createDbLinksStore, createMemoryLinksStore } from "../src/profiles/links-store";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

describe("links validator bounds", () => {
  it("pins the locked contract constants", () => {
    expect(MEMBER_LINKS_MAX).toBe(12);
    expect(MEMBER_LINK_LABEL_MAX).toBe(80);
    expect(MEMBER_LINK_URL_MAX).toBe(2048);
    expect(MEMBER_LINK_DENYLIST).toContain("blocked-example.test");
  });

  it("accepts a trimmed list and stores the trimmed form", () => {
    const result = validateLinksList([
      { label: "  Twitch  ", url: "  https://twitch.tv/alice  " },
    ]);
    expect(result).toEqual({
      ok: true,
      links: [{ label: "Twitch", url: "https://twitch.tv/alice" }],
    });
  });

  it("keeps the URL as typed instead of URL-normalizing it", () => {
    const result = validateLinksList([{ label: "Root", url: "https://example.com" }]);
    expect(result.ok && result.links).toEqual([{ label: "Root", url: "https://example.com" }]);
  });

  it("rejects control characters in labels and URLs", () => {
    expect(validateLinksList([{ label: "a\0b", url: "https://example.com" }]).ok).toBe(false);
    expect(validateLinksList([{ label: "ok", url: "https://example.com/a\u0007b" }]).ok).toBe(
      false,
    );
  });

  it("rejects non-string fields with a type error", () => {
    const label = validateLinksList([{ label: 7, url: "https://example.com" }]);
    expect(label.ok).toBe(false);
    const url = validateLinksList([{ label: "ok", url: 7 }]);
    expect(url.ok).toBe(false);
  });

  it("rejects a trailing-dot denylisted host", () => {
    const result = validateLinksList([
      { label: "Bad", url: "https://blocked-example.test./steal" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("names unknown JSON fields instead of saving past them", () => {
    const result = validateLinksJson({ links: [], admin: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toMatchObject({ admin: expect.any(String) });
  });

  it("parses form lines on the first separator and drops blank lines", () => {
    const result = parseLinksFormText("A | https://a.example\n\n  \nB | https://b.example/x|y");
    expect(result).toEqual({
      ok: true,
      links: [
        { label: "A", url: "https://a.example" },
        { label: "B", url: "https://b.example/x|y" },
      ],
    });
  });

  it("an absent form text clears, a non-string text is 422-shaped", () => {
    expect(parseLinksFormText(undefined)).toEqual({ ok: true, links: [] });
    const bad = parseLinksFormText(["x"]);
    expect(bad.ok).toBe(false);
  });

  it("a separator-less line names its line", () => {
    const result = parseLinksFormText("no separator here");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toMatchObject({ "links[0]": expect.stringContaining("1") });
  });
});

describe("links memory store", () => {
  it("misses as null and copies across the seam", async () => {
    const store = createMemoryLinksStore();
    expect(await store.find("100000000000000001")).toBeNull();
    const input = [{ label: "Twitch", url: "https://twitch.tv/alice" }];
    await store.save("100000000000000001", input);
    input[0]!.label = "mutated";
    input.push({ label: "extra", url: "https://example.com" });
    const found = await store.find("100000000000000001");
    expect(found).toEqual([{ label: "Twitch", url: "https://twitch.tv/alice" }]);
    found![0]!.label = "mutated";
    expect(await store.find("100000000000000001")).toEqual([
      { label: "Twitch", url: "https://twitch.tv/alice" },
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("links database store", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(() => fixture?.dispose());

  it("upserts whole lists per member, including an empty clear", async () => {
    await db.execute(
      sql`INSERT INTO users (id, username, member) VALUES ('100000000000000211', 'saver', true)`,
    );
    const store = createDbLinksStore(db);
    expect(await store.find("100000000000000211")).toBeNull();
    await store.save("100000000000000211", [
      { label: "Twitch", url: "https://twitch.tv/saver" },
    ]);
    expect(await store.find("100000000000000211")).toEqual([
      { label: "Twitch", url: "https://twitch.tv/saver" },
    ]);
    await store.save("100000000000000211", []);
    expect(await store.find("100000000000000211")).toEqual([]);
  });
});
