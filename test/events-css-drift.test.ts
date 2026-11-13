import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENTS_CRITICAL_CSS, EVENTS_CRITICAL_CSS_SHA256 } from "../src/events-critical-css";
import { securityHeadersFor } from "../src/headers";

const SOURCES = ["styles.css", "theme-tokens.css", "theme.css", "schedule-theme.css"];

describe("events inlined CSS", () => {
  it("preserves the served stylesheets and their cascade order", () => {
    const css = SOURCES.map((name) =>
      readFileSync(resolve(import.meta.dirname, "../public", name), "utf8"),
    ).join("\n");
    expect(EVENTS_CRITICAL_CSS).toBe(css);
  });

  it("scopes the events hash to the exact route", () => {
    const csp = (path: string) =>
      new Map(securityHeadersFor({ path, method: "GET" })).get("Content-Security-Policy") ?? "";
    expect(csp("/events")).toContain(`'sha256-${EVENTS_CRITICAL_CSS_SHA256}'`);
    for (const path of ["/events/past", "/events/", "/join", "/about"]) {
      expect(csp(path)).not.toContain(EVENTS_CRITICAL_CSS_SHA256);
    }
  });

  it("hashes the exact inline bytes and cannot close the style element", () => {
    expect(EVENTS_CRITICAL_CSS_SHA256).toBe(
      createHash("sha256").update(EVENTS_CRITICAL_CSS, "utf8").digest("base64"),
    );
    expect(EVENTS_CRITICAL_CSS).not.toMatch(/<\/style/i);
  });
});
