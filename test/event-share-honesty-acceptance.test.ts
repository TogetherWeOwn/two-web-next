// route-inventory: GET /e/:key
// Test-author owned: Builder consumes unchanged; corrections return to the author.
// Run: npx vitest run test/event-share-honesty-acceptance.test.ts
// Browser counterpart: e2e/event-share-honesty.spec.ts (intercepted local fixtures).
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";
import { nativeShareFixture, SHARE_CANONICAL, SHARE_VIEWS } from "./fixtures/event-native-share";

type Element = DefaultTreeAdapterMap["element"];
function elements(html: string): Element[] {
  const result: Element[] = [];
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("tagName" in node) result.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(html));
  return result;
}
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value;
const GOOGLE_TARGET =
  "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Chess%20%22night%22%20%26%20friends%20%E2%99%9F&dates=20350110T200000Z%2F20350110T220000Z&details=Public%20description%3B%20not%20part%20of%20the%20native%20payload.&location=The%20lobby";
const EXISTING_SCRIPTS = [
  "/islands/attendees-live.js",
  "/islands/copy-link.js",
  "/islands/event-device-timezone.js",
  "/islands/event-share.js",
  "/islands/going-count.js",
  "/islands/rsvp-button.js",
];

for (const view of SHARE_VIEWS) {
  describe(`${view} event share honesty acceptance`, () => {
    it("provides the canonical URL in an enabled readonly field without relying on JavaScript", async () => {
      // Catches replacing a manual-copy fallback with another navigation-only anchor.
      const { html, status } = await nativeShareFixture(view);
      expect(status).toBe(200);
      const fields = elements(html).filter(
        (node) => node.tagName === "input" && attr(node, "value") === SHARE_CANONICAL,
      );
      expect(
        fields,
        "a readonly canonical event URL must be available for manual copying",
      ).toHaveLength(1);
      expect(attr(fields[0]!, "readonly")).toBeDefined();
      expect(attr(fields[0]!, "disabled")).toBeUndefined();
      expect(attr(fields[0]!, "type") ?? "text").toBe("text");
    });

    it.each(["published", "past"])(
      "preserves %s calendar and copy destinations",
      async (status) => {
        // Literal, independently encoded destinations catch origin/query leakage and URL drift.
        const fixture = await nativeShareFixture(view, { status });
        expect(fixture.status).toBe(200);
        const nodes = elements(fixture.html);
        expect(attr(nodes.find((node) => attr(node, "data-testid") === "event-ics")!, "href")).toBe(
          "/events/01ARZ3NDEKTSV4RRFFQ69G5FAV.ics",
        );
        expect(
          attr(
            nodes.find((node) => attr(node, "data-testid") === "event-google-calendar")!,
            "href",
          ),
        ).toBe(GOOGLE_TARGET);
        expect(
          nodes.filter((node) => attr(node, "data-copy-link") === SHARE_CANONICAL),
        ).toHaveLength(1);
        if (status === "past") expect(fixture.html).toContain('data-testid="event-past"');
      },
    );

    it.each([
      { status: "published", viewer: "guest" as const },
      { status: "published", viewer: "member" as const },
      { status: "draft", viewer: "moderator" as const },
      { status: "past", viewer: "guest" as const },
    ])("adds no script or island to the $viewer $status page", async (options) => {
      // Catches solving an SSR affordance with another client bundle, inline handler, or hydration.
      const { html, status } = await nativeShareFixture(view, options);
      expect(status).toBe(200);
      const nodes = elements(html);
      const scripts = nodes.filter((node) => node.tagName === "script");
      const expectedScripts =
        view === "Hono" && options.viewer !== "guest"
          ? [...EXISTING_SCRIPTS, "/islands/auth-status.js"].sort()
          : EXISTING_SCRIPTS;
      expect(scripts.flatMap((node) => attr(node, "src") ?? []).sort()).toEqual(expectedScripts);
      for (const node of scripts.filter((node) => attr(node, "src") === undefined)) {
        expect(attr(node, "type")).toBe("application/ld+json");
      }
      const islands = nodes.flatMap((node) => attr(node, "data-island") ?? []).sort();
      expect(islands).toEqual(
        options.viewer === "guest"
          ? ["going-count", "rsvp-button"]
          : ["attendees-live", "going-count", "rsvp-button"],
      );
      expect(nodes.flatMap((node) => node.attrs.filter((a) => /^on/i.test(a.name)))).toEqual([]);
    });
  });
}
