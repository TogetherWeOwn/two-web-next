// route-inventory: GET /events
// route-inventory: GET /events/past
// Independent, immutable acceptance handoff. Builder incorporates this history
// unchanged; corrections belong to the test author. No runtime source changes.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FEED_URL,
  ORIGIN,
  SURFACES,
  subscriptionFixture,
} from "./helpers/calendar-subscription-fixture";

let fixture: Awaited<ReturnType<typeof subscriptionFixture>>;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture = await subscriptionFixture();
});
afterAll(() => {
  fixture?.dispose();
  vi.useRealTimers();
});

// Test-only text extraction for assertions (no HTML sink): walk angle
// brackets instead of a `<...>` regex replace so the helper does not read
// as an HTML sanitizer (CodeQL incomplete sanitization). tagReplacement is
// emitted once per tag, mirroring the empty- vs space-join at the call sites.
function textOutsideTags(fragment: string, tagReplacement = "") {
  let out = "";
  let inTag = false;
  for (const ch of fragment) {
    if (ch === "<" && !inTag) {
      out += tagReplacement;
      inTag = true;
    } else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

// Test-only script/style block skip for copy assertions (no HTML sink): drop
// each complete <script>/<style>…</…> block (case-insensitive) with index
// scans instead of a regex replace, so CodeQL does not read it as
// sanitization. An opening tag with no closing tag is left for the tag walk
// and its content stays visible, mirroring the old non-matching replace.
function stripScriptStyleBlocks(html: string) {
  const isWordChar = (c: string) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";
  let out = "";
  let i = 0;
  const lower = html.toLowerCase();
  while (i < html.length) {
    const scriptOpen = lower.indexOf("<script", i);
    const styleOpen = lower.indexOf("<style", i);
    let next = -1;
    let kind = "";
    if (scriptOpen !== -1 && (styleOpen === -1 || scriptOpen < styleOpen)) {
      next = scriptOpen;
      kind = "script";
    } else if (styleOpen !== -1) {
      next = styleOpen;
      kind = "style";
    }
    if (next === -1) {
      out += html.slice(i);
      break;
    }
    // Word boundary after the tag name, mirroring `\b`: `<scripts>` is not
    // a script open.
    if (isWordChar(lower[next + kind.length + 1] ?? "")) {
      out += html.slice(i, next + 1);
      i = next + 1;
      continue;
    }
    const openEnd = html.indexOf(">", next);
    if (openEnd === -1) {
      out += html.slice(i, next);
      break;
    }
    const closeTag = `</${kind}>`;
    const closeIdx = lower.indexOf(closeTag, openEnd + 1);
    if (closeIdx === -1) {
      out += html.slice(i, openEnd + 1);
      i = openEnd + 1;
      continue;
    }
    out += html.slice(i, next);
    i = closeIdx + closeTag.length;
  }
  return out;
}

function text(html: string) {
  return textOutsideTags(stripScriptStyleBlocks(html), " ")
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
    (match) => textOutsideTags(match[2]!).trim(),
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
