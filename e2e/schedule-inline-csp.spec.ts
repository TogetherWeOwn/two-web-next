// Real local compiled document, then isolated mutation copies under its exact
// response policy. This is CSP enforcement evidence, not visual acceptance or
// a performance observation; no screenshot/baseline or threshold is changed.
import { createHash } from "node:crypto";
import { test, expect, localOrigin } from "./fixtures";
import {
  LEAF_CRITICAL_CSS,
  LEAF_CRITICAL_CSS_SHA256,
  SCHEDULE_CRITICAL_CSS,
  SCHEDULE_CRITICAL_CSS_SHA256,
} from "../src/leaf-critical-css";

const blocks = `<style>${LEAF_CRITICAL_CSS}</style><style>${SCHEDULE_CRITICAL_CSS}</style>`;

test.use({ javaScriptEnabled: false, serviceWorkers: "block" });

for (const mutation of ["none", "L byte", "S byte", "arbitrary inline"] as const) {
  test(`upcoming document CSP: ${mutation}`, async ({ page, request }) => {
    const source = await request.get(`${localOrigin}/events`, { maxRedirects: 0 });
    expect(source.status()).toBe(200);
    const original = await source.text();
    const csp = source.headers()["content-security-policy"]!;
    expect(original).toContain(blocks);
    expect(csp).toContain(
      `style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}' 'sha256-${SCHEDULE_CRITICAL_CSS_SHA256}'`,
    );
    expect(csp).not.toContain("unsafe-inline");
    expect(createHash("sha256").update(LEAF_CRITICAL_CSS).digest("base64")).toBe(
      LEAF_CRITICAL_CSS_SHA256,
    );
    expect(createHash("sha256").update(SCHEDULE_CRITICAL_CSS).digest("base64")).toBe(
      SCHEDULE_CRITICAL_CSS_SHA256,
    );
    const html =
      mutation === "L byte"
        ? original.replace(
            `<style>${LEAF_CRITICAL_CSS}</style>`,
            `<style>${LEAF_CRITICAL_CSS} </style>`,
          )
        : mutation === "S byte"
          ? original.replace(
              `<style>${SCHEDULE_CRITICAL_CSS}</style>`,
              `<style>${SCHEDULE_CRITICAL_CSS} </style>`,
            )
          : mutation === "arbitrary inline"
            ? original.replace("</head>", "<style>body{display:none}</style></head>")
            : original;
    const stylesheetRequests: string[] = [];
    page.on("request", (req) => {
      if (/\/(?:styles|theme-tokens|theme|schedule-theme)\.css(?:\?|$)/.test(req.url())) {
        stylesheetRequests.push(req.url());
      }
    });
    await page.route(`${localOrigin}/events`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=UTF-8",
        headers: { "content-security-policy": csp },
        body: html,
      }),
    );
    await page.goto(`${localOrigin}/events`, { waitUntil: "load" });
    const rules = await page
      .locator("head style")
      .evaluateAll((nodes) => nodes.map((node: any) => node.sheet?.cssRules.length ?? 0));
    expect(rules).toHaveLength(mutation === "arbitrary inline" ? 3 : 2);
    expect(rules[0] === 0).toBe(mutation === "L byte");
    expect(rules[1] === 0).toBe(mutation === "S byte");
    if (mutation === "arbitrary inline") expect(rules[2]).toBe(0);
    expect(stylesheetRequests).toEqual([]);
    await expect(page.locator("h1")).toHaveText("Events");
    await expect(page.locator("h1")).toBeVisible();
  });
}
