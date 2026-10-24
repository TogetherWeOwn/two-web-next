// Unit pins for the inventory-return carrier parser (U3). Route-level proof
// lives in test/admin-event-inventory-return-acceptance.test.ts; these pin the
// pure normalize-or-refuse contract directly.
import { describe, expect, it } from "vitest";
import {
  editUrlWithOrigin,
  INVENTORY_RETURN_PARAM,
  parseInventoryOrigin,
} from "../src/admin/event-list";

describe("parseInventoryOrigin", () => {
  it("refuses non-string, empty, and overlong carriers", () => {
    expect(parseInventoryOrigin(undefined)).toBeNull();
    expect(parseInventoryOrigin(null)).toBeNull();
    expect(parseInventoryOrigin(42)).toBeNull();
    expect(parseInventoryOrigin("")).toBeNull();
    expect(parseInventoryOrigin(`/admin/events?q=${"x".repeat(4096)}`)).toBeNull();
    expect(parseInventoryOrigin("x".repeat(2049))).toBeNull();
  });

  it("refuses external, protocol-relative, wrong-path, and hash carriers", () => {
    expect(parseInventoryOrigin("https://evil.example/steal")).toBeNull();
    expect(parseInventoryOrigin("//evil.example/steal")).toBeNull();
    expect(parseInventoryOrigin("/admin/members?token=x")).toBeNull();
    expect(parseInventoryOrigin("/admin/events-mirror")).toBeNull();
    expect(parseInventoryOrigin("/admin/events/01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    expect(parseInventoryOrigin("/admin/events?q=x#frag")).toBeNull();
  });

  it("normalizes through the allowlisted list parser", () => {
    expect(parseInventoryOrigin("/admin/events")).toBe("/admin/events?sort=starts_at&order=desc");
    expect(
      parseInventoryOrigin(
        "/admin/events?q=+%E2%99%9F+%26+%3Cimg%3E+&q=discarded&status=invalid&series=standalone&fill=unlimited&rsvp_open=0&sort=invalid&order=invalid&page=9007199254740992&member_id=x&token=y",
      ),
    ).toBe(
      "/admin/events?q=%E2%99%9F+%26+%3Cimg%3E&series=standalone&fill=unlimited&rsvp_open=0&sort=starts_at&order=desc",
    );
    expect(parseInventoryOrigin(`/admin/events?q=${"x".repeat(129)}&sort=status`)).toBe(
      "/admin/events?sort=status&order=desc",
    );
  });
});

describe("editUrlWithOrigin", () => {
  it("keeps the bare edit href without an origin", () => {
    expect(editUrlWithOrigin("KEY", null)).toBe("/admin/events/KEY");
  });

  it("carries the normalized inventory otherwise", () => {
    expect(editUrlWithOrigin("KEY", "/admin/events?sort=title&order=asc")).toBe(
      `/admin/events/KEY?${INVENTORY_RETURN_PARAM}=${encodeURIComponent("/admin/events?sort=title&order=asc")}`,
    );
  });
});
