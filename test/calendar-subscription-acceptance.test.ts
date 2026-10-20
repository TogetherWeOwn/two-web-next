// route-inventory: GET /events
// route-inventory: GET /events/past
// Independent, immutable acceptance handoff. Builder incorporates this history
// unchanged; corrections belong to the test author. No runtime source changes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FEED_URL,
  ORIGIN,
  SURFACES,
  subscriptionFixture,
} from "./helpers/calendar-subscription-fixture";

let fixture: Awaited<ReturnType<typeof subscriptionFixture>>;
beforeAll(async () => {
  fixture = await subscriptionFixture();
});
afterAll(() => fixture?.dispose());

function text(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|quot|#39);/g, " ")
    .replace(/\s+/g, " ");
}

// Accept native selectable URL text or a field, not a link whose label merely
// says Download. The full value must exist in the server response itself.
function selectableUrls(html: string) {
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)]
    .filter(([tag]) => !/\bdisabled(?:\s|=|>)/i.test(tag))
    .map(([tag]) => tag.match(/\bvalue="([^"]*)"/i)?.[1]);
  const blocks = [...html.matchAll(/<(textarea|code|pre|a|output)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(
    (match) => match[2]!.replace(/<[^>]*>/g, "").trim(),
  );
  return [...inputs, ...blocks].filter((value) => value?.includes("/events.ics"));
}

export function expectSubscriptionGuidance(html: string) {
  const copy = text(html);
  expect(copy, "continuing subscription guidance").toMatch(/subscrib|subscription/i);
  expect(copy, "one-time import is not an ongoing subscription").toMatch(
    /one[ -]time|once|snapshot/i,
  );
  expect(copy).toMatch(/import/i);
  expect(copy).toMatch(/Google Calendar/i);
  expect(copy, "Google template adds an individual event").toMatch(
    /(?:single|individual|one)[ -]event/i,
  );
  expect(copy, "the calendar client controls refresh timing").toMatch(
    /(?:client|app|provider)[^.]{0,180}(?:refresh|timing|schedule)|(?:refresh|timing)[^.]{0,180}(?:client|app|provider)/i,
  );
}

describe.each(SURFACES)("%s subscription acceptance", (surface) => {
  for (const appUrl of [ORIGIN, `${ORIGIN}/`]) {
    it(`keeps existing native feed destinations at ${appUrl}`, async () => {
      const response = await fixture.render(surface, appUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("set-cookie")).toBeNull();
      if (surface.startsWith("kit")) expect(response.headers.get("x-two-renderer")).toBe("kit");
      const html = await response.text();
      expect(html).toContain(`href="${FEED_URL}"`);
      expect(html).toMatch(/href="(?:https:\/\/calendar\.example\.test)?\/events\.rss"/);
      // Archive historically exposes HTTPS ICS/RSS, not a webcal Subscribe.
      if (surface.endsWith("calendar"))
        expect(html).toContain('href="webcal://calendar.example.test/events.ics"');
    });

    it(`ships a selectable, unfiltered HTTPS URL without JavaScript at ${appUrl}`, async () => {
      const response = await fixture.render(
        surface,
        appUrl,
        "?q=fixture-query&page=2&user=fixture-member&token=fixture-marker&returnTo=https%3A%2F%2Funtrusted.example.test%2Fprivate",
      );
      expect(response.status).toBe(200);
      const urls = selectableUrls(await response.text());
      expect(urls, "a native selectable feed URL must be server-rendered").not.toHaveLength(0);
      expect([...new Set(urls)]).toEqual([FEED_URL]);
    });
  }

  it("makes subscription/import/template and refresh guidance available in an empty calendar/archive", async () => {
    const response = await fixture.render(surface);
    expect(response.status).toBe(200);
    expectSubscriptionGuidance(await response.text());
  });
});

for (const renderer of ["hono", "kit"] as const) {
  it(`${renderer} public FAQ carries the same subscription distinctions and client refresh caveat`, async () => {
    expectSubscriptionGuidance(await fixture.faq(renderer));
  });
}
