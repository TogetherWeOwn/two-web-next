import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

let render: RenderPage;
let cleanup: () => void;

beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/TimeBlockFixture.svelte");
  render = renderer.renderPage;
  cleanup = renderer.cleanup;
}, 120_000);
afterAll(() => cleanup?.());

const base = {
  start: "2026-11-07T19:30:00Z",
  asOf: "2026-11-07T19:20:00Z",
  viewerZone: "Europe/London",
  state: "upcoming",
  stale: false,
  refreshHref: "/events?view=upcoming",
};

describe("TimeBlock server output", () => {
  it("renders the absolute time and withdraws the countdown without hydration", () => {
    const html = render(base);
    expect(html).toContain('datetime="2026-11-07T19:30:00.000Z"');
    expect(html).toContain("Europe/London");
    expect(html).toContain("19:30 UTC");
    expect(html).toContain("as of");
    expect(html).toContain('href="/events?view=upcoming"');
    expect(html).not.toMatch(/starts in|\bin 10 m/);
  });

  it("labels the viewer zone and formats snapshot dates only across local days", () => {
    const sameDay = render(base);
    expect(sameDay).toContain("your time");
    expect(sameDay).toMatch(/Europe\/London(?: |&nbsp;|&#160;)· 19:30 UTC/);
    expect(sameDay).toMatch(/as of\s*<time[^>]*>19:20<\/time>/);
    const previousDay = render({ ...base, asOf: "2026-11-06T23:50:00Z" });
    expect(previousDay).toMatch(/as of\s*<time[^>]*>6 Nov 23:50<\/time>/);
  });

  it("keeps conditional separators attached without a preceding ordinary space", () => {
    for (const props of [
      base,
      { ...base, state: "live" },
      { ...base, state: "live", asOf: "invalid" },
      { ...base, state: "ended" },
      { ...base, state: "cancelled" },
    ]) {
      const html = render(props);
      expect(html).not.toMatch(/ (?:&nbsp;|&#160;| )·/);
    }
  });

  it("renders each conditional separator attached to its preceding text", () => {
    const cases = [
      [base, "19:30 UTC · as of 19:20 · Refresh"],
      [{ ...base, state: "live" }, "19:30 UTC · live as of 19:20 · Refresh"],
      [
        { ...base, state: "live", asOf: "invalid" },
        "19:30 UTC · Live status unavailable · Refresh",
      ],
      [{ ...base, state: "ended" }, "19:30 UTC · Ended · Echo frozen"],
      [{ ...base, state: "cancelled" }, "19:30 UTC · Cancelled"],
    ] as const;
    for (const [props, expected] of cases) {
      const html = render(props);
      const anchor = html.match(/<div class="(?:[^"]*\s)?anchor(?:\s[^"]*)?">([\s\S]*?)<\/div>/);
      expect(anchor).not.toBeNull();
      const text = Array.from(`>${anchor?.[1] ?? ""}`.matchAll(/(?<=>)[^<]+/g), (match) => match[0])
        .join("")
        .replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ");
      expect(text).toContain(expected);
      expect(text).not.toMatch(/\s ·/);
    }
  });

  it("withdraws live and room count claims but retains the snapshot time", () => {
    const html = render({ ...base, state: "live", roomCount: 8 });
    expect(html).toContain("live as of");
    expect(html).not.toContain("Live since");
    expect(html).not.toContain("8 in the room");
  });

  it("offers recovery when a live snapshot time is invalid", () => {
    const html = render({ ...base, state: "live", asOf: "invalid", roomCount: 8 });
    expect(html).toContain("Live status unavailable");
    expect(html).toContain('href="/events?view=upcoming"');
    expect(html).not.toContain("Live since");
    expect(html).not.toContain("8 in the room");
  });

  it("renders ended, cancelled and invalid states safely", () => {
    expect(render({ ...base, state: "ended", end: "2026-11-07T21:00:00Z" })).toContain(
      "Echo frozen",
    );
    expect(render({ ...base, state: "cancelled" })).toContain("Cancelled");
    const invalid = render({ ...base, start: "invalid" });
    expect(invalid).toContain("Time to be confirmed");
    expect(invalid).not.toContain("<time");
  });

  it("shows the local event date and ended wording even without an end time", () => {
    const html = render({
      ...base,
      state: "ended",
      start: "2026-11-07T23:30:00Z",
      viewerZone: "Europe/Berlin",
    });
    expect(html).toContain("8 Nov");
    expect(html).toContain("Ended");
    expect(html).toContain("Echo frozen");
    expect(html).not.toContain("href=");
  });

  it("rejects unsafe refresh destinations and falls back to UTC for invalid zones", () => {
    for (const refreshHref of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
      const html = render({ ...base, refreshHref });
      expect(html).not.toContain("href=");
      expect(html).toContain("as of");
    }
    for (const viewerZone of [undefined, "Invalid/Zone"]) {
      const html = render({ ...base, viewerZone });
      expect(html).toContain("UTC fallback");
      expect(html).not.toContain("your time");
    }
    expect(render({ ...base, viewerZone: "UTC" })).toContain("your time");
  });
});
