// Negotiation edges of the Kit error boundary (src/kit-errors.ts):
// quality/specificity/order tie-breaks, malformed q values, data-suffix and
// trailing-slash normalization, write-method machine contracts, and feed
// paths. Pure function pins: no network, no database, no clock.
import { describe, expect, it } from "vitest";
import { isFeedPath, negotiateKitError } from "../src/kit-errors";

const APP = "https://next.example.test";
const req = (path: string, init?: RequestInit) => new Request(`${APP}${path}`, init);
const accept = (value: string) => ({ headers: { accept: value } });

describe("negotiateKitError quality and specificity", () => {
  it("prefers the higher quality, and the more specific range on a quality tie", () => {
    expect(negotiateKitError(req("/gone", accept("text/html;q=0.5, application/json;q=0.9")))).toBe(
      "json",
    );
    expect(negotiateKitError(req("/gone", accept("text/html;q=0.9, application/json;q=0.5")))).toBe(
      "html",
    );
    // Quality beats specificity across keys: q=1 range outranks q=0.5 exact.
    expect(negotiateKitError(req("/gone", accept("text/html;q=0.5, application/*")))).toBe("json");
    // Exact beats range beats star on a quality tie.
    expect(negotiateKitError(req("/gone", accept("text/*, application/json")))).toBe("json");
    expect(negotiateKitError(req("/gone", accept("text/html, application/*")))).toBe("html");
    expect(negotiateKitError(req("/gone", accept("*/*")))).toBe("html");
  });

  it("keeps declaration order as the final tie-break and matches case-insensitively", () => {
    expect(negotiateKitError(req("/gone", accept("APPLICATION/JSON")))).toBe("json");
    expect(negotiateKitError(req("/gone", accept("Text/Html, Application/Json")))).toBe("html");
    expect(negotiateKitError(req("/gone", accept("Application/Json, Text/Html")))).toBe("json");
  });

  it("treats malformed q values as q=1 and double q=0 as no preference", () => {
    expect(negotiateKitError(req("/gone", accept("application/json;q=bogus")))).toBe("json");
    expect(negotiateKitError(req("/gone", accept("application/json;q=2")))).toBe("json");
    expect(negotiateKitError(req("/gone", accept("text/html;q=0, application/json;q=0")))).toBe(
      "html",
    );
    expect(negotiateKitError(req("/gone", accept("application/json;q=0")))).toBe("html");
  });
});

describe("negotiateKitError path normalization", () => {
  it("strips the __data.json suffix and trailing slashes before matching", () => {
    expect(negotiateKitError(req("/events.json/__data.json"))).toBe("json");
    expect(negotiateKitError(req("/events/__data.json"))).toBe("html");
    expect(negotiateKitError(req("/api/thing/", { method: "POST", ...accept("text/html") }))).toBe(
      "json",
    );
    expect(negotiateKitError(req("/llms.txt/"))).toBe("text");
  });
});

describe("negotiateKitError machine contracts", () => {
  it("keeps browser event GETs as HTML and /events.json as JSON", () => {
    const browser = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    expect(negotiateKitError(req("/events", accept(browser)))).toBe("html");
    expect(negotiateKitError(req("/events.json", accept(browser)))).toBe("json");
    expect(negotiateKitError(req("/events.json"))).toBe("json");
  });

  it("answers JSON to event writes whatever the browser accepts", () => {
    const html = accept("text/html");
    expect(negotiateKitError(req("/events", { method: "POST", ...html }))).toBe("json");
    for (const action of ["publish", "cancel", "rsvp-pause", "rsvp-reopen"]) {
      expect(
        negotiateKitError(
          req(`/events/01ARZ3NDEKTSV4RRFFQ69G5FAV/${action}`, { method: "POST", ...html }),
        ),
      ).toBe("json");
    }
    expect(
      negotiateKitError(req("/events/01ARZ3NDEKTSV4RRFFQ69G5FAV", { method: "PATCH", ...html })),
    ).toBe("json");
    expect(
      negotiateKitError(req("/events/01ARZ3NDEKTSV4RRFFQ69G5FAV/rsvp", { method: "PUT", ...html })),
    ).toBe("json");
    expect(
      negotiateKitError(
        req("/events/01ARZ3NDEKTSV4RRFFQ69G5FAV/rsvp", { method: "DELETE", ...html }),
      ),
    ).toBe("json");
    // Unknown event write paths still negotiate instead of forcing JSON.
    expect(
      negotiateKitError(
        req("/events/01ARZ3NDEKTSV4RRFFQ69G5FAV/rename", { method: "POST", ...html }),
      ),
    ).toBe("html");
  });
});

describe("negotiateKitError feeds", () => {
  it("keeps every feed suffix as text, even for JSON callers", () => {
    const json = accept("application/json");
    for (const path of ["/events/abc.rss", "/events/abc.ics", "/events/abc.md", "/llms.txt"]) {
      expect(negotiateKitError(req(path, json))).toBe("text");
      expect(negotiateKitError(req(path))).toBe("text");
    }
    expect(isFeedPath("/events/abc.rss")).toBe(true);
    expect(isFeedPath("/events/abc.md")).toBe(true);
    expect(isFeedPath("/llms.txt")).toBe(true);
    expect(isFeedPath("/events")).toBe(false);
  });
});
