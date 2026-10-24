// Saved-window bounds the Date decoder cannot represent (BC eras, infinities)
// must render as their exact saved text, never throw: a panel render throw
// inside the member-read boundary answers 503 (test/featured-window-precision).
// Run: npx vitest run test/featured-bound-display.test.ts
import { describe, expect, it } from "vitest";
import {
  featuredBoundDisplay,
  FEATURED_OPEN_END_COPY,
  FEATURED_OPEN_START_COPY,
} from "../src/featured-eligibility";
import { resolveKitFeaturedEdit } from "../src/admin/kit-featured-edit";
import type { Db } from "../src/db";
import { APP_URL, CHECKED_AT, savedFeatured } from "./helpers/featured-saved-content-cases";
import { renderSavedHono, renderSavedKit } from "./helpers/featured-saved-content-render";

const BC_START = "0200-10-01 12:34:56.789123 BC";
const BC_END = "0199-10-01 13:45:12.345678 BC";

function boundInstants(html: string): (number | null)[] {
  return [...html.matchAll(/<time\b[^>]*datetime="([^"]+)"/g)].map((match) => {
    const parsed = Date.parse(match[1]!);
    return Number.isNaN(parsed) ? null : parsed;
  });
}

describe("featuredBoundDisplay", () => {
  it("renders a finite Date as its UTC ISO instant", () => {
    const bound = new Date("2034-05-20T11:00:00.123Z");
    expect(featuredBoundDisplay(bound, "2034-05-20 11:00:00.123000")).toEqual({
      kind: "instant",
      iso: "2034-05-20T11:00:00.123Z",
    });
  });

  it("prefers the ISO instant over the SQL text for finite Dates", () => {
    // The SQL text parses as local time; only the ISO pins the saved instant.
    const display = featuredBoundDisplay(new Date(CHECKED_AT), "2034-05-20 12:00:00.123000");
    expect(display.kind).toBe("instant");
    if (display.kind === "instant") expect(Date.parse(display.iso)).toBe(CHECKED_AT.getTime());
  });

  it("falls back to the exact text for a BC bound the decoder cannot represent", () => {
    expect(featuredBoundDisplay(new Date(NaN), BC_START)).toEqual({
      kind: "text",
      text: BC_START,
    });
  });

  it("falls back to the exact text for an infinite bound", () => {
    expect(featuredBoundDisplay(new Date(NaN), "infinity")).toEqual({
      kind: "text",
      text: "infinity",
    });
  });

  it("falls back to the exact text for a non-Date decoded bound", () => {
    expect(featuredBoundDisplay(Infinity as unknown as Date, "infinity")).toEqual({
      kind: "text",
      text: "infinity",
    });
  });

  it("stays open when both the bound and the text are absent", () => {
    expect(featuredBoundDisplay(null, null)).toEqual({ kind: "open" });
    expect(featuredBoundDisplay(null, undefined)).toEqual({ kind: "open" });
  });
});

describe("saved panel with driver-undecodable bounds", () => {
  const bcRow = () =>
    savedFeatured({
      startsAt: new Date(NaN),
      startsAtText: BC_START,
      endsAt: new Date(NaN),
      endsAtText: BC_END,
    });

  it("Hono: shows the exact BC texts instead of throwing", async () => {
    const html = await renderSavedHono(bcRow());
    expect(html).toContain(BC_START);
    expect(html).toContain(BC_END);
    expect(html).toContain('data-testid="featured-preview"');
    // The checked-at instant still parses; no bound invents a datetime.
    expect(boundInstants(html)).toContain(CHECKED_AT.getTime());
    expect(boundInstants(html)).not.toContain(null);
    expect(html).not.toContain(FEATURED_OPEN_START_COPY);
    expect(html).not.toContain(FEATURED_OPEN_END_COPY);
  });

  it("Hono: shows the exact text for an infinite bound", async () => {
    const html = await renderSavedHono(
      savedFeatured({ startsAt: new Date(NaN), startsAtText: "infinity" }),
    );
    expect(html).toContain("infinity");
    expect(boundInstants(html)).not.toContain(null);
  });

  it("Kit view: carries the exact texts with a null instant", async () => {
    const outcome = await resolveKitFeaturedEdit("41", {
      db: {} as Db,
      get: async (_db, id) => (id === 41 ? bcRow() : null),
      now: CHECKED_AT,
      appUrl: APP_URL,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected the saved row to resolve");
    expect(outcome.view.startsAt).toBeNull();
    expect(outcome.view.endsAt).toBeNull();
    expect(outcome.view.startsAtText).toBe(BC_START);
    expect(outcome.view.endsAtText).toBe(BC_END);
  });

  it("Kit-executed: shows the exact BC texts instead of throwing", async () => {
    const html = await renderSavedKit(bcRow());
    expect(html).toContain(BC_START);
    expect(html).toContain(BC_END);
    expect(boundInstants(html)).toContain(CHECKED_AT.getTime());
    expect(boundInstants(html)).not.toContain(null);
  });
});
