import { describe, expect, it } from "vitest";
import { expiredRsvpBrowser } from "./helpers/expired-rsvp-browser";

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NEXT = `/e/${KEY}?attendees=2`;
const RECOVERY = "/auth/recover?next=" + encodeURIComponent(NEXT);
const JOIN = "/join/discord?next=" + encodeURIComponent(NEXT);

describe("shipped RSVP island expired-session destinations (local fixtures)", () => {
  for (const answer of [null, "going"] as const) {
    const action = answer === null ? "rsvp-going" : "rsvp-withdraw";
    const method = answer === null ? "PUT" : "DELETE";

    it(`${method} 401 with recovery renders that link, not the guest join link`, async () => {
      const browser = expiredRsvpBrowser(answer);
      browser.root.querySelector(`[data-testid="${action}"]`)!.click();
      expect(browser.requests).toHaveLength(1);
      expect(browser.requests[0]!.url).toBe(`/events/${KEY}/rsvp`);
      expect(browser.requests[0]!.init.method).toBe(method);
      browser.requests[0]!.resolve(
        Response.json({ error: "Unauthorized", recovery: RECOVERY }, { status: 401 }),
      );
      await browser.settle();

      // Refusal cannot broadcast success or replay the original write.
      expect(browser.requests).toHaveLength(1);
      expect(browser.broadcasts).toEqual([]);
      const notice = browser.root.querySelector('[data-testid="rsvp-session-expired"]');
      expect(notice).not.toBeNull();
      expect(notice!.getAttribute("role")).toBe("alert");
      expect(notice!.querySelectorAll("a").map((link) => link.href)).toEqual([RECOVERY]);
    });

    it(`${method} bare guest 401 keeps the join link and never invents recovery`, async () => {
      const browser = expiredRsvpBrowser(answer);
      browser.root.querySelector(`[data-testid="${action}"]`)!.click();
      expect(browser.requests).toHaveLength(1);
      browser.requests[0]!.resolve(Response.json({ error: "unauthenticated" }, { status: 401 }));
      await browser.settle();

      expect(browser.requests).toHaveLength(1);
      expect(browser.broadcasts).toEqual([]);
      const notice = browser.root.querySelector('[data-testid="rsvp-session-expired"]');
      expect(notice).not.toBeNull();
      expect(notice!.querySelectorAll("a").map((link) => link.href)).toEqual([JOIN]);
    });
  }
});
