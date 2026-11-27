import { createRequire } from "node:module";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { attr, textOf } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const require = createRequire(import.meta.url);
const { renderedElements, renderedText } = require("../ci/rendered-page.mjs") as {
  renderedElements: (node: Node, selector: { tag?: string; id?: string }) => Iterable<Element>;
  renderedText: typeof textOf;
};

let render: (props: Parameters<RenderPage>[0]) => DefaultTreeAdapterMap["document"];
let cleanup: () => void;

beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/TimeBlockFixture.svelte");
  render = (props) => parse(renderer.renderPage(props), { scriptingEnabled: false });
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

function timeAnchor(page: Node) {
  const anchor = [...renderedElements(page, { tag: "div" })].find((element) =>
    attr(element, "class")?.split(/\s+/).includes("anchor"),
  );
  assert.isDefined(anchor, "No rendered time anchor");
  return anchor;
}

function timeLabel(page: Node, datetime: string) {
  const time = [...renderedElements(page, { tag: "time" })].find(
    (element) => attr(element, "datetime") === datetime,
  );
  return time && renderedText(time);
}

function expectRefreshLink(page: Node) {
  const link = [...renderedElements(page, { tag: "a" })].find((anchor) =>
    /^Refresh\s*the event time$/.test(renderedText(anchor)),
  );
  assert.isDefined(link, "No rendered Refresh link");
  expect(attr(link, "href")).toBe(base.refreshHref);
  let node: Node | null = link;
  while (node && "tagName" in node && node.tagName !== "html") {
    const reload = attr(node, "data-sveltekit-reload");
    if (reload !== undefined) return expect(["", "true"]).toContain(reload);
    node = node.parentNode;
  }
  assert.fail("No reload marker for the Refresh link");
}

function markupNodes(node: Node): Node[] {
  const children = "content" in node ? [node.content] : "childNodes" in node ? node.childNodes : [];
  return [node, ...children.flatMap(markupNodes)];
}

function markupText(page: Node) {
  const parts = [textOf(page)];
  for (const node of markupNodes(page)) {
    if ("tagName" in node) parts.push(...node.attrs.map(({ value }) => value));
    if ("data" in node) parts.push(node.data);
    if ("content" in node) parts.push(textOf(node.content));
    if ("value" in node) parts.push(node.value);
  }
  return parts.join("\n");
}

const hasHref = (page: Node) =>
  markupNodes(page).some((node) => "tagName" in node && attr(node, "href") !== undefined);

