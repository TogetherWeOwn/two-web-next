import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { EventFormPage } from "../src/admin/pages";
import type { EventRow } from "../src/admin/store";
import { InternalErrorPage, MaintenancePage, NotFoundPage, RateLimitedPage } from "../src/errors";
import { Home } from "../src/pages";
import { ProfilePage } from "../src/profiles/pages";
import { concretePath, HTML_READS, MEMBER_ID, pageShellFixture } from "./helpers/page-shells";

// The comparison side is the stylesheet on main c502ca4, before factoring.
// Utilities are removed ONLY on that side; current renders must carry them.
const baseline = readFileSync(new URL("./helpers/styles-baseline.css", import.meta.url), "utf8");
const current = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const themeBaseline = readFileSync(new URL("./helpers/theme-baseline.css", import.meta.url), "utf8");
const profileThemeBaseline = readFileSync(new URL("./helpers/profile-theme-baseline.css", import.meta.url), "utf8");
const themeCurrent = readFileSync(new URL("../public/theme.css", import.meta.url), "utf8");
const profileThemeCurrent = readFileSync(new URL("../public/profile-theme.css", import.meta.url), "utf8");
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
// The served theme sheets must target tokenized class names. This is the same
// mechanical rename canonicalMarkup applies to markup, applied to selectors,
// so the originals in test/helpers are the only handwritten source.
const originalNames: Record<string, string> = Object.fromEntries(
  Object.entries(names).map(([token, original]) => [original, token]),
);
function tokenizeCss(css: string) {
  return css.replace(/\.([a-zA-Z][\w-]*)/g, (selector, name: string) => originalNames[name] ? `.${originalNames[name]}` : selector);
}
// Themed routes layer /theme.css (and /profile-theme.css) over styles.css on
// both comparison sides; unthemed rows stay base-only, as served.
function themedSheets(html: string, theme: string, profileTheme: string) {
  if (html.includes('class="homepage-theme"')) return [theme];
  if (html.includes('class="profile-theme"')) return [theme, profileTheme];
  return [];
}
function styleTag(...sheets: string[]) {
  return sheets.map((sheet) => `<style>${sheet}</style>`).join("");
}
function offline(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/g, "")
    .replace(/<img\b[^>]*>/g, (image) => image.replace(/\s(?:src|srcset)="[^"]*"/g, "")
      .replace("<img", '<img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'64\' height=\'64\'%3E%3C/svg%3E"'));
}
async function cases() {
  const rows: { name: string; html: string }[] = [];
  const missing = ["/missing-page", "/admin/events/missing-event"];
  for (const path of [...HTML_READS.map(concretePath), ...missing, "/events?view=calendar"]) {
    const response = await pageShellFixture().request(path);
    expect(response.status, path).toBe(missing.includes(path) ? 404 : 200);
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
  const now = new Date("2030-01-01T20:00:00Z");
  const populated404 = NotFoundPage({ suggestions: [
    { key: "style-proof-event", title: "Game night", startsAt: now, location: "Lobby" },
    { key: "style-proof-no-location", title: "Online games", startsAt: now, location: null },
  ] })!.toString();
  expect(populated404).toContain('data-testid="error-event-suggestion"');
  expect(populated404.match(/<p class="mt"><time datetime=/g)).toHaveLength(2);
  rows.push({ name: "error-404-populated", html: offline(populated404) });
  const row: EventRow = {
    id: 1, icsSequence: 1n, eventKey: "style-proof-event", title: "Game night", game: null, description: null,
    startsAt: now, endsAt: new Date("2030-01-01T22:00:00Z"), timezone: "UTC", location: "Lobby",
    capacity: null, status: "draft", discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    createdBy: MEMBER_ID, rsvpOpen: true, recurrenceFrequency: null, recurrenceCount: null, recurrenceEndsOn: null,
    parentEventId: null, recurrenceIndex: null, createdAt: now, updatedAt: now,
  };
  const rejected = EventFormPage({ mode: "edit", row, values: { title: "Rejected draft", capacity: "invalid" },
    errors: { capacity: "Use a whole number" } })!.toString();
  expect(rejected).toContain('data-event-draft=""');
  expect(rejected).toContain('data-testid="form-errors"');
  expect(rejected).toContain('class="err"');
  rows.push({ name: "admin-rejected-save", html: offline(rejected) });
  for (const [name, html] of [
    ["error-429", RateLimitedPage({})!.toString()],
    ["error-500", InternalErrorPage({})!.toString()],
    ["error-503", MaintenancePage({ inviteUrl: "/join" })!.toString()],
  ]) rows.push({ name: name!, html: offline(html!) });
  return rows;
}

async function snapshot(page: Page) {
  const result = await page.evaluate(`Array.from(document.querySelectorAll("body, body *"), (element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      style: Object.fromEntries(Array.from(style).filter((key) => !key.startsWith("--"))
        .map((key) => [key, style.getPropertyValue(key)])),
      bounds: [bounds.x, bounds.y, bounds.width, bounds.height],
    };
  })`);
  if (!Array.isArray(result)) throw new Error("computed-style snapshot must be an array");
  expect(result.length, "computed-style snapshot must contain rendered elements").toBeGreaterThan(1);
  return result;
}

describe("factored stylesheet", () => {
  it("returns nonempty computed-style snapshots and rejects unusable evaluation results", async () => {
    const bounds = { x: 0, y: 0, width: 360, height: 100 };
    const elements = ["BODY", "MAIN"].map((tagName) => ({ tagName, getBoundingClientRect: () => bounds }));
    const style = Object.assign(["color", "--ink"], { getPropertyValue: () => "rgb(22, 19, 15)" });
    const page = { evaluate: async (expression: string) => new Function("document", "getComputedStyle",
      `return (${expression});`)({ querySelectorAll: () => elements }, () => style) } as unknown as Page;
    expect(await snapshot(page)).toEqual(elements.map((element) => ({ tag: element.tagName,
      style: { color: "rgb(22, 19, 15)" }, bounds: [0, 0, 360, 100] })));
    await expect(snapshot({ evaluate: async () => undefined } as unknown as Page)).rejects.toThrow();
    await expect(snapshot({ evaluate: async () => [] } as unknown as Page)).rejects.toThrow();
  });

  it("serves theme sheets that are the mechanical token translation of the originals", () => {
    expect(tokenizeCss(themeBaseline)).toBe(themeCurrent);
    expect(tokenizeCss(profileThemeBaseline)).toBe(profileThemeCurrent);
  });

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
          const baselineTheme = themedSheets(row.html, themeBaseline, profileThemeBaseline);
          const currentTheme = themedSheets(row.html, themeCurrent, profileThemeCurrent);
          await oldPage.setContent(canonicalMarkup(row.html).replace("</head>", `${styleTag(baseline, ...baselineTheme)}</head>`));
          await newPage.setContent(row.html.replace("</head>", `${styleTag(current, ...currentTheme)}</head>`));
          // The hover step parks the pointer on a link; a stale pointer over
          // themed :hover colors would leak into the next row's states.
          for (const page of [oldPage, newPage]) await page.mouse.move(0, 0);
          if (row.name === "error-404-populated") {
            for (const page of [oldPage, newPage]) {
              // The muted declaration must reach the suggestion paragraphs; the
              // theme redefines the muted custom property, so compare against
              // the resolved value rather than the unthemed literal.
              const colors = (await page.evaluate(`(() => {
                const probe = document.createElement("div");
                probe.style.color = getComputedStyle(document.body).getPropertyValue("--muted").trim();
                document.body.appendChild(probe);
                const colors = [getComputedStyle(document.querySelector('[data-testid="error-event-suggestion"] + p')).color,
                  getComputedStyle(probe).color];
                probe.remove();
                return colors;
              })()`)) as string[];
              expect(colors[0], "suggestion paragraphs carry the muted declaration").toBe(colors[1]);
            }
          }
          if (row.html.includes('data-testid="profile-edit-control"')) {
            for (const page of [oldPage, newPage]) {
              expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-testid="profile-edit-control"]')).display`)).toBe("none");
            }
          }
          expect(await snapshot(newPage), `${width} ${row.name} default`).toEqual(await snapshot(oldPage));
          for (const page of [oldPage, newPage]) {
            await page.keyboard.press("Tab");
            expect(await page.evaluate(`document.querySelector('a[href="#main"]').matches(':focus')`)).toBe(true);
          }
          expect(await snapshot(newPage), `${width} ${row.name} keyboard focus`).toEqual(await snapshot(oldPage));
          expect(await snapshot(newPage), `${width} ${row.name} hover`).toEqual(await snapshot(oldPage));
          if (row.html.includes('data-testid="profile-edit-control"')) {
            for (const page of [oldPage, newPage]) {
              await page.evaluate(`document.querySelector('[data-testid="profile-edit-control"]').hidden = false`);
              expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-testid="profile-edit-again"]')).display`)).toBe("inline-flex");
            }
            expect(await snapshot(newPage), `${width} ${row.name} re-edit control`).toEqual(await snapshot(oldPage));
          }
          if (row.name === "avatar-abc") {
            for (const page of [oldPage, newPage]) {
              await page.evaluate(`(() => {
                document.querySelector("[data-avatar] img").hidden = true;
                document.querySelector("[data-avatar-initial]").hidden = false;
              })()`);
              expect(await page.evaluate(`getComputedStyle(document.querySelector("[data-avatar] img")).display`)).toBe("none");
              expect(await page.evaluate(`getComputedStyle(document.querySelector("[data-avatar-initial]")).display`)).toBe("flex");
            }
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
