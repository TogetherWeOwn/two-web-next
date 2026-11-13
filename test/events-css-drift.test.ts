import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { EVENTS_CRITICAL_CSS, EVENTS_CRITICAL_CSS_SHA256 } from "../src/events-critical-css";
import { securityHeadersFor } from "../src/headers";

it("preserves the exact served stylesheet bytes in cascade order", () => {
  const css = ["styles.css", "theme-tokens.css", "theme.css", "schedule-theme.css"]
    .map((name) => readFileSync(resolve(import.meta.dirname, "../public", name), "utf8"))
    .join("\n");
  expect(EVENTS_CRITICAL_CSS).toBe(css);
  expect(EVENTS_CRITICAL_CSS_SHA256).toBe(createHash("sha256").update(css).digest("base64"));
  expect(css).not.toMatch(/<\/style/i);
});

it("scopes the events hash to the exact route", () => {
  const csp = (path: string) =>
    new Map(securityHeadersFor({ path, method: "GET" })).get("Content-Security-Policy") ?? "";
  expect(csp("/events")).toContain(`'sha256-${EVENTS_CRITICAL_CSS_SHA256}'`);
  for (const path of ["/events/past", "/events/", "/join", "/about"]) {
    expect(csp(path)).not.toContain(EVENTS_CRITICAL_CSS_SHA256);
  }
});