describe("TimeBlock server output", () => {
  it("renders the absolute time and withdraws the countdown without hydration", () => {
    const html = render({ ...base, refreshHref: `${base.refreshHref}#details` });
    expect(timeLabel(html, "2026-11-07T19:30:00.000Z")).toBe("19:30");
    const text = renderedText(html);
    expect(text).toContain("Europe/London");
    expect(text).toContain("19:30 UTC");
    expect(text).toContain("as of");
    expectRefreshLink(html);
    expect(markupText(html)).not.toMatch(/starts in|\bin 10 m/);
  });

  it("labels the viewer zone and formats snapshot dates only across local days", () => {
    for (const asOf of [base.asOf, "2026-11-06T23:50:00Z"]) {
      const page = render({ ...base, asOf });
      expect(renderedText(page)).toContain("your time");
      const anchor = timeAnchor(page);
      const [time] = renderedElements(anchor, { tag: "time" });
      assert.isDefined(time, "No rendered snapshot time");
      expect(time.parentNode).toBe(anchor);
      const siblings = anchor.childNodes;
      const prefix = siblings.slice(0, siblings.indexOf(time)).map(renderedText).join("");
      expect(prefix).toMatch(/Europe\/London · 19:30 UTC · as of\s*$/);
      expect(attr(time, "datetime")).toBe(new Date(asOf).toISOString());
      expect(renderedText(time)).toBe(asOf === base.asOf ? "19:20" : "6 Nov 23:50");
    }
  });

  it("keeps conditional separators attached without a preceding ordinary space", () => {
    for (const props of [
      base,
      { ...base, state: "live" },
      { ...base, state: "live", asOf: "invalid" },
      { ...base, state: "ended", echoFrozen: true },
      { ...base, state: "cancelled" },
    ]) {
      expect(markupText(render(props))).not.toContain("  ·");
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
      [{ ...base, state: "ended" }, "19:30 UTC · Ended"],
      [{ ...base, state: "ended", echoFrozen: true }, "19:30 UTC · Ended · Echo frozen"],
      [{ ...base, state: "ended", end: "2026-11-07T21:00:00Z" }, "19:30 UTC · ended 21:00"],
      [{ ...base, state: "cancelled" }, "19:30 UTC · Cancelled"],
    ] as const;
    for (const [props, expected] of cases) {
      const text = renderedText(timeAnchor(render(props)));
      expect(text).toContain(expected);
      expect(text.includes("Echo frozen")).toBe(expected.includes("Echo frozen"));
      expect(text).not.toMatch(/\s ·/);
    }
  });

  it("withdraws live and room count claims but retains the snapshot time", () => {
    const html = render({ ...base, state: "live", roomCount: 8 });
    expect(renderedText(html)).toContain("live as of");
    expect(markupText(html)).not.toMatch(/Live since|8 in the room/);
  });

  it("dates a live snapshot and scheduled end across local midnight and a DST fold", () => {
    const live = {
      start: "2026-11-01T03:30:00Z",
      asOf: "2026-11-01T06:10:00Z",
      viewerZone: "America/New_York",
      state: "live",
      stale: false,
      serverLive: true,
    };
    const html = render({ ...live, end: "2026-11-01T06:30:00Z" });
    expect(renderedText(html)).toContain("Saturday 31 October");
    expect(renderedText(timeAnchor(html))).toContain("since 23:30 GMT-4");
    expect(timeLabel(html, "2026-11-01T06:10:00.000Z")).toBe("1 Nov 01:10 GMT-5");
    expect(timeLabel(html, "2026-11-01T06:30:00.000Z")).toBe(
      "Sunday 1 November, 01:30 America/New_York · 06:30 UTC",
    );
    const missingEnd = render(live);
    const liveBadge = [...renderedElements(missingEnd, { tag: "span" })].find(
      (span) => attr(span, "data-live-fresh") === "" && renderedText(span) === "Live",
    );
    expect(liveBadge).toBeDefined();
    expect([...renderedElements(missingEnd, { id: "kit-live-refresh" })]).toHaveLength(1);
    expect(markupText(missingEnd)).not.toContain("Ends");
  });

  it("offers recovery when a live snapshot time is invalid", () => {
    const html = render({ ...base, state: "live", asOf: "invalid", roomCount: 8 });
    expect(renderedText(html)).toContain("Live status unavailable");
    expectRefreshLink(html);
    expect(markupText(html)).not.toMatch(/Live since|8 in the room/);
  });

  it("renders ended, cancelled and invalid states safely", () => {
    const end = "2026-11-07T21:00:00Z";
    const ended = render({ ...base, state: "ended", end, echoFrozen: true });
    expect(renderedText(ended)).toContain("Echo frozen");
    expect(renderedText(render({ ...base, state: "cancelled" }))).toContain("Cancelled");
    const invalid = render({ ...base, start: "invalid" });
    expect(renderedText(invalid)).toContain("Time to be confirmed");
    expect(markupNodes(invalid).map((node) => node.nodeName)).not.toContain("time");
  });

  it("shows the local event date and ended wording even without an end time", () => {
    const html = render({
      ...base,
      state: "ended",
      start: "2026-11-07T23:30:00Z",
      viewerZone: "Europe/Berlin",
    });
    const text = renderedText(html);
    expect(text).toContain("8 Nov");
    expect(text).toContain("Ended");
    expect(markupText(html)).not.toContain("Echo frozen");
    expect(hasHref(html)).toBe(false);
  });

  it("rejects unsafe refresh destinations and falls back to UTC for invalid zones", () => {
    for (const refreshHref of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
      const html = render({ ...base, refreshHref });
      expect(hasHref(html)).toBe(false);
      expect(renderedText(html)).toContain("as of");
    }
    for (const viewerZone of [undefined, "Invalid/Zone"]) {
      const html = render({ ...base, viewerZone });
      expect(renderedText(html)).toContain("UTC fallback");
      expect(markupText(html)).not.toContain("your time");
    }
    expect(renderedText(render({ ...base, viewerZone: "UTC" }))).toContain("your time");
  });
});
