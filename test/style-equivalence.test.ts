import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { Home } from "../src/pages";
import { ProfilePage } from "../src/profiles/pages";
import { concretePath, HTML_READS, MEMBER_ID, pageShellFixture } from "./helpers/page-shells";

// The comparison side is the stylesheet on main c502ca4, before factoring.
// Utilities are removed ONLY on that side; current renders must carry them.
const baseline = readFileSync(new URL("./helpers/styles-baseline.css", import.meta.url), "utf8");
const current = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const names: Record<string, string> = {
  st: "strap", ld: "lead", bt: "btn", ln: "link", w: "who", nt: "notice",
  ft: "facts", cd: "card", cnt: "counts", rst: "rank-stack", hes: "home-events",
  hel: "home-event-link", fimg: "featured-image", sl: "skip-link", tbl: "admin-table",
  fd: "field", hn: "hint", err: "error", act: "actions", flt: "filters",
  ees: "error-events-search", av: "avatar", ai: "avatar-initial",
};
const utilities = new Set(["rw", "ct", "bk", "mt", "bd", "pl", "cp", "ifnt"]);
function canonicalMarkup(html: string) {
  return html.replace(/class="([^"]*)"/g, (_, value: string) => `class="${value.split(/\s+/)
    .filter((name) => !utilities.has(name)).map((name) => names[name] ?? name).join(" ")}"`);
}
function offline(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/g, "")
    .replace(/<img\b[^>]*>/g, (image) => image.replace(/\s(?:src|srcset)="[^"]*"/g, "")
      .replace("<img", '<img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'64\' height=\'64\'%3E%3C/svg%3E"'));
}
async function cases() {
  const rows: { name: string; html: string }[] = [];
  for (const path of [...HTML_READS.map(concretePath), "/missing-page", "/events?view=calendar"]) {
    const response = await pageShellFixture().request(path);
    expect(response.status, path).toBe(path === "/missing-page" ? 404 : 200);
    rows.push({ name: path, html: offline(await response.text()) });
  }
  const event = { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "Game night",
    startsAt: new Date("2030-01-01T20:00:00Z"), timezone: "UTC", location: "Lobby", goingCount: 3 };
  rows.push({ name: "populated-home", html: offline(Home({ session: null, notice: "joined",
    inviteUrl: "/join", appUrl: "https://next.example.test", eventsUnavailable: false,
    upcomingEvents: [event, event, event], counts: { memberCount: 54, onlineCount: 10,
      ranks: [{ key: "member", label: "Member", memberCount: 30 }] },
    featured: [{ id: 1, title: "Games", body: "Play together", url: "/events", imageUrl: null, imageAlt: null }],
  })!.toString()) });
  for (const avatar of [null, "abc"]) {
    rows.push({ name: `avatar-${avatar ?? "initial"}`, html: offline(ProfilePage({
      member: { id: MEMBER_ID, username: "Fixture", avatar, bio: null, games: [], timezone: null },
      isOwner: true, appUrl: "https://next.example.test", errors: { bio: "Invalid bio" },
    })!.toString()) });
  }
  return rows;
}

async function snapshot(page: Page) {
  return page.evaluate(`() => Array.from(document.querySelectorAll("body, body *"), (element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      style: Object.fromEntries(Array.from(style).filter((key) => !key.startsWith("--"))
        .map((key) => [key, style.getPropertyValue(key)])),
      bounds: [bounds.x, bounds.y, bounds.width, bounds.height],
    };
  })`);
}

describe("factored stylesheet", () => {
  it("renders all route shells without leftover canonical classes", async () => {
    const rows = await cases();
    for (const row of rows) {
      for (const [, value] of row.html.matchAll(/class="([^"]*)"/g)) {
        for (const name of value!.split(/\s+/)) expect(Object.values(names), row.name).not.toContain(name);
      }
    }
    if (process.env.CSS_PROOF_FIXTURES) writeFileSync(process.env.CSS_PROOF_FIXTURES,
      JSON.stringify({ baseline, current, rows: rows.map((row) => ({ ...row, canonical: canonicalMarkup(row.html) })) }));
  });

  it.skipIf(process.env.CSS_BROWSER_TESTS !== "true")("preserves computed styles and bounds at phone/desktop widths, focus, hover and broken avatars", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ locale: "en-GB", timezoneId: "UTC" });
      await context.route("**/*", (route) => route.abort());
      const oldPage = await context.newPage();
      const newPage = await context.newPage();
      for (const width of [360, 1280]) {
        await oldPage.setViewportSize({ width, height: 900 });
        await newPage.setViewportSize({ width, height: 900 });
        for (const row of await cases()) {
          await oldPage.setContent(canonicalMarkup(row.html).replace("</head>", `<style>${baseline}</style></head>`));
          await newPage.setContent(row.html.replace("</head>", `<style>${current}</style></head>`));
          expect(await snapshot(newPage), `${width} ${row.name} default`).toEqual(await snapshot(oldPage));
          for (const page of [oldPage, newPage]) await page.keyboard.press("Tab");
          expect(await snapshot(newPage), `${width} ${row.name} keyboard focus`).toEqual(await snapshot(oldPage));
          for (const page of [oldPage, newPage]) {
            // The focused skip link overlays the brand; compare hover as a separate state.
            await page.evaluate("() => document.activeElement.blur()");
            const link = page.locator('a[href]:not([href="#main"])').first();
            await link.hover();
            expect(await link.evaluate("element => element.matches(':hover')")).toBe(true);
          }
          expect(await snapshot(newPage), `${width} ${row.name} hover`).toEqual(await snapshot(oldPage));
          if (row.name === "avatar-abc") {
            for (const page of [oldPage, newPage]) await page.evaluate(`() => {
              document.querySelector("[data-avatar] img").hidden = true;
              document.querySelector("[data-avatar-initial]").hidden = false;
            }`);
            expect(await snapshot(newPage), `${width} broken avatar`).toEqual(await snapshot(oldPage));
          }
        }
      }
      // Prove that the comparison would catch a dropped declaration.
      await newPage.addStyleTag({ content: "body{font-size:30px!important}" });
      expect(await snapshot(newPage)).not.toEqual(await snapshot(oldPage));
    } finally { await browser.close(); }
  }, 120_000);
});
